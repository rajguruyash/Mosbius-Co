'use strict';

/**
 * The in-app OAuth engine behind the shared broker: the token provider plugged into
 * the MCP route as its CredentialProvider, with a stand-in OAuth provider AND a
 * stand-in protected MCP server (the same fixture).
 *
 * NOTE ON SCOPE. The app does not do this yet: index.ts registers no MCP route and
 * mints no MCP capability (that is a later phase, and a test pins it). These tests
 * assemble the pieces the way that phase will, to prove they fit and that the
 * security properties hold when they do: the upstream gets the engine's token, the
 * agent never does, capabilities are per agent and per channel and deny by default,
 * and Disconnect takes effect immediately.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startIdp } = require('./fixtures/oauth-idp.cjs');
const { makeEnv, until } = require('./fixtures/oauth-env.cjs');
const { call, open, json, bearer, rpc, until: poll } = require('./fixtures/broker-helpers.cjs');
const loadTs = require('./load-ts.cjs');

const { IntegrationBroker } = loadTs('src/main/integrationBroker.ts');
const { disconnectBridged } = loadTs('src/main/mcpDisconnect.ts');
const { McpAuthVault } = loadTs('src/main/mcpAuthVault.ts');
const { mcpCatalogEntry, mcpOauthRef } = loadTs('src/shared/mcpCatalog.ts');

const INIT = rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } }, 1);
const LIST = rpc('tools/list', undefined, 2);
const CLASSES = { search: 'read', send: 'destructive' };

async function setup(t, { grants, idpOpts, envOpts } = {}) {
  const idp = await startIdp(t, idpOpts);
  const env = await makeEnv(t, idp, envOpts);
  assert.deepEqual(await env.controller.signIn('gmail'), { ok: true });
  await Promise.all(env.pendingBrowse);
  const state = { grants: grants === undefined ? { defaults: { gmail: { preset: 'read' } } } : grants };
  const integ = { id: 'gmail', url: `${idp.issuer}/mcp`, enabled: true, classification: { toolClasses: CLASSES } };
  const broker = new IntegrationBroker({ getRecord: () => undefined, getSecret: () => undefined }, {
    mcp: { resolve: (id) => (id === 'gmail' ? integ : undefined), credentials: env.controller.provider, grants: () => state.grants }
  });
  const { port } = await broker.start();
  t.after(() => broker.stop());
  const record = () => JSON.parse(env.secrets.map.get(mcpOauthRef('gmail')));
  const hdr = (tok, extra = {}) => ({ ...bearer(tok), 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...extra });
  const post = (tok, body = INIT) => call(port, { method: 'POST', path: '/m/gmail', headers: hdr(tok), body });
  return { idp, env, broker, port, state, record, post, hdr };
}
const upstreamAuth = (idp) => idp.requests('/mcp').map((r) => r.headers.authorization);

test('the upstream is called with the ENGINE\'s token; the agent\'s own credential never goes upstream, and the engine\'s token never comes back', async (t) => {
  const { idp, broker, post, record } = await setup(t);
  const cap = broker.grantMcp('agent-A', ['gmail']);
  const r = await post(cap);
  assert.equal(r.status, 200);
  assert.deepEqual(upstreamAuth(idp), [`Bearer ${record().accessToken}`]);
  assert.equal(JSON.stringify(idp.requests('/mcp')[0].headers).includes(cap), false, 'the capability token is the agent\'s, and stays on this side');

  const list = await post(cap, LIST);
  assert.deepEqual(json(list).result.tools.map((x) => x.name), ['search'], 'read preset: the destructive tool is not even listed');
  for (const x of [r, list]) {
    const everything = JSON.stringify(x.headers) + x.body.toString('utf8');
    assert.equal(everything.includes(record().accessToken), false, 'the access token never reaches the agent');
    assert.equal(everything.includes(record().refreshToken), false);
    assert.equal(/SECRET-gmail/.test(everything), false);
  }
});

test('CAPABILITIES: unique per agent and per channel, and a REST token is no use on the MCP path', async (t) => {
  const { broker, post } = await setup(t);
  const a = broker.grantMcp('agent-A', ['gmail']);
  const b = broker.grantMcp('agent-B', ['gmail']);
  const aRest = broker.grant('agent-A', ['gmail']);
  assert.equal(new Set([a, b, aRest]).size, 3, 'no two agents or channels share a token');
  for (const tok of [a, b, aRest]) assert.match(tok, /^[A-Za-z0-9_-]{43}$/);
  assert.equal((await post(a)).status, 200);
  assert.equal((await post(b)).status, 200);
  assert.ok((await post(aRest)).status >= 400, 'the REST channel token does not open the MCP channel');
});

test('DEFAULT DENY: with no grant, no preset or "none", nothing reaches the upstream — not even initialize', async (t) => {
  for (const grants of [undefined, {}, { defaults: {} }, { defaults: { gmail: { preset: 'none' } } }, { defaults: { slack: { preset: 'write' } } }]) {
    const ctx = await setup(t, { grants: grants === undefined ? {} : grants });
    const cap = ctx.broker.grantMcp('agent-A', ['gmail']);
    const r = await ctx.post(cap);
    assert.ok([401, 403].includes(r.status), JSON.stringify(grants));
    assert.equal(ctx.idp.requests('/mcp').length, 0, `${JSON.stringify(grants)}: the upstream was contacted`);
  }
});

test('per-agent grants: one agent may, another may not, and neither sees the other\'s access', async (t) => {
  const { idp, broker, post } = await setup(t, { grants: { agents: { 'agent-A': { gmail: { preset: 'read' } } } } });
  const a = broker.grantMcp('agent-A', ['gmail']);
  const b = broker.grantMcp('agent-B', ['gmail']);
  assert.equal((await post(a)).status, 200);
  assert.ok((await post(b)).status >= 400);
  assert.equal(idp.requests('/mcp').length, 1);
});

test('EXPIRY: a request after the token expires triggers one refresh and the upstream sees the NEW token', async (t) => {
  const { idp, env, broker, post, record } = await setup(t);
  const caps = Array.from({ length: 4 }, (_, i) => broker.grantMcp(`agent-${i}`, ['gmail']));   // (one capability may run 8 requests at once)
  await post(caps[0]);
  const first = record().accessToken;
  env.clock.advance(3600_000);
  idp.inject('token', { delayMs: 120, status: 0 });
  const results = await Promise.all(caps.flatMap((c) => Array.from({ length: 5 }, () => post(c))));
  assert.equal(results.length, 20);
  assert.deepEqual([...new Set(results.map((r) => r.status))], [200]);
  assert.equal(idp.tokenRequests('refresh_token').length, 1, 'twenty simultaneous requests from four agents, one refresh');
  assert.notEqual(record().accessToken, first);
  assert.deepEqual([...new Set(upstreamAuth(idp).slice(1))], [`Bearer ${record().accessToken}`]);
  assert.equal(idp.liveAccessTokens().includes(record().accessToken), true);
});

test('EXPIRED AND UNREFRESHABLE: the agent is told to sign in, and the upstream is never contacted with a dead token', async (t) => {
  const { idp, env, broker, post, record } = await setup(t);
  const cap = broker.grantMcp('agent-A', ['gmail']);
  idp.revokeGrant(record().refreshToken);
  env.clock.advance(3600_000);
  const r = await post(cap);
  assert.equal(r.status, 401);
  assert.equal(json(r).code, 'sign_in_required');
  assert.equal(r.headers['www-authenticate'], undefined, 'the agent\'s CLI is never prompted to start an OAuth flow of its own');
  assert.equal(idp.requests('/mcp').length, 0);
});

test('PROVIDER DOWN: a transient refresh failure is a 503 "unavailable", not a sign-out, and recovers', async (t) => {
  const { idp, env, broker, post } = await setup(t);
  const cap = broker.grantMcp('agent-A', ['gmail']);
  env.clock.advance(3600_000);
  idp.inject('token', { status: 503, body: {} }, 3);
  const down = await post(cap);
  assert.equal(down.status, 503);
  assert.equal(json(down).code, 'unavailable');
  assert.equal(env.controller.status('gmail'), 'connected');
  env.clock.advance(100);
  assert.equal((await post(cap)).status, 200);
});

test('REVOCATION IS IMMEDIATE: revoking an agent ends its access on its very next request', async (t) => {
  const { broker, post, idp } = await setup(t);
  const cap = broker.grantMcp('agent-A', ['gmail']);
  assert.equal((await post(cap)).status, 200);
  broker.revoke('agent-A');
  const after = await post(cap);
  assert.equal(after.status, 401);
  assert.equal(idp.requests('/mcp').length, 1);
});

test('REVOCATION IS IMMEDIATE: revoking the integration cuts a request that is already in flight', async (t) => {
  const { broker, port, idp, hdr } = await setup(t);
  const cap = broker.grantMcp('agent-A', ['gmail']);
  idp.inject('mcp', { hang: true });
  const stream = call(port, { method: 'POST', path: '/m/gmail', headers: hdr(cap), body: INIT });
  await poll(() => idp.requests('/mcp').length === 1);
  const t0 = Date.now();
  broker.revokeIntegration('gmail');
  const res = await stream;
  assert.ok(res.error || res.status >= 400, 'the request did not complete normally');
  assert.ok(Date.now() - t0 < 1500, 'and it was cut at once, not left to time out');
  assert.equal((await call(port, { method: 'POST', path: '/m/gmail', headers: hdr(cap), body: INIT })).status, 403, 'the capability no longer names this integration');
});

test('DISCONNECT: agent access ends, the account is revoked and wiped, and a re-grant finds nothing to use', async (t) => {
  const { idp, env, broker, post, record } = await setup(t);
  const cap = broker.grantMcp('agent-A', ['gmail']);
  assert.equal((await post(cap)).status, 200);
  const rt = record().refreshToken;

  const base = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'md-bi-')), 'mcp-auth');
  t.after(() => fs.rmSync(path.dirname(base), { recursive: true, force: true }));
  const res = await disconnectBridged({
    cancelSignIn: (id) => env.controller.cancel(id),
    vault: new McpAuthVault(() => base, { get: env.secrets.get, set: env.secrets.set, delete: (r) => env.secrets.delete(r) }),
    revoke: async () => ({ attempted: 0, confirmed: 0 }),
    secrets: { delete: (r) => env.secrets.delete(r), has: (r) => env.secrets.has(r) },
    broker: { hasTokens: (id) => env.controller.hasTokens(id), revoke: (id) => env.controller.revoke(id), forget: (id) => env.controller.forget(id) },
    onDisconnected: (id) => broker.revokeIntegration(id)
  }, mcpCatalogEntry('gmail'));
  assert.deepEqual(res, { ok: true, revoked: true });

  assert.equal((await post(cap)).status, 403, 'the old capability no longer reaches this integration');
  assert.equal(idp.grants.get(rt).revoked, true, 'the provider forgot the refresh token');
  const fresh = broker.grantMcp('agent-A', ['gmail']);
  const again = await post(fresh);
  assert.equal(again.status, 503);
  assert.equal(json(again).code, 'no_secret', 'even a freshly granted capability finds no credential');
  assert.equal(idp.requests('/mcp').length, 1, 'the upstream was never contacted again');
});

test('MANY WORKERS AT ONCE: eight agents, forty requests, each with its own capability and the one shared token', async (t) => {
  const { idp, broker, post, record } = await setup(t);
  const caps = Array.from({ length: 8 }, (_, i) => broker.grantMcp(`worker-${i}`, ['gmail']));
  assert.equal(new Set(caps).size, 8);
  const results = await Promise.all(caps.flatMap((c) => Array.from({ length: 5 }, () => post(c))));
  assert.equal(results.length, 40);
  assert.equal(results.every((r) => r.status === 200), true);
  assert.deepEqual([...new Set(upstreamAuth(idp))], [`Bearer ${record().accessToken}`]);
  const seen = JSON.stringify(idp.requests('/mcp').map((r) => r.headers));
  for (const c of caps) assert.equal(seen.includes(c), false, 'no capability token reached the upstream');
  assert.equal(idp.tokenRequests('refresh_token').length, 0);
});

test('one worker\'s revocation does not touch another\'s access', async (t) => {
  const { broker, post } = await setup(t);
  const a = broker.grantMcp('worker-A', ['gmail']);
  const b = broker.grantMcp('worker-B', ['gmail']);
  broker.revoke('worker-A');
  assert.equal((await post(a)).status, 401);
  assert.equal((await post(b)).status, 200);
});

// ─── with the real secret store ─────────────────────────────────────────────

test('REAL SECRET STORE: sign-in, refresh and disconnect against the actual encrypted store, nothing in the clear on disk', async (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'md-oauth-real-'));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const electron = require.resolve('electron');
  const before = require.cache[electron];
  require.cache[electron] = {
    id: electron, filename: electron, loaded: true,
    exports: {
      app: { getPath: () => userData },
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (s) => Buffer.from(Buffer.from('enc:' + s, 'utf8').toString('base64'), 'utf8'),   // not plaintext on disk
        decryptString: (b) => Buffer.from(b.toString('utf8'), 'base64').toString('utf8').replace(/^enc:/, '')
      }
    }
  };
  t.after(() => { if (before) require.cache[electron] = before; else delete require.cache[electron]; });
  const integrations = loadTs('src/main/integrations.ts');
  const { OAuthController } = loadTs('src/main/oauth/controller.ts');
  const { safeLog } = loadTs('src/main/oauth/types.ts');
  const { mcpSecretRefs } = loadTs('src/shared/mcpCatalog.ts');
  const { browse } = require('./fixtures/oauth-env.cjs');

  const idp = await startIdp(t, { rotate: true });
  const port = await require('./fixtures/oauth-env.cjs').freePort();
  idp.addClient('real-store-client', 'REAL-STORE-CLIENT-SECRET', [`http://127.0.0.1:${port}/oauth/callback`]);
  const [idRef, secretRef] = mcpSecretRefs(mcpCatalogEntry('gmail'));
  assert.deepEqual(integrations.setSecret(idRef, 'real-store-client'), { ok: true });
  assert.deepEqual(integrations.setSecret(secretRef, 'REAL-STORE-CLIENT-SECRET'), { ok: true });

  let now = 1_700_000_000_000;
  idp.now = () => now;
  const opened = [];
  const controller = new OAuthController({
    entry: (id) => { const e = mcpCatalogEntry(id); return e ? { ...e, spec: { ...e.spec, revoke: idp.revokeSpec() } } : e; },
    secrets: { get: integrations.getSecret, set: integrations.setSecret, has: integrations.hasSecret, readable: integrations.secretStoreReadable },
    fetch: (u, i) => { if (!String(u).startsWith('http://127.0.0.1:')) throw new Error('TEST SAFETY'); return fetch(u, i); },
    openUrl: async (url) => { opened.push(url); void browse(url, {}); },
    now: () => now, log: safeLog(() => {}), policy: { allowInsecureLoopback: true },
    specOverride: () => idp.spec(), portOverride: () => port,
    timeouts: { retryDelaysMs: [], cooldownMs: 10 }
  });
  t.after(() => controller.dispose());

  assert.deepEqual(await controller.signIn('gmail'), { ok: true });
  assert.equal(controller.status('gmail'), 'connected');
  const issued = [...idp.access.keys(), ...idp.grants.keys()];
  const filesText = () => fs.readdirSync(userData).filter((n) => n.startsWith('integration-secrets.json')).map((n) => fs.readFileSync(path.join(userData, n), 'utf8')).join('\n');
  for (const secret of [...issued, 'REAL-STORE-CLIENT-SECRET', idp.tokenRequests()[0].form.code]) assert.equal(filesText().includes(secret), false, 'plaintext secret on disk');
  assert.equal(JSON.parse(fs.readFileSync(path.join(userData, 'integration-secrets.json'), 'utf8'))[mcpOauthRef('gmail')].length > 20, true, 'the record is there, as ciphertext');

  // a refresh with rotation, through the real atomic store
  now += 3600_000;
  const r = await controller.provider.accessHeaders({ id: 'gmail' });
  assert.equal(r.ok, true);
  assert.equal(integrations.secretStoreStatus().state, 'ok');
  assert.equal(JSON.parse(integrations.getSecret(mcpOauthRef('gmail'))).refreshToken, [...idp.grants.entries()].find(([, g]) => !g.revoked)[0]);

  // disconnect, with the real store's own delete and the verification on top of it
  const base = path.join(userData, 'mcp-auth');
  const disc = (extra = {}) => disconnectBridged({
    cancelSignIn: (id) => controller.cancel(id),
    vault: new McpAuthVault(() => base, { get: integrations.getSecret, set: integrations.setSecret, delete: integrations.deleteSecret }),
    revoke: async () => ({ attempted: 0, confirmed: 0 }),
    secrets: { delete: integrations.deleteSecret, has: integrations.hasSecret },
    broker: { hasTokens: (id) => controller.hasTokens(id), revoke: (id) => controller.revoke(id), forget: (id) => controller.forget(id) },
    ...extra
  }, mcpCatalogEntry('gmail'));

  // the store becomes unreadable: a disconnect that cannot delete must say so
  const file = path.join(userData, 'integration-secrets.json');
  const saved = fs.readFileSync(file);
  fs.rmSync(file); fs.rmSync(`${file}.bak`, { force: true }); fs.mkdirSync(file);
  const failed = await disc();
  assert.equal(failed.ok, false);
  assert.match(failed.error, /Not fully disconnected/);
  fs.rmdirSync(file); fs.writeFileSync(file, saved);

  assert.deepEqual(await disc(), { ok: true, revoked: true });
  assert.equal(fs.existsSync(file), false, 'the last secret is gone, so is the file');
  assert.equal(idp.liveAccessTokens().length, 0);
});
