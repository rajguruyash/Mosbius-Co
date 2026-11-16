/**
 * The two ways to get a first token without a key or an OAuth app of the user's own. Each returns a
 * GrantDraft (the client, the endpoints and the tokens) or a fixed error code, and touches no store:
 * the manager saves what they return.
 *
 *   signInDcr     discover, register a public client for THIS sign-in, authorization code + PKCE on a
 *                 loopback address, exchange with no secret. (RFC 9728, 8414, 7591, 7636, 8707, 9207.)
 *   signInDevice  the device authorization grant (RFC 8628) with an app's public client id.
 *
 * Everything a provider sends is data: a code or message of its own is never shown, only classified.
 */
import { CLIENT_ID_RE, type ConnectDevice, type ConnectError, type ConnectSpec } from '../../shared/connect';
import type { EndpointPolicy } from '../oauth/endpoints';
import { formBody } from '../oauth/http';
import { challengeS256, newCodeVerifier, newState, verifyS256, type RandomBytes } from '../oauth/pkce';
import { parseTokenResponse } from '../oauth/token-response';
import type { OAuthLogger, TokenSet } from '../oauth/types';
import { discoverServer } from './discovery';
import { parseJson, rawRequest, type RawFetch } from './http';
import { openLoopback } from './loopback';
import { makeHostPolicy } from './policy';

export type Prompt =
  | { kind: 'browser' }
  | { kind: 'device'; userCode: string; verificationUri: string; expiresAt: number };

export interface FlowCtx {
  id: string;
  label: string;
  fetch: RawFetch;
  endpointPolicy: EndpointPolicy;
  now(): number;
  log: OAuthLogger;
  random?: RandomBytes;
  openUrl(url: string): Promise<void>;
  signal: AbortSignal;
  signInMs: number;
  requestMs: number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  prompt(p: Prompt): void;
}

export interface GrantDraft {
  method: 'dcr' | 'device';
  clientId: string;
  clientSecret?: string;
  issuer: string;
  authorizationEndpoint?: string;
  tokenEndpoint: string;
  revocationEndpoint?: string;
  resource?: string;
  scope?: string;
  registration?: { uri: string; token: string };
  tokens: TokenSet;
}

export type FlowResult = { ok: true; draft: GrantDraft } | { ok: false; error: ConnectError };
const fail = (error: ConnectError): FlowResult => ({ ok: false, error });

const CLIENT_NAME = 'Mosbius & Co';
const SECRET_RE = /^[\x21-\x7e]{1,2048}$/;

function exchangeError(parsed: ReturnType<typeof parseTokenResponse>): ConnectError {
  switch (parsed.kind) {
    case 'permanent': case 'rejected': return 'exchange-failed';
    case 'transient': return 'unavailable';
    default: return 'bad-token-response';
  }
}

// ─── self-registering sign-in ───────────────────────────────────────────────

