/**
 * The connection manager: connect a hosted MCP server with the account the user signs in to, keep that
 * sign-in alive, and take it away again. It is the one place the new sign-in methods meet the rest of the
 * app, and it adds almost nothing of its own:
 *
 *   • the first token comes from a flow (flows.ts): self-registration or the device grant;
 *   • keeping it fresh is the EXISTING OAuthTokenProvider (expiry margin, single flight, write-ahead
 *     rotation, dead grants, abort on disconnect), told this connection's endpoints and client;
 *   • it implements the broker's CredentialProvider, so the MCP route asks it for headers exactly as it
 *     asks any other credential source;
 *   • Disconnect cancels a sign-in that is waiting, asks the provider to forget the token, removes the
 *     client the app registered if the provider lets it, aborts any refresh on the wire, and wipes the
 *     vault, in that order, and says what it could and could not do.
 *
 * Nothing here returns a token, a code, a client secret or a provider's text to a caller. Failures are
 * fixed codes. Electron-free: everything it touches is injected.
 */
import {
  isPlausibleClientId, scopeFor, type ConnectError, type ConnectMethod, type ConnectMethodView, type ConnectSpec, type ConnectionSummary
} from '../../shared/connect';
import { mcpOauthRef, type McpCatalogEntry, type McpOauthSpec } from '../../shared/mcpCatalog';
import type { CredentialProvider, CredentialResult } from '../broker/credentials';
import { PRODUCTION_POLICY, type EndpointPolicy } from '../oauth/endpoints';
import type { RandomBytes } from '../oauth/pkce';
import { OAuthTokenProvider, type ConnectionState } from '../oauth/provider';
import { revokeTokens } from '../oauth/revoke';
import { TokenStore, clientFingerprint, type TokenRecord } from '../oauth/token-store';
import type { OAuthClient, OAuthLogger } from '../oauth/types';
import { signInDcr, signInDevice, type FlowCtx, type FlowResult, type GrantDraft, type Prompt } from './flows';
import { GrantStore, type GrantMeta, type VaultIO } from './grant-store';
import { rawRequest, type RawFetch } from './http';
import { makeHostPolicy } from './policy';

export interface ConnectionManagerDeps {
  entry(id: string): McpCatalogEntry | undefined;
  secrets: VaultIO;
  fetch: RawFetch;
  openUrl(url: string): Promise<void>;
  now(): number;
  log: OAuthLogger;
  /** Production passes nothing: every endpoint must then be https. Only tests relax it. */
  policy?: EndpointPolicy;
  random?: RandomBytes;
  /** A client id the user gave for a method that needs an app (a public value). */
  userClientId?(id: string): string | undefined;
  /** One line for the activity trail: what happened to which connection. Never a secret. */
  audit?(e: { action: string; id: string; decision: 'allow' | 'deny'; reason?: string }): void;
  /** Something about a connection changed: the page should look again. */
  onChange?(id: string): void;
  sleep?(ms: number, signal: AbortSignal): Promise<void>;
  timeouts?: { signInMs?: number; requestMs?: number; refreshMs?: number; retryDelaysMs?: number[]; cooldownMs?: number; revokeMs?: number };
}

export interface ConnectRequest {
  method?: ConnectMethod['kind'];
  /** A public client id for a method that needs an app. */
  clientId?: string;
  /** How much to ask for, where the server has more than one tier. Read-only unless said otherwise. */
  tier?: 'read' | 'write';
}

export type ConnectResult = { ok: true } | { ok: false; error: ConnectError };

export interface DisconnectReport {
  ok: boolean;
  /** What the provider confirmed forgetting. `attempted` 0 means it offers no way to ask. */
  revoked: { attempted: number; confirmed: number };
  /** Whether the client the app registered was removed; null when there was nothing to remove or no way to. */
  unregistered: boolean | null;
  wiped: boolean;
  /** True when the user must also end the sign-in in the provider's own settings. */
  endAtProvider: boolean;
}

