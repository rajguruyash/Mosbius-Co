'use strict';

/**
 * Reading a token endpoint's answer: only known fields, strictly checked, and
 * every failure a fixed classification — never the provider's own text.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { parseTokenResponse } = loadTs('src/main/oauth/token-response.ts');

const NOW = 1_700_000_000_000;
const OAUTH2 = { tokenResponse: 'oauth2' };
const SLACK = { tokenResponse: 'slack' };
const ok = (obj, spec = OAUTH2, prev) => parseTokenResponse(200, JSON.stringify(obj), spec, NOW, prev);

test('a normal answer yields the tokens, the expiry and the scope', () => {
  const r = ok({ access_token: 'ya29.abc-DEF_1', refresh_token: '1//0gRefresh', expires_in: 3599, token_type: 'Bearer', scope: 'a b' });
  assert.equal(r.kind, 'tokens');
  assert.deepEqual(r.tokens, { accessToken: 'ya29.abc-DEF_1', refreshToken: '1//0gRefresh', expiresAt: NOW + 3_599_000, scope: 'a b' });
  assert.equal(r.rotated, false);
});

test('no lifetime means no expiry is assumed; the token is used until it is refused', () => {
  const r = ok({ access_token: 'xoxp-1', token_type: 'bearer' });
  assert.equal(r.kind, 'tokens');
  assert.equal(r.tokens.expiresAt, undefined);
});

test('expires_in may be a numeric string; nonsense is malformed', () => {
  assert.equal(ok({ access_token: 't', expires_in: '3600' }).tokens.expiresAt, NOW + 3_600_000);
  assert.equal(ok({ access_token: 't', expires_in: null }).tokens.expiresAt, undefined, 'null is the same as absent');
  for (const bad of [0, -5, 'soon', '3600x', 1e12, true, {}, []]) {
    assert.equal(ok({ access_token: 't', expires_in: bad }).kind, 'malformed', JSON.stringify(bad));
  }
});

test('an access token that is not a safe header value is malformed (no CR/LF, no spaces, bounded)', () => {
  for (const bad of ['', 'has space', 'line\r\nInjected: header', 'tab\there', 'x'.repeat(8193), 5, null, {}, ['a']]) {
    assert.equal(ok({ access_token: bad }).kind, 'malformed', JSON.stringify(bad)?.slice(0, 40));
  }
  assert.equal(ok({ access_token: 'x'.repeat(8192) }).kind, 'tokens');
  assert.equal(ok({ access_token: 't', refresh_token: 'bad token' }).kind, 'malformed');
});

test('only bearer tokens are accepted (Slack\'s "user" too, only for Slack)', () => {
  assert.equal(ok({ access_token: 't', token_type: 'mac' }).kind, 'malformed');
  assert.equal(ok({ access_token: 't', token_type: 'user' }).kind, 'malformed');
  assert.equal(ok({ access_token: 't', token_type: 'user' }, SLACK).kind, 'tokens');
  assert.equal(ok({ access_token: 't', token_type: 'BEARER' }).kind, 'tokens');
});

test('Slack: the {ok:true} envelope, and a token nested under authed_user, both work', () => {
  assert.equal(ok({ ok: true, access_token: 'xoxp-top', token_type: 'user' }, SLACK).tokens.accessToken, 'xoxp-top');
  const nested = ok({ ok: true, authed_user: { id: 'U1', access_token: 'xoxp-nested', token_type: 'user', scope: 's' } }, SLACK);
  assert.equal(nested.tokens.accessToken, 'xoxp-nested');
  assert.equal(ok({ ok: true, authed_user: { access_token: 'x' } }).kind, 'malformed', 'the nesting is a Slack-only convention');
});

test('only known fields are kept: nothing else in the answer is carried forward', () => {
  const r = ok({ access_token: 't', id_token: 'eyJ.secret.jwt', extra: { deep: 'x' }, refresh_token_expires_in: 99 });
  assert.deepEqual(Object.keys(r.tokens).sort(), ['accessToken']);
  assert.equal(JSON.stringify(r).includes('eyJ'), false);
});

test('REFRESH: no new refresh token keeps the old one; a different one is a rotation', () => {
  const keep = ok({ access_token: 'n', expires_in: 60 }, OAUTH2, { refreshToken: 'OLD', scope: 'kept' });
  assert.equal(keep.tokens.refreshToken, 'OLD');
  assert.equal(keep.tokens.scope, 'kept');
  assert.equal(keep.rotated, false);
  const rot = ok({ access_token: 'n', refresh_token: 'NEW', expires_in: 60 }, OAUTH2, { refreshToken: 'OLD' });
  assert.equal(rot.tokens.refreshToken, 'NEW');
  assert.equal(rot.rotated, true);
  const same = ok({ access_token: 'n', refresh_token: 'OLD' }, OAUTH2, { refreshToken: 'OLD' });
  assert.equal(same.rotated, false);
});

test('dead grants are PERMANENT; everything else the provider says is not enough to end a sign-in', () => {
  for (const error of ['invalid_grant', 'invalid_client', 'unauthorized_client', 'invalid_refresh_token', 'token_revoked']) {
    assert.deepEqual(parseTokenResponse(400, JSON.stringify({ error }), OAUTH2, NOW), { kind: 'permanent', code: error }, error);
  }
  assert.deepEqual(parseTokenResponse(401, '{"error":"invalid_client"}', OAUTH2, NOW), { kind: 'permanent', code: 'invalid_client' });
  assert.deepEqual(parseTokenResponse(400, '{"error":"invalid_request"}', OAUTH2, NOW), { kind: 'rejected', code: 'invalid_request' });
  assert.deepEqual(parseTokenResponse(400, '{"error":"something-new!"}', OAUTH2, NOW), { kind: 'rejected', code: 'unknown' }, 'a code that does not look like one is not trusted');
  assert.deepEqual(parseTokenResponse(403, 'not json', OAUTH2, NOW), { kind: 'rejected', code: 'unknown' });
});

test('overload, rate limits and server errors are TRANSIENT', () => {
  for (const status of [429, 408, 500, 502, 503, 504]) assert.deepEqual(parseTokenResponse(status, '', OAUTH2, NOW), { kind: 'transient' }, String(status));
  assert.deepEqual(parseTokenResponse(400, '{"error":"temporarily_unavailable"}', OAUTH2, NOW), { kind: 'transient' });
  assert.deepEqual(parseTokenResponse(200, '{"ok":false,"error":"ratelimited"}', SLACK, NOW), { kind: 'transient' });
});

test('Slack reports failure with HTTP 200 and ok:false', () => {
  assert.deepEqual(parseTokenResponse(200, '{"ok":false,"error":"invalid_refresh_token"}', SLACK, NOW), { kind: 'permanent', code: 'invalid_refresh_token' });
  assert.deepEqual(parseTokenResponse(200, '{"ok":false,"error":"bad_redirect_uri"}', SLACK, NOW), { kind: 'rejected', code: 'bad_redirect_uri' });
});

test('a 200 that is not a token response is malformed, never a success', () => {
  for (const text of ['', 'null', '[]', '"str"', '{}', '{"access_token":5}', '<html>captive portal</html>', '{"error":"x"', 'x'.repeat(10)]) {
    assert.equal(parseTokenResponse(200, text, OAUTH2, NOW).kind, 'malformed', text.slice(0, 30));
  }
  assert.equal(parseTokenResponse(204, '', OAUTH2, NOW).kind, 'malformed');
  assert.equal(parseTokenResponse(302, '', OAUTH2, NOW).kind, 'malformed', 'a redirect is never a token response');
});

test('the provider\'s free text is never read, kept or returned', () => {
  const evil = parseTokenResponse(400, JSON.stringify({ error: 'invalid_grant', error_description: 'Bearer SECRET-IN-DESCRIPTION', error_uri: 'https://evil.example' }), OAUTH2, NOW);
  assert.equal(JSON.stringify(evil).includes('SECRET'), false);
  assert.equal(JSON.stringify(evil).includes('evil'), false);
});
