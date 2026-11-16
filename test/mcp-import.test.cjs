'use strict';

/**
 * Copying a bridge sign-in into the in-app engine. Copy, never move; never overwrite;
 * never trust what it reads; never say more than it knows.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startIdp } = require('./fixtures/oauth-idp.cjs');
const { makeEnv, memorySecrets, loadTs } = require('./fixtures/oauth-env.cjs');

const { importBridgeTokens, UNKNOWN_AGE_GRACE_MS } = loadTs('src/main/mcpImport.ts');
const { TokenStore, clientFingerprint, parseRecord } = loadTs('src/main/oauth/token-store.ts');
const { mcpCatalogEntry, mcpTokenRef, mcpOauthRef } = loadTs('src/shared/mcpCatalog.ts');

const NOW = 1_700_000_000_000;
const gmail = mcpCatalogEntry('gmail');
const file = (name, tokens) => ({ [`${name.repeat(32).slice(0, 32)}_tokens.json`]: JSON.stringify(tokens) });
const sealed = (files) => JSON.stringify({ files });

function setup({ blob, client = 'client-1' } = {}) {
  const secrets = memorySecrets();
  if (blob !== undefined) secrets.map.set(mcpTokenRef('gmail'), blob);
  if (client) secrets.map.set('mcp:gmail:client_id', client);
  const store = new TokenStore({ get: (r) => secrets.get(r), set: (r, v) => secrets.set(r, v), has: (r) => secrets.has(r), readable: () => secrets.readable() });
  const run = () => importBridgeTokens({ secrets: { get: (r) => secrets.get(r), set: (r, v) => secrets.set(r, v), has: (r) => secrets.has(r), readable: () => secrets.readable() }, store, now: () => NOW }, gmail);
  return { secrets, store, run };
}

test('a bridge sign-in WITH a refresh token is copied, marked expired so the first use refreshes it, and the bridge\'s copy is untouched', () => {
  const blob = sealed(file('a', { access_token: 'ACCESS-1', refresh_token: 'REFRESH-1', token_type: 'Bearer', expires_in: 3600, scope: 'gmail.readonly' }));
  const { secrets, store, run } = setup({ blob });
  assert.deepEqual(run(), { kind: 'imported', refreshable: true });
  const r = store.load('gmail');
  assert.equal(r.kind, 'record');
  assert.deepEqual(r.record, {
    v: 1, accessToken: 'ACCESS-1', refreshToken: 'REFRESH-1', expiresAt: NOW, scope: 'gmail.readonly',
    obtainedAt: NOW, clientFingerprint: clientFingerprint('client-1')
  });
  assert.equal(secrets.map.get(mcpTokenRef('gmail')), blob, 'COPY, never move: the bridge\'s sealed tokens are byte for byte what they were');
  assert.deepEqual(secrets.sets.map((s) => s.ref), [mcpOauthRef('gmail')], 'and the only thing written is the in-app record');
});

test('one WITHOUT a refresh token is copied as short-lived: five minutes of trust, because its age is unknown', () => {
  const { store, run } = setup({ blob: sealed(file('b', { access_token: 'ACCESS-ONLY' })) });
  assert.deepEqual(run(), { kind: 'imported', refreshable: false });
  const { record } = store.load('gmail');
  assert.equal(record.refreshToken, undefined);
  assert.equal(record.expiresAt, NOW + UNKNOWN_AGE_GRACE_MS);
  assert.equal(UNKNOWN_AGE_GRACE_MS, 5 * 60_000);
});

test('an in-app record that already exists is NEVER overwritten, whatever state it is in', () => {
  for (const existing of ['{"v":1}', 'not json', '', JSON.stringify({ v: 1, accessToken: 'MINE', obtainedAt: 1, clientFingerprint: clientFingerprint('client-1'), dead: { at: 1, reason: 'invalid_grant' } })]) {
    const { secrets, run } = setup({ blob: sealed(file('a', { access_token: 'NEW', refresh_token: 'NEWR' })) });
    secrets.map.set(mcpOauthRef('gmail'), existing);
    assert.deepEqual(run(), { kind: 'already' });
    assert.equal(secrets.map.get(mcpOauthRef('gmail')), existing);
    assert.deepEqual(secrets.sets, [], 'no write at all');
  }
});

test('running it twice changes nothing the second time', () => {
  const { secrets, run } = setup({ blob: sealed(file('a', { access_token: 'A', refresh_token: 'R' })) });
  assert.equal(run().kind, 'imported');
  const first = secrets.map.get(mcpOauthRef('gmail'));
  assert.deepEqual(run(), { kind: 'already' });
  assert.equal(secrets.map.get(mcpOauthRef('gmail')), first);
});

test('with several token files the one that can be refreshed is preferred', () => {
  const blob = sealed({ ...file('a', { access_token: 'NOREFRESH' }), ...file('b', { access_token: 'WITHREFRESH', refresh_token: 'R2' }) });
  const { store, run } = setup({ blob });
  assert.deepEqual(run(), { kind: 'imported', refreshable: true });
  assert.equal(store.load('gmail').record.accessToken, 'WITHREFRESH');
});

test('NOTHING TO COPY: no sealed tokens, none usable, or not for this integration → `none`, and nothing is written', () => {
  for (const blob of [undefined, sealed({}), sealed(file('a', { token_type: 'Bearer' })), sealed(file('a', { access_token: '' })), sealed(file('a', { access_token: 5 })), sealed({ 'not-a-token-file.json': '{"access_token":"X"}' }), sealed({ [`${'a'.repeat(32)}_tokens.json`]: 'not json' })]) {
    const { secrets, run } = setup({ blob });
    assert.deepEqual(run(), { kind: 'none' }, String(blob).slice(0, 60));
    assert.deepEqual(secrets.sets, []);
  }
  const { run } = setup({ blob: undefined });
  assert.equal(importBridgeTokens({ secrets: memorySecrets(), store: new TokenStore(memorySecrets()), now: () => NOW }, mcpCatalogEntry('github')).kind, 'none', 'an integration with no in-app engine');
  assert.equal(run().kind, 'none');
});

test('REFUSES, saying why and writing nothing: unreadable store, undecryptable blob, malformed blob, no client, a token that does not fit, a store that refuses', () => {
  const blob = sealed(file('a', { access_token: 'A', refresh_token: 'R' }));
  let c = setup({ blob }); c.secrets.unreadable = true;
  assert.deepEqual(c.run(), { kind: 'failed', why: 'unreadable' });
  c = setup({ blob }); c.secrets.undecryptable.add(mcpTokenRef('gmail'));
  assert.deepEqual(c.run(), { kind: 'failed', why: 'unreadable' }, 'present but cannot be decrypted is not "nothing there"');
  for (const bad of ['not json', '[]', '"x"', 'null', '{"files":[]}', '{"files":"x"}']) {
    c = setup({ blob: bad });
    assert.deepEqual(c.run(), { kind: 'failed', why: 'malformed' }, bad);
  }
  c = setup({ blob, client: null });
  assert.deepEqual(c.run(), { kind: 'failed', why: 'no-client' });
  c = setup({ blob, client: '   ' });
  assert.deepEqual(c.run(), { kind: 'failed', why: 'no-client' });
  for (const token of ['has space', 'new\nline', 'x'.repeat(8193), 'ünïcode']) {
    c = setup({ blob: sealed(file('a', { access_token: token, refresh_token: 'R' })) });
    assert.deepEqual(c.run(), { kind: 'failed', why: 'malformed' }, 'a token the record would refuse is not copied');
  }
  c = setup({ blob }); c.secrets.failSet = true;
  assert.deepEqual(c.run(), { kind: 'failed', why: 'not-stored' });
  assert.equal(c.secrets.map.has(mcpOauthRef('gmail')), false);
  assert.equal(c.secrets.map.get(mcpTokenRef('gmail')), blob, 'and the bridge copy is still there');
});

test('what is copied always passes the same checks as any stored record', () => {
  const { secrets, run } = setup({ blob: sealed(file('a', { access_token: 'A'.repeat(500), refresh_token: 'R'.repeat(500), scope: 'x'.repeat(5000) })) });
  assert.equal(run().kind, 'imported');
  const parsed = parseRecord(secrets.map.get(mcpOauthRef('gmail')));
  assert.ok(parsed);
  assert.equal(parsed.scope.length, 2000, 'an absurd scope is cut, not copied whole');
});

test('END TO END: an imported sign-in refreshes against the provider on first use, and the bridge copy still stands', async (t) => {
  const idp = await startIdp(t);
  const env = await makeEnv(t, idp);
  // make a real sign-in at the stand-in provider, then pretend it was the BRIDGE's
  assert.deepEqual(await env.controller.signIn('gmail'), { ok: true });
  await Promise.all(env.pendingBrowse);
  const rec = JSON.parse(env.secrets.map.get(mcpOauthRef('gmail')));
  env.controller.forget('gmail');
  env.secrets.map.delete(mcpOauthRef('gmail'));
  const bridgeBlob = sealed(file('c', { access_token: rec.accessToken, refresh_token: rec.refreshToken, token_type: 'Bearer', expires_in: 3600 }));
  env.secrets.map.set(mcpTokenRef('gmail'), bridgeBlob);
  const before = idp.tokenRequests('refresh_token').length;

  assert.equal(env.controller.status('gmail'), 'signed-out');
  assert.deepEqual(env.controller.importFromBridge('gmail'), { kind: 'imported', refreshable: true });
  assert.equal(env.controller.status('gmail'), 'connected');
  const h = await env.controller.provider.accessHeaders({ id: 'gmail' });
  assert.equal(h.ok, true);
  assert.equal(idp.tokenRequests('refresh_token').length, before + 1, 'the first use refreshed it: the grant was proved alive');
  assert.notEqual(h.headers.Authorization, `Bearer ${rec.accessToken}`, 'and the access token of unknown age is no longer in use');
  assert.equal(env.secrets.map.get(mcpTokenRef('gmail')), bridgeBlob, 'the bridge\'s tokens are untouched');
  const logs = env.logs.join('\n');
  for (const secret of [rec.accessToken, rec.refreshToken, 'SECRET-gmail']) assert.equal(logs.includes(secret), false, 'no log line carries a token');
  assert.match(logs, /import/);
});