interface Pending { ac: AbortController; prompt?: Prompt }

const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> => new Promise((resolve) => {
  if (signal.aborted) return resolve();
  const t = setTimeout(done, ms);
  function done(): void { clearTimeout(t); signal.removeEventListener('abort', done); resolve(); }
  signal.addEventListener('abort', done, { once: true });
});

const connectSpecOf = (e: McpCatalogEntry | undefined): ConnectSpec | undefined =>
  e && e.spec.transport === 'http' ? e.spec.connect : undefined;

export class ConnectionManager implements CredentialProvider<{ id: string }> {
  readonly provider: OAuthTokenProvider;
  private readonly tokens: TokenStore;
  private readonly grants: GrantStore;
  private readonly policy: EndpointPolicy;
  private readonly pending = new Map<string, Pending>();
  private readonly lastError = new Map<string, ConnectError>();
  private readonly metaCache = new Map<string, GrantMeta>();

  constructor(private readonly deps: ConnectionManagerDeps) {
    this.policy = deps.policy ?? PRODUCTION_POLICY;
    this.tokens = new TokenStore(deps.secrets);
    this.grants = new GrantStore(deps.secrets);
    this.provider = new OAuthTokenProvider({
      oauthSpec: (id) => this.specOf(id),
      client: (id) => this.clientOf(id),
      store: this.tokens,
      fetch: deps.fetch,
      policy: this.policy,
      now: deps.now,
      log: deps.log,
      timeoutMs: deps.timeouts?.refreshMs,
      retryDelaysMs: deps.timeouts?.retryDelaysMs,
      cooldownMs: deps.timeouts?.cooldownMs,
      sleep: deps.sleep ? (ms) => deps.sleep!(ms, new AbortController().signal) : undefined
    });
  }

  // ─── what is stored ────────────────────────────────────────────────────

  private metaOf(id: string): GrantMeta | undefined {
    const cached = this.metaCache.get(id);
    if (cached) return cached;
    const r = this.grants.load(id);
    if (r.kind !== 'meta') return undefined;
    this.metaCache.set(id, r.meta);
    return r.meta;
  }

  private specOf(id: string): McpOauthSpec | undefined {
    const g = this.metaOf(id);
    if (!g) return undefined;
    return {
      issuer: g.issuer,
      // a device grant has no authorization endpoint; the engine's checks want a valid one, and it is never used
      authorizationEndpoint: g.authorizationEndpoint ?? g.tokenEndpoint,
      tokenEndpoint: g.tokenEndpoint,
      issParameter: 'optional',
      tokenResponse: g.method === 'device' ? 'github' : 'oauth2',
      ...(g.resource ? { resource: g.resource } : {})
    };
  }

  private clientOf(id: string): OAuthClient | undefined {
    const g = this.metaOf(id);
    return g ? { clientId: g.clientId, ...(g.clientSecret ? { clientSecret: g.clientSecret } : {}) } : undefined;
  }

  // ─── what the page and the broker ask ────────────────────────────────────

  /** Whether this catalogue entry can be connected this way at all. */
  supports(id: string): boolean { return !!connectSpecOf(this.deps.entry(id)); }

  status(id: string): ConnectionState {
    if (!this.supports(id)) return 'unconfigured';
    const r = this.grants.load(id);
    if (r.kind === 'unavailable') return 'unavailable';
    if (r.kind === 'missing') return 'signed-out';
    if (r.kind === 'malformed') return 'needs-signin';
    return this.provider.status(id);
  }

  methodsOf(id: string): ConnectMethodView[] {
    const spec = connectSpecOf(this.deps.entry(id));
    if (!spec) return [];
    return spec.methods.map((m): ConnectMethodView => {
      if (m.kind === 'dcr') return { kind: 'dcr', available: true };
      if (m.kind === 'device') {
        const has = !!(m.clientId ?? this.deps.userClientId?.(id));
        return { kind: 'device', available: has, ...(has ? {} : { needs: 'client-id' as const }) };
      }
      return { kind: m.kind, available: false };
    });
  }

