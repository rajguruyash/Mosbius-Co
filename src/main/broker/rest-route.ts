/**
 * The REST route: `<METHOD> /i/<integrationId>/<path...>`.
 *
 * This is the original integration broker's forwarding logic, moved here
 * unchanged in behaviour (broker-rest-characterization pins it). The one thing
 * that differs is hardening: a malformed %-escape in the integration id used to
 * throw out of the request handler and crash the main process; it is now a 400.
 *
 * NOT an open proxy: a worker selects an integration by id and never a host,
 * and the path is confined under the integration's own origin.
 */
import type { IncomingMessage } from 'node:http';
import { type IntegrationRecord, resolveUpstreamUrl } from '../../shared/integrations';
import type { BrokerRoute, RouteContext } from './core';
import type { CredentialProvider } from './credentials';
import { BodyTooLarge, HOP_BY_HOP, pipeWebStream, readBodyCapped, sendError } from './http-util';
import { effectiveGrant, type McpGrants } from './permissions';
import {
  METHOD_OVERRIDE_HEADERS, auditablePath, isGraphqlPath, relativeRestPath, restRequestAllowed
} from './rest-permissions';

export const REST_MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB request-body cap
export const REST_UPSTREAM_TIMEOUT_MS = 30_000;
const DEFAULT_USER_AGENT = 'mosbius-co-broker/1';

/** Request headers the worker is NEVER allowed to pass upstream. */
const STRIP_REQUEST = new Set([
  'authorization', 'x-md-broker-token', 'host', 'cookie', 'content-length', ...HOP_BY_HOP
]);
/** Response headers never forwarded back (fetch already decodes the body, so the
 *  upstream content-encoding/length would be wrong). */
const STRIP_RESPONSE = new Set(['content-encoding', 'content-length', 'set-cookie', ...HOP_BY_HOP]);

export interface RestMatch {
  /** The id after percent-decoding, or null if the escape was malformed. */
  integrationId: string | null;
  path: string;
  query: string;
}

/** What the durable audit trail is told about a REST request. Metadata only: the method, the
 *  path relative to the integration with opaque segments and the query left out, the verdict. */
export interface RestAuditEvent {
  at: number;
  agentId: string;
  integrationId: string;
  method: string;
  path: string;
  decision: 'allow' | 'deny';
  reason: string;
}

export interface RestRouteDeps {
  getRecord: (id: string) => IntegrationRecord | undefined;
  credentials: CredentialProvider<IntegrationRecord>;
  /**
   * The live per-agent grants, read on every request so an edit applies at once. When present,
   * a request is allowed only if the agent holds a grant that covers its method and path (see
   * rest-permissions.ts): no grant, no access. The app always supplies it. It is optional only
   * so the broker's original capability-only behaviour stays testable on its own.
   */
  grants?: () => McpGrants | undefined;
  now?: () => number;
  /** Told of every request the grants decided on, allowed or refused. Never given a body or a header. */
  audit?: (event: RestAuditEvent) => void;
}

export class RestRoute implements BrokerRoute<RestMatch> {
  readonly channel = 'rest' as const;

  constructor(private readonly deps: RestRouteDeps) {}

