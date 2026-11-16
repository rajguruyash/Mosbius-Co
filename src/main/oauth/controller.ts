/**
 * The in-app OAuth engine's front door: what `mcp:signIn`, `mcp:secretStatus` and
 * quit talk to when an integration's engine is `broker`.
 *
 * It owns the pending sign-ins (at most one per integration), the memory of codes
 * already used, and the token provider. It never returns a token, a code or a
 * provider's text: results are `{ok}` and fixed error codes.
 *
 * Disconnect is NOT here: it is one orchestration for both engines
 * (mcpDisconnect.ts), so an account is never half-removed because one engine was
 * selected and the other still held a token. This class supplies the pieces it
 * needs: `tokens`, `revoke` (the provider call), `forget` and `cancel`.
 *
 * Electron-free: everything it touches is injected.
 */
import { mcpSecretRefs, type McpCatalogEntry, type McpOauthSpec } from '../../shared/mcpCatalog';
import { PRODUCTION_POLICY, validateOauthSpec, type EndpointPolicy } from './endpoints';
import { SignInSession, type FlowOptions } from './flow';
import type { FetchLike } from './http';
import type { RandomBytes } from './pkce';
import { OAuthTokenProvider, type ConnectionState } from './provider';
import { revokeTokens } from './revoke';
import { importBridgeTokens, type ImportOutcome } from '../mcpImport';
import { TokenStore, clientFingerprint, type SecretIO, type TokenRecord } from './token-store';
import type { OAuthClient, OAuthLogger, SignInError } from './types';

export interface ControllerDeps {
  /** The catalogue (injected so tests can use their own). */
  entry(id: string): McpCatalogEntry | undefined;
  /** The encrypted store, plus the two reads that tell "empty" from "unreadable". */
  secrets: SecretIO;
  fetch: FetchLike;
  /** Open the authorization URL in the user's browser. */
  openUrl(url: string): Promise<void>;
  now(): number;
  log: OAuthLogger;
  /** Production passes nothing: every endpoint must then be https. Only tests relax it. */
  policy?: EndpointPolicy;
  random?: RandomBytes;
  /** Test seam: replace the catalogue's OAuth spec (stand-in provider endpoints). */
  specOverride?(id: string): McpOauthSpec | undefined;
  /** Test seam: replace the catalogue's callback port. */
  portOverride?(id: string): number | undefined;
  timeouts?: FlowOptions & { refreshMs?: number; retryDelaysMs?: number[]; cooldownMs?: number; revokeMs?: number };
  sleep?: (ms: number) => Promise<void>;
}

export type SignInResult = { ok: true } | { ok: false; error: SignInError };

export class OAuthController {
  readonly provider: OAuthTokenProvider;
  private readonly store: TokenStore;
  private readonly pending = new Map<string, SignInSession>();
  private readonly usedCodes = new Set<string>();
  private readonly policy: EndpointPolicy;

  constructor(private readonly deps: ControllerDeps) {
    this.policy = deps.policy ?? PRODUCTION_POLICY;
    this.store = new TokenStore(deps.secrets);
    this.provider = new OAuthTokenProvider({
      oauthSpec: (id) => this.specOf(id),
      client: (id) => this.clientOf(id),
      store: this.store,
      fetch: deps.fetch,
      policy: this.policy,
      now: deps.now,
      log: deps.log,
      timeoutMs: deps.timeouts?.refreshMs,
      retryDelaysMs: deps.timeouts?.retryDelaysMs,
      cooldownMs: deps.timeouts?.cooldownMs,
      sleep: deps.sleep
    });
  }

  // ─── lookups ───────────────────────────────────────────────────────────────

  private specOf(id: string): McpOauthSpec | undefined {
    const over = this.deps.specOverride?.(id);
    if (over) return over;
    const e = this.deps.entry(id);
    return e && e.spec.transport === 'bridge' ? e.spec.oauth : undefined;
  }

  private portOf(id: string): number | undefined {
    const over = this.deps.portOverride?.(id);
    if (over !== undefined) return over;
    const e = this.deps.entry(id);
    return e && e.spec.transport === 'bridge' ? e.spec.callbackPort : undefined;
  }

  private clientOf(id: string): OAuthClient | undefined {
    const e = this.deps.entry(id);
    if (!e) return undefined;
    const [idRef, secretRef] = mcpSecretRefs(e);
    let clientId: string | undefined;
    let clientSecret: string | undefined;
    try { clientId = this.deps.secrets.get(idRef)?.trim(); clientSecret = this.deps.secrets.get(secretRef)?.trim(); } catch { return undefined; }
    return clientId && clientSecret ? { clientId, clientSecret } : undefined;
  }

  // ─── what the Settings panel and the broker ask ─────────────────────────────

  status(id: string): ConnectionState { return this.provider.status(id); }

  /** MAIN-ONLY. The tokens held (so Disconnect can revoke them). */
  hasTokens(id: string): boolean {
    const t = this.provider.tokens(id);
    return !!(t.accessToken || t.refreshToken);
  }