  summary(id: string): ConnectionSummary {
    const status = this.status(id);
    const meta = this.metaOf(id);
    const p = this.pending.get(id);
    const out: ConnectionSummary = { id, status, methods: this.methodsOf(id) };
    if (meta) {
      out.method = meta.method;
      out.connectedAt = meta.connectedAt;
      out.canRevoke = !!meta.revocationEndpoint;
      if (meta.account) out.account = meta.account;
      const t = this.tokens.load(id);
      if (t.kind === 'record') {
        if (t.record.expiresAt !== undefined) out.expiresAt = t.record.expiresAt;
        if (t.record.scope) out.scope = t.record.scope;
        out.hasRefresh = t.record.refreshToken !== undefined;
      }
    }
    if (p?.prompt) out.pending = p.prompt.kind === 'device' ? { kind: 'device', userCode: p.prompt.userCode, verificationUri: p.prompt.verificationUri, expiresAt: p.prompt.expiresAt } : { kind: 'browser' };
    else if (p) out.pending = { kind: 'browser' };
    const err = this.lastError.get(id);
    if (err && !p && status !== 'connected') out.lastError = err;
    return out;
  }

  // ─── the credential the broker injects ───────────────────────────────────

  async accessHeaders(subject: { id: string }): Promise<CredentialResult> {
    if (!this.supports(subject.id)) return { ok: false, code: 'unavailable' };
    const st = this.status(subject.id);
    if (st === 'unavailable') return { ok: false, code: 'unavailable' };
    if (st === 'signed-out' || st === 'unconfigured' || st === 'needs-signin') return { ok: false, code: 'sign_in_required' };
    return this.provider.accessHeaders(subject);
  }

  rejected(subject: { id: string }, used: Record<string, string>): void { this.provider.rejected(subject, used); }

  /** MAIN-ONLY. Whether any token is held (so Disconnect knows there is something to revoke). */
  hasTokens(id: string): boolean {
    const t = this.provider.tokens(id);
    return !!(t.accessToken || t.refreshToken);
  }

  // ─── connecting ──────────────────────────────────────────────────────────

  async connect(id: string, req: ConnectRequest = {}): Promise<ConnectResult> {
    const entry = this.deps.entry(id);
    const spec = connectSpecOf(entry);
    if (!entry || !spec || entry.spec.transport !== 'http') return this.refuse(id, 'not-available');
    if (this.pending.has(id)) return { ok: false, error: 'in-progress' };

    const method = this.pick(spec, req.method, id);
    if (!method) return this.refuse(id, 'not-available');
    let clientId = '';
    if (method.kind === 'device') {
      clientId = (req.clientId ?? method.clientId ?? this.deps.userClientId?.(id) ?? '').trim();
      if (!clientId) return this.refuse(id, 'needs-client-id');
      if (!isPlausibleClientId(clientId)) return this.refuse(id, 'bad-client-id');
    }

    const slot: Pending = { ac: new AbortController() };
    this.pending.set(id, slot);
    this.lastError.delete(id);
    this.changed(id);
    this.audit('connect.start', id, 'allow', method.kind);
    try {
      const ctx: FlowCtx = {
        id, label: entry.label, fetch: this.deps.fetch, endpointPolicy: this.policy, now: this.deps.now, log: this.deps.log, random: this.deps.random,
        openUrl: this.deps.openUrl, signal: slot.ac.signal,
        signInMs: this.deps.timeouts?.signInMs ?? 5 * 60_000, requestMs: this.deps.timeouts?.requestMs ?? 20_000,
        sleep: this.deps.sleep ?? defaultSleep,
        prompt: (p) => { slot.prompt = p; this.changed(id); }
      };
      const scope = scopeFor(spec, req.tier ?? 'read');
      let r: FlowResult;
      if (method.kind === 'dcr') r = await signInDcr(ctx, spec, entry.spec.url, scope);
      else if (method.kind === 'device') r = await signInDevice(ctx, spec, method, clientId);
      else r = { ok: false, error: 'not-available' };
      if (!r.ok) { this.lastError.set(id, r.error); this.audit('connect.end', id, 'deny', r.error); return { ok: false, error: r.error }; }
      if (slot.ac.signal.aborted) return { ok: false, error: 'cancelled' };
      const retired = this.metaOf(id);
      const retiredTokens = retired ? this.provider.tokens(id) : {};
      if (!this.persist(id, r.draft)) { this.lastError.set(id, 'not-stored'); this.audit('connect.end', id, 'deny', 'not-stored'); return { ok: false, error: 'not-stored' }; }
      this.audit('connect.end', id, 'allow', r.draft.method);
      // a reconnect leaves an older sign-in and client behind: let the provider know, best effort
      if (retired && retired.clientId !== r.draft.clientId) void this.releaseAtProvider(retired, retiredTokens);
      return { ok: true };
    } finally {
      this.pending.delete(id);
      this.changed(id);
    }
  }

