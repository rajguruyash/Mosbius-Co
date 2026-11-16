'use strict';

/**
 * PHASE 4 FINDING F1, FIXED in Stage C: written as a test so it can be re-run. (It was a `todo` that
 * reported without failing the suite while the finding was open; the fix is in src/main/oauth/provider.ts:
 * a refusal is checked against the store before a grant is declared dead, and a dead marker never
 * overwrites a live record someone else saved.)
 *
 * Two processes on one encrypted store (the app and a second tool, say) each keep their own copy of the
 * tokens. The app takes the single-instance lock, so TWO APPS cannot share a store; anything else that
 * opens the store (this repository's own verification tool, or a future helper) can.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startIdp } = require('./fixtures/oauth-idp.cjs');
const { makeEnv, loadTs } = require('./fixtures/oauth-env.cjs');

const { OAuthController } = loadTs('src/main/oauth/controller.ts');
const { safeLog } = loadTs('src/main/oauth/types.ts');
const { mcpCatalogEntry, mcpOauthRef } = loadTs('src/shared/mcpCatalog.ts');

function secondEngine(env, idp) {
  const real = mcpCatalogEntry('gmail').spec.oauth;
  return new OAuthController({
    entry: (id) => mcpCatalogEntry(id),
    secrets: { get: (r) => env.secrets.get(r), set: (r, v) => env.secrets.set(r, v), has: (r) => env.secrets.has(r), readable: () => env.secrets.readable() },
    fetch: (u, i) => fetch(u, i), openUrl: async () => {}, now: () => env.clock.now, log: safeLog(() => {}),
    policy: { allowInsecureLoopback: true },
    specOverride: () => idp.spec({ scope: real.scope, authorizeParams: real.authorizeParams }),
    portOverride: () => env.ports.gmail,
    timeouts: { refreshMs: 5000, retryDelaysMs: [0, 0], cooldownMs: 50 }
  });
}

async function race(t, rotate) {
  const idp = await startIdp(t, { rotate });
  const env = await makeEnv(t, idp);
  assert.deepEqual(await env.controller.signIn('gmail'), { ok: true });
  await Promise.all(env.pendingBrowse);
  const other = secondEngine(env, idp);
  t.after(() => other.dispose());
  env.clock.advance(3_600_000);                           // both hold an expired token
  idp.inject('token', { delayMs: 200, status: 0 }, 2);    // both refresh requests are on the wire before either is answered
  const [a, b] = await Promise.all([env.controller.provider.accessHeaders({ id: 'gmail' }), other.provider.accessHeaders({ id: 'gmail' })]);
  const stored = JSON.parse(env.secrets.map.get(mcpOauthRef('gmail')));
  return { a, b, dead: !!stored.dead, requests: idp.tokenRequests('refresh_token').length };
}

test('two engines, one store, a provider that KEEPS its refresh token (Google\'s behaviour): both refresh, the stored sign-in is intact', async (t) => {
  const r = await race(t, false);
  assert.equal(r.a.ok && r.b.ok, true);
  assert.equal(r.dead, false);
  assert.equal(r.requests, 2, 'there is no cross-process single flight: both ask');
});

test('FIXED (Phase 4 finding F1): two engines, one store, a provider that ROTATES single-use refresh tokens: the loser adopts the winner\'s tokens and the sign-in survives', async (t) => {
  const r = await race(t, true);
  assert.equal(r.dead, false, 'the stored sign-in was marked dead by the engine that lost the race');
  assert.equal(r.a.ok && r.b.ok, true, 'both engines end up with a working token');
  assert.equal(r.requests >= 2, true, 'both asked, as before: there is still no cross-process single flight');
});

test('F1 does not hide a real revocation: when the grant really is over at the provider, the sign-in IS marked dead', async (t) => {
  const idp = await startIdp(t, { rotate: true });
  const env = await makeEnv(t, idp);
  assert.deepEqual(await env.controller.signIn('gmail'), { ok: true });
  await Promise.all(env.pendingBrowse);
  const other = secondEngine(env, idp);
  t.after(() => other.dispose());
  for (const rt of [...idp.grants.keys()]) idp.revokeGrant(rt);        // revoked at the provider
  env.clock.advance(3_600_000);
  const [a, b] = await Promise.all([env.controller.provider.accessHeaders({ id: 'gmail' }), other.provider.accessHeaders({ id: 'gmail' })]);
  assert.equal(a.ok, false);
  assert.equal(b.ok, false);
  assert.equal(JSON.parse(env.secrets.map.get(mcpOauthRef('gmail'))).dead.reason, 'invalid_grant');
});
