/**
 * One in-app OAuth sign-in: authorization-code flow with PKCE (S256), run entirely
 * in the main process.
 *
 *   1. Make a code verifier and its S256 challenge, and a single-use `state`.
 *   2. Listen on the integration's loopback port (127.0.0.1 only, exclusively).
 *   3. Send the user's browser to the provider's pinned authorization endpoint.
 *   4. Wait for ONE valid redirect back; everything else is ignored.
 *   5. Exchange the code at the pinned token endpoint, with the verifier and the
 *      user's client secret, and read the answer through a strict schema.
 *
 * The callback table — what a redirect must satisfy, and what happens when it does
 * not. A request that fails a row before "state matches" is IGNORED: it gets an
 * error page and changes nothing, so a forged or malformed request can never end a
 * sign-in that is waiting for the real one.
 *
 * There is deliberately no "too many bad requests, stop answering": that would let
 * anything on this machine lock the user out of their own sign-in. Bad requests cost a
 * parse and a constant-time compare; only the logging of them is throttled.
 *
 *   method is GET                              405
 *   Host is exactly 127.0.0.1:<port>           400   (DNS-rebinding guard)
 *   URL ≤ 4 KiB, every parameter ≤ 2 KiB       414 / 400
 *   path is exactly /oauth/callback            404
 *   a browser NAVIGATION (Sec-Fetch-*)         400   (not an <img>, fetch() or <iframe>)
 *   state, code, error, iss appear once        400
 *   state equals ours (constant time)          400   ← from here on, the request is ours
 *   state not already used                     400   (a replayed callback)
 *   ── state is now spent, whatever follows ──
 *   `error` → ends the sign-in as denied / provider-error (its text is never read)
 *   `iss` equals the catalogue issuer          (and is REQUIRED when the provider says it sends it)
 *   `code` has a plausible shape and was never used before (replay memory)
 *
 * What is never done: no authorization code is ever sent to the token endpoint
 * twice, no redirect is followed, nothing from the request is echoed into the
 * response page, and nothing here logs a code, a state, a verifier or a token.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { MCP_CALLBACK_HOST, mcpRedirectUri, type McpOauthSpec } from '../../shared/mcpCatalog';
import { validateOauthSpec, type EndpointPolicy } from './endpoints';
import { formBody, send, type FetchLike } from './http';
import {
  challengeS256, constantTimeEqual, fingerprint, newCodeVerifier, newState, verifyS256, type RandomBytes
} from './pkce';
import { parseTokenResponse } from './token-response';
import type { OAuthClient, OAuthLogger, SignInError, TokenSet } from './types';

export const CALLBACK_PATH = '/oauth/callback';
const MAX_URL = 4096;
const MAX_PARAM = 2048;
/** Authorization codes are opaque; this is only a sanity bound on what is sent onward. */
const CODE_RE = /^[A-Za-z0-9._~/+=-]{1,2048}$/;
const USED_CODES_KEPT = 256;

export interface SignInRequest {
  integrationId: string;
  /** Shown on the "you can close this tab" page. From the catalogue, never from a request. */
  label: string;
  spec: McpOauthSpec;
  scope?: string;
  client: OAuthClient;
  callbackPort: number;
}

export interface FlowDeps {
  fetch: FetchLike;
  /** Open the authorization URL in the user's own browser. */
  openUrl(url: string): Promise<void>;
  now(): number;
  log: OAuthLogger;
  policy: EndpointPolicy;
  random?: RandomBytes;
  /** Fingerprints of the codes this app has already used, shared by every sign-in,
   *  so a replayed code is refused here before the provider is ever asked. */
  usedCodes: Set<string>;
}

export interface FlowOptions {
  /** How long the user has to finish in the browser. */
  timeoutMs?: number;
  /** How long the token endpoint has to answer. */
  exchangeTimeoutMs?: number;
}

export type SignInOutcome = { ok: true; tokens: TokenSet } | { ok: false; error: SignInError };

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

function page(res: ServerResponse, status: number, title: string, line: string): void {
  const html = `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title>`
    + `<body style="font:16px system-ui,sans-serif;margin:3rem;max-width:34rem"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(line)}</p></body>`;
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': String(Buffer.byteLength(html)),
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    connection: 'close'
  });
  res.end(html);
}

/** True unless the browser says this request is not a top-level navigation. Old
 *  browsers send no Sec-Fetch headers; every current one does. */
function isNavigation(req: IncomingMessage): boolean {
  const mode = req.headers['sec-fetch-mode'];
  const dest = req.headers['sec-fetch-dest'];
  if (mode !== undefined && mode !== 'navigate') return false;
  if (dest !== undefined && dest !== 'document') return false;
  return true;
}

export class SignInSession {
  private server?: Server;
  private settled = false;
  private resolveOutcome!: (o: SignInOutcome) => void;
  private timer?: NodeJS.Timeout;
  private verifier?: string;
  private readonly state: string;
  private consumed = false;
  private badHits = 0;
  private cancelled = false;
  private readonly exchangeAbort = new AbortController();
  private started = false;
  readonly redirectUri: string;