  match(req: IncomingMessage): RestMatch | null {
    const m = /^\/i\/([^/?#]+)(?:\/([^?#]*))?(\?[^#]*)?$/.exec(req.url ?? '');
    if (!m) return null;
    let integrationId: string | null;
    try { integrationId = decodeURIComponent(m[1]); } catch { integrationId = null; }
    return { integrationId, path: m[2] ?? '', query: m[3] ?? '' };
  }

  async handle(ctx: RouteContext<RestMatch>): Promise<void> {
    const { res, cap } = ctx;
    const { integrationId, path, query } = ctx.match;
    if (integrationId === null) return sendError(res, 400, 'bad_request', 'invalid integration id');

    // Authorize against this worker's capability.
    if (!cap.allowedIds.has(integrationId)) {
      return sendError(res, 403, 'forbidden', 'integration not in this worker capability');
    }
    ctx.bindIntegration(integrationId);

    // Resolve the record (still enabled?).
    const rec = this.deps.getRecord(integrationId);
    if (!rec) return sendError(res, 404, 'not_found', 'unknown integration');
    if (!rec.enabled) return sendError(res, 403, 'forbidden', 'integration is disabled');

    // Confine the upstream URL under the integration origin (NOT an open proxy).
    const upstream = resolveUpstreamUrl(rec.baseUrl, path + query);
    if (!upstream) return sendError(res, 400, 'bad_request', 'invalid or out-of-bounds path');

    // What THIS agent may do here (Stage B). Decided before the credential is touched, so a
    // refused request never causes the secret to be read, and re-read on every request, so a
    // grant that is taken away stops the very next call.
    let preBody: Buffer | undefined;
    if (this.deps.grants) {
      const method = (ctx.req.method ?? 'GET').toUpperCase();
      const rel = relativeRestPath(rec.baseUrl, upstream);
      // Only a POST to a GraphQL endpoint is classified by its body, so only then is the body read here.
      const graphql = isGraphqlPath(rel) || isGraphqlPath(upstream.pathname);
      if (method === 'POST' && graphql) {
        try {
          preBody = await readBodyCapped(ctx.req, REST_MAX_BODY_BYTES);
        } catch (e) {
          if (e instanceof BodyTooLarge) return sendError(res, 413, 'payload_too_large', 'request body too large');
          return sendError(res, 400, 'bad_request', 'could not read request body');
        }
      }
      const grant = effectiveGrant(this.deps.grants(), cap.agentId, integrationId, (this.deps.now ?? Date.now)());
      const verdict = restRequestAllowed(grant, method, rel, preBody, upstream.pathname);
      this.audit({
        agentId: cap.agentId, integrationId, method, path: auditablePath(rel),
        decision: verdict.allow ? 'allow' : 'deny', reason: verdict.reason
      });
      if (!verdict.allow) return sendError(res, 403, 'forbidden', 'this agent may not make that request');
    }

    // The credential (materialized ONLY here, used ONLY to inject the upstream header).
    const creds = await this.deps.credentials.accessHeaders(rec);
    if (!creds.ok) return sendError(res, 503, 'no_secret', 'no secret configured for this integration');

    return this.forward(ctx, upstream, creds.headers, preBody);
  }

  private audit(e: Omit<RestAuditEvent, 'at'>): void {
    if (!this.deps.audit) return;
    try { this.deps.audit({ at: (this.deps.now ?? Date.now)(), ...e }); } catch { /* an observer must never break a request */ }
  }

  private async forward(ctx: RouteContext<RestMatch>, upstream: URL, injected: Record<string, string>, preBody?: Buffer): Promise<void> {
    const { req, res } = ctx;
    // Buffer the request body with a hard cap (write methods).
    const method = (req.method ?? 'GET').toUpperCase();
    const hasBody = method !== 'GET' && method !== 'HEAD';
    let body: Buffer | undefined = preBody;
    if (hasBody && preBody === undefined) {
      try {
        body = await readBodyCapped(req, REST_MAX_BODY_BYTES);
      } catch (e) {
        if (e instanceof BodyTooLarge) return sendError(res, 413, 'payload_too_large', 'request body too large');
        return sendError(res, 400, 'bad_request', 'could not read request body');
      }
    }

    // Sanitize worker headers, then inject the auth header(s). Injected auth ALWAYS
    // wins: the strip list removes any worker-supplied authorization/auth header.
    const outHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const key = k.toLowerCase();
      if (STRIP_REQUEST.has(key)) continue;
      // A request is judged by its method, so it must not be able to ask the upstream to treat it
      // as another one (a POST that arrives as a DELETE would slip past a write-only grant).
      if (this.deps.grants && (METHOD_OVERRIDE_HEADERS as readonly string[]).includes(key)) continue;
      if (Array.isArray(v)) outHeaders[key] = v.join(', ');
      else if (typeof v === 'string') outHeaders[key] = v;
    }
    if (!outHeaders['user-agent']) outHeaders['user-agent'] = DEFAULT_USER_AGENT;
    for (const [k, v] of Object.entries(injected)) {
      delete outHeaders[k]; // ensure the worker can't shadow an injected header
      outHeaders[k] = v;
    }

    // One controller covers the timeout, a revoke, a stop and a client that went away.
    const ac = new AbortController();
    const onAbort = (): void => ac.abort();
    if (ctx.signal.aborted) ac.abort(); else ctx.signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => ac.abort(), REST_UPSTREAM_TIMEOUT_MS);
    try {
      let upstreamRes: Response;
      try {
        upstreamRes = await fetch(upstream, {
          method,
          headers: outHeaders,
          body: body as BodyInit | undefined,
          redirect: 'manual',
          signal: ac.signal
        });
      } catch (e) {
        // The message could in theory contain the URL but never the secret.
        return sendError(res, 502, 'bad_gateway', `upstream request failed: ${(e as Error).message}`);
      }

      // Stream the response back (status + sanitized headers + body).
      const respHeaders: Record<string, string> = {};
      upstreamRes.headers.forEach((value, key) => {
        if (!STRIP_RESPONSE.has(key.toLowerCase())) respHeaders[key] = value;
      });
      res.writeHead(upstreamRes.status, respHeaders);
      try {
        if (upstreamRes.body) await pipeWebStream(upstreamRes.body, res, ac.signal);
        else res.end();
      } catch {
        try { res.end(); } catch { /* socket gone */ }
      }
    } finally {
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', onAbort);
    }
  }
}
