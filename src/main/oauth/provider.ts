/**
 * The access token an upstream request is allowed to carry — kept fresh, kept in
 * the main process, handed out only as an `Authorization` header value.
 *
 * It implements the broker's `CredentialProvider` seam, so the MCP route asks it
 * for headers exactly as the REST route asks `StaticSecretProvider`, and never
 * learns where a token lives or how it was refreshed.
 *
 * Rules, each pinned by a test:
 *
 *   • EXPIRY. A token within `marginMs` (120 s) of its expiry is refreshed BEFORE it
 *     is used, so an upstream call never starts with a token about to die.
 *   • SINGLE FLIGHT. However many workers ask at once, one refresh request is made
 *     per integration; every caller gets that one answer.
 *   • ROTATION. A new refresh token from the provider is written to the encrypted
 *     store BEFORE the new access token is handed out ("write-ahead"): if the app
 *     dies a moment later, the token the provider now expects is the one on disk.
 *   • DEAD GRANTS. `invalid_grant` / `invalid_client` and friends mean the user must
 *     sign in again. That is remembered (and persisted) so the provider is not asked
 *     again and again; anything that is not clearly a dead grant (a 5xx, a timeout,
 *     a rate limit, an unknown 4xx) is `unavailable` — retried with backoff, then
 *     left alone for a cool-down — and never throws a working sign-in away.
 *   • DISCONNECT WINS. `forget()` bumps a per-integration epoch and aborts in-flight
 *     refreshes; a refresh that was already on the wire when the user disconnected
 *     is discarded, not saved, so a disconnect can never be undone by a late answer.
 *   • NOTHING LEAKS. Failures are codes. No token, client secret or provider text is
 *     returned from here, put in an error, or logged.
 */
import type { McpOauthSpec } from '../../shared/mcpCatalog';
import type { CredentialProvider, CredentialResult } from '../broker/credentials';
import { validateOauthSpec, type EndpointPolicy } from './endpoints';
import { formBody, send, type FetchLike } from './http';
import { parseTokenResponse } from './token-response';
import { clientFingerprint, type TokenRecord, type TokenStore } from './token-store';
import type { OAuthClient, OAuthLogger } from './types';

export type ConnectionState =
  | 'unconfigured'   // no OAuth client stored, or the integration has no in-app sign-in
  | 'signed-out'     // a client, but no sign-in yet
  | 'connected'      // a usable sign-in
  | 'needs-signin'   // the sign-in is over (revoked, expired for good, malformed, or for another client)
  | 'unavailable';   // the credential store cannot be read or decrypted right now

export interface ProviderDeps {
  /** The pinned OAuth spec for an integration, or undefined if it has none. */
  oauthSpec(id: string): McpOauthSpec | undefined;
  /** The user's OAuth client, or undefined while one half is missing. */
  client(id: string): OAuthClient | undefined;
  store: TokenStore;
  fetch: FetchLike;
  policy: EndpointPolicy;
  now(): number;
  log: OAuthLogger;
  /** Refresh when the token has less than this left. Default 120 s. */
  marginMs?: number;
  /** Pauses between refresh attempts after a transient failure. Default [1000, 2000]. */
  retryDelaysMs?: number[];
  /** After a transient failure, answer `unavailable` for this long without calling the provider. Default 5 s. */
  cooldownMs?: number;
  /** Time the token endpoint has to answer. Default 15 s. */
  timeoutMs?: number;
  /** Test seam: how to wait. */
  sleep?: (ms: number) => Promise<void>;
}

interface Entry { record: TokenRecord; forceRefresh: boolean; persistPending: boolean }

const HEADER = (token: string): CredentialResult => ({ ok: true, headers: { Authorization: `Bearer ${token}` } });

export class OAuthTokenProvider implements CredentialProvider<{ id: string }> {
  private readonly cache = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<CredentialResult>>();
  private readonly aborters = new Map<string, Set<AbortController>>();
  private readonly epoch = new Map<string, number>();
  private readonly coolUntil = new Map<string, number>();
  private readonly rejectedAt = new Map<string, number>();
  private disposed = false;
  /** Quitting: no NEW refresh starts, but one already on the wire may finish and be saved. */
  private draining = false;

  constructor(private readonly deps: ProviderDeps) {}

  private get margin(): number { return this.deps.marginMs ?? 120_000; }
  private epochOf(id: string): number { return this.epoch.get(id) ?? 0; }

  // ─── status (no network) ───────────────────────────────────────────────────

