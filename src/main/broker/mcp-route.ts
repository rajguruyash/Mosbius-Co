/**
 * The MCP route: `POST | GET | DELETE /m/<integrationId>` (Streamable HTTP).
 *
 * It is registered by `IntegrationBroker` only when the caller supplies
 * `extras.mcp`. The app does so for an integration whose engine is `broker`; for
 * every other integration `resolve` answers nothing and this route is a 404.
 *
 * What it enforces, per request:
 *   • before anyone is authenticated: method, no `Origin` / `Sec-Fetch-*` header
 *     (a browser sent this), and `Host` must be exactly this broker's own address
 *     (DNS-rebinding guard);
 *   • an MCP-channel capability that lists this integration;
 *   • the integration exists and is enabled, and the agent has a GRANT for it
 *     (no grant, no access — see permissions.ts);
 *   • every JSON-RPC message in the body is checked against the grant. A batch is
 *     all-or-nothing: one denied message refuses the lot;
 *   • `tools/list` answers contain only the tools the grant allows, whether the
 *     server answered with JSON or with an event stream (an answer that cannot be
 *     read is refused, never passed on unfiltered);
 *   • the upstream URL is fixed by the integration, never chosen by the agent, and
 *     redirects are not followed;
 *   • only an allow-list of headers crosses in either direction. The agent's own
 *     Authorization never goes upstream; `WWW-Authenticate` never comes back, so
 *     the agent's CLI is never prompted to start an OAuth flow of its own;
 *   • an upstream session id belongs to the agent that opened it;
 *   • how fast and how many: a token bucket per agent and integration, a cap on
 *     requests and open streams in flight, and a global cap.
 *
 * The credential comes from a CredentialProvider; this file never sees where
 * it is kept and never logs, echoes or stores what it returns. When the upstream
 * refuses it (401) and the provider can get a newer one, the request is replayed
 * ONCE; if that is refused too, the agent is told to sign in again.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CapabilityRegistry } from './capabilities';
import type { BrokerRoute, Rejection, RouteContext } from './core';
import type { CredentialFailure, CredentialProvider } from './credentials';
import { BodyTooLarge, pipeWebStream, readBodyCapped, sendError } from './http-util';
import {
  RPC_NOT_PERMITTED, filterToolsResult, isRequest, parseRpcBody, rpcError,
  type ParsedBody, type RpcMessage
} from './jsonrpc';
import {
  classifyTool, effectiveGrant, methodVerdict, toolAllowed,
  type ClassificationPolicy, type IntegrationGrant, type McpGrants, type ToolClass, type ToolInfo
} from './permissions';
import { RateLimiter } from './ratelimit';
import { findRpcResponse, parseSse, sseMessage } from './sse';

export const MCP_MAX_BODY_BYTES = 10 * 1024 * 1024;
const USER_AGENT = 'mosbius-co-broker/1';
/** Request headers an agent may pass upstream. Nothing else crosses. */
const FORWARD_REQUEST_HEADERS = ['content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id'];
/** Response headers that come back to the agent. Nothing else does. */
const RETURN_RESPONSE_HEADERS = new Set(['content-type', 'mcp-session-id', 'mcp-protocol-version', 'cache-control']);
/** The protocol revision the broker itself speaks when it lists tools for the Settings panel. */
const DISCOVERY_PROTOCOL = '2025-06-18';
/** The identity under which the broker itself (never an agent) talks to a server the app runs. */
export const DISCOVERY_AGENT = '@broker';

export interface McpLimits {
  /** Time allowed for the upstream to start answering. */
  headersMs: number;
  /** A stream that goes this long without a chunk is cut. */
  idleMs: number;
  /** A stream is cut after this long however busy it is (clients resume). */
  maxStreamMs: number;
  /** Requests (including open streams) one capability may run at once. */
  maxInflight: number;
  /** Largest `tools/list` answer that will be read and filtered. */
  maxListingBytes: number;
  /** Time a `tools/list` answer has to arrive in full once its headers are in. */
  listingMs: number;
  /** Upstream sessions remembered at once. */
  maxSessions: number;
  /** Sustained requests per second, and the burst, for one agent on one integration. */
  ratePerSec: number;
  burst: number;
  /** Event streams (GET) one agent may hold open on one integration. */
  maxStreams: number;
  /** Requests the whole broker runs at once, whichever agent they are for. */
  maxGlobalInflight: number;
  /** Time a best-effort `DELETE` of an upstream session has. */
  sessionDeleteMs: number;
  /** Time the whole of a tool discovery (initialize, list, close) has. */
  discoveryMs: number;
}
export const DEFAULT_MCP_LIMITS: McpLimits = {
  headersMs: 30_000, idleMs: 5 * 60_000, maxStreamMs: 30 * 60_000,
  maxInflight: 8, maxListingBytes: 5 * 1024 * 1024, listingMs: 30_000, maxSessions: 1000,
  ratePerSec: 10, burst: 30, maxStreams: 4, maxGlobalInflight: 100,
  sessionDeleteMs: 3_000, discoveryMs: 20_000
};