  constructor(private readonly req: SignInRequest, private readonly deps: FlowDeps, private readonly opts: FlowOptions = {}) {
    this.redirectUri = mcpRedirectUri(req.callbackPort);
    this.state = newState(deps.random);
  }

  /** Run the sign-in. Resolves exactly once; never rejects, never throws. */
  start(): Promise<SignInOutcome> {
    return new Promise<SignInOutcome>((resolve) => {
      this.resolveOutcome = resolve;
      if (this.started) { resolve({ ok: false, error: 'failed' }); return; }
      this.started = true;

      let authUrl: string;
      try {
        validateOauthSpec(this.req.spec, this.deps.policy);
        const verifier = newCodeVerifier(this.deps.random);
        const challenge = challengeS256(verifier);
        // Check our own pair the way a provider will, before anything leaves the machine.
        if (!verifyS256(verifier, challenge)) throw new Error('pkce self-check');
        this.verifier = verifier;
        authUrl = this.authorizationUrl(challenge);
      } catch {
        this.settle({ ok: false, error: 'failed' });
        return;
      }

      const server = createServer((rq, rs) => this.onRequest(rq, rs));
      this.server = server;
      server.requestTimeout = 30_000;
      server.headersTimeout = 10_000;
      server.on('clientError', (_e, socket) => { try { socket.destroy(); } catch { /* noop */ } });
      server.once('error', (e: NodeJS.ErrnoException) => {
        this.settle({ ok: false, error: e.code === 'EADDRINUSE' ? 'port-busy' : 'failed' });
      });
      server.listen({ port: this.req.callbackPort, host: MCP_CALLBACK_HOST, exclusive: true }, () => {
        // Cancelled (Disconnect, quit) in the moment before the port was bound: the
        // sign-in is already over, so no browser may be opened for it.
        if (this.settled) { try { server.close(); } catch { /* noop */ } return; }
        // From here the runtime errors are not listen errors; they just end the sign-in.
        server.removeAllListeners('error');
        server.on('error', () => this.settle({ ok: false, error: 'failed' }));
        this.timer = setTimeout(() => this.settle({ ok: false, error: 'timeout' }), this.opts.timeoutMs ?? 5 * 60_000);
        this.timer.unref();
        this.deps.log({ event: 'signin.waiting', id: this.req.integrationId, port: this.req.callbackPort });
        // `openUrl` may throw as well as reject; neither may escape into the main process.
        Promise.resolve().then(() => this.deps.openUrl(authUrl)).catch(() => this.settle({ ok: false, error: 'no-browser' }));
      });
    });
  }

  /** Stop waiting (Disconnect, quit). Anything already received is thrown away. */
  cancel(): void {
    this.cancelled = true;
    this.exchangeAbort.abort();
    this.settle({ ok: false, error: 'cancelled' });
  }

  get waiting(): boolean { return this.started && !this.settled; }

  // ─── the authorization request ───────────────────────────────────────────

  private authorizationUrl(challenge: string): string {
    const { spec, client } = this.req;
    const u = new URL(spec.authorizationEndpoint);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', client.clientId);
    u.searchParams.set('redirect_uri', this.redirectUri);
    u.searchParams.set('state', this.state);
    u.searchParams.set('code_challenge', challenge);
    u.searchParams.set('code_challenge_method', 'S256');
    const scope = this.req.scope ?? spec.scope;
    if (scope) u.searchParams.set('scope', scope);
    for (const [k, v] of Object.entries(spec.authorizeParams ?? {})) u.searchParams.set(k, v);
    return u.toString();
  }

  // ─── the redirect ────────────────────────────────────────────────────────

  private onRequest(req: IncomingMessage, res: ServerResponse): void {
    const ignore = (status: number, reason: string): void => {
      this.badHits++;
      if (this.badHits <= 10 || this.badHits % 100 === 0) {
        this.deps.log({ event: 'signin.callback.ignored', id: this.req.integrationId, reason, hits: this.badHits });
      }
      page(res, status, 'Not a sign-in link', 'This address is not a sign-in the app is waiting for.');
    };
    if (this.settled) return ignore(410, 'finished');
    if (req.method !== 'GET') return ignore(405, 'method');
    if (req.headers.host !== `${MCP_CALLBACK_HOST}:${this.req.callbackPort}`) return ignore(400, 'host');
    const raw = req.url ?? '';
    if (raw.length > MAX_URL) return ignore(414, 'too-long');
    // The path is compared as the browser SENT it. `new URL` would quietly resolve
    // `/oauth/../oauth/callback` and `/oauth//callback` into the real path; a redirect
    // from the provider is always exactly the registered address, so anything else is not one.
    if (raw.split('?', 1)[0] !== CALLBACK_PATH) return ignore(404, 'path');
    let url: URL;
    try { url = new URL(raw, `http://${MCP_CALLBACK_HOST}:${this.req.callbackPort}`); } catch { return ignore(400, 'url'); }
    if (!isNavigation(req)) return ignore(400, 'not-navigation');

    const q = url.searchParams;
    for (const k of ['state', 'code', 'error', 'iss']) if (q.getAll(k).length > 1) return ignore(400, 'duplicate-param');
    for (const v of q.values()) if (v.length > MAX_PARAM) return ignore(400, 'param-too-long');

    const state = q.get('state');
    if (!state || !constantTimeEqual(state, this.state)) return ignore(400, 'state');
    if (this.consumed) return ignore(400, 'replayed');
    this.consumed = true;                 // single use, whatever follows
    void this.onValidRedirect(q, res);
  }

