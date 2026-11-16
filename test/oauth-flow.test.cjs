'use strict';

/**
 * The in-app OAuth sign-in, end to end, against a stand-in provider that behaves
 * like a careful real one (see fixtures/oauth-idp.cjs). Nothing here reaches a real
 * provider: the test environment's fetch refuses anything that is not loopback.
 *
 * What is covered: the happy path and the exact shape of the requests; state
 * mismatch; PKCE mismatch; replayed callbacks and replayed codes; invalid and forged
 * callbacks (which must never abort a sign-in that is waiting); `iss` handling;
 * refusal by the user; every way the token endpoint can fail; timeout, cancel, a busy
 * port; and several sign-ins running at once.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { startIdp } = require('./fixtures/oauth-idp.cjs');
const { makeEnv, rawGet, browse, until, freePort, loadTs } = require('./fixtures/oauth-env.cjs');

const { verifyS256, challengeS256, newCodeVerifier } = loadTs('src/main/oauth/pkce.ts');
const { mcpOauthRef } = loadTs('src/shared/mcpCatalog.ts');

const portIsFree = (port) => new Promise((resolve) => {
  const s = net.createConnection({ host: '127.0.0.1', port });
  s.once('connect', () => { s.destroy(); resolve(false); });
  s.once('error', () => resolve(true));
});

/** Start a sign-in with a browser that never finishes it by itself; hand back what a test needs to drive it. */
async function pending(t, idp, opts = {}) {
  const env = await makeEnv(t, idp, { ...opts, browser: null });
  const result = env.controller.signIn(opts.id ?? 'gmail');
  await until(() => env.opened.length > 0);
  const url = new URL(env.opened[0]);
  const id = opts.id ?? 'gmail';
  const port = env.ports[id];
  return {
    env, result, url, port,
    state: url.searchParams.get('state'),
    cb: (qs, o) => rawGet(port, `/oauth/callback${qs}`, o),
    finish: () => browse(env.opened[0], env)
  };
}

// ─── the happy path ─────────────────────────────────────────────────────────

test('a sign-in completes, with exactly the requests a careful provider expects', async (t) => {
  const idp = await startIdp(t);
  const env = await makeEnv(t, idp);
  const res = await env.controller.signIn('gmail');
  await Promise.all(env.pendingBrowse);
  assert.deepEqual(res, { ok: true });
  assert.deepEqual(env.browseErrors, []);

  // the authorization request
  const authz = idp.requests('/authorize');
  assert.equal(authz.length, 1);
  const q = authz[0].query;
  assert.equal(q.response_type, 'code');
  assert.equal(q.client_id, 'client-gmail');
  assert.equal(q.redirect_uri, `http://127.0.0.1:${env.ports.gmail}/oauth/callback`, 'the exact registered redirect URI');
  assert.equal(q.code_challenge_method, 'S256');
  assert.match(q.code_challenge, /^[A-Za-z0-9_-]{43}$/);
  assert.match(q.state, /^[A-Za-z0-9_-]{43}$/);
  assert.match(q.scope, /gmail\.readonly/);
  assert.equal(q.access_type, 'offline', 'Google only issues a refresh token for offline access');
  assert.equal(q.prompt, 'consent');
  assert.equal(q.client_secret, undefined, 'the client secret is never in the authorization URL');
  assert.equal(q.code_verifier, undefined);
  assert.deepEqual(env.opened, [`${idp.issuer}/authorize?${new URLSearchParams(q).toString()}`.replace(/%20/g, '+')].map((u) => env.opened[0]), 'one browser window');

  // the token request: one, with the verifier, the secret in the body only
  const tok = idp.tokenRequests();
  assert.equal(tok.length, 1);
  assert.equal(tok[0].form.grant_type, 'authorization_code');
  assert.equal(tok[0].form.redirect_uri, q.redirect_uri);
  assert.equal(tok[0].form.client_id, 'client-gmail');
  assert.equal(tok[0].form.client_secret, 'SECRET-gmail-DO-NOT-LEAK');
  assert.equal(verifyS256(tok[0].form.code_verifier, q.code_challenge), true, 'the verifier is the one the challenge was made from');
  assert.equal(tok[0].headers.authorization, undefined, 'client_secret_post: no Authorization header');
  assert.equal(idp.stats.pkceFailures, 0);

  // what was stored, and where
  assert.equal(env.controller.status('gmail'), 'connected');
  const sealed = env.secrets.map.get(mcpOauthRef('gmail'));
  const record = JSON.parse(sealed);
  assert.equal(record.v, 1);
  assert.match(record.accessToken, /^at-/);
  assert.match(record.refreshToken, /^rt-/);
  assert.equal(record.expiresAt, env.clock.now + 3600_000);
  assert.equal(sealed.includes('SECRET-gmail'), false, 'the client secret is not in the token record');
  assert.equal(sealed.includes(tok[0].form.code), false, 'nor is the authorization code');
  assert.equal(sealed.includes(tok[0].form.code_verifier), false, 'nor the verifier');
  assert.equal(await portIsFree(env.ports.gmail), true, 'the callback listener is gone');
});