  /** Where this integration stands, from what is stored. Never calls the provider. */
  status(id: string): ConnectionState {
    const client = this.deps.client(id);
    if (!this.deps.oauthSpec(id) || !client) return 'unconfigured';
    const loaded = this.load(id);
    if (loaded.kind === 'unavailable') return 'unavailable';
    if (loaded.kind === 'missing') return 'signed-out';
    if (loaded.kind === 'malformed') return 'needs-signin';
    const r = loaded.entry.record;
    if (r.dead || r.clientFingerprint !== clientFingerprint(client.clientId)) return 'needs-signin';
    if (r.expiresAt !== undefined && r.expiresAt <= this.deps.now() && !r.refreshToken) return 'needs-signin';
    return 'connected';
  }

  /** MAIN-ONLY. The tokens held, so Disconnect can revoke them. Never sent over IPC. */
  tokens(id: string): { accessToken?: string; refreshToken?: string } {
    const loaded = this.load(id);
    if (loaded.kind !== 'entry') return {};
    const r = loaded.entry.record;
    return { accessToken: r.accessToken, ...(r.refreshToken ? { refreshToken: r.refreshToken } : {}) };
  }

  // ─── the credential ────────────────────────────────────────────────────────

  async accessHeaders(subject: { id: string }): Promise<CredentialResult> {
    const id = subject.id;
    if (this.disposed) return { ok: false, code: 'unavailable' };
    const spec = this.deps.oauthSpec(id);
    const client = this.deps.client(id);
    if (!spec || !client) return { ok: false, code: 'no_secret' };

    const loaded = this.load(id);
    if (loaded.kind === 'unavailable') return { ok: false, code: 'unavailable' };
    if (loaded.kind === 'missing' || loaded.kind === 'malformed') return { ok: false, code: 'sign_in_required' };
    const entry = loaded.entry;
    if (entry.record.dead || entry.record.clientFingerprint !== clientFingerprint(client.clientId)) return { ok: false, code: 'sign_in_required' };

    if (entry.persistPending) this.retryPersist(id, entry);

    const expired = entry.record.expiresAt !== undefined && entry.record.expiresAt - this.deps.now() <= this.margin;
    if (!expired && !entry.forceRefresh) return HEADER(entry.record.accessToken);

    let p = this.inflight.get(id);
    if (!p && this.draining) return { ok: false, code: 'unavailable' };      // quitting: nothing new starts
    if (!p) {
      // Only remove the entry if it is still THIS refresh's: after a disconnect and a new
      // sign-in a newer refresh may own the slot, and a late finish must not evict it
      // (that would let a third caller start a second refresh while one is on the wire).
      const mine: Promise<CredentialResult> = this.refresh(id, spec, client).finally(() => {
        if (this.inflight.get(id) === mine) this.inflight.delete(id);
      });
      p = mine;
      this.inflight.set(id, mine);
    }
    return p;
  }

  /**
   * The upstream refused this access token (a 401). The next request refreshes
   * instead of reusing it. Rate-limited: a server that rejects every token for a
   * reason a refresh cannot fix must not turn into a refresh loop.
   */
  markRejected(id: string, usedAccessToken?: string): void {
    const entry = this.cache.get(id);
    if (!entry) return;
    if (usedAccessToken !== undefined && entry.record.accessToken !== usedAccessToken) return;   // already replaced
    const last = this.rejectedAt.get(id);
    if (last !== undefined && this.deps.now() - last < 10_000) return;
    this.rejectedAt.set(id, this.deps.now());
    entry.forceRefresh = true;
  }

  /**
   * The route's hook: the upstream refused a request that carried `used` (the headers
   * `accessHeaders` returned). The access token in it is marked rejected, so the next
   * `accessHeaders` refreshes it; the route then replays the request once.
   */
  rejected(subject: { id: string }, used: Record<string, string>): void {
    let header: string | undefined;
    for (const [k, v] of Object.entries(used)) if (k.toLowerCase() === 'authorization') header = v;
    const m = header ? /^Bearer\s+(\S+)$/i.exec(header) : null;
    this.markRejected(subject.id, m ? m[1] : undefined);
  }

  /** Adopt a record a sign-in just produced (already saved by the caller). */
  adopt(id: string, record: TokenRecord): void {
    this.cache.set(id, { record, forceRefresh: false, persistPending: false });
    this.coolUntil.delete(id);
    this.rejectedAt.delete(id);
  }