  /** Stop waiting for a sign-in (the user closed the dialog, or Disconnect). Anything received is thrown away. */
  cancel(id: string): void { this.pending.get(id)?.ac.abort(); }

  private refuse(id: string, error: ConnectError): ConnectResult {
    this.lastError.set(id, error);
    this.audit('connect.start', id, 'deny', error);
    return { ok: false, error };
  }

  private pick(spec: ConnectSpec, wanted: ConnectMethod['kind'] | undefined, id: string): ConnectMethod | undefined {
    const usable = (m: ConnectMethod): boolean => m.kind === 'dcr' || (m.kind === 'device' && !!(m.clientId ?? this.deps.userClientId?.(id)));
    if (wanted) return spec.methods.find((m) => m.kind === wanted);
    return spec.methods.find(usable) ?? spec.methods[0];
  }

  /** Save what a flow returned, and look at it again before calling it connected. */
  private persist(id: string, d: GrantDraft): boolean {
    const now = this.deps.now();
    const meta: GrantMeta = {
      v: 1, method: d.method, clientId: d.clientId, ...(d.clientSecret ? { clientSecret: d.clientSecret } : {}),
      issuer: d.issuer, ...(d.authorizationEndpoint ? { authorizationEndpoint: d.authorizationEndpoint } : {}), tokenEndpoint: d.tokenEndpoint,
      ...(d.revocationEndpoint ? { revocationEndpoint: d.revocationEndpoint } : {}), ...(d.resource ? { resource: d.resource } : {}),
      ...(d.scope ? { scope: d.scope } : {}), ...(d.registration ? { registration: d.registration } : {}), connectedAt: now
    };
    const record: TokenRecord = {
      v: 1, accessToken: d.tokens.accessToken, ...(d.tokens.refreshToken ? { refreshToken: d.tokens.refreshToken } : {}),
      ...(d.tokens.expiresAt !== undefined ? { expiresAt: d.tokens.expiresAt } : {}), ...(d.tokens.scope ? { scope: d.tokens.scope } : {}),
      obtainedAt: now, clientFingerprint: clientFingerprint(d.clientId)
    };
    const rollback = (): false => {
      this.grants.delete(id);
      try { this.deps.secrets.delete(mcpOauthRef(id)); } catch { /* best effort */ }
      this.metaCache.delete(id);
      return false;
    };
    // the engine for the OLD sign-in (if any) must stop before the new one is saved over it
    this.provider.forget(id);
    this.metaCache.delete(id);
    if (!this.grants.save(id, meta)) return rollback();
    if (!this.tokens.save(id, record).ok) return rollback();
    const back = this.tokens.load(id);
    const meta2 = this.grants.load(id);
    if (back.kind !== 'record' || back.record.accessToken !== record.accessToken || meta2.kind !== 'meta') return rollback();
    this.metaCache.set(id, meta2.meta);
    this.provider.adopt(id, record);
    return true;
  }