test('the page the browser lands on is static, uncacheable, and echoes nothing', async (t) => {
  const idp = await startIdp(t);
  const env = await makeEnv(t, idp, { browser: null });
  const res = env.controller.signIn('gmail');
  await until(() => env.opened.length > 0);
  const r = await browse(env.opened[0], env);
  assert.deepEqual(await res, { ok: true });
  assert.equal(r.callback.status, 200);
  assert.match(r.callback.body, /Gmail is connected/);
  assert.equal(r.callback.headers['cache-control'], 'no-store');
  assert.equal(r.callback.headers['referrer-policy'], 'no-referrer');
  assert.equal(r.callback.headers['x-content-type-options'], 'nosniff');
  assert.match(r.callback.headers['content-security-policy'], /default-src 'none'/);
  const loc = new URL(r.location);
  assert.equal(r.callback.body.includes(loc.searchParams.get('code')), false, 'the code is not reflected');
  assert.equal(r.callback.body.includes(loc.searchParams.get('state')), false, 'nor the state');
  assert.equal(/<script/i.test(r.callback.body), false);
});

test('already signed in: a second call returns ok without opening a browser', async (t) => {
  const idp = await startIdp(t);
  const env = await makeEnv(t, idp);
  assert.deepEqual(await env.controller.signIn('gmail'), { ok: true });
  assert.deepEqual(await env.controller.signIn('gmail'), { ok: true });
  assert.equal(env.opened.length, 1);
});

test('no OAuth client stored: refused before anything is opened or bound', async (t) => {
  const idp = await startIdp(t);
  const env = await makeEnv(t, idp);
  env.secrets.map.delete('mcp:gmail:client_secret');
  assert.deepEqual(await env.controller.signIn('gmail'), { ok: false, error: 'no-client' });
  assert.equal(env.opened.length, 0);
  assert.equal(await portIsFree(env.ports.gmail), true);
});

test('an unknown integration, or one with no in-app sign-in, is refused', async (t) => {
  const idp = await startIdp(t);
  const env = await makeEnv(t, idp);
  for (const id of ['nope', 'notion', '__proto__', '']) assert.deepEqual(await env.controller.signIn(id), { ok: false, error: 'failed' }, id);
});

// ─── state ──────────────────────────────────────────────────────────────────

test('STATE MISMATCH: a redirect with the wrong state is ignored, no code is exchanged, and the sign-in is still waiting', async (t) => {
  const idp = await startIdp(t);
  idp.stateParam = 'wrong';
  const env = await makeEnv(t, idp, { browser: 'auto', timeouts: { timeoutMs: 600 } });
  const res = await env.controller.signIn('gmail');
  await Promise.all(env.pendingBrowse);
  assert.deepEqual(res, { ok: false, error: 'timeout' }, 'it kept waiting for the real redirect until it timed out');
  assert.equal(idp.tokenRequests().length, 0, 'a code that came with the wrong state was never exchanged');
  assert.equal(env.secrets.map.has(mcpOauthRef('gmail')), false);
});

test('STATE MISSING: the same', async (t) => {
  const idp = await startIdp(t);
  idp.stateParam = 'missing';
  const env = await makeEnv(t, idp, { browser: 'auto', timeouts: { timeoutMs: 400 } });
  assert.deepEqual(await env.controller.signIn('gmail'), { ok: false, error: 'timeout' });
  assert.equal(idp.tokenRequests().length, 0);
});