export async function signInDcr(ctx: FlowCtx, spec: ConnectSpec, mcpUrl: string, scope: string | undefined): Promise<FlowResult> {
  const policy = makeHostPolicy(spec.hosts, ctx.endpointPolicy);
  const disc = await discoverServer({ mcpUrl, authorizationServer: spec.authorizationServer, policy, fetch: ctx.fetch, timeoutMs: ctx.requestMs, signal: ctx.signal });
  // A person who pressed Cancel while the service's details were being read did not meet a failure.
  if (!disc.ok) { ctx.log({ event: 'connect.discovery', id: ctx.id, ok: false }); return fail(ctx.signal.aborted ? 'cancelled' : 'discovery-failed'); }
  const d = disc.found;
  if (!d.registrationEndpoint) { ctx.log({ event: 'connect.discovery', id: ctx.id, ok: true, registration: false }); return fail('not-available'); }
  ctx.log({ event: 'connect.discovery', id: ctx.id, ok: true, registration: true, iss: d.issParameterSupported });

  let lb;
  try { lb = await openLoopback({ path: '/callback', label: ctx.label }); }
  catch (e) { return fail((e as NodeJS.ErrnoException)?.code === 'EADDRINUSE' ? 'port-busy' : 'failed'); }
  try {
    const reg = await rawRequest(ctx.fetch, d.registrationEndpoint, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        client_name: CLIENT_NAME, redirect_uris: [lb.redirectUri], grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'], token_endpoint_auth_method: 'none', ...(scope ? { scope } : {})
      })
    }, { timeoutMs: ctx.requestMs, signal: ctx.signal });
    const regBody = reg.ok && (reg.status === 200 || reg.status === 201) ? parseJson(reg.text) : null;
    if (!regBody || typeof regBody.client_id !== 'string' || !CLIENT_ID_RE.test(regBody.client_id)) {
      ctx.log({ event: 'connect.register', id: ctx.id, ok: false, status: reg.status });
      return fail(ctx.signal.aborted ? 'cancelled' : 'registration-failed');
    }
    const clientId = regBody.client_id;
    // A provider that insists on a secret hands this client its own: unique to this registration, sealed
    // in the vault, and used, never shipped.
    const clientSecret = typeof regBody.client_secret === 'string' && SECRET_RE.test(regBody.client_secret) ? regBody.client_secret : undefined;
    // The handle for removing the client again (RFC 7592) is a convenience: one that points off the pinned
    // hosts is simply not kept, and the sign-in carries on.
    let handle: { uri: string; token: string } | undefined;
    if (typeof regBody.registration_access_token === 'string' && SECRET_RE.test(regBody.registration_access_token) && typeof regBody.registration_client_uri === 'string') {
      try { policy.check(regBody.registration_client_uri, 'registration handle'); handle = { uri: regBody.registration_client_uri, token: regBody.registration_access_token }; } catch { handle = undefined; }
    }
    ctx.log({ event: 'connect.register', id: ctx.id, ok: true, secret: !!clientSecret, handle: !!handle });

    const verifier = newCodeVerifier(ctx.random);
    const challenge = challengeS256(verifier);
    if (!verifyS256(verifier, challenge)) return fail('failed');
    const state = newState(ctx.random);
    const url = new URL(d.authorizationEndpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', lb.redirectUri);
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('resource', d.resource);
    if (scope) url.searchParams.set('scope', scope);
    const waiting = lb.arm({ state, issuer: d.issuer, issRequired: d.issParameterSupported, timeoutMs: ctx.signInMs, signal: ctx.signal });
    ctx.prompt({ kind: 'browser' });
    try { await ctx.openUrl(url.toString()); } catch { lb.close(); return fail('no-browser'); }
    const cb = await waiting;
    if (cb.refused.length > 0) ctx.log({ event: 'connect.callback.refused', id: ctx.id, count: cb.refused.length });
    if (!cb.ok) {
      ctx.log({ event: 'connect.callback', id: ctx.id, ok: false, why: cb.error });
      return fail(cb.error);
    }
    const tok = await rawRequest(ctx.fetch, d.tokenEndpoint, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: formBody({
        grant_type: 'authorization_code', code: cb.code, redirect_uri: lb.redirectUri, client_id: clientId, code_verifier: verifier,
        resource: d.resource, ...(clientSecret ? { client_secret: clientSecret } : {})
      })
    }, { timeoutMs: ctx.requestMs, signal: ctx.signal });
    if (ctx.signal.aborted) return fail('cancelled');
    if (!tok.ok) return fail('unavailable');
    const parsed = parseTokenResponse(tok.status, tok.text, { tokenResponse: 'oauth2' }, ctx.now());
    ctx.log({ event: 'connect.exchange', id: ctx.id, outcome: parsed.kind, ...(parsed.kind === 'tokens' ? { refresh: parsed.tokens.refreshToken !== undefined } : {}) });
    if (parsed.kind !== 'tokens') return fail(exchangeError(parsed));
    return {
      ok: true,
      draft: {
        method: 'dcr', clientId, ...(clientSecret ? { clientSecret } : {}), issuer: d.issuer,
        authorizationEndpoint: d.authorizationEndpoint, tokenEndpoint: d.tokenEndpoint,
        ...(d.revocationEndpoint ? { revocationEndpoint: d.revocationEndpoint } : {}),
        resource: d.resource, ...(parsed.tokens.scope ?? scope ? { scope: parsed.tokens.scope ?? scope } : {}),
        ...(handle ? { registration: handle } : {}), tokens: parsed.tokens
      }
    };
  } catch (e) {
    // a refused address (an unpinned host in a document) or anything unexpected ends the sign-in, never crashes it
    ctx.log({ event: 'connect.error', id: ctx.id });
    return fail(e && (e as Error).name === 'ConnectRefused' ? 'discovery-failed' : 'failed');
  } finally {
    lb.close();
  }
}

// ─── device flow ────────────────────────────────────────────────────────────

