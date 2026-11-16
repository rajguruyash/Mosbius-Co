'use strict';

/**
 * The token provider: expiry, refresh, rotation, failure handling and the
 * disconnect race, against the stand-in provider and a fake clock.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { startIdp } = require('./fixtures/oauth-idp.cjs');
const { makeEnv, until } = require('./fixtures/oauth-env.cjs');
const loadTs = require('./load-ts.cjs');

const { mcpOauthRef } = loadTs('src/shared/mcpCatalog.ts');
const { serializeRecord } = loadTs('src/main/oauth/token-store.ts');

const SUBJECT = { id: 'gmail' };

async function signedIn(t, idpOpts = {}, envOpts = {}) {
  const idp = await startIdp(t, idpOpts);
  const env = await makeEnv(t, idp, envOpts);
  assert.deepEqual(await env.controller.signIn('gmail'), { ok: true });
  await Promise.all(env.pendingBrowse);
  const provider = env.controller.provider;
  const stored = (id = 'gmail') => JSON.parse(env.secrets.map.get(mcpOauthRef(id)));
  const bearer = (r) => r.headers.Authorization.replace(/^Bearer /, '');
  const refreshes = () => idp.tokenRequests('refresh_token');
  return { idp, env, provider, stored, bearer, refreshes };
}

// ─── the happy path and the clock ───────────────────────────────────────────

test('a fresh token is handed out as a Bearer header, with no call to the provider', async (t) => {
  const { idp, provider, stored, bearer, refreshes } = await signedIn(t);
  const r = await provider.accessHeaders(SUBJECT);
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r.headers), ['Authorization']);
  assert.equal(bearer(r), stored().accessToken);
  assert.equal(refreshes().length, 0);
  assert.equal(idp.liveAccessTokens().includes(bearer(r)), true);
});

test('EXPIRY: refreshed before the last two minutes, not after, and the new expiry is respected', async (t) => {
  const { env, provider, stored, bearer, refreshes } = await signedIn(t);
  const first = stored();
  env.clock.advance(3600_000 - 121_000);                         // 121 s left
  assert.equal(bearer(await provider.accessHeaders(SUBJECT)), first.accessToken);
  assert.equal(refreshes().length, 0);

  env.clock.advance(2_000);                                       // 119 s left: inside the margin
  const r = await provider.accessHeaders(SUBJECT);
  assert.equal(r.ok, true);
  assert.notEqual(bearer(r), first.accessToken);
  assert.equal(refreshes().length, 1);
  assert.equal(stored().expiresAt, env.clock.now + 3600_000, 'the new lifetime was recorded');
  assert.equal(stored().refreshToken, first.refreshToken, 'no rotation: the refresh token is kept');

  // and the new token is good for another hour without another call
  env.clock.advance(1800_000);
  await provider.accessHeaders(SUBJECT);
  assert.equal(refreshes().length, 1);
});

test('EXPIRY: a token already past its expiry is refreshed, never handed out', async (t) => {
  const { env, provider, stored, bearer } = await signedIn(t);
  const old = stored().accessToken;
  env.clock.advance(7 * 24 * 3600_000);
  const r = await provider.accessHeaders(SUBJECT);
  assert.equal(r.ok, true);
  assert.notEqual(bearer(r), old);
});

test('the refresh request carries the refresh token and client credentials in its body only', async (t) => {
  const { env, provider, idp, stored, refreshes } = await signedIn(t);
  const rt = stored().refreshToken;
  env.clock.advance(3600_000);
  await provider.accessHeaders(SUBJECT);
  const req = refreshes()[0];
  assert.equal(req.form.refresh_token, rt);
  assert.equal(req.form.client_id, 'client-gmail');
  assert.equal(req.form.client_secret, 'SECRET-gmail-DO-NOT-LEAK');
  assert.equal(req.headers.authorization, undefined);
  assert.equal(req.query.client_secret, undefined);
  assert.equal(idp.log.filter((r) => JSON.stringify(r.query).includes('SECRET')).length, 0, 'the secret is never in a URL');
});

test('status is answered from what is stored and never calls the provider', async (t) => {
  const { env, provider, idp } = await signedIn(t);
  const before = idp.log.length;
  for (let i = 0; i < 20; i++) provider.status('gmail');
  env.clock.advance(10 * 3600_000);
  assert.equal(provider.status('gmail'), 'connected', 'an expired token with a refresh token is still a live sign-in');
  assert.equal(idp.log.length, before);
});

// ─── single flight ──────────────────────────────────────────────────────────

test('SINGLE FLIGHT: 40 workers asking at once cause ONE refresh, and all get its token', async (t) => {
  const { env, provider, bearer, refreshes, idp } = await signedIn(t);
  env.clock.advance(3600_000);
  idp.inject('token', { delayMs: 150, status: 0 });             // keep the refresh in flight while the others arrive
  const results = await Promise.all(Array.from({ length: 40 }, () => provider.accessHeaders(SUBJECT)));
  assert.equal(refreshes().length, 1);
  assert.equal(new Set(results.map(bearer)).size, 1);
  assert.equal(results.every((r) => r.ok), true);
});

test('different integrations refresh independently and in parallel', async (t) => {
  const idp = await startIdp(t);
  const env = await makeEnv(t, idp, { ids: ['gmail', 'google-calendar'] });
  await env.controller.signIn('gmail');
  await env.controller.signIn('google-calendar');
  env.clock.advance(3600_000);
  idp.inject('token', { delayMs: 120, status: 0 }, 2);
  const [a, b] = await Promise.all([
    env.controller.provider.accessHeaders({ id: 'gmail' }),
    env.controller.provider.accessHeaders({ id: 'google-calendar' })
  ]);
  assert.equal(idp.tokenRequests('refresh_token').length, 2);
  assert.notEqual(a.headers.Authorization, b.headers.Authorization);
  assert.equal(JSON.parse(env.secrets.map.get(mcpOauthRef('gmail'))).accessToken, a.headers.Authorization.slice(7));
  assert.equal(JSON.parse(env.secrets.map.get(mcpOauthRef('google-calendar'))).accessToken, b.headers.Authorization.slice(7));
});

test('a refresh that fails is not remembered as success: the next caller after the cool-down tries again', async (t) => {
  const { env, provider, idp, refreshes } = await signedIn(t);
  env.clock.advance(3600_000);
  idp.inject('token', { status: 503, body: {} }, 3);
  assert.deepEqual(await provider.accessHeaders(SUBJECT), { ok: false, code: 'unavailable' });
  env.clock.advance(100);
  assert.equal((await provider.accessHeaders(SUBJECT)).ok, true);
  assert.equal(refreshes().length, 4);
});

// ─── rotation ───────────────────────────────────────────────────────────────

test('ROTATION: the new refresh token is saved BEFORE the new access token is handed out', async (t) => {
  const { env, provider, idp, stored, refreshes } = await signedIn(t, { rotate: true });
  const oldRt = stored().refreshToken;
  env.clock.advance(3600_000);

  let handedOut = false;
  const realSet = env.secrets.set;
  const saveWhileNotHandedOut = [];
  env.secrets.set = (ref, v) => { saveWhileNotHandedOut.push({ ref, handedOut, rt: JSON.parse(v).refreshToken }); return realSet(ref, v); };

  const r = await provider.accessHeaders(SUBJECT).then((x) => { handedOut = true; return x; });
  assert.equal(r.ok, true);
  assert.equal(saveWhileNotHandedOut.length, 1);
  assert.equal(saveWhileNotHandedOut[0].handedOut, false, 'the record was written first');
  assert.notEqual(saveWhileNotHandedOut[0].rt, oldRt, 'and it holds the NEW refresh token');
  assert.equal(stored().refreshToken, saveWhileNotHandedOut[0].rt);
  assert.equal(idp.grants.get(oldRt).revoked, true, 'the provider has retired the old one');

  // and the chain goes on: the next refresh uses the rotated token and succeeds
  env.clock.advance(3600_000);
  assert.equal((await provider.accessHeaders(SUBJECT)).ok, true);
  assert.equal(refreshes()[1].form.refresh_token, saveWhileNotHandedOut[0].rt);
});

test('ROTATION: a store that cannot be written does not drop the session; the save is retried', async (t) => {
  const { env, provider, idp, stored, bearer } = await signedIn(t, { rotate: true });
  const oldStored = stored();
  env.clock.advance(3600_000);
  env.secrets.failSet = true;
  const r = await provider.accessHeaders(SUBJECT);
  assert.equal(r.ok, true, 'the running session keeps working from memory');
  assert.deepEqual(stored(), oldStored, 'but the disk still holds the OLD record: that is the hazard being reported');
  assert.ok(env.logs.some((l) => l.includes('"event":"token.refreshed"') && l.includes('"saved":false')));

  env.secrets.failSet = false;
  const again = await provider.accessHeaders(SUBJECT);
  assert.equal(bearer(again), bearer(r), 'same token, no new refresh');
  assert.notEqual(stored().refreshToken, oldStored.refreshToken, 'the rotated token reached the disk as soon as the store came back');
  assert.equal(idp.grants.get(stored().refreshToken).revoked, false);
});

// ─── refresh failures ───────────────────────────────────────────────────────

test('REFRESH FAILURE (permanent): invalid_grant ends the sign-in, is remembered, and the provider is not asked again', async (t) => {
  const { env, provider, idp, stored, refreshes } = await signedIn(t);
  idp.revokeGrant(stored().refreshToken);                       // the user revoked access in their Google account
  env.clock.advance(3600_000);
  assert.deepEqual(await provider.accessHeaders(SUBJECT), { ok: false, code: 'sign_in_required' });
  assert.equal(refreshes().length, 1);
  assert.equal(stored().dead.reason, 'invalid_grant', 'persisted, so a restart does not forget it');
  assert.equal(provider.status('gmail'), 'needs-signin');
  for (let i = 0; i < 5; i++) assert.equal((await provider.accessHeaders(SUBJECT)).code, 'sign_in_required');
  assert.equal(refreshes().length, 1, 'no hammering of a provider that has said no');

  // signing in again replaces the dead record
  env.controller.forget('gmail');
  env.secrets.map.delete(mcpOauthRef('gmail'));
  assert.deepEqual(await env.controller.signIn('gmail'), { ok: true });
  assert.equal((await env.controller.provider.accessHeaders(SUBJECT)).ok, true);
  assert.equal(env.controller.status('gmail'), 'connected');
});

test('REFRESH FAILURE (permanent): the dead flag survives a restart', async (t) => {
  const { env, provider, idp, stored } = await signedIn(t);
  idp.revokeGrant(stored().refreshToken);
  env.clock.advance(3600_000);
  await provider.accessHeaders(SUBJECT);
  // a new controller over the same store: what the app has after a restart
  const { OAuthController } = loadTs('src/main/oauth/controller.ts');
  const fresh = new OAuthController({ ...env.controller.deps });
  assert.equal(fresh.status('gmail'), 'needs-signin');
  assert.deepEqual(await fresh.provider.accessHeaders(SUBJECT), { ok: false, code: 'sign_in_required' });
  assert.equal(idp.tokenRequests('refresh_token').length, 1, 'the restarted app did not ask again');
  fresh.dispose();
});

test('REFRESH FAILURE (transient): a 503 is retried with backoff, then cooled down; the sign-in is NOT discarded', async (t) => {
  const { env, provider, idp, stored, refreshes } = await signedIn(t, {}, { timeouts: { retryDelaysMs: [10, 20] } });
  const before = stored();
  env.clock.advance(3600_000);
  idp.inject('token', { status: 503, body: {} }, 3);
  assert.deepEqual(await provider.accessHeaders(SUBJECT), { ok: false, code: 'unavailable' });
  assert.equal(refreshes().length, 3, 'one try and two retries');
  assert.deepEqual(env.sleeps, [10, 20], 'with the configured backoff between them');
  assert.deepEqual(stored(), before, 'nothing about the stored sign-in changed');
  assert.equal(provider.status('gmail'), 'connected');

  // during the cool-down the provider is left alone
  assert.deepEqual(await provider.accessHeaders(SUBJECT), { ok: false, code: 'unavailable' });
  assert.equal(refreshes().length, 3);

  // after it, the provider recovered
  env.clock.advance(100);
  assert.equal((await provider.accessHeaders(SUBJECT)).ok, true);
  assert.equal(refreshes().length, 4);
});

test('REFRESH FAILURE: a transient failure that clears on the retry is invisible to the caller', async (t) => {
  const { env, provider, idp, refreshes } = await signedIn(t);
  env.clock.advance(3600_000);
  idp.inject('token', { status: 500, body: {} });
  assert.equal((await provider.accessHeaders(SUBJECT)).ok, true);
  assert.equal(refreshes().length, 2);
});

for (const [what, injected] of [
  ['an unknown 400', { status: 400, body: { error: 'invalid_request' } }],
  ['a 403', { status: 403, body: {} }],
  ['a 200 that is not a token response', { status: 200, body: { nope: true } }],
  ['a 200 that is HTML', { status: 200, raw: '<html>' }],
  ['a dropped connection', { destroy: true }],
  ['a hung connection', { hang: true }],
  ['an oversized answer', { status: 200, raw: 'x'.repeat(300 * 1024) }],
  ['a redirect', { redirect: 'https://evil.example/steal' }]
]) {
  test(`REFRESH FAILURE: ${what} is "unavailable" and does not discard a working sign-in`, async (t) => {
    const { env, provider, idp, stored } = await signedIn(t, {}, { timeouts: { refreshMs: 200, retryDelaysMs: [] } });
    const before = stored();
    env.clock.advance(3600_000);
    idp.inject('token', injected);
    assert.deepEqual(await provider.accessHeaders(SUBJECT), { ok: false, code: 'unavailable' });
    assert.deepEqual(stored(), before, 'the record was not marked dead');
    assert.equal(provider.status('gmail'), 'connected');
    assert.equal(idp.log.some((r) => r.path === '/steal'), false);
  });
}

test('REFRESH: the refresh token is never sent to a redirect target', async (t) => {
  const { env, provider, idp } = await signedIn(t, {}, { timeouts: { retryDelaysMs: [] } });
  env.clock.advance(3600_000);
  idp.inject('token', { redirect: `${idp.issuer}/leak` });
  await provider.accessHeaders(SUBJECT);
  assert.equal(idp.requests('/leak').length, 0, 'redirects are not followed');
});

test('a sign-in with no refresh token ends at expiry: sign in again, no refresh attempted', async (t) => {
  const { env, provider, idp, stored } = await signedIn(t);
  const record = { ...stored() };
  delete record.refreshToken;
  env.secrets.map.set(mcpOauthRef('gmail'), serializeRecord(record));
  env.controller.forget('gmail');
  assert.equal(provider.status('gmail'), 'connected', 'still good until it expires');
  assert.equal((await provider.accessHeaders(SUBJECT)).ok, true);
  env.clock.advance(3600_000);
  assert.equal(provider.status('gmail'), 'needs-signin');
  assert.deepEqual(await provider.accessHeaders(SUBJECT), { ok: false, code: 'sign_in_required' });
  assert.equal(idp.tokenRequests('refresh_token').length, 0);
  assert.equal(stored().dead.reason, 'no_refresh_token');
});

test('a provider that gives no lifetime: the token is used until the upstream refuses it', async (t) => {
  const { env, provider, stored, bearer } = await signedIn(t);
  const record = { ...stored() };
  delete record.expiresAt;
  env.secrets.map.set(mcpOauthRef('gmail'), serializeRecord(record));
  env.controller.forget('gmail');
  env.clock.advance(365 * 24 * 3600_000);
  assert.equal(bearer(await provider.accessHeaders(SUBJECT)), record.accessToken);
  provider.markRejected('gmail', record.accessToken);
  assert.equal((await provider.accessHeaders(SUBJECT)).ok, true, 'a rejection triggers a refresh, which this provider supports');
});

// ─── the upstream said 401 ──────────────────────────────────────────────────

test('REJECTED BY THE UPSTREAM: the next request refreshes — once; a refresh loop is not possible', async (t) => {
  const { env, provider, bearer, refreshes } = await signedIn(t);
  const first = bearer(await provider.accessHeaders(SUBJECT));

  provider.markRejected('gmail', 'some-older-token');
  assert.equal(bearer(await provider.accessHeaders(SUBJECT)), first, 'a rejection of a token we no longer hold means nothing');
  assert.equal(refreshes().length, 0);

  provider.markRejected('gmail', first);
  const second = bearer(await provider.accessHeaders(SUBJECT));
  assert.notEqual(second, first);
  assert.equal(refreshes().length, 1);

  provider.markRejected('gmail', second);                       // an immediate second rejection
  assert.equal(bearer(await provider.accessHeaders(SUBJECT)), second, 'rate-limited: no second refresh within ten seconds');
  assert.equal(refreshes().length, 1);

  env.clock.advance(11_000);
  provider.markRejected('gmail', second);
  assert.notEqual(bearer(await provider.accessHeaders(SUBJECT)), second);
  assert.equal(refreshes().length, 2);
});

// ─── whose tokens are these? ────────────────────────────────────────────────

test('a CHANGED OAuth client id invalidates the sign-in without sending the old refresh token to anyone', async (t) => {
  const { env, provider, idp } = await signedIn(t);
  const before = idp.log.length;
  env.secrets.map.set('mcp:gmail:client_id', 'a-brand-new-client');
  assert.equal(provider.status('gmail'), 'needs-signin');
  assert.deepEqual(await provider.accessHeaders(SUBJECT), { ok: false, code: 'sign_in_required' });
  env.clock.advance(3600_000);
  assert.deepEqual(await provider.accessHeaders(SUBJECT), { ok: false, code: 'sign_in_required' });
  assert.equal(idp.log.length, before, 'nothing was sent to the provider with the other client\'s credentials');
});

test('a rotated client SECRET (same id) keeps the sign-in and is used for the next refresh', async (t) => {
  const { env, provider, idp, refreshes } = await signedIn(t);
  idp.clients.get('client-gmail').secret = 'the-new-secret';
  env.secrets.map.set('mcp:gmail:client_secret', 'the-new-secret');
  env.clock.advance(3600_000);
  assert.equal((await provider.accessHeaders(SUBJECT)).ok, true);
  assert.equal(refreshes()[0].form.client_secret, 'the-new-secret');
});

test('with the OAuth client removed there is nothing to sign in with: no_secret, and "unconfigured"', async (t) => {
  const { env, provider } = await signedIn(t);
  env.secrets.map.delete('mcp:gmail:client_id');
  assert.deepEqual(await provider.accessHeaders(SUBJECT), { ok: false, code: 'no_secret' });
  assert.equal(provider.status('gmail'), 'unconfigured');
  assert.deepEqual(await provider.accessHeaders({ id: 'notion' }), { ok: false, code: 'no_secret' });
  assert.deepEqual(await provider.accessHeaders({ id: '__proto__' }), { ok: false, code: 'no_secret' });
});

test('signed out: sign_in_required, and "signed-out"', async (t) => {
  const idp = await startIdp(t);
  const env = await makeEnv(t, idp);
  assert.equal(env.controller.status('gmail'), 'signed-out');
  assert.deepEqual(await env.controller.provider.accessHeaders(SUBJECT), { ok: false, code: 'sign_in_required' });
});

// ─── damaged and unavailable credentials ────────────────────────────────────

const MALFORMED = {
  'not JSON': 'this is not json',
  'JSON but not an object': '[1,2,3]',
  'an empty object': '{}',
  'a version from the future': JSON.stringify({ v: 2, accessToken: 'x', obtainedAt: 1, clientFingerprint: '0123456789abcdef' }),
  'a missing access token': JSON.stringify({ v: 1, obtainedAt: 1, clientFingerprint: '0123456789abcdef' }),
  'an access token with a newline in it': JSON.stringify({ v: 1, accessToken: 'abc\r\nX-Injected: 1', obtainedAt: 1, clientFingerprint: '0123456789abcdef' }),
  'an access token of the wrong type': JSON.stringify({ v: 1, accessToken: 12345, obtainedAt: 1, clientFingerprint: '0123456789abcdef' }),
  'a refresh token that is not a string': JSON.stringify({ v: 1, accessToken: 'a', refreshToken: { x: 1 }, obtainedAt: 1, clientFingerprint: '0123456789abcdef' }),
  'an expiry that is not a number': JSON.stringify({ v: 1, accessToken: 'a', expiresAt: 'soon', obtainedAt: 1, clientFingerprint: '0123456789abcdef' }),
  'a bad fingerprint': JSON.stringify({ v: 1, accessToken: 'a', obtainedAt: 1, clientFingerprint: 'nope' }),
  'a dead marker of the wrong shape': JSON.stringify({ v: 1, accessToken: 'a', obtainedAt: 1, clientFingerprint: '0123456789abcdef', dead: 'yes' }),
  'a huge token': JSON.stringify({ v: 1, accessToken: 'x'.repeat(9000), obtainedAt: 1, clientFingerprint: '0123456789abcdef' })
};
for (const [what, text] of Object.entries(MALFORMED)) {
  test(`MALFORMED credential (${what}): sign_in_required, never a crash, never sent anywhere`, async (t) => {
    const idp = await startIdp(t);
    const env = await makeEnv(t, idp);
    env.secrets.map.set(mcpOauthRef('gmail'), text);
    assert.deepEqual(await env.controller.provider.accessHeaders(SUBJECT), { ok: false, code: 'sign_in_required' });
    assert.equal(env.controller.status('gmail'), 'needs-signin');
    assert.equal(idp.log.length, 0);
    assert.equal(env.secrets.map.get(mcpOauthRef('gmail')), text, 'left alone: it may belong to a newer version of the app');
    assert.ok(env.logs.some((l) => l.includes('token.malformed')));
    // signing in again overwrites it
    env.secrets.map.delete(mcpOauthRef('gmail'));
  });
}

test('UNAVAILABLE: a store that cannot be read is "unavailable", not "signed out", and recovers on its own', async (t) => {
  const { env, provider, idp } = await signedIn(t);
  env.controller.forget('gmail');                                // drop the cache so the store is consulted
  env.secrets.unreadable = true;
  // the client halves cannot be read either, so this is first "unconfigured"; make only the token record unreadable:
  env.secrets.unreadable = false;
  env.secrets.undecryptable.add(mcpOauthRef('gmail'));
  const before = idp.log.length;
  assert.deepEqual(await provider.accessHeaders(SUBJECT), { ok: false, code: 'unavailable' });
  assert.equal(provider.status('gmail'), 'unavailable');
  assert.ok(env.logs.some((l) => l.includes('undecryptable')));
  assert.equal(idp.log.length, before);
  env.secrets.undecryptable.clear();                              // the keychain is back
  assert.equal((await provider.accessHeaders(SUBJECT)).ok, true);
});

test('UNAVAILABLE: an unreadable store is reported as such', async (t) => {
  const idp = await startIdp(t);
  const env = await makeEnv(t, idp);
  // clients are held by the test's own accessor; make only the token ref fail the "readable" probe
  const realReadable = env.secrets.readable;
  env.secrets.map.set(mcpOauthRef('gmail'), 'ignored');
  env.secrets.undecryptable.add(mcpOauthRef('gmail'));
  env.secrets.readable = () => false;
  assert.deepEqual(await env.controller.provider.accessHeaders(SUBJECT), { ok: false, code: 'unavailable' });
  assert.ok(env.logs.some((l) => l.includes('store-unreadable')));
  env.secrets.readable = realReadable;
});

// ─── disconnect wins every race ─────────────────────────────────────────────

test('DISCONNECT RACE: a refresh on the wire when the user disconnects is discarded, not saved', async (t) => {
  const { env, provider, idp, stored } = await signedIn(t, { rotate: true });
  env.clock.advance(3600_000);
  idp.inject('token', { delayMs: 300, status: 0 });
  const inflight = provider.accessHeaders(SUBJECT);
  await until(() => idp.tokenRequests('refresh_token').length === 1);

  // the user presses Disconnect: forget the memory, delete the stored record
  env.controller.forget('gmail');
  env.secrets.map.delete(mcpOauthRef('gmail'));
  const wiped = env.secrets.sets.length;

  assert.deepEqual(await inflight, { ok: false, code: 'sign_in_required' });
  await new Promise((r) => setTimeout(r, 400));                   // let the stand-in's late answer arrive
  assert.equal(env.secrets.map.has(mcpOauthRef('gmail')), false, 'a late answer must not undo a disconnect');
  assert.equal(env.secrets.sets.length, wiped, 'and nothing was written');
  assert.equal(provider.status('gmail'), 'signed-out');
});

test('DISCONNECT RACE: callers waiting on a refresh when the user disconnects get a refusal, not a token', async (t) => {
  const { env, provider, idp } = await signedIn(t);
  env.clock.advance(3600_000);
  idp.inject('token', { delayMs: 200, status: 0 });
  const waiting = Promise.all([provider.accessHeaders(SUBJECT), provider.accessHeaders(SUBJECT), provider.accessHeaders(SUBJECT)]);
  await until(() => idp.tokenRequests('refresh_token').length === 1);
  env.controller.forget('gmail');
  env.secrets.map.delete(mcpOauthRef('gmail'));
  for (const r of await waiting) assert.deepEqual(r, { ok: false, code: 'sign_in_required' });
});

test('another process may have rotated the token: its record is used and ours is not spent', async (t) => {
  const { env, provider, idp, stored, bearer, refreshes } = await signedIn(t, { rotate: true });
  await provider.accessHeaders(SUBJECT);                          // prime the cache
  // a second instance refreshed and wrote the rotated record
  env.clock.advance(3600_000);
  const rotated = { ...stored(), accessToken: 'at-from-the-other-instance', refreshToken: 'rt-from-the-other-instance', expiresAt: env.clock.now + 3600_000, obtainedAt: env.clock.now };
  env.secrets.map.set(mcpOauthRef('gmail'), serializeRecord(rotated));
  const r = await provider.accessHeaders(SUBJECT);
  assert.equal(bearer(r), 'at-from-the-other-instance');
  assert.equal(refreshes().length, 0, 'the provider was not asked: our refresh token was left unspent');
});

// ─── shutdown ───────────────────────────────────────────────────────────────

test('SHUTDOWN: after dispose nothing is handed out, and a refresh on the wire is aborted', async (t) => {
  const { env, provider, idp } = await signedIn(t);
  env.clock.advance(3600_000);
  idp.inject('token', { hang: true });
  const inflight = provider.accessHeaders(SUBJECT);
  await until(() => idp.tokenRequests('refresh_token').length === 1);
  const t0 = Date.now();
  env.controller.dispose();
  assert.deepEqual(await inflight, { ok: false, code: 'sign_in_required' });
  assert.ok(Date.now() - t0 < 1000, 'it did not wait out the hung request');
  assert.deepEqual(await provider.accessHeaders(SUBJECT), { ok: false, code: 'unavailable' });
});

test('CRASH RECOVERY: a restart finds the record exactly as the last save left it, and keeps working', async (t) => {
  const { env, provider, stored, bearer } = await signedIn(t, { rotate: true });
  env.clock.advance(3600_000);
  await provider.accessHeaders(SUBJECT);                          // rotate and save
  const onDisk = stored();
  const { OAuthController } = loadTs('src/main/oauth/controller.ts');
  const afterCrash = new OAuthController({ ...env.controller.deps });     // no dispose(): the old one just vanished
  assert.equal(afterCrash.status('gmail'), 'connected');
  const r = await afterCrash.provider.accessHeaders(SUBJECT);
  assert.equal(bearer(r), onDisk.accessToken);
  env.clock.advance(3600_000);
  assert.equal((await afterCrash.provider.accessHeaders(SUBJECT)).ok, true, 'and it can refresh with the rotated token');
  afterCrash.dispose();
});

test('SINGLE FLIGHT survives a disconnect: a refresh finishing late does not evict the newer refresh from the slot', async (t) => {
  const { env, provider, idp, stored, refreshes } = await signedIn(t);
  const oldRecord = stored();
  env.clock.advance(3600_000);

  idp.inject('token', { delayMs: 300, status: 0 });           // refresh #1: slow
  const first = provider.accessHeaders(SUBJECT);
  await until(() => refreshes().length === 1);

  // the user disconnects and signs in again: a new record, already expired
  env.controller.forget('gmail');
  provider.adopt('gmail', { ...oldRecord, expiresAt: env.clock.now - 1 });
  idp.inject('token', { delayMs: 450, status: 0 });           // refresh #2: slower still
  const second = provider.accessHeaders(SUBJECT);
  await until(() => refreshes().length === 2);

  await new Promise((r) => setTimeout(r, 350));               // refresh #1 has now finished and run its cleanup; #2 is still on the wire
  const third = provider.accessHeaders(SUBJECT);              // must JOIN #2, not start a #3
  assert.deepEqual(await first, { ok: false, code: 'sign_in_required' }, 'the pre-disconnect refresh was discarded');
  assert.equal((await second).ok, true);
  assert.equal((await third).ok, true);
  assert.equal(refreshes().length, 2, 'a late finish must not let a third caller start another refresh');
});