  // ─── disconnecting ───────────────────────────────────────────────────────

  async disconnect(id: string): Promise<DisconnectReport> {
    this.cancel(id);
    const meta = this.metaOf(id);
    const t = meta ? this.provider.tokens(id) : {};
    // 1. ask the provider to forget, 2. remove the client we registered, 3. only then forget locally
    const released = meta ? await this.releaseAtProvider(meta, t) : { revoked: { attempted: 0, confirmed: 0 }, unregistered: null as boolean | null };
    // abort any refresh on the wire: a late answer must not bring the sign-in back
    this.provider.forget(id);
    this.metaCache.delete(id);
    const a = this.grants.delete(id);
    let b = true;
    try { this.deps.secrets.delete(mcpOauthRef(id)); b = !this.deps.secrets.has(mcpOauthRef(id)); } catch { b = false; }
    const wiped = a && b;
    this.lastError.delete(id);
    this.audit('disconnect', id, wiped ? 'allow' : 'deny', wiped ? undefined : 'not-wiped');
    this.changed(id);
    return {
      ok: wiped, revoked: released.revoked, unregistered: released.unregistered, wiped,
      endAtProvider: !!meta && released.revoked.confirmed === 0
    };
  }

  private async releaseAtProvider(meta: GrantMeta, tokens: { accessToken?: string; refreshToken?: string }): Promise<{ revoked: { attempted: number; confirmed: number }; unregistered: boolean | null }> {
    let revoked = { attempted: 0, confirmed: 0 };
    if (meta.revocationEndpoint && (tokens.accessToken || tokens.refreshToken)) {
      try {
        const r = await revokeTokens({ url: meta.revocationEndpoint, style: 'oauth2' }, tokens, {
          fetch: this.deps.fetch, policy: this.policy, timeoutMs: this.deps.timeouts?.revokeMs, clientId: meta.clientId
        });
        revoked = { attempted: r.attempted, confirmed: r.confirmed };
      } catch { /* best effort */ }
    }
    let unregistered: boolean | null = null;
    if (meta.registration) {
      try {
        const host = new URL(meta.registration.uri);
        const policy = makeHostPolicy([host.host, host.hostname], this.policy);
        policy.check(meta.registration.uri, 'registration handle');
        const r = await rawRequest(this.deps.fetch, meta.registration.uri, { method: 'DELETE', headers: { authorization: `Bearer ${meta.registration.token}` } }, { timeoutMs: this.deps.timeouts?.revokeMs ?? 10_000 });
        unregistered = r.ok && (r.status === 204 || r.status === 200);
      } catch { unregistered = false; }
    }
    this.deps.log({ event: 'connect.release', attempted: revoked.attempted, confirmed: revoked.confirmed, ...(unregistered !== null ? { unregistered } : {}) });
    return { revoked, unregistered };
  }

  // ─── lifecycle ───────────────────────────────────────────────────────────

  beginShutdown(): void { this.provider.beginShutdown(); for (const p of this.pending.values()) p.ac.abort(); }
  drain(ms: number): Promise<void> { return this.provider.drain(ms); }
  dispose(): void { for (const p of this.pending.values()) p.ac.abort(); this.provider.dispose(); this.metaCache.clear(); }

  private audit(action: string, id: string, decision: 'allow' | 'deny', reason?: string): void {
    try { this.deps.audit?.({ action, id, decision, ...(reason ? { reason } : {}) }); } catch { /* the trail never breaks a sign-in */ }
  }
  private changed(id: string): void { try { this.deps.onChange?.(id); } catch { /* a listener never breaks a sign-in */ } }
}