  /** Ask the provider to forget the tokens held. Best-effort; reports what it confirmed. */
  async revoke(id: string): Promise<{ attempted: number; confirmed: number }> {
    const e = this.deps.entry(id);
    const t = this.provider.tokens(id);
    if (!e || e.spec.transport !== 'bridge' || (!t.accessToken && !t.refreshToken)) return { attempted: 0, confirmed: 0 };
    const r = await revokeTokens(e.spec.revoke, t, { fetch: this.deps.fetch, policy: this.policy, timeoutMs: this.deps.timeouts?.revokeMs });
    this.deps.log({ event: 'revoke', id, attempted: r.attempted, confirmed: r.confirmed });
    return { attempted: r.attempted, confirmed: r.confirmed };
  }

  /** Copy the bridge's sign-in for this integration into the in-app record (never
   *  overwriting one, never touching the bridge's copy). See mcpImport.ts. */
  importFromBridge(id: string): ImportOutcome {
    const entry = this.deps.entry(id);
    if (!entry) return { kind: 'none' };
    const out = importBridgeTokens({ secrets: this.deps.secrets, store: this.store, now: this.deps.now }, entry);
    this.deps.log({ event: 'import', id, outcome: out.kind, ...(out.kind === 'failed' ? { why: out.why } : {}), ...(out.kind === 'imported' ? { refreshable: out.refreshable } : {}) });
    return out;
  }

  // ─── sign-in ───────────────────────────────────────────────────────────────

  async signIn(id: string): Promise<SignInResult> {
    const entry = this.deps.entry(id);
    const spec = this.specOf(id);
    const port = this.portOf(id);
    if (!entry || !spec || port === undefined) return { ok: false, error: 'failed' };
    const client = this.clientOf(id);
    if (!client) return { ok: false, error: 'no-client' };
    if (this.pending.has(id)) return { ok: false, error: 'in-progress' };

    const state = this.provider.status(id);
    if (state === 'connected') return { ok: true };
    // A sign-in whose tokens could not be kept would be lost at once: say so first.
    if (state === 'unavailable') return { ok: false, error: 'unavailable' };

    try { validateOauthSpec(spec, this.policy); } catch { return { ok: false, error: 'failed' }; }

    const session = new SignInSession({
      integrationId: id, label: entry.label, spec, client, callbackPort: port,
      scope: spec.scope ?? (entry.spec.transport === 'bridge' ? entry.spec.scope : undefined)
    }, {
      fetch: this.deps.fetch, openUrl: this.deps.openUrl, now: this.deps.now, log: this.deps.log,
      policy: this.policy, random: this.deps.random, usedCodes: this.usedCodes
    }, this.deps.timeouts);
    this.pending.set(id, session);
    let outcome;
    try { outcome = await session.start(); }
    finally { if (this.pending.get(id) === session) this.pending.delete(id); }
    if (!outcome.ok) return { ok: false, error: outcome.error };

    const t = outcome.tokens;
    const record: TokenRecord = {
      v: 1, accessToken: t.accessToken,
      ...(t.refreshToken ? { refreshToken: t.refreshToken } : {}),
      ...(t.expiresAt !== undefined ? { expiresAt: t.expiresAt } : {}),
      ...(t.scope ? { scope: t.scope } : {}),
      obtainedAt: this.deps.now(),
      clientFingerprint: clientFingerprint(client.clientId)
    };
    const saved = this.store.save(id, record);
    if (!saved.ok) {
      // Tokens we cannot keep are tokens nobody should hold: hand them back.
      void revokeTokens(entry.spec.transport === 'bridge' ? entry.spec.revoke : undefined, t, { fetch: this.deps.fetch, policy: this.policy })
        .catch(() => undefined);
      this.deps.log({ event: 'signin.not-stored', id });
      return { ok: false, error: 'not-stored' };
    }
    this.provider.adopt(id, record);
    const asked = (spec.scope ?? (entry.spec.transport === 'bridge' ? entry.spec.scope : '') ?? '').split(' ').filter(Boolean);
    const got = (t.scope ?? '').split(/[ ,]/).filter(Boolean);
    this.deps.log({
      event: 'signin.stored', id, refreshToken: t.refreshToken !== undefined, expires: t.expiresAt !== undefined,
      scopeNarrower: got.length > 0 && asked.some((s) => !got.includes(s))
    });
    return { ok: true };
  }

  // ─── ending things ─────────────────────────────────────────────────────────

  /** Stop a sign-in that is waiting in the browser (one integration, or all). */
  cancel(id?: string): void {
    for (const [key, session] of [...this.pending]) {
      if (id && key !== id) continue;
      this.pending.delete(key);
      session.cancel();
    }
  }

  /** Disconnect step: stop a waiting sign-in and drop everything held in memory. A
   *  refresh on the wire is aborted and its answer discarded. */
  forget(id: string): void {
    this.cancel(id);
    this.provider.forget(id);
  }

  /** Quit has begun: stop waiting sign-ins, and start no new refresh. A refresh already
   *  on the wire is left to finish (see `drain`). */
  beginShutdown(): void {
    this.cancel();
    this.provider.beginShutdown();
  }

  /** Give refreshes on the wire up to `ms` to finish and be saved. Never throws. */
  drain(ms: number): Promise<void> { return this.provider.drain(ms); }

  /** Quit: close every listener, abort every refresh, drop every cached token. */
  dispose(): void {
    this.cancel();
    this.provider.dispose();
  }

}