const USER_CODE_RE = /^[A-Za-z0-9 -]{4,24}$/;

export async function signInDevice(ctx: FlowCtx, spec: ConnectSpec, method: ConnectDevice, clientId: string): Promise<FlowResult> {
  if (!CLIENT_ID_RE.test(clientId)) return fail('bad-client-id');
  const policy = makeHostPolicy(spec.hosts, ctx.endpointPolicy);
  try {
    policy.check(method.deviceEndpoint, 'device endpoint');
    policy.check(method.tokenEndpoint, 'token endpoint');
  } catch { return fail('discovery-failed'); }

  const start = await rawRequest(ctx.fetch, method.deviceEndpoint, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: formBody({ client_id: clientId, ...(method.scope ? { scope: method.scope } : {}) })
  }, { timeoutMs: ctx.requestMs, signal: ctx.signal });
  if (ctx.signal.aborted) return fail('cancelled');
  const sb = start.ok ? parseJson(start.text) : null;
  if (!sb) return fail(start.ok ? 'provider-error' : 'unavailable');
  if (typeof sb.error === 'string') {
    ctx.log({ event: 'connect.device', id: ctx.id, ok: false, code: /^[a-z_]{1,40}$/.test(sb.error) ? sb.error : 'unknown' });
    return fail(sb.error === 'device_flow_disabled' ? 'device-flow-disabled' : 'provider-error');
  }
  const deviceCode = sb.device_code; const userCode = sb.user_code; const verification = sb.verification_uri;
  if (typeof deviceCode !== 'string' || !SECRET_RE.test(deviceCode) || typeof userCode !== 'string' || !USER_CODE_RE.test(userCode) || typeof verification !== 'string') {
    return fail('provider-error');
  }
  // Only a page on a pinned host is shown to the user: a provider's answer cannot send them elsewhere.
  try { policy.check(verification, 'verification address'); } catch { return fail('discovery-failed'); }
  const lifetimeMs = Math.min(Math.max(Number(sb.expires_in) || 900, 30), 3600) * 1000;
  let interval = Math.min(Math.max(Number.isFinite(Number(sb.interval)) ? Number(sb.interval) : 5, 1), 60);
  const expiresAt = ctx.now() + lifetimeMs;
  ctx.prompt({ kind: 'device', userCode, verificationUri: verification, expiresAt });
  ctx.log({ event: 'connect.device', id: ctx.id, ok: true, interval });

  for (;;) {
    await ctx.sleep(interval * 1000, ctx.signal);
    if (ctx.signal.aborted) return fail('cancelled');
    if (ctx.now() > expiresAt) return fail('expired');
    const r = await rawRequest(ctx.fetch, method.tokenEndpoint, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: formBody({ client_id: clientId, device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' })
    }, { timeoutMs: ctx.requestMs, signal: ctx.signal });
    if (ctx.signal.aborted) return fail('cancelled');
    if (!r.ok) { if (r.error === 'network' || r.error === 'timeout') continue; return fail('unavailable'); }
    const body = parseJson(r.text);
    const code = body && typeof body.error === 'string' && /^[a-z_]{1,40}$/.test(body.error) ? body.error : undefined;
    if (code === 'authorization_pending') continue;
    if (code === 'slow_down') { interval = Math.min(Math.max(Number.isFinite(Number(body?.interval)) ? Number(body?.interval) : interval + 5, interval + 1), 120); continue; }
    if (code === 'access_denied') return fail('denied');
    if (code === 'expired_token') return fail('expired');
    if (code) { ctx.log({ event: 'connect.device.poll', id: ctx.id, code }); return fail(code === 'device_flow_disabled' ? 'device-flow-disabled' : 'provider-error'); }
    const parsed = parseTokenResponse(r.status, r.text, { tokenResponse: 'github' }, ctx.now());
    ctx.log({ event: 'connect.exchange', id: ctx.id, outcome: parsed.kind, ...(parsed.kind === 'tokens' ? { refresh: parsed.tokens.refreshToken !== undefined } : {}) });
    if (parsed.kind !== 'tokens') return fail(exchangeError(parsed));
    const origin = new URL(method.tokenEndpoint).origin;
    return {
      ok: true,
      draft: {
        method: 'device', clientId, issuer: origin, tokenEndpoint: method.tokenEndpoint,
        ...(parsed.tokens.scope ? { scope: parsed.tokens.scope } : {}), tokens: parsed.tokens
      }
    };
  }
}
