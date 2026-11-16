/**
 * Provider-side revocation: ask the provider to forget a token.
 *
 * Deleting our copy does nothing to a refresh token that is still valid at the
 * provider, so where the provider documents a revocation call it is made BEFORE
 * the local wipe. Best-effort by design — the user may be offline, and a
 * disconnect must still delete everything local — but never silent: the report
 * says exactly what the provider confirmed.
 *
 * Deliberately narrow: the URL comes from the catalogue (never from a response),
 * must be https, a redirect is an error, and the request carries nothing but the
 * token. It never throws and never puts a token in what it returns.
 */
import type { McpRevokeSpec } from '../../shared/mcpCatalog';
import { checkEndpoint, type EndpointPolicy } from './endpoints';
import { formBody, parseJsonObject, send, type FetchLike } from './http';

export type RevokeOutcome =
  | 'revoked'          // the provider says it forgot the token
  | 'already-invalid'  // the provider did not know it: same end state
  | 'rejected'         // the provider answered, but not with a confirmation
  | 'unreachable'      // offline, timed out, redirected, or an unreadable answer
  | 'unsupported';     // no revocation endpoint for this provider

export interface RevokeReport {
  attempted: number;
  /** Tokens the provider confirmed gone (revoked or already invalid). */
  confirmed: number;
  outcomes: RevokeOutcome[];
}

export interface RevokeDeps {
  fetch: FetchLike;
  policy: EndpointPolicy;
  timeoutMs?: number;
  /** A public client identifies itself (RFC 7009 section 2.1) and says what it is revoking. Google's
   *  and Slack's calls take only the token, so the bridged engines leave this out. */
  clientId?: string;
}

const SLACK_ALREADY_GONE = new Set(['token_revoked', 'invalid_auth', 'token_expired', 'account_inactive']);

export async function revokeTokens(
  spec: McpRevokeSpec | undefined,
  tokens: { accessToken?: string; refreshToken?: string },
  deps: RevokeDeps
): Promise<RevokeReport> {
  const report: RevokeReport = { attempted: 0, confirmed: 0, outcomes: [] };
  if (!spec) return report;
  try { checkEndpoint(spec.url, deps.policy, 'revocation endpoint'); } catch { return report; }

  // Google: revoking the refresh token takes its access tokens with it, so one call
  // does it. Slack: auth.revoke kills only the token it is called with, so send both.
  const hint = spec.style === 'oauth2' ? (tokens.refreshToken ? 'refresh_token' : 'access_token') : undefined;
  const values: string[] = [];
  if (spec.style === 'oauth2') {
    const one = tokens.refreshToken ?? tokens.accessToken;
    if (one) values.push(one);
  } else {
    for (const t of [tokens.accessToken, tokens.refreshToken]) if (t && !values.includes(t)) values.push(t);
  }

  for (const token of values) {
    report.attempted++;
    const outcome = await revokeOne(spec, token, deps, hint);
    report.outcomes.push(outcome);
    if (outcome === 'revoked' || outcome === 'already-invalid') report.confirmed++;
  }
  return report;
}

async function revokeOne(spec: McpRevokeSpec, token: string, deps: RevokeDeps, hint?: string): Promise<RevokeOutcome> {
  const res = spec.style === 'oauth2'
    ? await send(deps.fetch, spec.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: formBody({ token, ...(deps.clientId ? { client_id: deps.clientId, ...(hint ? { token_type_hint: hint } : {}) } : {}) })
    }, { timeoutMs: deps.timeoutMs ?? 10_000 })
    : await send(deps.fetch, spec.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }
    }, { timeoutMs: deps.timeoutMs ?? 10_000 });
  if (res.kind === 'network') return 'unreachable';

  const body = parseJsonObject(res.text);
  if (spec.style === 'oauth2') {
    if (res.status === 200) return 'revoked';
    // RFC 7009 / Google: 400 invalid_token means the provider no longer knows it.
    if (res.status === 400 && body?.error === 'invalid_token') return 'already-invalid';
    return 'rejected';
  }
  if (!body) return 'unreachable';
  if (body.ok === true) return 'revoked';
  if (typeof body.error === 'string' && SLACK_ALREADY_GONE.has(body.error)) return 'already-invalid';
  return 'rejected';
}
