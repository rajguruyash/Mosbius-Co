'use strict';

/**
 * Provider-side revocation: what is sent, what counts as confirmed, and that a
 * failure is reported, never thrown and never silent.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { startIdp } = require('./fixtures/oauth-idp.cjs');
const loadTs = require('./load-ts.cjs');

const { revokeTokens } = loadTs('src/main/oauth/revoke.ts');
const POLICY = { allowInsecureLoopback: true };
const deps = (extra = {}) => ({ fetch: (u, i) => fetch(u, i), policy: POLICY, timeoutMs: 1500, ...extra });

/** Put a grant into the stand-in so there is something to revoke. */
function mint(idp) {
  const access = `at-${Math.random().toString(36).slice(2)}`;
  const refresh = `rt-${Math.random().toString(36).slice(2)}`;
  idp.grants.set(refresh, { clientId: 'c', scope: '', revoked: false });
  idp.access.set(access, { clientId: 'c', exp: Date.now() + 3600_000, revoked: false, grant: refresh });
  return { access, refresh };
}

test('Google style: ONE call, with the refresh token, and it takes the access token down with it', async (t) => {
  const idp = await startIdp(t);
  const { access, refresh } = mint(idp);
  const r = await revokeTokens(idp.revokeSpec(), { accessToken: access, refreshToken: refresh }, deps());
  assert.deepEqual(r, { attempted: 1, confirmed: 1, outcomes: ['revoked'] });
  assert.equal(idp.requests('/revoke').length, 1);
  assert.equal(idp.requests('/revoke')[0].form.token, refresh);
  assert.equal(idp.grants.get(refresh).revoked, true);
  assert.equal(idp.access.get(access).revoked, true);
  assert.equal(idp.requests('/revoke')[0].headers.authorization, undefined, 'the token goes in the body, not a header');
});

test('Google style with only an access token revokes that', async (t) => {
  const idp = await startIdp(t);
  const { access } = mint(idp);
  const r = await revokeTokens(idp.revokeSpec(), { accessToken: access }, deps());
  assert.equal(r.confirmed, 1);
  assert.equal(idp.access.get(access).revoked, true);
});

test('a token the provider no longer knows counts as gone (same end state)', async (t) => {
  const idp = await startIdp(t);
  const r = await revokeTokens(idp.revokeSpec(), { refreshToken: 'rt-never-existed' }, deps());
  assert.deepEqual(r.outcomes, ['already-invalid']);
  assert.equal(r.confirmed, 1);
});

test('any other refusal is "rejected" and is NOT counted as confirmed', async (t) => {
  const idp = await startIdp(t);
  idp.inject('revoke', { status: 400, body: { error: 'invalid_request' } });
  idp.inject('revoke', { status: 403, body: {} });
  idp.inject('revoke', { status: 500, body: {} });
  for (const _ of [1, 2, 3]) {
    const r = await revokeTokens(idp.revokeSpec(), { refreshToken: 'rt-x' }, deps());
    assert.deepEqual(r.outcomes, ['rejected']);
    assert.equal(r.confirmed, 0);
  }
});

test('Slack style: both tokens are sent, each as a Bearer, and the answer is read from the envelope', async (t) => {
  const idp = await startIdp(t, { style: 'slack' });
  const { access, refresh } = mint(idp);
  const r = await revokeTokens(idp.slackRevokeSpec(), { accessToken: access, refreshToken: refresh }, deps());
  assert.equal(r.attempted, 2);
  assert.equal(r.confirmed, 2);
  const sent = idp.requests('/api/auth.revoke').map((x) => x.headers.authorization);
  assert.deepEqual(sent.sort(), [`Bearer ${access}`, `Bearer ${refresh}`].sort());
  assert.equal(idp.requests('/api/auth.revoke')[0].rawBody, '', 'nothing but the header');
  const again = await revokeTokens(idp.slackRevokeSpec(), { accessToken: access }, deps());
  assert.deepEqual(again.outcomes, ['already-invalid']);
});

test('Slack: an unexpected error code is rejected, and a body that is not JSON is unreachable', async (t) => {
  const idp = await startIdp(t, { style: 'slack' });
  idp.inject('revoke', { status: 200, body: { ok: false, error: 'ratelimited' } });
  assert.deepEqual((await revokeTokens(idp.slackRevokeSpec(), { accessToken: 'a' }, deps())).outcomes, ['rejected']);
  idp.inject('revoke', { raw: '<html>', status: 200 });
  assert.deepEqual((await revokeTokens(idp.slackRevokeSpec(), { accessToken: 'a' }, deps())).outcomes, ['unreachable']);
});

test('offline, hung, redirected and oversized answers are "unreachable" — reported, not thrown', async (t) => {
  const idp = await startIdp(t);
  const spec = idp.revokeSpec();
  idp.inject('revoke', { hang: true });
  const hung = await revokeTokens(spec, { refreshToken: 'x' }, deps({ timeoutMs: 150 }));
  assert.deepEqual(hung.outcomes, ['unreachable']);
  idp.inject('revoke', { destroy: true });
  assert.deepEqual((await revokeTokens(spec, { refreshToken: 'x' }, deps())).outcomes, ['unreachable']);
  idp.inject('revoke', { redirect: 'https://evil.example/steal' });
  assert.deepEqual((await revokeTokens(spec, { refreshToken: 'x' }, deps())).outcomes, ['unreachable'], 'a redirect is an error: the token is never re-sent');
  idp.inject('revoke', { status: 200, raw: 'x'.repeat(300 * 1024) });
  assert.deepEqual((await revokeTokens(spec, { refreshToken: 'x' }, deps())).outcomes, ['unreachable']);
  const dead = await revokeTokens({ url: 'http://127.0.0.1:1/revoke', style: 'oauth2' }, { refreshToken: 'x' }, deps());
  assert.deepEqual(dead.outcomes, ['unreachable']);
});

test('no endpoint, no tokens, or an unacceptable URL means nothing is attempted', async (t) => {
  const idp = await startIdp(t);
  assert.deepEqual(await revokeTokens(undefined, { refreshToken: 'x' }, deps()), { attempted: 0, confirmed: 0, outcomes: [] });
  assert.deepEqual(await revokeTokens(idp.revokeSpec(), {}, deps()), { attempted: 0, confirmed: 0, outcomes: [] });
  // production policy: http is refused, so the token never leaves
  assert.deepEqual(await revokeTokens(idp.revokeSpec(), { refreshToken: 'x' }, deps({ policy: { allowInsecureLoopback: false } })), { attempted: 0, confirmed: 0, outcomes: [] });
  assert.equal(idp.log.length, 0);
});

test('the report never contains a token', async (t) => {
  const idp = await startIdp(t);
  const { access, refresh } = mint(idp);
  const r = await revokeTokens(idp.revokeSpec(), { accessToken: access, refreshToken: refresh }, deps());
  assert.equal(JSON.stringify(r).includes(access), false);
  assert.equal(JSON.stringify(r).includes(refresh), false);
});