test('the state is unique per sign-in and never reused', async (t) => {
  const idp = await startIdp(t);
  const env = await makeEnv(t, idp, { ids: ['gmail', 'google-calendar', 'google-drive'] });
  const states = new Set();
  for (const id of ['gmail', 'google-calendar', 'google-drive']) {
    assert.deepEqual(await env.controller.signIn(id), { ok: true });
  }
  for (const u of env.opened) states.add(new URL(u).searchParams.get('state'));
  assert.equal(states.size, 3);
});

// ─── forged and malformed callbacks must not abort a waiting sign-in ────────

test('FORGED AND MALFORMED CALLBACKS never abort a sign-in that is waiting for the real one', async (t) => {
  const idp = await startIdp(t);
  const p = await pending(t, idp);
  const ok = 'code=4%2Fxxx&iss=' + encodeURIComponent(idp.issuer);
  const forged = [
    ['no parameters', () => p.cb('')],
    ['wrong state', () => p.cb(`?state=${'A'.repeat(43)}&${ok}`)],
    ['empty state', () => p.cb(`?state=&${ok}`)],
    ['state missing', () => p.cb(`?${ok}`)],
    ['state of the right length but wrong', () => p.cb(`?state=${p.state.slice(0, -1)}${p.state.endsWith('A') ? 'B' : 'A'}&${ok}`)],
    ['a different path', () => rawGet(p.port, `/oauth/callbackX?state=${p.state}&${ok}`)],
    ['the root', () => rawGet(p.port, `/?state=${p.state}&${ok}`)],
    ['a path traversal', () => rawGet(p.port, `/oauth/../oauth/callback?state=${p.state}&${ok}`)],
    ['POST', () => p.cb(`?state=${p.state}&${ok}`, { method: 'POST' })],
    ['PUT', () => p.cb(`?state=${p.state}&${ok}`, { method: 'PUT' })],
    ['a DNS-rebound Host', () => p.cb(`?state=${p.state}&${ok}`, { host: 'evil.example.com' })],
    ['the right Host on the wrong port', () => p.cb(`?state=${p.state}&${ok}`, { host: '127.0.0.1:80' })],
    ['localhost instead of 127.0.0.1', () => p.cb(`?state=${p.state}&${ok}`, { host: `localhost:${p.port}` })],
    ['a fetch(), not a navigation', () => p.cb(`?state=${p.state}&${ok}`, { headers: { 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' } })],
    ['an <img>', () => p.cb(`?state=${p.state}&${ok}`, { headers: { 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' } })],
    ['an <iframe>', () => p.cb(`?state=${p.state}&${ok}`, { headers: { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' } })],
    ['duplicate state', () => p.cb(`?state=${p.state}&state=${p.state}&${ok}`)],
    ['duplicate code', () => p.cb(`?state=${p.state}&code=a&code=b&iss=${encodeURIComponent(idp.issuer)}`)],
    ['an oversized parameter', () => p.cb(`?state=${p.state}&code=${'x'.repeat(3000)}`)],
    ['an oversized URL', () => p.cb(`?${'a=b&'.repeat(2000)}state=${p.state}`)],
    ['garbage', () => rawGet(p.port, '/%E0%A4%A')]
  ];
  for (const [what, send] of forged) {
    const r = await send();
    assert.ok(r.status >= 400 && r.status < 500, `${what}: answered ${r.status}`);
    assert.equal(/code|state|4\/xxx/.test(r.body.replace(/not a sign-in the app is waiting for/, '')), false, `${what}: the response page echoes the request`);
    assert.equal(idp.tokenRequests().length, 0, `${what}: reached the token endpoint`);
    assert.equal(p.env.controller.status('gmail'), 'signed-out');
  }
  // and the REAL redirect still works after all of that
  const real = await p.finish();
  assert.equal(real.callback.status, 200);
  assert.deepEqual(await p.result, { ok: true });
  assert.equal(idp.tokenRequests().length, 1, 'exactly one exchange, for the one real redirect');
});

test('a flood of forged requests never locks the user out of their own sign-in', async (t) => {
  const idp = await startIdp(t);
  const p = await pending(t, idp);
  const statuses = new Set();
  for (let i = 0; i < 600; i++) statuses.add((await p.cb(`?state=wrong${i}`)).status);
  assert.deepEqual([...statuses], [400], 'every one is refused the same way; the listener never stops answering');
  const real = await p.finish();
  assert.equal(real.callback.status, 200, 'the real redirect is still honoured after the flood');
  assert.deepEqual(await p.result, { ok: true });
  assert.equal(idp.tokenRequests().length, 1);
  // the log is throttled, not flooded
  assert.ok(p.env.logs.filter((l) => l.includes('callback.ignored')).length < 40, 'a flood must not become a log flood');
});

test('a callback aimed at one integration\'s port with another\'s state is refused and disturbs neither', async (t) => {
  const idp = await startIdp(t);
  const env = await makeEnv(t, idp, { ids: ['gmail', 'google-drive'], browser: null });
  const a = env.controller.signIn('gmail');
  const b = env.controller.signIn('google-drive');
  await until(() => env.opened.length === 2);
  const [urlA, urlB] = env.opened.map((u) => new URL(u));
  assert.notEqual(urlA.searchParams.get('state'), urlB.searchParams.get('state'));
  // deliver gmail's state to drive's port, and drive's to gmail's
  const cross1 = await rawGet(env.ports['google-drive'], `/oauth/callback?state=${urlA.searchParams.get('state')}&code=4%2Fa&iss=${encodeURIComponent(idp.issuer)}`);
  const cross2 = await rawGet(env.ports.gmail, `/oauth/callback?state=${urlB.searchParams.get('state')}&code=4%2Fb&iss=${encodeURIComponent(idp.issuer)}`);
  assert.equal(cross1.status, 400);
  assert.equal(cross2.status, 400);
  assert.equal(idp.tokenRequests().length, 0);
  await Promise.all(env.opened.map((u) => browse(u, env)));
  assert.deepEqual(await a, { ok: true });
  assert.deepEqual(await b, { ok: true });
});

// ─── replay ─────────────────────────────────────────────────────────────────

test('REPLAYED CALLBACK: the same redirect delivered twice is exchanged once', async (t) => {
  const idp = await startIdp(t);
  idp.inject('token', { delayMs: 250, status: 0 }, 0);                      // (no-op; keep the helper honest)
  const p = await pending(t, idp);
  // slow the exchange so the replay lands while the first is in flight
  const tokenDelay = { delayMs: 300 };
  idp.inject('token', { ...tokenDelay, status: 0 });
  const first = await fetch(p.env.opened[0], { redirect: 'manual' });
  const loc = new URL(first.headers.get('location'));
  const qs = loc.search;
  const firstHit = p.cb(qs);                                                 // not awaited: the exchange is slow
  await until(() => idp.requests('/token').length === 1);
  const replay = await p.cb(qs);                                             // the very same URL again
  assert.equal(replay.status, 400, 'the replay is refused');
  assert.equal(idp.requests('/token').length, 1, 'the code was not presented a second time');
  assert.ok(p.env.logs.some((l) => l.includes('"reason":"replayed"')), 'refused because the state was already spent, not by a later check');
  const landed = await firstHit;
  assert.equal(landed.status, 200, 'the genuine redirect still got its success page');
  assert.deepEqual(await p.result, { ok: true }, 'a replay must not end, or fail, the sign-in it tried to copy');
  assert.equal(idp.stats.replayedCodes, 0, 'the provider never saw the code twice');
});

test('REPLAYED CODE: a code this app already used is never sent again, even under a fresh state', async (t) => {
  const idp = await startIdp(t);
  const env = await makeEnv(t, idp, { ids: ['gmail'], browser: 'auto' });
  assert.deepEqual(await env.controller.signIn('gmail'), { ok: true });
  const usedCode = idp.tokenRequests()[0].form.code;

  // sign out, then start another sign-in and have an attacker deliver the OLD code with the NEW state
  env.controller.forget('gmail');
  env.secrets.map.delete(mcpOauthRef('gmail'));
  env.browser = null;
  const again = env.controller.signIn('gmail');
  await until(() => env.opened.length === 2);
  const state2 = new URL(env.opened[1]).searchParams.get('state');
  const r = await rawGet(env.ports.gmail, `/oauth/callback?state=${state2}&code=${encodeURIComponent(usedCode)}&iss=${encodeURIComponent(idp.issuer)}`);
  assert.equal(r.status, 400);
  assert.deepEqual(await again, { ok: false, error: 'invalid-callback' });
  assert.equal(idp.tokenRequests().length, 1, 'the used code never reached the provider a second time');
  assert.equal(idp.stats.replayedCodes, 0);
});

test('a code the provider itself refuses as replayed ends the sign-in, and nothing is retried', async (t) => {
  const idp = await startIdp(t);
  const p = await pending(t, idp);
  // the provider has already consumed this code elsewhere
  const first = await fetch(p.env.opened[0], { redirect: 'manual' });
  const loc = new URL(first.headers.get('location'));
  idp.auths.get(loc.searchParams.get('code')).used = true;
  const r = await p.cb(loc.search);
  assert.equal(r.status, 400);
  assert.deepEqual(await p.result, { ok: false, error: 'exchange-failed' });
  assert.equal(idp.tokenRequests().length, 1, 'one attempt, no retry');
});

// ─── PKCE ───────────────────────────────────────────────────────────────────

test('PKCE MISMATCH: if the challenge the provider holds is not ours, the exchange fails and nothing is stored', async (t) => {
  const idp = await startIdp(t);
  // something in the middle swaps the challenge in the authorization request
  const env = await makeEnv(t, idp, {
    browser: async (url, e) => {
      const u = new URL(url);
      u.searchParams.set('code_challenge', challengeS256(newCodeVerifier()));
      await browse(u.toString(), e);
    }
  });
  const res = await env.controller.signIn('gmail');
  await Promise.all(env.pendingBrowse);
  assert.deepEqual(res, { ok: false, error: 'exchange-failed' });
  assert.equal(idp.stats.pkceFailures, 1, 'the provider rejected the verifier');
  assert.equal(env.secrets.map.has(mcpOauthRef('gmail')), false);
  assert.equal(env.controller.status('gmail'), 'signed-out');
});

test('the authorization request is S256 whatever the provider supports: "plain" is never sent', async (t) => {
  const idp = await startIdp(t);
  const env = await makeEnv(t, idp);
  await env.controller.signIn('gmail');
  for (const r of idp.requests('/authorize')) assert.equal(r.query.code_challenge_method, 'S256');
  assert.equal(idp.stats.authorizeRejections.length, 0);
});

// ─── issuer ─────────────────────────────────────────────────────────────────

test('ISS: a wrong issuer is refused before the code is exchanged — whether iss is required or optional', async (t) => {
  for (const issParameter of ['required', 'optional']) {
    const idp = await startIdp(t, { issParameter });
    idp.issuerParam = 'wrong';
    const env = await makeEnv(t, idp);
    assert.deepEqual(await env.controller.signIn('gmail'), { ok: false, error: 'invalid-callback' }, issParameter);
    await Promise.all(env.pendingBrowse);
    assert.equal(idp.tokenRequests().length, 0, `${issParameter}: the code was not exchanged`);
  }
});

test('ISS: a missing issuer is refused when the provider is known to send one, and tolerated when it is not', async (t) => {
  const strict = await startIdp(t, { issParameter: 'required' });
  strict.issuerParam = 'missing';
  const e1 = await makeEnv(t, strict);
  assert.deepEqual(await e1.controller.signIn('gmail'), { ok: false, error: 'invalid-callback' });
  assert.equal(strict.tokenRequests().length, 0);

  const lax = await startIdp(t, { issParameter: 'optional' });
  lax.issuerParam = 'missing';
  const e2 = await makeEnv(t, lax);
  assert.deepEqual(await e2.controller.signIn('gmail'), { ok: true });
});

// ─── refusal ────────────────────────────────────────────────────────────────

test('the user says no: denied, and the provider\'s own words never reach the page', async (t) => {
  const idp = await startIdp(t);
  idp.consent = 'deny';
  const env = await makeEnv(t, idp, { browser: null });
  const res = env.controller.signIn('gmail');
  await until(() => env.opened.length > 0);
  const r = await browse(env.opened[0], env);
  assert.deepEqual(await res, { ok: false, error: 'denied' });
  assert.equal(r.callback.status, 400);
  assert.equal(/access_denied/.test(r.callback.body), false);
  assert.equal(idp.tokenRequests().length, 0);
});

test('a provider-side error is a distinct, fixed code', async (t) => {
  const idp = await startIdp(t);
  idp.consent = 'error';
  const env = await makeEnv(t, idp);
  assert.deepEqual(await env.controller.signIn('gmail'), { ok: false, error: 'provider-error' });
  await Promise.all(env.pendingBrowse);
});

test('the authorization page itself refusing the request ends nothing and stores nothing', async (t) => {
  const idp = await startIdp(t);
  const env = await makeEnv(t, idp, { timeouts: { timeoutMs: 300 } });
  idp.clients.get('client-gmail').redirectUris.clear();            // the user registered a different redirect URI
  assert.deepEqual(await env.controller.signIn('gmail'), { ok: false, error: 'timeout' });
  assert.match(idp.stats.authorizeRejections[0], /redirect_uri/);
  assert.equal(idp.tokenRequests().length, 0);
});

// ─── the token endpoint failing ─────────────────────────────────────────────

const exchangeFailures = [
  ['a 500', { status: 500, body: { error: 'server_error' } }, 'unavailable'],
  ['a 503', { status: 503, body: {} }, 'unavailable'],
  ['a 429', { status: 429, body: {} }, 'unavailable'],
  ['the connection dropped', { destroy: true }, 'unavailable'],
  ['no answer within the timeout', { hang: true }, 'unavailable'],
  ['a redirect (never followed)', { redirect: 'https://evil.example/steal' }, 'unavailable'],
  ['an oversized body', { status: 200, raw: 'x'.repeat(300 * 1024) }, 'unavailable'],
  ['invalid_grant', { status: 400, body: { error: 'invalid_grant' } }, 'exchange-failed'],
  ['invalid_client', { status: 401, body: { error: 'invalid_client' } }, 'exchange-failed'],
  ['an unknown 400', { status: 400, body: { error: 'invalid_request' } }, 'exchange-failed'],
  ['a 200 with no token', { status: 200, body: { hello: 'world' } }, 'bad-token-response'],
  ['a 200 with a hostile token', { status: 200, body: { access_token: 'a b\r\nX: y' } }, 'bad-token-response'],
  ['a 200 that is HTML', { status: 200, raw: '<html>captive portal</html>' }, 'bad-token-response']
];
for (const [what, injected, expected] of exchangeFailures) {
  test(`TOKEN ENDPOINT: ${what} → ${expected}; the code is presented once and nothing is stored`, async (t) => {
    const idp = await startIdp(t);
    idp.inject('token', injected);
    const env = await makeEnv(t, idp, { timeouts: { exchangeTimeoutMs: 250 } });
    const res = await env.controller.signIn('gmail');
    await Promise.all(env.pendingBrowse);
    assert.deepEqual(res, { ok: false, error: expected });
    assert.equal(idp.tokenRequests().length, 1, 'the exchange is never retried: a code is good for one try');
    assert.equal(env.secrets.map.has(mcpOauthRef('gmail')), false);
    assert.equal(await portIsFree(env.ports.gmail), true);
    assert.equal(env.controller.status('gmail'), 'signed-out');
  });
}

test('a wrong client secret is the provider refusing the client, reported as a failed exchange', async (t) => {
  const idp = await startIdp(t);
  const env = await makeEnv(t, idp);
  env.secrets.map.set('mcp:gmail:client_secret', 'a-different-secret');
  assert.deepEqual(await env.controller.signIn('gmail'), { ok: false, error: 'exchange-failed' });
});

test('tokens that cannot be stored are refused, and handed back to the provider', async (t) => {
  const idp = await startIdp(t);
  const env = await makeEnv(t, idp);
  env.secrets.failSet = true;
  assert.deepEqual(await env.controller.signIn('gmail'), { ok: false, error: 'not-stored' });
  await until(() => idp.requests('/revoke').length === 1);
  assert.equal(idp.liveAccessTokens().length, 0, 'the tokens that could not be kept were revoked');
  assert.equal(env.controller.status('gmail'), 'signed-out');
});

test('a store that cannot be read refuses to start a sign-in whose result would be lost', async (t) => {
  const idp = await startIdp(t);
  const env = await makeEnv(t, idp);
  env.secrets.unreadable = true;
  // the client halves are unreadable too, so this is "no client" here; with only the token record unreadable:
  env.secrets.unreadable = false;
  env.secrets.undecryptable.add(mcpOauthRef('gmail'));
  env.secrets.map.set(mcpOauthRef('gmail'), 'ciphertext-we-cannot-decrypt');
  assert.deepEqual(await env.controller.signIn('gmail'), { ok: false, error: 'unavailable' });
  assert.equal(env.opened.length, 0);
});

// ─── timeout, cancel, port ──────────────────────────────────────────────────

test('TIMEOUT: a user who never finishes frees the port and stores nothing', async (t) => {
  const idp = await startIdp(t);
  const env = await makeEnv(t, idp, { browser: null, timeouts: { timeoutMs: 250 } });
  assert.deepEqual(await env.controller.signIn('gmail'), { ok: false, error: 'timeout' });
  assert.equal(await portIsFree(env.ports.gmail), true);
  assert.equal(idp.tokenRequests().length, 0);
  // and a late redirect for the dead sign-in goes nowhere
  const late = await rawGet(env.ports.gmail, '/oauth/callback?state=x').catch((e) => ({ status: e.code }));
  assert.equal(late.status, 'ECONNREFUSED');
});

test('CANCEL: stops a waiting sign-in at once and frees the port', async (t) => {
  const idp = await startIdp(t);
  const p = await pending(t, idp);
  p.env.controller.cancel('gmail');
  assert.deepEqual(await p.result, { ok: false, error: 'cancelled' });
  assert.equal(await portIsFree(p.port), true);
  assert.equal(p.env.controller.status('gmail'), 'signed-out');
});

test('CANCEL during the exchange: what the provider then returns is discarded, not stored', async (t) => {
  const idp = await startIdp(t);
  idp.inject('token', { delayMs: 400, status: 0 });
  const p = await pending(t, idp);
  const hit = p.finish();
  await until(() => idp.requests('/token').length === 1);
  p.env.controller.cancel('gmail');
  assert.deepEqual(await p.result, { ok: false, error: 'cancelled' });
  await hit;
  assert.equal(p.env.secrets.map.has(mcpOauthRef('gmail')), false, 'a late answer must not resurrect a cancelled sign-in');
});

test('quitting (dispose) cancels every waiting sign-in and closes every listener', async (t) => {
  const idp = await startIdp(t);
  const env = await makeEnv(t, idp, { ids: ['gmail', 'google-calendar'], browser: null });
  const a = env.controller.signIn('gmail');
  const b = env.controller.signIn('google-calendar');
  await until(() => env.opened.length === 2);
  env.controller.dispose();
  assert.deepEqual(await a, { ok: false, error: 'cancelled' });
  assert.deepEqual(await b, { ok: false, error: 'cancelled' });
  assert.equal(await portIsFree(env.ports.gmail), true);
  assert.equal(await portIsFree(env.ports['google-calendar']), true);
});

test('PORT BUSY: reported as such, before a browser is opened', async (t) => {
  const idp = await startIdp(t);
  const env = await makeEnv(t, idp);
  const squatter = net.createServer();
  await new Promise((r) => squatter.listen(env.ports.gmail, '127.0.0.1', r));
  t.after(() => squatter.close());
  assert.deepEqual(await env.controller.signIn('gmail'), { ok: false, error: 'port-busy' });
  assert.equal(env.opened.length, 0);
  assert.equal(env.controller.status('gmail'), 'signed-out');
});

test('the browser cannot be opened: no-browser, and the port is freed', async (t) => {
  const idp = await startIdp(t);
  const env = await makeEnv(t, idp, { browser: null });
  env.controller.deps.openUrl = async () => { throw new Error('no browser'); };
  assert.deepEqual(await env.controller.signIn('gmail'), { ok: false, error: 'no-browser' });
  assert.equal(await portIsFree(env.ports.gmail), true);
});

test('IN PROGRESS: a second sign-in for the same integration is refused and does not disturb the first', async (t) => {
  const idp = await startIdp(t);
  const p = await pending(t, idp);
  assert.deepEqual(await p.env.controller.signIn('gmail'), { ok: false, error: 'in-progress' });
  assert.equal(p.env.opened.length, 1);
  await p.finish();
  assert.deepEqual(await p.result, { ok: true });
});

// ─── several sign-ins at once ───────────────────────────────────────────────

test('SIMULTANEOUS SIGN-INS: four integrations at once, finished out of order, each with its own tokens', async (t) => {
  const idp = await startIdp(t);
  const ids = ['gmail', 'google-calendar', 'google-drive'];
  const env = await makeEnv(t, idp, { ids, browser: null });
  const results = ids.map((id) => env.controller.signIn(id));
  await until(() => env.opened.length === 3);
  const byClient = new Map(env.opened.map((u) => [new URL(u).searchParams.get('client_id'), u]));
  // finish them in reverse, concurrently, with jitter
  await Promise.all([...byClient.values()].reverse().map(async (u, i) => {
    await new Promise((r) => setTimeout(r, 5 * i));
    return browse(u, env);
  }));
  assert.deepEqual(await Promise.all(results), [{ ok: true }, { ok: true }, { ok: true }]);

  const accessTokens = new Set();
  const refreshTokens = new Set();
  for (const id of ids) {
    const rec = JSON.parse(env.secrets.map.get(mcpOauthRef(id)));
    accessTokens.add(rec.accessToken);
    refreshTokens.add(rec.refreshToken);
    assert.equal(env.controller.status(id), 'connected');
  }
  assert.equal(accessTokens.size, 3, 'no two integrations share a token');
  assert.equal(refreshTokens.size, 3);
  assert.equal(idp.tokenRequests().length, 3);
  // every token request carried its own client's credentials and its own verifier
  const verifiers = new Set(idp.tokenRequests().map((r) => r.form.code_verifier));
  assert.equal(verifiers.size, 3);
  for (const r of idp.tokenRequests()) assert.equal(r.form.client_secret, `SECRET-${r.form.client_id.replace('client-', '')}-DO-NOT-LEAK`);
  for (const id of ids) assert.equal(await portIsFree(env.ports[id]), true);
});

test('a failure in one simultaneous sign-in does not touch the others', async (t) => {
  const idp = await startIdp(t);
  const ids = ['gmail', 'google-calendar'];
  const env = await makeEnv(t, idp, { ids, browser: null });
  idp.inject('token', { status: 400, body: { error: 'invalid_grant' } });     // whichever exchanges first fails
  const results = ids.map((id) => env.controller.signIn(id));
  await until(() => env.opened.length === 2);
  const first = await browse(env.opened[0], env);
  assert.equal(first.callback.status, 400);
  const second = await browse(env.opened[1], env);
  assert.equal(second.callback.status, 200);
  const settled = await Promise.all(results);
  assert.deepEqual(settled.map((r) => r.ok).sort(), [false, true]);
  assert.equal(env.secrets.map.has(mcpOauthRef('gmail')) !== env.secrets.map.has(mcpOauthRef('google-calendar')), true, 'exactly one integration got tokens');
});

// ─── Slack's flavour ────────────────────────────────────────────────────────

test('a Slack-style provider (ok-envelope, user tokens, HTTP 200 errors) signs in too', async (t) => {
  const idp = await startIdp(t, { style: 'slack', issParameter: 'optional' });
  idp.issuerParam = 'missing';
  const env = await makeEnv(t, idp, { ids: ['slack'] });
  assert.deepEqual(await env.controller.signIn('slack'), { ok: true });
  assert.equal(env.controller.status('slack'), 'connected');
  assert.match(idp.requests('/authorize')[0].query.scope, /channels:history/);
  assert.equal(/chat:write|files:write|canvases:write/.test(idp.requests('/authorize')[0].query.scope), false, 'read-only scopes');
  idp.inject('token', { status: 200, body: { ok: false, error: 'invalid_code' } });
  env.controller.forget('slack');
  env.secrets.map.delete(mcpOauthRef('slack'));
  assert.deepEqual(await env.controller.signIn('slack'), { ok: false, error: 'exchange-failed' });
  await Promise.all(env.pendingBrowse);
});

// ─── robustness at the edges ────────────────────────────────────────────────

test('an openUrl that THROWS (instead of rejecting) is no-browser, not an exception in the main process', async (t) => {
  const idp = await startIdp(t);
  const env = await makeEnv(t, idp, { browser: null });
  env.controller.deps.openUrl = () => { throw new Error('no handler for https'); };
  const uncaught = [];
  const onUncaught = (e) => uncaught.push(e);
  process.on('uncaughtException', onUncaught);
  t.after(() => process.off('uncaughtException', onUncaught));
  assert.deepEqual(await env.controller.signIn('gmail'), { ok: false, error: 'no-browser' });
  assert.deepEqual(uncaught, []);
  assert.equal(await portIsFree(env.ports.gmail), true);
});

test('CANCEL in the instant before the port is bound: no browser is opened for a sign-in that is already over', async (t) => {
  const idp = await startIdp(t);
  const env = await makeEnv(t, idp, { browser: null });
  const result = env.controller.signIn('gmail');
  env.controller.cancel('gmail');                               // synchronously, before listen() has called back
  assert.deepEqual(await result, { ok: false, error: 'cancelled' });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(env.opened.length, 0, 'the browser was opened for a cancelled sign-in');
  assert.equal(await portIsFree(env.ports.gmail), true);
});
