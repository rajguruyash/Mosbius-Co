/**
 * Who may make which REST request through the broker (Stage B, F3).
 *
 * The MCP route has had per-agent, per-tool grants since Phase 3; the REST route only asked
 * "is this integration in the worker's capability?", which is all or nothing. This applies the
 * SAME model to REST so the two channels behave alike:
 *
 *   • no grant means no access (an agent-level `none` beats an integration-wide default);
 *   • `read` reaches only read requests, `write` reaches read and write requests, and a
 *     `destructive` request (DELETE, or any method the broker does not recognise) is NEVER
 *     reached by a preset — it must be named in `allow`;
 *   • `deny` always wins, then `allow`, then the preset;
 *   • `custom` is exactly its `allow` list.
 *
 * A "tool" is a request: `METHOD /path` with the query left out and the path taken relative to
 * the integration's own base URL. A pattern in `allow` / `deny` is `METHOD /path`, where METHOD
 * may be `*` and the path may end in `*` to cover everything under it:
 *
 *   GET /repos/*          every GET under /repos
 *   * /search/*           any method under /search
 *   DELETE /repos/a/b     exactly that
 *
 * Classes: GET, HEAD, OPTIONS read; POST, PUT, PATCH write; DELETE destructive; anything else
 * destructive. A POST to a GraphQL endpoint (its path ends in `/graphql`) is read when the
 * document is only queries and write otherwise; a body that cannot be read as a document is a
 * write, never a read. HTTP method-override headers are stripped by the route, so a POST cannot
 * turn into a DELETE after it has been classified.
 *
 * Pure functions over plain data: the whole policy is unit-tested without a server.
 */
import type { IntegrationGrant, ToolClass } from './permissions';

export type RestClass = ToolClass;

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH']);

/** Path of `upstream` relative to `baseUrl`'s own path, with a leading slash and no query. */
export function relativeRestPath(baseUrl: string, upstream: URL): string {
  let basePath = '';
  try { basePath = new URL(baseUrl).pathname.replace(/\/+$/, ''); } catch { /* use the whole path */ }
  let p = upstream.pathname;
  if (basePath && (p === basePath || p.startsWith(`${basePath}/`))) p = p.slice(basePath.length);
  if (!p.startsWith('/')) p = `/${p}`;
  return p.replace(/\/{2,}/g, '/');
}

export const isGraphqlPath = (relPath: string): boolean => /(^|\/)graphql\/?$/i.test(relPath);

/** Strip string literals and comments so a keyword inside either is not mistaken for an operation. */
function stripGraphqlNoise(doc: string): string {
  return doc
    .replace(/"""[\s\S]*?"""/g, ' ')
    .replace(/"(?:\\.|[^"\\])*"/g, ' ')
    .replace(/#[^\n\r]*/g, ' ');
}

/**
 * True only when the document can do nothing but read: it starts like a query (`{`, `query` or
 * `fragment`) and, once strings and comments are removed, never mentions `mutation` or
 * `subscription`. GraphQL has no other way to write, and its keywords cannot be spelled around
 * outside a string. Conservative on purpose: a field that happens to be called `mutation` makes
 * the whole document a write, and anything that does not look like a document is not a read.
 */
export function graphqlIsQueryOnly(doc: unknown): boolean {
  if (typeof doc !== 'string' || !doc.trim() || doc.length > 200_000) return false;
  const text = stripGraphqlNoise(doc).trim();
  if (!/^(\{|query\b|fragment\b)/i.test(text)) return false;
  return !/\b(mutation|subscription)\b/i.test(text);
}

/** GraphQL over HTTP: `{ query }`, or a batch (array) of them. Read only if EVERY entry is a query. */
function graphqlBodyIsRead(body: Buffer | undefined): boolean {
  if (!body || body.length === 0) return false;
  let parsed: unknown;
  try { parsed = JSON.parse(body.toString('utf8')); } catch { return false; }
  const docs = Array.isArray(parsed) ? parsed : [parsed];
  if (docs.length === 0 || docs.length > 50) return false;
  return docs.every((d) => !!d && typeof d === 'object' && graphqlIsQueryOnly((d as { query?: unknown }).query));
}

/**
 * How harmful a request is, from its method, its path and (for GraphQL) its body. `fullPath` is
 * the whole upstream path: a GraphQL integration usually has `/graphql` in its BASE URL (Linear's
 * is `https://api.linear.app/graphql`), so the path relative to the base is just `/`.
 */
export function classifyRestRequest(method: string, relPath: string, body?: Buffer, fullPath?: string): RestClass {
  const m = method.toUpperCase();
  if (READ_METHODS.has(m)) return 'read';
  if (m === 'POST' && (isGraphqlPath(relPath) || (fullPath !== undefined && isGraphqlPath(fullPath)))) {
    return graphqlBodyIsRead(body) ? 'read' : 'write';
  }
  if (WRITE_METHODS.has(m)) return 'write';
  return 'destructive'; // DELETE, and any method the broker has no word for
}

/** The name a request goes by in a grant and in the audit trail: `METHOD /path`. */
export const restToolName = (method: string, relPath: string): string => `${method.toUpperCase()} ${relPath}`;

/** Whether one `METHOD /path` pattern covers a request. A trailing `*` covers everything under that prefix. */
export function restPatternMatches(pattern: string, method: string, relPath: string): boolean {
  const m = /^(\*|[A-Za-z]+)\s+(\/\S*)$/.exec(pattern.trim());
  if (!m) return false;
  if (m[1] !== '*' && m[1].toUpperCase() !== method.toUpperCase()) return false;
  const want = m[2];
  if (want.endsWith('*')) {
    const prefix = want.slice(0, -1);
    return relPath.startsWith(prefix) || relPath === prefix.replace(/\/$/, '');
  }
  return relPath === want || relPath === `${want}/`;
}

export interface RestVerdict { allow: boolean; reason: string; cls: RestClass; name: string }

/** May this grant make this request? */
export function restRequestAllowed(grant: IntegrationGrant, method: string, relPath: string, body?: Buffer, fullPath?: string): RestVerdict {
  const cls = classifyRestRequest(method, relPath, body, fullPath);
  const name = restToolName(method, relPath);
  const v = (allow: boolean, reason: string): RestVerdict => ({ allow, reason, cls, name });
  if (grant.preset === 'none') return v(false, 'no access has been granted');
  if (grant.deny?.some((p) => restPatternMatches(p, method, relPath))) return v(false, 'request denied');
  if (grant.allow?.some((p) => restPatternMatches(p, method, relPath))) return v(true, 'request allowed by name');
  if (grant.preset === 'read') return cls === 'read' ? v(true, 'read') : v(false, `a ${cls} request needs more than read access`);
  if (grant.preset === 'write') {
    return cls === 'read' || cls === 'write' ? v(true, cls) : v(false, 'a destructive request must be named');
  }
  return v(false, 'not on the allow list'); // 'custom' is exactly its allow list
}

/** A path made safe to record: no query, long opaque segments (ids, tokens) replaced. */
export function auditablePath(relPath: string): string {
  return relPath
    .split('/')
    .map((seg) => (/^[A-Za-z0-9_\-+=.]{24,}$/.test(seg) ? '…' : seg.slice(0, 48)))
    .join('/')
    .slice(0, 120);
}

/** Request headers that ask the upstream to treat the request as another method. Never forwarded. */
export const METHOD_OVERRIDE_HEADERS = ['x-http-method-override', 'x-method-override', 'x-http-method'] as const;