export interface McpIntegration {
  id: string;
  /** The one upstream endpoint. Fixed here; the agent never supplies a host or a path. */
  url: string;
  enabled: boolean;
  classification?: ClassificationPolicy;
  maxBodyBytes?: number;
  /**
   * The server is run BY THE APP (src/main/broker/stdio-host.ts), not reached over the network:
   * `url` is then only a name, requests go to `deps.hosted`, and there is no upstream session id.
   */
  hosted?: boolean;
  /** Time the upstream has to start answering, when it is not the route's default (a local tool may be slow). */
  headersMs?: number;
}

/** A way to run a request against a server the app itself runs, one per agent. */
export interface HostedUpstream {
  /** One POST body (a JSON-RPC message or batch) for `agentId`'s own copy of the server. */
  handle(integrationId: string, agentId: string, body: string, signal: AbortSignal): Promise<{ status: number; body?: string }>;
  /** Stop `agentId`'s copy of one server, or all of its servers. */
  close(agentId: string, integrationId?: string): void;
}

export interface McpAuditEvent {
  at: number;
  agentId: string;
  integrationId: string;
  method?: string;
  tool?: string;
  decision: 'allow' | 'deny';
  reason?: string;
}

export interface McpRouteDeps {
  resolve(id: string): McpIntegration | undefined;
  credentials: CredentialProvider<McpIntegration>;
  /** The live grants (read on every request, so an edit applies at once). */
  grants(): McpGrants | undefined;
  now?(): number;
  /** Metadata only: never bodies, params, headers or credentials. */
  audit?(event: McpAuditEvent): void;
  limits?: Partial<McpLimits>;
  /** Runs the integrations marked `hosted`. When a capability is revoked, the servers it
   *  reached are stopped here at once, so a revoked agent's work does not keep running. */
  hosted?: HostedUpstream;
}

export interface McpMatch { id: string | null }

/** What the Settings panel is shown for one tool: a name, a class and a description, nothing else. */
export interface McpToolView { name: string; description: string; class: ToolClass }

export type DiscoverResult =
  | { ok: true; tools: McpToolView[] }
  | { ok: false; code: 'unknown' | 'disabled' | 'sign_in_required' | 'unavailable' | 'upstream' };

interface Verdict { allow: boolean; reason?: string; method?: string; tool?: string }

const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)) });
  res.end(text);
};

const sendTooMany = (res: ServerResponse, code: string, message: string, retryAfterMs?: number): void => {
  if (res.headersSent) { try { res.end(); } catch { /* socket gone */ } return; }
  res.writeHead(429, {
    'content-type': 'application/json',
    ...(retryAfterMs !== undefined ? { 'retry-after': String(Math.max(1, Math.ceil(retryAfterMs / 1000))) } : {})
  });
  res.end(JSON.stringify({ error: message, code }));
};

const oneHeader = (v: string | string[] | undefined): string | undefined =>
  typeof v === 'string' && v ? v : undefined;

/**
 * Is this request from a web page rather than from an agent's CLI? The broker refuses pages: a page can reach a loopback
 * port, and although it cannot know a pass, a guard that does not depend on that is cheaper than a mistake.
 *
 * What a page cannot hide: a browser sends `Origin` on every cross-origin POST, and sends the whole Fetch Metadata set
 * (`Sec-Fetch-Site`, `-Mode`, `-Dest`, and `-User` for a navigation) to a loopback address, which it counts as
 * trustworthy. Those names are forbidden header names: a page cannot set, change or drop one.
 *
 * What a CLI sends: nothing of that, with ONE measured exception. Node's built-in `fetch` (Node 22 and 26 both) adds
 * `Sec-Fetch-Mode: cors` to every request and nothing else of the set, and the real Gemini CLI is built on it: the first
 * version of this guard refused every request it made. So `Sec-Fetch-Mode: cors` ALONE (no `Origin`, no `Sec-Fetch-Site`,
 * `-Dest` or `-User`) is the signature of a program, not a page, because a page's request always carries `Sec-Fetch-Site`
 * with it. Any other mode, and any of the other names, is still refused.
 */
export function looksLikeBrowser(h: IncomingMessage['headers']): boolean {
  if (h.origin !== undefined) return true;
  if (h['sec-fetch-site'] !== undefined || h['sec-fetch-dest'] !== undefined || h['sec-fetch-user'] !== undefined) return true;
  const mode = h['sec-fetch-mode'];
  return mode !== undefined && mode !== 'cors';
}

