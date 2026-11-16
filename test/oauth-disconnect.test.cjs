'use strict';

/**
 * Disconnect, with the in-app OAuth engine in the loop: agent access ends first, the
 * provider is asked to forget the tokens, every local copy is deleted AND checked,
 * and a failure anywhere is reported as a failure.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startIdp } = require('./fixtures/oauth-idp.cjs');
const { makeEnv, until, freePort } = require('./fixtures/oauth-env.cjs');
const loadTs = require('./load-ts.cjs');

const { disconnectBridged } = loadTs('src/main/mcpDisconnect.ts');
const { McpAuthVault } = loadTs('src/main/mcpAuthVault.ts');
const { mcpCatalogEntry, mcpOauthRef, mcpTokenRef } = loadTs('src/shared/mcpCatalog.ts');

const GMAIL = mcpCatalogEntry('gmail');

/** The disconnect wiring exactly as index.ts builds it, over the test environment. */
function wire(t, env, extra = {}) {
  const base = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'md-disc-')), 'mcp-auth');
  t.after(() => fs.rmSync(path.dirname(base), { recursive: true, force: true }));
  const events = [];
  const bridgeRevocations = [];
  const vault = new McpAuthVault(() => base, { get: env.secrets.get, set: env.secrets.set, delete: (r) => env.secrets.delete(r) });
  const deps = {
    cancelSignIn: (id) => { events.push('cancel'); env.controller.cancel(id); },
    vault,
    revoke: async (spec, tokens) => { bridgeRevocations.push(tokens); return { attempted: tokens.length, confirmed: tokens.length }; },
    secrets: { delete: (r) => env.secrets.delete(r), has: (r) => env.secrets.has(r) },
    broker: {
      hasTokens: (id) => env.controller.hasTokens(id),
      revoke: (id) => env.controller.revoke(id),
      forget: (id) => { events.push('forget'); env.controller.forget(id); }
    },
    onDisconnected: (id) => events.push(`capabilities-revoked@${env.idp.log.length}`),
    ...extra
  };
  return { deps, events, bridgeRevocations, vault, run: () => disconnectBridged(deps, GMAIL) };
}

async function connected(t, idpOpts = {}, envOpts = {}) {
  const idp = await startIdp(t, idpOpts);
  const env = await makeEnv(t, idp, envOpts);
  assert.deepEqual(await env.controller.signIn('gmail'), { ok: true });
  await Promise.all(env.pendingBrowse);
  return { idp, env };
}

const remaining = (env) => env.refsOf('gmail').filter((ref) => env.secrets.map.has(ref));

test('a clean disconnect: agent access first, then the provider, then every local copy', async (t) => {
  const { idp, env } = await connected(t);
  const w = wire(t, env);
  const refreshToken = JSON.parse(env.secrets.map.get(mcpOauthRef('gmail'))).refreshToken;
  const liveBefore = idp.liveAccessTokens().length;
  assert.equal(liveBefore, 1);
  const requestsBefore = idp.log.length;

  assert.deepEqual(await w.run(), { ok: true, revoked: true });

  // ORDER: capabilities were cut before the first request to the provider
  assert.deepEqual(w.events, ['cancel', `capabilities-revoked@${requestsBefore}`, 'forget']);
  // the provider was asked, with the refresh token, and forgot it
  assert.equal(idp.requests('/revoke').length, 1);
  assert.equal(idp.requests('/revoke')[0].form.token, refreshToken);
  assert.equal(idp.grants.get(refreshToken).revoked, true);
  assert.equal(idp.liveAccessTokens().length, 0, 'the access token died with it');
  // nothing local survived: the sealed record AND the OAuth client
  assert.deepEqual(remaining(env), []);
  assert.equal(env.controller.status('gmail'), 'unconfigured');
  assert.deepEqual(await env.controller.provider.accessHeaders({ id: 'gmail' }), { ok: false, code: 'no_secret' });
});

test('the provider unreachable: still disconnected here, and honest that it was not revoked', async (t) => {
  for (const injected of [{ destroy: true }, { status: 503, body: {} }, { hang: true }]) {
    const { idp, env } = await connected(t, {}, { timeouts: { revokeMs: 200 } });
    idp.inject('revoke', injected);
    const res = await wire(t, env).run();
    assert.deepEqual(res, { ok: true, revoked: false }, JSON.stringify(injected));
    assert.deepEqual(remaining(env), [], 'the local wipe is not best-effort');
    assert.equal(idp.liveAccessTokens().length, 1, 'and the report is true: the provider still honours the token');
  }
});

test('REVOCATION FAILURE (the provider says no) is reported as not revoked, not as a failure to disconnect', async (t) => {
  const { idp, env } = await connected(t);
  idp.inject('revoke', { status: 400, body: { error: 'invalid_request' } });
  assert.deepEqual(await wire(t, env).run(), { ok: true, revoked: false });
  assert.deepEqual(remaining(env), []);
});

test('DELETE FAILURE: when the store refuses, it is NOT disconnected — and agent access is still cut', async (t) => {
  const { idp, env } = await connected(t);
  const w = wire(t, env);
  env.secrets.refuseDelete = true;
  const res = await w.run();
  assert.equal(res.ok, false);
  assert.equal(res.revoked, true, 'the provider did revoke; that is reported separately');
  assert.match(res.error, /^Not fully disconnected/);
  assert.match(res.error, /still on this computer/);
  assert.deepEqual(w.events.slice(0, 2), ['cancel', `capabilities-revoked@${idp.log.length - 1}`], 'agent access was cut regardless');
  assert.equal(remaining(env).length, 3, 'all three credentials are still stored: the report is true');
  assert.equal(env.controller.status('gmail'), 'connected', 'and the panel does not pretend otherwise');

  // the store recovers: the next attempt finishes the job
  env.secrets.refuseDelete = false;
  assert.deepEqual(await wire(t, env).run(), { ok: true, revoked: true });
  assert.deepEqual(remaining(env), []);
});

