/**
 * Reading a token endpoint's answer — for the authorization-code exchange and for
 * a refresh alike — into either usable tokens or one fixed classification.
 *
 * The provider's text is DATA. Only fields with a known shape are taken from it;
 * an `error_description` (free text) is never read, stored, logged or returned,
 * and only an `error` code that looks like a code is kept.
 */
import type { McpOauthSpec } from '../../shared/mcpCatalog';
import { parseJsonObject } from './http';
import type { TokenSet } from './types';

/** Visible ASCII, no whitespace or control characters: safe to put in a header. */
const TOKEN_RE = /^[\x21-\x7e]{1,8192}$/;
const ERROR_CODE_RE = /^[a-z][a-z0-9_]{0,39}$/;
const MAX_LIFETIME_SEC = 60 * 60 * 24 * 366;

/** Errors that mean this grant is over and the user must sign in again. Anything
 *  else a provider says is not enough to throw a working sign-in away. */
const PERMANENT = new Set([
  'invalid_grant', 'invalid_client', 'unauthorized_client',
  'invalid_refresh_token', 'token_revoked', 'invalid_auth', 'account_inactive',
  'bad_client_secret', 'invalid_client_id', 'not_authed', 'revoked_token',
  // GitHub's names for a refresh token that is spent or never was, and for a client that is not this one
  'bad_refresh_token', 'incorrect_client_credentials'
]);

export type TokenOutcome =
  | { kind: 'tokens'; tokens: TokenSet; rotated: boolean }
  /** The provider says the grant (or the client) is no good: sign in again. */
  | { kind: 'permanent'; code: string }
  /** The provider refused for a reason that is not about the grant (our request, a limit). */
  | { kind: 'rejected'; code: string }
  /** Could not tell, or the provider is having a bad moment: try again later. */
  | { kind: 'transient' }
  /** A 200 that is not a token response. */
  | { kind: 'malformed' };

export function parseTokenResponse(
  status: number,
  text: string,
  spec: Pick<McpOauthSpec, 'tokenResponse'>,
  now: number,
  previous?: { refreshToken?: string; scope?: string }
): TokenOutcome {
  const body = parseJsonObject(text);
  const code = typeof body?.error === 'string' && ERROR_CODE_RE.test(body.error) ? body.error : undefined;

  if (status === 429 || status === 408 || status >= 500) return { kind: 'transient' };

  // Slack answers 200 with {ok:false,error}; everyone else uses a 4xx.
  const slackFailed = spec.tokenResponse === 'slack' && body?.ok === false;
  // GitHub answers 200 whatever happened and says so in an `error` field.
  const githubFailed = spec.tokenResponse === 'github' && body !== null && typeof body.error === 'string' && typeof body.access_token !== 'string';
  if (status >= 400 || slackFailed || githubFailed) {
    if (code && PERMANENT.has(code)) return { kind: 'permanent', code };
    if (code && ['ratelimited', 'rate_limited', 'service_unavailable', 'fatal_error', 'internal_error', 'temporarily_unavailable', 'server_error'].includes(code)) return { kind: 'transient' };
    return { kind: 'rejected', code: code ?? 'unknown' };
  }
  if (status !== 200 || !body) return { kind: 'malformed' };

  // Slack's user-token flow can nest the token under authed_user.
  const nested = spec.tokenResponse === 'slack' && body.authed_user && typeof body.authed_user === 'object'
    ? (body.authed_user as Record<string, unknown>) : undefined;
  const source = typeof body.access_token === 'string' ? body : (nested ?? body);

  const access = source.access_token;
  if (typeof access !== 'string' || !TOKEN_RE.test(access)) return { kind: 'malformed' };

  const type = typeof source.token_type === 'string' ? source.token_type.toLowerCase() : undefined;
  if (type !== undefined && type !== 'bearer' && !(spec.tokenResponse === 'slack' && type === 'user')) return { kind: 'malformed' };

  const tokens: TokenSet = { accessToken: access };

  const rt = source.refresh_token;
  if (rt !== undefined) {
    if (typeof rt !== 'string' || !TOKEN_RE.test(rt)) return { kind: 'malformed' };
    tokens.refreshToken = rt;
  }

  const life = source.expires_in;
  if (life !== undefined && life !== null) {
    const sec = typeof life === 'number' ? life : (typeof life === 'string' && /^\d{1,9}$/.test(life) ? Number(life) : NaN);
    if (!Number.isFinite(sec) || sec <= 0 || sec > MAX_LIFETIME_SEC) return { kind: 'malformed' };
    tokens.expiresAt = now + Math.floor(sec * 1000);
  }

  if (typeof source.scope === 'string' && source.scope.length <= 2000 && !/[\u0000-\u001f\u007f]/.test(source.scope)) tokens.scope = source.scope;
  else if (previous?.scope) tokens.scope = previous.scope;

  // A refresh that returns no refresh token keeps the old one; one that returns a
  // DIFFERENT one is a rotation, and the new one must be saved before it is relied on.
  const rotated = previous?.refreshToken !== undefined && tokens.refreshToken !== undefined && tokens.refreshToken !== previous.refreshToken;
  if (tokens.refreshToken === undefined && previous?.refreshToken !== undefined) tokens.refreshToken = previous.refreshToken;
  return { kind: 'tokens', tokens, rotated };
}