  private async onValidRedirect(q: URLSearchParams, res: ServerResponse): Promise<void> {
    const end = (error: SignInError): void => {
      page(res, 400, 'Sign-in did not complete', 'Return to the app and try again.');
      this.settle({ ok: false, error });
    };

    const providerError = q.get('error');
    if (providerError !== null) return end(providerError === 'access_denied' ? 'denied' : 'provider-error');

    const iss = q.get('iss');
    const wantIss = this.req.spec.issuer;
    if (iss !== null ? !constantTimeEqual(iss, wantIss) : this.req.spec.issParameter === 'required') {
      this.deps.log({ event: 'signin.callback.rejected', id: this.req.integrationId, reason: iss === null ? 'iss-missing' : 'iss-mismatch' });
      return end('invalid-callback');
    }

    const code = q.get('code');
    if (!code || !CODE_RE.test(code)) return end('invalid-callback');
    const fp = fingerprint(code);
    if (this.deps.usedCodes.has(fp)) {
      this.deps.log({ event: 'signin.callback.rejected', id: this.req.integrationId, reason: 'code-replayed' });
      return end('invalid-callback');
    }
    this.deps.usedCodes.add(fp);
    if (this.deps.usedCodes.size > USED_CODES_KEPT) {
      const oldest = this.deps.usedCodes.values().next().value;
      if (oldest !== undefined) this.deps.usedCodes.delete(oldest);
    }

    const outcome = await this.exchange(code);
    if (this.cancelled) return end('cancelled');
    if (!outcome.ok) return end(outcome.error);
    page(res, 200, 'Signed in', `${this.req.label} is connected. You can close this tab and go back to the app.`);
    this.settle(outcome);
  }

  // ─── the exchange ────────────────────────────────────────────────────────

  /** One attempt, with this code, ever. A failure ends the sign-in; it is never retried. */
  private async exchange(code: string): Promise<SignInOutcome> {
    const { spec, client } = this.req;
    const verifier = this.verifier;
    if (!verifier) return { ok: false, error: 'cancelled' };
    const r = await send(this.deps.fetch, spec.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: formBody({
        grant_type: 'authorization_code', code, redirect_uri: this.redirectUri,
        client_id: client.clientId, ...(client.clientSecret ? { client_secret: client.clientSecret } : {}), code_verifier: verifier,
        ...(spec.resource ? { resource: spec.resource } : {})
      })
    }, { timeoutMs: this.opts.exchangeTimeoutMs ?? 20_000, signal: this.exchangeAbort.signal });
    if (r.kind === 'network') {
      this.deps.log({ event: 'signin.exchange', id: this.req.integrationId, outcome: 'network' });
      return { ok: false, error: 'unavailable' };
    }
    const parsed = parseTokenResponse(r.status, r.text, spec, this.deps.now());
    this.deps.log({
      event: 'signin.exchange', id: this.req.integrationId, outcome: parsed.kind,
      ...(parsed.kind === 'permanent' || parsed.kind === 'rejected' ? { code: parsed.code } : {}),
      ...(parsed.kind === 'tokens' ? { refreshToken: parsed.tokens.refreshToken !== undefined, expires: parsed.tokens.expiresAt !== undefined } : {})
    });
    switch (parsed.kind) {
      case 'tokens': return { ok: true, tokens: parsed.tokens };
      case 'permanent': case 'rejected': return { ok: false, error: 'exchange-failed' };
      case 'transient': return { ok: false, error: 'unavailable' };
      default: return { ok: false, error: 'bad-token-response' };
    }
  }

  // ─── the end ─────────────────────────────────────────────────────────────

  private settle(outcome: SignInOutcome): void {
    if (this.settled) return;
    this.settled = true;
    if (this.timer) clearTimeout(this.timer);
    this.verifier = undefined;                       // the verifier lives exactly as long as the sign-in
    const server = this.server;
    if (server) {
      try { server.close(); } catch { /* not listening */ }
      try { server.closeIdleConnections(); } catch { /* noop */ }
      // let a page that is still being written finish, then drop whatever is left
      setTimeout(() => { try { server.closeAllConnections(); } catch { /* noop */ } }, 1500).unref();
    }
    this.deps.log({ event: 'signin.end', id: this.req.integrationId, ok: outcome.ok, ...(outcome.ok ? {} : { error: outcome.error }) });
    this.resolveOutcome(outcome);
  }
}
