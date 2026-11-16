/**
 * Finding a hosted server's authorization server (RFC 9728, RFC 8414), from the pinned hosts and nothing
 * else. Every address a document names goes through the host policy before it is used.
 *
 *   1. an unauthenticated `initialize`: a 401 whose WWW-Authenticate may name the resource metadata;
 *   2. the resource metadata (that address, else the well-known one for the path, else for the origin);
 *      a server that publishes none may name its authorization server in the catalogue instead;
 *   3. the authorization server's metadata (RFC 8414 path-insertion form, then OpenID's);
 *   4. checks: the issuer is the one asked for, PKCE S256 is offered, the endpoints exist.
 */
import { parseJson, rawRequest, type RawFetch } from './http';
import { ConnectRefused, type HostPolicy } from './policy';

export interface Discovered {
  issuer: string;
  /** The resource indicator (RFC 8707) to send: the server's own, else the pinned MCP address. */
  resource: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  revocationEndpoint?: string;
  issParameterSupported: boolean;
  publicClientsAccepted: boolean;
  scopesSupported?: string[];
}

export type DiscoveryResult = { ok: true; found: Discovered } | { ok: false };

const INIT = JSON.stringify({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mosbius', version: '0' } }
});

export interface DiscoverArgs {
  mcpUrl: string;
  authorizationServer?: string;
  policy: HostPolicy;
  fetch: RawFetch;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export async function discoverServer(a: DiscoverArgs): Promise<DiscoveryResult> {
  try { return await run(a); } catch (e) {
    if (e instanceof ConnectRefused) return { ok: false };
    return { ok: false };
  }
}

async function getJson(a: DiscoverArgs, url: string, what: string): Promise<Record<string, unknown> | null> {
  a.policy.check(url, what);
  const r = await rawRequest(a.fetch, url, { method: 'GET', headers: { accept: 'application/json' } }, { timeoutMs: a.timeoutMs, signal: a.signal });
  return r.ok && r.status === 200 ? parseJson(r.text) : null;
}

async function run(a: DiscoverArgs): Promise<DiscoveryResult> {
  const mcp = a.policy.check(a.mcpUrl, 'the server address');
  const base = `${mcp.protocol}//${mcp.host}`;
  const path = mcp.pathname.replace(/\/$/, '');

  const first = await rawRequest(a.fetch, a.mcpUrl, {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: INIT
  }, { timeoutMs: a.timeoutMs, signal: a.signal });
  const named = /resource_metadata="([^"]+)"/.exec(first.headers.get('www-authenticate') ?? '');

  const candidates: string[] = [];
  if (named) { try { a.policy.check(named[1], 'resource metadata'); candidates.push(named[1]); } catch { /* an unpinned address in a header is ignored */ } }
  if (path) candidates.push(`${base}/.well-known/oauth-protected-resource${path}`);
  candidates.push(`${base}/.well-known/oauth-protected-resource`);
  let rs: Record<string, unknown> | null = null;
  for (const u of candidates) { rs = await getJson(a, u, 'resource metadata'); if (rs) break; }
  if (!rs && a.authorizationServer) rs = { resource: a.mcpUrl, authorization_servers: [a.authorizationServer] };
  if (!rs) return { ok: false };

  const issuerAsked = Array.isArray(rs.authorization_servers) && typeof rs.authorization_servers[0] === 'string' ? rs.authorization_servers[0] : base;
  const issuerUrl = a.policy.check(issuerAsked, 'authorization server');
  const origin = `${issuerUrl.protocol}//${issuerUrl.host}`;
  const ipath = issuerUrl.pathname.replace(/\/$/, '');
  let as: Record<string, unknown> | null = null;
  for (const u of [
    `${origin}/.well-known/oauth-authorization-server${ipath}`,
    `${origin}${ipath}/.well-known/openid-configuration`,
    `${origin}/.well-known/openid-configuration${ipath}`
  ]) { as = await getJson(a, u, 'authorization server metadata'); if (as) break; }
  if (!as) return { ok: false };

  if (typeof as.issuer !== 'string' || as.issuer.replace(/\/$/, '') !== issuerAsked.replace(/\/$/, '')) return { ok: false };
  const pkce = Array.isArray(as.code_challenge_methods_supported) ? as.code_challenge_methods_supported : [];
  if (!pkce.includes('S256')) return { ok: false };
  const need = (k: string): string | undefined => (typeof as![k] === 'string' ? (as![k] as string) : undefined);
  const authorization = need('authorization_endpoint');
  const token = need('token_endpoint');
  if (!authorization || !token) return { ok: false };
  a.policy.check(authorization, 'authorization endpoint');
  a.policy.check(token, 'token endpoint');
  const registration = need('registration_endpoint');
  if (registration) a.policy.check(registration, 'registration endpoint');
  const revocation = need('revocation_endpoint');
  if (revocation) a.policy.check(revocation, 'revocation endpoint');

  let resource = a.mcpUrl;
  if (typeof rs.resource === 'string') {
    try { const r = a.policy.check(rs.resource, 'resource'); if (a.mcpUrl.startsWith(r.origin)) resource = rs.resource; } catch { /* keep the pinned address */ }
  }
  const methods = Array.isArray(as.token_endpoint_auth_methods_supported) ? as.token_endpoint_auth_methods_supported : [];
  const scopes = Array.isArray(as.scopes_supported) ? as.scopes_supported.filter((s): s is string => typeof s === 'string') : undefined;
  return {
    ok: true,
    found: {
      issuer: as.issuer, resource, authorizationEndpoint: authorization, tokenEndpoint: token,
      ...(registration ? { registrationEndpoint: registration } : {}),
      ...(revocation ? { revocationEndpoint: revocation } : {}),
      issParameterSupported: as.authorization_response_iss_parameter_supported === true,
      publicClientsAccepted: methods.includes('none'),
      ...(scopes ? { scopesSupported: scopes } : {})
    }
  };
}