  /**
   * Drop everything held in memory for this integration and make any refresh that
   * is on the wire useless: it is aborted, and if its answer still arrives it is
   * discarded rather than saved.
   */
  forget(id: string): void {
    this.epoch.set(id, this.epochOf(id) + 1);
    this.cache.delete(id);
    this.coolUntil.delete(id);
    this.rejectedAt.delete(id);
    for (const ac of this.aborters.get(id) ?? []) ac.abort();
    this.aborters.delete(id);
    this.inflight.delete(id);
  }

  /** Quit has begun: refuse to start a refresh, but leave one already on the wire alone. */
  beginShutdown(): void { this.draining = true; }

  /**
   * Wait (at most `ms`) for refreshes on the wire to finish, so a rotated refresh token
   * the provider has already issued is saved instead of lost. Never throws.
   */
  async drain(ms: number): Promise<void> {
    const pending = [...this.inflight.values()];
    if (pending.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled(pending),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); })
      ]);
    } finally { if (timer) clearTimeout(timer); }
  }

  dispose(): void {
    this.disposed = true;
    for (const id of [...this.aborters.keys()]) this.forget(id);
    this.cache.clear();
    this.inflight.clear();
  }

  // ─── loading ───────────────────────────────────────────────────────────────

  private load(id: string):
    | { kind: 'entry'; entry: Entry }
    | { kind: 'missing' } | { kind: 'malformed' } | { kind: 'unavailable' } {
    const cached = this.cache.get(id);
    if (cached) return { kind: 'entry', entry: cached };
    const r = this.deps.store.load(id);
    if (r.kind === 'record') {
      const entry: Entry = { record: r.record, forceRefresh: false, persistPending: false };
      this.cache.set(id, entry);
      return { kind: 'entry', entry };
    }
    if (r.kind === 'unavailable') this.deps.log({ event: 'token.unavailable', id, why: r.why });
    if (r.kind === 'malformed') this.deps.log({ event: 'token.malformed', id });
    return { kind: r.kind } as { kind: 'missing' } | { kind: 'malformed' } | { kind: 'unavailable' };
  }

  // ─── refresh ───────────────────────────────────────────────────────────────

  private async refresh(id: string, spec: McpOauthSpec, client: OAuthClient): Promise<CredentialResult> {
    const epoch = this.epochOf(id);
    const stale = (): boolean => this.disposed || this.epochOf(id) !== epoch;
    const entry = this.cache.get(id);
    if (!entry) return { ok: false, code: 'sign_in_required' };

    try { validateOauthSpec(spec, this.deps.policy); } catch { return { ok: false, code: 'unavailable' }; }

    // Another process may already have rotated the token: use its record, do not spend ours.
    const stored = this.deps.store.load(id);
    if (stored.kind === 'record' && stored.record.refreshToken !== undefined
      && stored.record.refreshToken !== entry.record.refreshToken && stored.record.obtainedAt >= entry.record.obtainedAt) {
      entry.record = stored.record;
      entry.forceRefresh = false;
      const left = entry.record.expiresAt === undefined ? Infinity : entry.record.expiresAt - this.deps.now();
      if (left > this.margin && !entry.record.dead) return HEADER(entry.record.accessToken);
    }

    let refreshToken = entry.record.refreshToken;
    let adoptions = 0;
    if (!refreshToken) {
      this.markDead(id, entry, 'no_refresh_token');
      return { ok: false, code: 'sign_in_required' };
    }
    if ((this.coolUntil.get(id) ?? 0) > this.deps.now()) return { ok: false, code: 'unavailable' };

    const delays = this.deps.retryDelaysMs ?? [1000, 2000];
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    for (let attempt = 0; ; attempt++) {
      if (stale()) return { ok: false, code: 'sign_in_required' };
      const ac = new AbortController();
      this.track(id, ac);
      let res;
      try {
        res = await send(this.deps.fetch, spec.tokenEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
          body: formBody({
            grant_type: 'refresh_token', refresh_token: refreshToken, client_id: client.clientId,
            ...(client.clientSecret ? { client_secret: client.clientSecret } : {}),
            ...(spec.resource ? { resource: spec.resource } : {})
          })
        }, { timeoutMs: this.deps.timeoutMs ?? 15_000, signal: ac.signal });
      } finally { this.untrack(id, ac); }

      // A disconnect (or quit) happened while this was on the wire: whatever came back is void.
      if (stale()) return { ok: false, code: 'sign_in_required' };

      const outcome = res.kind === 'network'
        ? ({ kind: 'transient' } as const)
        : parseTokenResponse(res.status, res.text, spec, this.deps.now(), { refreshToken, scope: entry.record.scope });

      if (outcome.kind === 'tokens') {
        const next: TokenRecord = {
          ...entry.record,
          accessToken: outcome.tokens.accessToken,
          refreshToken: outcome.tokens.refreshToken ?? refreshToken,
          expiresAt: outcome.tokens.expiresAt,
          scope: outcome.tokens.scope ?? entry.record.scope,
          obtainedAt: this.deps.now()
        };
        delete next.dead;
        // WRITE-AHEAD: the new refresh token is on disk before anyone is handed the new access token.
        const saved = this.deps.store.save(id, next);
        entry.record = next;
        entry.forceRefresh = false;
        entry.persistPending = !saved.ok;
        this.coolUntil.delete(id);
        this.deps.log({ event: 'token.refreshed', id, rotated: outcome.rotated, saved: saved.ok });
        return HEADER(next.accessToken);
      }
      if (outcome.kind === 'permanent') {
        // PHASE 4 FINDING F1. A provider that ROTATES refresh tokens refuses a spent one. When two engines share
        // one store and both were refreshing at once, the loser is refused for a token the WINNER already spent,
        // and the grant is alive: look at the store again before burying it, and carry on with the winner's token.
        const adopted = adoptions < 2 ? this.adoptNewer(id, entry, refreshToken) : undefined;
        if (adopted) {
          adoptions++;
          const left = adopted.expiresAt === undefined ? Infinity : adopted.expiresAt - this.deps.now();
          this.deps.log({ event: 'token.adopted', id });
          if (left > this.margin) return HEADER(adopted.accessToken);
          refreshToken = adopted.refreshToken as string;
          continue;
        }
        this.markDead(id, entry, outcome.code);
        return { ok: false, code: 'sign_in_required' };
      }
      if (outcome.kind === 'transient' && attempt < delays.length) {
        this.deps.log({ event: 'token.refresh.retry', id, attempt: attempt + 1 });
        await sleep(delays[attempt]);
        continue;
      }
      // transient and out of retries, an unknown refusal, or a 200 that was not a token response
      this.coolUntil.set(id, this.deps.now() + (this.deps.cooldownMs ?? 5000));
      this.deps.log({ event: 'token.refresh.failed', id, outcome: outcome.kind, ...(outcome.kind === 'rejected' ? { code: outcome.code } : {}) });
      return { ok: false, code: 'unavailable' };
    }
  }

  /** A live record in the store with a refresh token other than `used`: someone else rotated it. */
  private adoptNewer(id: string, entry: Entry, used: string | undefined): TokenRecord | undefined {
    const stored = this.deps.store.load(id);
    if (stored.kind !== 'record') return undefined;
    const r = stored.record;
    if (r.dead || r.refreshToken === undefined || r.refreshToken === used) return undefined;
    if (r.clientFingerprint !== entry.record.clientFingerprint) return undefined;
    entry.record = r;
    entry.forceRefresh = false;
    entry.persistPending = false;
    return r;
  }

  private markDead(id: string, entry: Entry, reason: string): void {
    // Never write a dead marker over a live record someone else saved in the meantime (F1).
    const stored = this.deps.store.load(id);
    if (stored.kind === 'record' && !stored.record.dead && stored.record.refreshToken !== entry.record.refreshToken
      && stored.record.obtainedAt >= entry.record.obtainedAt) {
      entry.record = stored.record;
      return;
    }
    const dead = { at: this.deps.now(), reason: /^[a-z][a-z0-9_-]{0,39}$/.test(reason) ? reason : 'unknown' };
    entry.record = { ...entry.record, dead };
    const saved = this.deps.store.save(id, entry.record);
    entry.persistPending = !saved.ok;
    this.deps.log({ event: 'token.dead', id, reason: dead.reason, saved: saved.ok });
  }

  private retryPersist(id: string, entry: Entry): void {
    const saved = this.deps.store.save(id, entry.record);
    if (saved.ok) { entry.persistPending = false; this.deps.log({ event: 'token.persisted', id }); }
  }

  private track(id: string, ac: AbortController): void {
    let set = this.aborters.get(id);
    if (!set) { set = new Set(); this.aborters.set(id, set); }
    set.add(ac);
  }
  private untrack(id: string, ac: AbortController): void { this.aborters.get(id)?.delete(ac); }
}