test('DELETE FAILURE on the sealed token record alone is still a failure to disconnect', async (t) => {
  const { env } = await connected(t);
  const realDelete = env.secrets.delete;
  env.secrets.delete = (ref) => (ref === mcpOauthRef('gmail') ? { ok: false, error: 'secret store unreadable (EIO)' } : realDelete(ref));
  const res = await wire(t, env).run();
  assert.equal(res.ok, false);
  assert.match(res.error, /EIO/);
  assert.equal(env.secrets.map.has(mcpOauthRef('gmail')), true, 'the token record is still there, and the error says so');
  assert.equal(env.secrets.map.has('mcp:gmail:client_id'), false, 'what could be removed was');
});

test('a store that says "deleted" but kept the record is still a failure', async (t) => {
  const { env } = await connected(t);
  env.secrets.delete = () => ({ ok: true });                        // lies
  const res = await wire(t, env).run();
  assert.equal(res.ok, false);
  assert.match(res.error, /still stored after the delete/);
});

test('BOTH ENGINES: disconnect removes the bridge\'s sealed tokens as well as the in-app record', async (t) => {
  const { idp, env } = await connected(t);
  env.secrets.map.set(mcpTokenRef('gmail'), JSON.stringify({ files: { [`${'a'.repeat(32)}_tokens.json`]: JSON.stringify({ access_token: 'BRIDGE-A', refresh_token: 'BRIDGE-R' }) } }));
  const w = wire(t, env);
  assert.deepEqual(await w.run(), { ok: true, revoked: true });
  assert.equal(env.secrets.map.has(mcpTokenRef('gmail')), false, 'the bridge\'s sealed tokens are gone');
  assert.equal(env.secrets.map.has(mcpOauthRef('gmail')), false);
  assert.deepEqual(w.bridgeRevocations.flat(), [{ access_token: 'BRIDGE-A', refresh_token: 'BRIDGE-R' }], 'and they were revoked too');
  assert.equal(idp.requests('/revoke').length, 1, 'while the in-app engine revoked its own');
});

test('DISCONNECT DURING A SIGN-IN cancels it, frees the port, and a late redirect goes nowhere', async (t) => {
  const idp = await startIdp(t);
  const env = await makeEnv(t, idp, { browser: null });
  const w = wire(t, env);
  const waiting = env.controller.signIn('gmail');
  await until(() => env.opened.length === 1);
  assert.deepEqual(await w.run(), { ok: true, revoked: false });
  assert.deepEqual(await waiting, { ok: false, error: 'cancelled' });
  const late = await fetch(env.opened[0], { redirect: 'manual' }).then((r) => fetch(r.headers.get('location'), { redirect: 'manual' })).then(() => 'answered', (e) => e.cause?.code ?? 'refused');
  assert.equal(late, 'ECONNREFUSED');
  assert.equal(idp.tokenRequests().length, 0);
  assert.deepEqual(remaining(env), []);
});

test('disconnecting something that was never connected is a clean no-op', async (t) => {
  const idp = await startIdp(t);
  const env = await makeEnv(t, idp);
  assert.deepEqual(await wire(t, env).run(), { ok: true, revoked: false });
  assert.equal(idp.log.length, 0, 'nothing to revoke, nobody asked');
});

test('disconnect is repeatable: a second one changes nothing and still succeeds', async (t) => {
  const { idp, env } = await connected(t);
  const w = wire(t, env);
  assert.equal((await w.run()).ok, true);
  const seen = idp.log.length;
  assert.deepEqual(await w.run(), { ok: true, revoked: false });
  assert.equal(idp.log.length, seen);
});

test('disconnect then sign in again is a complete cycle with fresh tokens', async (t) => {
  const { idp, env } = await connected(t);
  const first = JSON.parse(env.secrets.map.get(mcpOauthRef('gmail')));
  await wire(t, env).run();
  // the user enters their OAuth client again and signs in
  env.secrets.map.set('mcp:gmail:client_id', 'client-gmail');
  env.secrets.map.set('mcp:gmail:client_secret', 'SECRET-gmail-DO-NOT-LEAK');
  assert.deepEqual(await env.controller.signIn('gmail'), { ok: true });
  const second = JSON.parse(env.secrets.map.get(mcpOauthRef('gmail')));
  assert.notEqual(second.refreshToken, first.refreshToken);
  assert.equal(env.controller.status('gmail'), 'connected');
  assert.equal(idp.liveAccessTokens().length, 1);
});

test('a refresh that is on the wire when Disconnect is pressed cannot bring the account back', async (t) => {
  const { idp, env } = await connected(t, { rotate: true });
  env.clock.advance(3600_000);
  idp.inject('token', { delayMs: 250, status: 0 });
  const inflight = env.controller.provider.accessHeaders({ id: 'gmail' });
  await until(() => idp.tokenRequests('refresh_token').length === 1);
  assert.equal((await wire(t, env).run()).ok, true);
  assert.deepEqual(await inflight, { ok: false, code: 'sign_in_required' });
  await new Promise((r) => setTimeout(r, 350));
  assert.deepEqual(remaining(env), [], 'nothing was written after the wipe');
});