/** Strip control characters and cap the length of anything an agent chose that gets logged. */
const loggable = (s: string): string => s.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 128);

/** The credential headers, lower-cased, so two results can be compared. */
const lowerKeys = (h: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));

const sameCredential = (a: Record<string, string>, b: Record<string, string>): boolean => {
  const x = lowerKeys(a);
  const y = lowerKeys(b);
  const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
  for (const k of keys) if (x[k] !== y[k]) return false;
  return true;
};

type Fetched =
  | { kind: 'response'; up: Response; creds: Record<string, string> }
  | { kind: 'network' }
  | { kind: 'credential'; code: CredentialFailure }
  | { kind: 'unauthorized' };

export class McpRoute implements BrokerRoute<McpMatch> {
  readonly channel = 'mcp' as const;
  private readonly limits: McpLimits;
  private readonly limiter: RateLimiter;
  /** upstream session id → the agent and integration that opened it */
  private readonly sessions = new Map<string, { agentId: string; integrationId: string }>();
  /** integration id → every tool seen listed, unfiltered (needed to class a `tools/call`) */
  private readonly toolIndex = new Map<string, Map<string, ToolInfo>>();
  private readonly inflight = new Map<string, number>();
  private readonly streams = new Map<string, number>();
  private globalInflight = 0;
  private readonly discovering = new Map<string, Promise<DiscoverResult>>();

  constructor(private readonly deps: McpRouteDeps, registry: CapabilityRegistry) {
    this.limits = { ...DEFAULT_MCP_LIMITS, ...deps.limits };
    this.limiter = new RateLimiter(this.limits.ratePerSec, this.limits.burst, () => (this.deps.now ?? Date.now)());
    registry.onRevoke((cap, reason, integrationId) => {
      if (cap.channel !== 'mcp') return;
      const closing = (reason === 'revoked' || reason === 'replaced') ? this.sessionsOf(cap.agentId, integrationId) : [];
      this.dropSessions(cap.agentId, integrationId);
      if (reason !== 'integration') this.limiter.forgetPrefix(`${cap.id}|`);
      // An agent that ended (or was respawned) leaves no upstream session open behind it.
      for (const [sid, integId] of closing) void this.closeUpstreamSession(integId, sid);
      // A server the app runs for this agent stops NOW (and takes whatever it started with it).
      // What it had already sent to the outside world cannot be recalled; nothing new will be.
      if (this.deps.hosted) this.deps.hosted.close(cap.agentId, reason === 'integration' ? integrationId : undefined);
    });
  }

