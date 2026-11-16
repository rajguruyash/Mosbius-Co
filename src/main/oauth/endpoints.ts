/**
 * Which URLs the sign-in is allowed to talk to.
 *
 * The endpoints are pinned in the catalogue and checked here once more before
 * use, so a mistyped or tampered entry cannot send an authorization code, a
 * refresh token or the user's client secret to a host nobody reviewed.
 *
 * `allowInsecureLoopback` exists for one reason: the test suite's stand-in
 * provider is an http server on 127.0.0.1. The app never sets it (a test pins
 * that), so in the shipped app every endpoint must be https.
 */
import type { McpOauthSpec, McpRevokeSpec } from '../../shared/mcpCatalog';

export interface EndpointPolicy { allowInsecureLoopback: boolean }
export const PRODUCTION_POLICY: EndpointPolicy = Object.freeze({ allowInsecureLoopback: false });

export class EndpointError extends Error {
  constructor(public readonly what: string) {
    super(`unacceptable endpoint: ${what}`);
    this.name = 'EndpointError';
  }
}

/** Parameters the sign-in sets itself; a catalogue entry may not override them. */
export const RESERVED_AUTHORIZE_PARAMS: ReadonlySet<string> = new Set([
  'response_type', 'client_id', 'client_secret', 'redirect_uri', 'state', 'scope',
  'code_challenge', 'code_challenge_method', 'code_verifier', 'code', 'request', 'request_uri',
  'response_mode', 'resource', 'login_hint', 'nonce'
]);

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Parse and vet one endpoint URL. Throws EndpointError; never returns a URL that is not acceptable. */
export function checkEndpoint(raw: string, policy: EndpointPolicy, label = 'endpoint'): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new EndpointError(`${label} is not a URL`); }
  const loopback = LOOPBACK_HOSTS.has(u.hostname) || LOOPBACK_HOSTS.has(`[${u.hostname}]`);
  // A provider is never on this machine. (Only the test suite's stand-in is.)
  if (loopback && !policy.allowInsecureLoopback) throw new EndpointError(`${label} must not be a loopback address`);
  if (u.protocol === 'http:') {
    if (!(policy.allowInsecureLoopback && loopback)) throw new EndpointError(`${label} must be https`);
  } else if (u.protocol !== 'https:') {
    throw new EndpointError(`${label} must be https`);
  }
  if (u.username || u.password) throw new EndpointError(`${label} must not carry credentials`);
  if (u.hash) throw new EndpointError(`${label} must not have a fragment`);
  if (u.search) throw new EndpointError(`${label} must not have a query`);
  if (!u.hostname) throw new EndpointError(`${label} has no host`);
  // A provider is a name, not a bare address (a loopback address is the test-only exception).
  if (!loopback && (/^[0-9.]+$/.test(u.hostname) || u.hostname.startsWith('['))) throw new EndpointError(`${label} must be a host name`);
  return u;
}

/** Vet a whole catalogue spec. Throws EndpointError. */
export function validateOauthSpec(spec: McpOauthSpec, policy: EndpointPolicy): void {
  checkEndpoint(spec.authorizationEndpoint, policy, 'authorization endpoint');
  checkEndpoint(spec.tokenEndpoint, policy, 'token endpoint');
  const iss = checkEndpoint(spec.issuer, policy, 'issuer');
  if (iss.pathname !== '/' && iss.pathname !== '') { /* an issuer may have a path; only its origin form is compared, as given */ }
  if (spec.issParameter !== 'required' && spec.issParameter !== 'optional') throw new EndpointError('issParameter');
  if (spec.tokenResponse !== 'oauth2' && spec.tokenResponse !== 'slack' && spec.tokenResponse !== 'github') throw new EndpointError('tokenResponse');
  for (const [k, v] of Object.entries(spec.authorizeParams ?? {})) {
    if (RESERVED_AUTHORIZE_PARAMS.has(k.toLowerCase())) throw new EndpointError(`authorizeParams may not set ${k}`);
    if (!/^[A-Za-z0-9_]{1,40}$/.test(k) || typeof v !== 'string' || v.length > 100) throw new EndpointError('authorizeParams entry');
  }
}

export function validateRevokeSpec(spec: McpRevokeSpec, policy: EndpointPolicy): void {
  checkEndpoint(spec.url, policy, 'revocation endpoint');
  if (spec.style !== 'oauth2' && spec.style !== 'slack') throw new EndpointError('revocation style');
}