  match(req: IncomingMessage): McpMatch | null {
    const path = (req.url ?? '').split('?')[0];
    if (path !== '/m' && !path.startsWith('/m/')) return null;
    const m = /^\/m\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})$/.exec(path);
    return { id: m ? m[1] : null };
  }

  preflight(req: IncomingMessage, info: { port: number }): Rejection | null {
    const method = (req.method ?? '').toUpperCase();
    if (method !== 'POST' && method !== 'GET' && method !== 'DELETE') {
      return { status: 405, code: 'method_not_allowed', message: 'method not allowed' };
    }
    if (looksLikeBrowser(req.headers)) {
      return { status: 403, code: 'forbidden', message: 'browser requests are not allowed' };
    }
    if (req.headers.host !== `127.0.0.1:${info.port}`) {
      return { status: 421, code: 'misdirected', message: 'unexpected host' };
    }
    return null;
  }

  async handle(ctx: RouteContext<McpMatch>): Promise<void> {
    const { req, res, cap } = ctx;
    const id = ctx.match.id;
    if (id === null) return sendError(res, 404, 'not_found', 'expected /m/<integrationId>');
    if (!cap.allowedIds.has(id)) return sendError(res, 403, 'forbidden', 'integration not in this agent capability');
    ctx.bindIntegration(id);

    const integ = this.deps.resolve(id);
    if (!integ) return sendError(res, 404, 'not_found', 'unknown integration');
    if (!integ.enabled) return sendError(res, 403, 'forbidden', 'integration is disabled');

    const grant = effectiveGrant(this.deps.grants(), cap.agentId, id, (this.deps.now ?? Date.now)());
    if (grant.preset === 'none') {
      this.audit({ agentId: cap.agentId, integrationId: id, decision: 'deny', reason: 'no access granted' });
      return sendError(res, 403, 'forbidden', 'no access has been granted to this agent');
    }

    const method = (req.method ?? 'GET').toUpperCase();
    const sessionId = oneHeader(req.headers['mcp-session-id']);
    if (sessionId !== undefined && !this.ownsSession(cap.agentId, id, sessionId)) {
      return sendError(res, 404, 'session_not_found', 'unknown session');
    }

    // How many, then how fast. A refusal here costs the upstream nothing.
    const running = this.inflight.get(cap.id) ?? 0;
    if (running >= this.limits.maxInflight) return sendTooMany(res, 'too_many_requests', 'too many concurrent requests');
    if (this.globalInflight >= this.limits.maxGlobalInflight) return sendTooMany(res, 'too_many_requests', 'the broker is busy');
    const streamKey = `${cap.id}|${id}`;
    if (method === 'GET' && (this.streams.get(streamKey) ?? 0) >= this.limits.maxStreams) {
      return sendTooMany(res, 'too_many_streams', 'too many open streams');
    }
    const turn = this.limiter.take(streamKey);
    if (!turn.ok) return sendTooMany(res, 'rate_limited', 'too many requests, slow down', turn.retryAfterMs);

    this.inflight.set(cap.id, running + 1);
    this.globalInflight++;
    if (method === 'GET') this.streams.set(streamKey, (this.streams.get(streamKey) ?? 0) + 1);
    try {
      const creds = await this.deps.credentials.accessHeaders(integ);
      if (!creds.ok) return this.credentialFailure(res, creds.code);
      if (method === 'POST') return await this.post(ctx, integ, grant, creds.headers);
      return await this.forward(ctx, integ, { method, body: undefined, headers: creds.headers, requestId: undefined, initialize: false, sessionId });
    } finally {
      const left = (this.inflight.get(cap.id) ?? 1) - 1;
      if (left <= 0) this.inflight.delete(cap.id); else this.inflight.set(cap.id, left);
      this.globalInflight = Math.max(0, this.globalInflight - 1);
      if (method === 'GET') {
        const open = (this.streams.get(streamKey) ?? 1) - 1;
        if (open <= 0) this.streams.delete(streamKey); else this.streams.set(streamKey, open);
      }
    }
  }

  // ─── POST ────────────────────────────────────────────────────────────────

  private async post(ctx: RouteContext<McpMatch>, integ: McpIntegration, grant: IntegrationGrant, creds: Record<string, string>): Promise<void> {
    const { req, res, cap } = ctx;
    let body: Buffer;
    try {
      body = await readBodyCapped(req, integ.maxBodyBytes ?? MCP_MAX_BODY_BYTES);
    } catch (e) {
      if (e instanceof BodyTooLarge) return sendError(res, 413, 'payload_too_large', 'request body too large');
      return sendError(res, 400, 'bad_request', 'could not read request body');
    }
    const parsed = parseRpcBody(body);
    if (!parsed.ok) return sendJson(res, 400, rpcError(null, parsed.code, parsed.message));

    const index = this.toolIndex.get(integ.id);
    const verdicts = parsed.messages.map((m) => this.decide(m, grant, integ, index));
    // A tool list can only be filtered when it is the one thing asked for. Inside a batch its answer
    // would be forwarded whole, so a batch that asks for one is refused (and, like any batch, all of it).
    if (parsed.batch) {
      parsed.messages.forEach((m, i) => {
        if (m.method === 'tools/list' && verdicts[i].allow) verdicts[i] = { allow: false, reason: 'tools/list cannot be part of a batch', method: 'tools/list' };
      });
    }
    verdicts.forEach((v) => this.audit({
      agentId: cap.agentId, integrationId: integ.id, method: v.method, tool: v.tool,
      decision: v.allow ? 'allow' : 'deny', reason: v.reason
    }));
    if (verdicts.some((v) => !v.allow)) return this.respondDenied(res, parsed, verdicts);

    const only = parsed.messages.length === 1 ? parsed.messages[0] : undefined;
    const listingId = only?.method === 'tools/list' && (typeof only.id === 'string' || typeof only.id === 'number') ? only.id : undefined;
    return this.forward(ctx, integ, {
      method: 'POST', body, headers: creds,
      // a `tools/list` is read whole and filtered; its id is how the answer is found in a stream
      requestId: only?.method === 'tools/list' ? (listingId ?? null) : undefined,
      grant,
      initialize: parsed.messages.some((m) => m.method === 'initialize'),
      sessionId: oneHeader(req.headers['mcp-session-id'])
    });
  }

  private decide(m: RpcMessage, grant: IntegrationGrant, integ: McpIntegration, index: Map<string, ToolInfo> | undefined): Verdict {
    const base = { method: m.method !== undefined ? loggable(m.method) : undefined };
    const v = methodVerdict(m.method, grant);
    if (!v.allow) return { allow: false, reason: v.reason, ...base };
    if (v.kind !== 'tools/call') return { allow: true, ...base };

    const name = (m.params && typeof m.params === 'object') ? (m.params as { name?: unknown }).name : undefined;
    if (typeof name !== 'string' || !name || name.length > 256) return { allow: false, reason: 'invalid tool call', ...base };
    const info = index?.get(name);
    const cls = info ? classifyTool(info, integ.classification) : undefined;
    if (!toolAllowed(grant, name, cls)) {
      return { allow: false, reason: info ? 'tool not granted' : 'tool not known; list tools first', tool: loggable(name), ...base };
    }
    return { allow: true, tool: loggable(name), ...base };
  }

  /** Refuse the whole body. Every request in it gets an answer; notifications get none. */
  private respondDenied(res: ServerResponse, parsed: Extract<ParsedBody, { ok: true }>, verdicts: Verdict[]): void {
    const answers: RpcMessage[] = [];
    parsed.messages.forEach((m, i) => {
      if (!isRequest(m)) return;
      const v = verdicts[i];
      const text = v.allow
        ? 'Not permitted: refused together with another request in the same batch'
        : v.tool !== undefined
          ? `Not permitted: "${v.tool}" is not granted to this agent (${v.reason})`
          : `Not permitted: ${v.reason}`;
      answers.push(rpcError(m.id, RPC_NOT_PERMITTED, text));
    });
    if (answers.length === 0) { res.writeHead(202); res.end(); return; }
    sendJson(res, 200, parsed.batch ? answers : answers[0]);
  }

  // ─── forwarding ──────────────────────────────────────────────────────────

  /**
   * Send one request upstream with the integration's credential. If the upstream
   * answers 401 and the provider can mint a newer credential, ask once more with it;
   * a second 401 (or a provider with nothing newer) is the end of it.
   */
  private async fetchUpstream(
    integ: McpIntegration, creds: Record<string, string>,
    req: { method: string; body: Buffer | undefined; base: Record<string, string> },
    ac: AbortController, headersMs: number, agentId: string
  ): Promise<Fetched> {
    const provider = this.deps.credentials;
    let current = creds;
    for (let attempt = 0; ; attempt++) {
      const headers: Record<string, string> = { ...req.base };
      for (const [k, v] of Object.entries(current)) headers[k.toLowerCase()] = v;   // the broker's credential always wins
      const timer = setTimeout(() => ac.abort(), integ.headersMs ?? headersMs);
      let up: Response;
      try {
        if (integ.hosted) {
          // A server the app runs itself: no network, no session id, no 401 to recover from.
          if (!this.deps.hosted) return { kind: 'network' };
          if (req.method === 'POST') {
            const out = await this.deps.hosted.handle(integ.id, agentId, req.body ? req.body.toString('utf8') : '', ac.signal);
            up = new Response(out.body ?? null, { status: out.status, headers: out.body ? { 'content-type': 'application/json' } : {} });
          } else if (req.method === 'DELETE') {
            this.deps.hosted.close(agentId, integ.id);
            up = new Response(null, { status: 200 });
          } else {
            up = new Response(null, { status: 405 });      // no server-initiated stream: the spec's "not offered"
          }
          return { kind: 'response', up, creds: current };
        }
        up = await fetch(integ.url, { method: req.method, headers, body: req.body as BodyInit | undefined, redirect: 'manual', signal: ac.signal });
      } catch {
        return { kind: 'network' };
      } finally {
        clearTimeout(timer);
      }
      if (up.status !== 401 || !provider.rejected) return { kind: 'response', up, creds: current };

      try { await up.body?.cancel(); } catch { /* noop */ }
      if (attempt > 0) return { kind: 'unauthorized' };
      try { provider.rejected(integ, current); } catch { /* a provider must not break the request */ }
      const again = await provider.accessHeaders(integ);
      if (!again.ok) return { kind: 'credential', code: again.code };
      if (sameCredential(again.headers, current)) return { kind: 'unauthorized' };      // nothing newer to try
      current = again.headers;
    }
  }

  private async forward(
    ctx: RouteContext<McpMatch>, integ: McpIntegration,
    o: { method: string; body: Buffer | undefined; headers: Record<string, string>; requestId: string | number | null | undefined; grant?: IntegrationGrant; initialize: boolean; sessionId: string | undefined }
  ): Promise<void> {
    const { req, res, cap } = ctx;
    const base: Record<string, string> = { 'user-agent': USER_AGENT };
    for (const h of FORWARD_REQUEST_HEADERS) {
      const v = oneHeader(req.headers[h]);
      if (v) base[h] = v;
    }

    const ac = new AbortController();
    const onAbort = (): void => ac.abort();
    if (ctx.signal.aborted) ac.abort(); else ctx.signal.addEventListener('abort', onAbort, { once: true });
    try {
      const got = await this.fetchUpstream(integ, o.headers, { method: o.method, body: o.body, base }, ac, this.limits.headersMs, cap.agentId);
      if (got.kind === 'network') return sendError(res, 502, 'bad_gateway', 'upstream request failed');
      if (got.kind === 'credential') return this.credentialFailure(res, got.code);
      if (got.kind === 'unauthorized') return this.credentialFailure(res, 'sign_in_required');
      const up = got.up;

      if (up.status >= 300 && up.status < 400) {
        try { await up.body?.cancel(); } catch { /* noop */ }
        return sendError(res, 502, 'bad_gateway', 'upstream redirect refused');
      }
      const contentType = (up.headers.get('content-type') ?? '').toLowerCase();

      if (o.requestId !== undefined) {
        return await this.respondListing(res, up, integ, o.grant ?? { preset: 'none' }, o.requestId, contentType.startsWith('text/event-stream'));
      }

      const sessionHeader = up.headers.get('mcp-session-id');
      if (o.initialize && sessionHeader && up.ok) this.bindSession(cap.agentId, integ.id, sessionHeader);
      if (o.method === 'DELETE' && o.sessionId && (up.ok || up.status === 404)) this.sessions.delete(o.sessionId);

      const back: Record<string, string> = {};
      up.headers.forEach((value, key) => { if (RETURN_RESPONSE_HEADERS.has(key.toLowerCase())) back[key] = value; });
      res.writeHead(up.status, back);
      // An event stream may sit silent for a while after its headers; the client has to
      // see those headers now, not with the first event.
      res.flushHeaders();
      try {
        if (up.body) await pipeWebStream(up.body, res, ac.signal, { idleMs: this.limits.idleMs, maxMs: this.limits.maxStreamMs });
        else res.end();
      } catch {
        try { res.end(); } catch { /* socket gone */ }
      }
    } finally {
      ctx.signal.removeEventListener('abort', onAbort);
    }
  }

  /**
   * A `tools/list` answer: read it whole (within a size and a time limit), remember
   * every tool, and send back only the allowed ones, in the form the server used. An
   * answer that cannot be read, or that is not an answer to THIS request, is refused:
   * nothing is passed on unfiltered.
   */
  private async respondListing(
    res: ServerResponse, up: Response, integ: McpIntegration, grant: IntegrationGrant,
    requestId: string | number | null, streamed: boolean
  ): Promise<void> {
    let text: string;
    try {
      text = await readLimited(up, this.limits.maxListingBytes, this.limits.listingMs);
    } catch {
      return sendError(res, 502, 'bad_gateway', 'tool list unreadable');
    }

    let msg: unknown;
    if (streamed) {
      if (requestId === null) return sendError(res, 502, 'bad_gateway', 'tool list unreadable');
      msg = findRpcResponse(parseSse(text), requestId);
    } else {
      try { msg = JSON.parse(text); } catch { return sendError(res, 502, 'bad_gateway', 'tool list unreadable'); }
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return sendError(res, 502, 'bad_gateway', 'tool list unreadable');
    const rpc = msg as RpcMessage;

    const headers: Record<string, string> = { 'content-type': streamed ? 'text/event-stream' : 'application/json' };
    if (streamed) headers['cache-control'] = 'no-cache';
    const sid = up.headers.get('mcp-session-id');
    if (sid) headers['mcp-session-id'] = sid;
    const send = (status: number, value: unknown): void => {
      const body = streamed ? sseMessage(value) : JSON.stringify(value);
      res.writeHead(status, { ...headers, 'content-length': String(Buffer.byteLength(body)) });
      res.end(body);
    };

    // An error answer carries no tools: pass it on as it is.
    if (rpc.error !== undefined || !up.ok) return send(up.status, msg);

    this.learn(integ.id, (rpc.result && typeof rpc.result === 'object') ? (rpc.result as { tools?: unknown }).tools : undefined);
    const filtered = filterToolsResult(rpc.result, (tool) => toolAllowed(grant, tool.name, classifyTool(tool as ToolInfo, integ.classification)));
    send(up.status, { ...rpc, result: filtered });
  }

  // ─── the tool index, and tool discovery for the Settings panel ───────────

  /** Remember tools an upstream listed, unfiltered. Anything that is not a named tool is skipped. */
  private learn(integrationId: string, tools: unknown, replace = false): void {
    if (!Array.isArray(tools)) return;
    let known = this.toolIndex.get(integrationId);
    if (!known || replace) { known = new Map(); this.toolIndex.set(integrationId, known); }
    for (const t of tools) {
      if (t && typeof t === 'object' && typeof (t as { name?: unknown }).name === 'string' && (t as { name: string }).name.length <= 256) {
        known.set((t as ToolInfo).name, t as ToolInfo);
      }
    }
  }

  /** The tools seen so far for an integration, as the Settings panel may show them. */
  toolsOf(integrationId: string): McpToolView[] {
    const integ = this.deps.resolve(integrationId);
    const known = this.toolIndex.get(integrationId);
    if (!integ || !known) return [];
    return [...known.values()]
      .map((t) => ({
        name: t.name,
        description: describe((t as { description?: unknown }).description),
        class: classifyTool(t, integ.classification)
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Forget what was learnt about an integration (it was disconnected). */
  forgetTools(integrationId: string): void { this.toolIndex.delete(integrationId); }

  /**
   * Ask the integration's server for its tool list, as the broker (never as an
   * agent), so the Settings panel can show a checklist before any agent has run.
   * One at a time per integration; the upstream is the integration's fixed URL; the
   * credential never leaves this process.
   */
  discover(integrationId: string): Promise<DiscoverResult> {
    const running = this.discovering.get(integrationId);
    if (running) return running;
    const p: Promise<DiscoverResult> = this.runDiscovery(integrationId)
      .catch((): DiscoverResult => ({ ok: false, code: 'upstream' }))
      .finally(() => { this.discovering.delete(integrationId); });
    this.discovering.set(integrationId, p);
    return p;
  }

  private async runDiscovery(integrationId: string): Promise<DiscoverResult> {
    const integ = this.deps.resolve(integrationId);
    if (!integ) return { ok: false, code: 'unknown' };
    if (!integ.enabled) return { ok: false, code: 'disabled' };
    const creds = await this.deps.credentials.accessHeaders(integ);
    if (!creds.ok) return { ok: false, code: creds.code === 'sign_in_required' ? 'sign_in_required' : 'unavailable' };

    const ac = new AbortController();
    const overall = setTimeout(() => ac.abort(), this.limits.discoveryMs);
    let sessionId: string | undefined;
    let protocol = DISCOVERY_PROTOCOL;
    let headers = creds.headers;
    try {
      const call = async (body: Record<string, unknown>, id: number | undefined): Promise<
        { ok: true; status: number; rpc?: Record<string, unknown> } | { ok: false; code: 'sign_in_required' | 'unavailable' | 'upstream' }
      > => {
        const base: Record<string, string> = {
          'user-agent': USER_AGENT, 'content-type': 'application/json', accept: 'application/json, text/event-stream',
          ...(sessionId ? { 'mcp-session-id': sessionId } : {}), ...(sessionId ? { 'mcp-protocol-version': protocol } : {})
        };
        const got = await this.fetchUpstream(integ, headers, { method: 'POST', body: Buffer.from(JSON.stringify(body)), base }, ac, this.limits.headersMs, DISCOVERY_AGENT);
        if (got.kind === 'network') return { ok: false, code: 'upstream' };
        if (got.kind === 'credential') return { ok: false, code: got.code === 'sign_in_required' ? 'sign_in_required' : 'unavailable' };
        if (got.kind === 'unauthorized') return { ok: false, code: 'sign_in_required' };
        const up = got.up;
        headers = got.creds;                       // keep whatever the last (possibly replayed) request ended with
        const sid = up.headers.get('mcp-session-id');
        if (sid && id === 1 && sid.length <= 256) sessionId = sid;
        if (up.status === 401) { try { await up.body?.cancel(); } catch { /* noop */ } return { ok: false, code: 'sign_in_required' }; }
        if (!up.ok) { try { await up.body?.cancel(); } catch { /* noop */ } return { ok: false, code: 'upstream' }; }
        if (id === undefined) { try { await up.body?.cancel(); } catch { /* noop */ } return { ok: true, status: up.status }; }
        let text: string;
        try { text = await readLimited(up, this.limits.maxListingBytes, this.limits.listingMs); } catch { return { ok: false, code: 'upstream' }; }
        const ct = (up.headers.get('content-type') ?? '').toLowerCase();
        let rpc: unknown;
        if (ct.startsWith('text/event-stream')) rpc = findRpcResponse(parseSse(text), id);
        else { try { rpc = JSON.parse(text); } catch { rpc = undefined; } }
        if (!rpc || typeof rpc !== 'object' || Array.isArray(rpc) || (rpc as { id?: unknown }).id !== id) return { ok: false, code: 'upstream' };
        return { ok: true, status: up.status, rpc: rpc as Record<string, unknown> };
      };

      const init = await call({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: DISCOVERY_PROTOCOL, capabilities: {}, clientInfo: { name: 'mosbius-co-broker', version: '1' } }
      }, 1);
      if (!init.ok) return init;
      if (init.rpc?.error !== undefined) return { ok: false, code: 'upstream' };
      const negotiated = (init.rpc?.result as { protocolVersion?: unknown } | undefined)?.protocolVersion;
      if (typeof negotiated === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(negotiated)) protocol = negotiated;
      const hello = await call({ jsonrpc: '2.0', method: 'notifications/initialized' }, undefined);
      if (!hello.ok) return hello;

      const collected: unknown[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 20 && collected.length < 1000; page++) {
        const listed = await call({ jsonrpc: '2.0', id: 2 + page, method: 'tools/list', ...(cursor ? { params: { cursor } } : {}) }, 2 + page);
        if (!listed.ok) return listed;
        if (listed.rpc?.error !== undefined) return { ok: false, code: 'upstream' };
        const result = listed.rpc?.result as { tools?: unknown; nextCursor?: unknown } | undefined;
        if (!result || !Array.isArray(result.tools)) return { ok: false, code: 'upstream' };
        collected.push(...result.tools);
        if (typeof result.nextCursor !== 'string' || !result.nextCursor) break;
        cursor = result.nextCursor;
      }
      this.learn(integrationId, collected, true);
      return { ok: true, tools: this.toolsOf(integrationId) };
    } finally {
      clearTimeout(overall);
      if (sessionId) void this.closeUpstreamSession(integrationId, sessionId);
      // the broker's own copy of an app-run server exists only for this listing
      if (integ.hosted) this.deps.hosted?.close(DISCOVERY_AGENT, integrationId);
    }
  }

  // ─── sessions, failures, audit ───────────────────────────────────────────

  private bindSession(agentId: string, integrationId: string, sessionId: string): void {
    if (sessionId.length > 256) return;
    if (this.sessions.size >= this.limits.maxSessions) {
      const oldest = this.sessions.keys().next().value;
      if (oldest !== undefined) this.sessions.delete(oldest);
    }
    this.sessions.set(sessionId, { agentId, integrationId });
  }

  private ownsSession(agentId: string, integrationId: string, sessionId: string): boolean {
    const s = this.sessions.get(sessionId);
    return !!s && s.agentId === agentId && s.integrationId === integrationId;
  }

  private sessionsOf(agentId: string, integrationId?: string): Array<[string, string]> {
    const out: Array<[string, string]> = [];
    for (const [sid, s] of this.sessions) {
      if (s.agentId === agentId && (integrationId === undefined || s.integrationId === integrationId)) out.push([sid, s.integrationId]);
    }
    return out;
  }

  private dropSessions(agentId: string, integrationId?: string): void {
    for (const [sid] of this.sessionsOf(agentId, integrationId)) this.sessions.delete(sid);
  }

  /** Best effort, bounded, silent: tell the upstream a session is over. Never throws. */
  private async closeUpstreamSession(integrationId: string, sessionId: string): Promise<void> {
    try {
      const integ = this.deps.resolve(integrationId);
      if (!integ || !integ.enabled) return;
      const creds = await this.deps.credentials.accessHeaders(integ);
      if (!creds.ok) return;
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), this.limits.sessionDeleteMs);
      try {
        const r = await fetch(integ.url, {
          method: 'DELETE', redirect: 'manual', signal: ac.signal,
          headers: { 'user-agent': USER_AGENT, 'mcp-session-id': sessionId, ...lowerKeys(creds.headers) }
        });
        try { await r.body?.cancel(); } catch { /* noop */ }
      } finally { clearTimeout(timer); }
    } catch { /* it was a courtesy */ }
  }

  private credentialFailure(res: ServerResponse, code: CredentialFailure): void {
    if (code === 'sign_in_required') return sendError(res, 401, 'sign_in_required', 'sign in to this integration again');
    if (code === 'no_secret') return sendError(res, 503, 'no_secret', 'no credential configured for this integration');
    return sendError(res, 503, 'unavailable', 'credential temporarily unavailable');
  }

  private audit(e: Omit<McpAuditEvent, 'at'>): void {
    if (!this.deps.audit) return;
    try { this.deps.audit({ at: (this.deps.now ?? Date.now)(), ...e }); } catch { /* an observer must never break a request */ }
  }
}

/** A tool's own description, as text that is safe to show: no control characters, cut short. */
function describe(v: unknown): string {
  return typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300) : '';
}

/** Read a fetch body to a string, refusing more than `max` bytes or more time than `ms`. */
async function readLimited(up: Response, max: number, ms: number): Promise<string> {
  if (!up.body) return '';
  const reader = up.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let late = false;
  const timer = setTimeout(() => { late = true; void reader.cancel().catch(() => undefined); }, ms);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) { try { await reader.cancel(); } catch { /* noop */ } throw new Error('too large'); }
      chunks.push(value);
    }
  } finally {
    clearTimeout(timer);
  }
  if (late) throw new Error('too slow');
  return Buffer.concat(chunks).toString('utf8');
}
