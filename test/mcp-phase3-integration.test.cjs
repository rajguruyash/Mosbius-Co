'use strict';

/**
 * Phase 3 assembled the way the app assembles it: the in-app OAuth engine, the broker
 * with its MCP route, the wiring rules, and the hive writing an agent's MCP config; with a
 * stand-in OAuth provider and MCP server behind them, and a plain HTTP client standing in
 * for the agent's CLI (it reads the config file the hive wrote and does exactly what the
 * file says, nothing more).
 *
 * `spawn()` / `teardown()` below mirror the spawn and teardown code in src/main/index.ts;
 * test/mcp-route.test.cjs pins that code's shape so the two cannot drift apart unseen.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { assemble, until } = require('./fixtures/phase3-env.cjs');
const { call, open, json, rpc } = require('./fixtures/broker-helpers.cjs');
const loadTs = require('./load-ts.cjs');

const { IntegrationBroker } = loadTs('src/main/integrationBroker.ts');
const { HiveManager } = loadTs('src/main/hive.ts');
const { disconnectBridged } = loadTs('src/main/mcpDisconnect.ts');
const { McpAuthVault } = loadTs('src/main/mcpAuthVault.ts');
const { AuditLog } = loadTs('src/main/broker/audit.ts');
const { mcpIntegrationFor, eligibleIntegrationIds, sanitizeMcpGrants, applyGrantUpdate, brokerExposure, noLongerServed } = loadTs('src/main/mcpWiring.ts');
const { MCP_CATALOG, mcpCatalogEntry, mcpOauthRef } = loadTs('src/shared/mcpCatalog.ts');

const INIT = rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'claude-code', version: '0' } }, 1);
const LIST = rpc('tools/list', undefined, 2);
const CALL = (name) => rpc('tools/call', { name, arguments: { to: 'someone@example.com', secretArgument: 'ARGUMENT-DO-NOT-LEAK' } }, 3);

const names = (r) => json(r).result.tools.map((x) => x.name);

// ─── the whole path ──────────────────────────────────────────────────────────

test('THE WHOLE PATH: sign in → grant → spawn → the agent lists, calls and is refused, with the engine\'s token never leaving main', async (t) => {
  const c = await assemble(t, { grants: { defaults: { gmail: { preset: 'custom', allow: ['search'] } } } });
  await c.signIn();
  const { file, token, mcpIds } = await c.spawn('agent-A');
  assert.deepEqual(mcpIds, ['gmail']);

  const agent = c.agent(file);
  assert.deepEqual(agent.config, { type: 'http', url: `${c.broker.url()}/m/gmail`, headers: { Authorization: `Bearer ${token}` } });

  assert.equal((await agent.post(INIT)).status, 200);
  const list = await agent.post(LIST);
  assert.deepEqual(names(list), ['search'], 'only the tool that was named: `send` is not even listed');
  assert.equal((await agent.post(CALL('search'))).status, 200);
  const denied = await agent.post(CALL('send'));
  assert.equal(denied.status, 200);
  assert.equal(json(denied).error.code, -32003);
  assert.match(json(denied).error.message, /not granted/);

  const seen = c.idp.requests('/mcp');
  assert.deepEqual(seen.map((r) => JSON.parse(r.rawBody || '{}').method), ['initialize', 'tools/list', 'tools/call'], 'the denied call never went upstream');
  assert.deepEqual([...new Set(c.upstreamAuth())], [`Bearer ${c.record().accessToken}`], 'the upstream saw the ENGINE\'s token, and only that');
  for (const r of seen) assert.equal(JSON.stringify(r.headers).includes(token), false, 'the capability never goes upstream');
});

test('FAIL CLOSED: with no tool classified, the presets reach nothing; only a tool named in an allow list is reachable', async (t) => {
  for (const preset of ['read', 'write']) {
    const c = await assemble(t, { grants: { defaults: { gmail: { preset } } } });
    await c.signIn();
    const { file } = await c.spawn('agent-A');
    const a = c.agent(file);
    await a.post(INIT);
    assert.deepEqual(names(await a.post(LIST)), [], `${preset}: nothing is classified, so nothing is listed`);
    for (const tool of ['search', 'send']) assert.match(json(await a.post(CALL(tool))).error.message, /not granted/, `${preset}/${tool}`);
    assert.equal(c.idp.requests('/mcp').filter((r) => JSON.parse(r.rawBody || '{}').method === 'tools/call').length, 0);
  }
});

test('once a maintainer pins a class, the presets work as designed: read sees reads, write adds writes, neither ever reaches `send`', async (t) => {
  const classes = { search: 'read', send: 'destructive' };
  const c = await assemble(t, { classes, grants: { defaults: { gmail: { preset: 'write' } } } });
  await c.signIn();
  const { file } = await c.spawn('agent-A');
  const a = c.agent(file);
  await a.post(INIT);
  assert.deepEqual(names(await a.post(LIST)), ['search']);
  assert.match(json(await a.post(CALL('send'))).error.message, /not granted/);
  // …and the destructive tool becomes reachable only by NAME
  c.cfg.mcpGrants = { defaults: { gmail: { preset: 'write', allow: ['send'] } } };
  assert.deepEqual(names(await a.post(LIST)), ['search', 'send'], 'live: no respawn needed to narrow or to widen what an entry already lets through');
  assert.equal(json(await a.post(CALL('send'))).result.ok, true);
});

test('DEFAULT DENY: nothing is written for an agent that has not been granted anything, and a capability for nothing is not minted', async (t) => {
  const c = await assemble(t, { grants: {} });
  await c.signIn();
  const { file, token, mcpIds } = await c.spawn('agent-A');
  assert.equal(token, undefined);
  assert.deepEqual(mcpIds, []);
  // Nothing is on by default any more, so an agent with no grants has no MCP config file at
  // all: the stricter form of "nothing is written".
  const written = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers : {};
  assert.equal('mosbius-gmail' in written, false);
  assert.deepEqual(Object.keys(written), [], 'no server of any kind');
  assert.equal(c.broker.hasMcp('agent-A'), false);
});

test('NEVER ON ITS OWN: each of the four conditions is needed, and a missing one means no entry and no capability', async (t) => {
  const c = await assemble(t, { grants: { defaults: { gmail: { preset: 'custom', allow: ['search'] } } } });
  const spawnIds = async (agent) => (await c.spawn(agent)).mcpIds;
  assert.deepEqual(await spawnIds('a0'), [], 'not signed in');
  await c.signIn();
  assert.deepEqual(await spawnIds('a1'), ['gmail']);
  c.cfg.mcpDefaults.gmail.enabled = false;
  assert.deepEqual(await spawnIds('a2'), [], 'switched off');
  c.cfg.mcpDefaults.gmail.enabled = true;
  c.cfg.mcpEngine.gmail = 'bridge';
  assert.deepEqual(await spawnIds('a3'), [], 'on the bridge');
  c.cfg.mcpEngine.gmail = 'broker';
  c.cfg.mcpGrants = {};
  assert.deepEqual(await spawnIds('a4'), [], 'no grant');
  c.cfg.mcpGrants = { defaults: { gmail: { preset: 'read' } } };
  assert.deepEqual(await spawnIds('a5'), ['gmail']);
});

// ─── isolation ───────────────────────────────────────────────────────────────

test('ISOLATION: each agent has its own capability and its own grants; one agent\'s is no use as another\'s', async (t) => {
  const c = await assemble(t, { grants: { defaults: { gmail: { preset: 'custom', allow: ['search'] } }, agents: { 'agent-B': { gmail: { preset: 'custom', allow: ['search', 'send'] } }, 'agent-C': { gmail: { preset: 'none' } } } } });
  await c.signIn();
  const A = await c.spawn('agent-A'), B = await c.spawn('agent-B'), C = await c.spawn('agent-C');
  assert.deepEqual(C.mcpIds, [], 'cut off by name: no entry, no capability');
  assert.equal(new Set([A.token, B.token]).size, 2);
  const a = c.agent(A.file), b = c.agent(B.file);
  await a.post(INIT); await b.post(INIT);
  assert.deepEqual(names(await a.post(LIST)), ['search']);
  assert.deepEqual(names(await b.post(LIST)), ['search', 'send']);
  assert.match(json(await a.post(CALL('send'))).error.message, /not granted/, 'A never gets what B has');
  assert.equal(json(await b.post(CALL('send'))).result.ok, true);
  // A's session id is A's
  const sidA = (await a.post(INIT)).headers['mcp-session-id'];
  if (sidA) assert.equal((await b.post(LIST, { 'mcp-session-id': sidA })).status, 404);
});

test('ISOLATION: the capability is no use on the REST channel, nor a REST token on the MCP channel', async (t) => {
  const c = await assemble(t, { grants: { defaults: { gmail: { preset: 'custom', allow: ['search'] } } } });
  await c.signIn();
  const { token } = await c.spawn('agent-A');
  const restToken = c.broker.grant('agent-A', ['gmail']);
  const port = Number(new URL(c.broker.url()).port);
  assert.equal((await call(port, { path: '/i/gmail/x', headers: { authorization: `Bearer ${token}` } })).status, 401);
  assert.equal((await call(port, { method: 'POST', path: '/m/gmail', headers: { authorization: `Bearer ${restToken}`, 'content-type': 'application/json' }, body: INIT })).status, 401);
});

// ─── revocation is immediate ─────────────────────────────────────────────────

test('REVOCATION: ending the agent kills its capability and its config at once, and cuts what it was running', async (t) => {
  const c = await assemble(t, { grants: { defaults: { gmail: { preset: 'custom', allow: ['search'] } } } });
  await c.signIn();
  const A = await c.spawn('agent-A'), B = await c.spawn('agent-B');
  const a = c.agent(A.file), b = c.agent(B.file);
  const stream = await a.stream();
  assert.equal(stream.status, 200);
  c.teardown('agent-A');
  assert.equal((await a.post(INIT)).status, 401, 'dead on the very next request');
  assert.equal(fs.existsSync(A.file), false, 'and its config is gone');
  assert.ok(await until(() => stream.events.closed || stream.events.ended || stream.events.error), 'the stream it held open was cut');
  assert.equal((await b.post(INIT)).status, 200, 'another agent is untouched');
});

test('REVOCATION: a respawn of the same agent is a new capability, and the old process\'s teardown cannot revoke the new one', async (t) => {
  const c = await assemble(t, { grants: { defaults: { gmail: { preset: 'custom', allow: ['search'] } } } });
  await c.signIn();
  const first = await c.spawn('agent-A', 'pty-1');
  const second = await c.spawn('agent-A', 'pty-2');
  assert.notEqual(first.token, second.token);
  assert.equal((await c.agent(first.file).post(INIT)).status, 200, 'the file was rewritten: it now holds the NEW capability');
  c.teardown('agent-A', 'pty-1');                       // the OLD process finally goes
  assert.equal((await c.agent(second.file).post(INIT)).status, 200, 'the new process still works');
  c.teardown('agent-A', 'pty-2');
  assert.equal((await call(Number(new URL(c.broker.url()).port), { method: 'POST', path: '/m/gmail', headers: { authorization: `Bearer ${second.token}`, 'content-type': 'application/json' }, body: INIT })).status, 401);
});

test('REVOCATION: Disconnect ends every agent\'s access on the spot, before anything slow happens', async (t) => {
  const c = await assemble(t, { grants: { defaults: { gmail: { preset: 'custom', allow: ['search'] } } } });
  await c.signIn();
  const files = [await c.spawn('agent-A'), await c.spawn('agent-B')].map((x) => c.agent(x.file));
  const streams = await Promise.all(files.map((f) => f.stream()));
  const order = [];
  const vault = new McpAuthVault(() => path.join(c.home, 'vault'), { get: (r) => c.env.secrets.get(r), set: (r, v) => c.env.secrets.set(r, v), delete: (r) => c.env.secrets.delete(r) });
  const res = await disconnectBridged({
    cancelSignIn: () => {},
    vault,
    revoke: async () => { order.push('bridge-revoke'); return { attempted: 0, confirmed: 0 }; },
    secrets: { delete: (r) => c.env.secrets.delete(r), has: (r) => c.env.secrets.has(r) },
    broker: {
      hasTokens: (id) => c.env.controller.hasTokens(id),
      revoke: async (id) => { order.push(`agents-cut:${c.broker.hasMcp('agent-A')}`); return c.env.controller.revoke(id); },
      forget: (id) => c.env.controller.forget(id)
    },
    onDisconnected: (id) => { c.broker.revokeIntegration(id); order.push('revokeIntegration'); }
  }, mcpCatalogEntry('gmail'));
  assert.equal(res.ok, true);
  assert.equal(order[0], 'revokeIntegration', 'agent access ends FIRST');
  for (const f of files) assert.equal((await f.post(INIT)).status, 403, 'the integration is gone from every capability');
  assert.ok(await until(() => streams.every((s) => s.events.closed || s.events.ended || s.events.error)), 'open streams were cut');
  assert.equal(c.env.secrets.map.has(mcpOauthRef('gmail')), false, 'and the sign-in is deleted');
});

test('REVOCATION: switching an integration off, or back to the bridge, is felt on the next request; the exposure diff says which to cut', async (t) => {
  const c = await assemble(t, { grants: { defaults: { gmail: { preset: 'custom', allow: ['search'] } } } });
  await c.signIn();
  const { file } = await c.spawn('agent-A');
  const a = c.agent(file);
  assert.equal((await a.post(INIT)).status, 200);
  const before = brokerExposure(c.cfg);
  // every catalogue integration is listed; only the one switched on AND on the broker engine is served
  assert.deepEqual(before, Object.fromEntries(MCP_CATALOG.map((e) => [e.id, e.id === 'gmail'])));
  c.cfg.mcpDefaults.gmail.enabled = false;
  assert.equal((await a.post(INIT)).status, 403, 'switched off');
  assert.deepEqual(noLongerServed(before, brokerExposure(c.cfg)), ['gmail']);
  c.cfg.mcpDefaults.gmail.enabled = true;
  assert.equal((await a.post(INIT)).status, 200);
  c.cfg.mcpEngine.gmail = 'bridge';
  assert.equal((await a.post(INIT)).status, 404, 'back on the bridge: the route does not serve it');
  assert.deepEqual(noLongerServed(before, brokerExposure(c.cfg)), ['gmail']);
  assert.deepEqual(noLongerServed(null, brokerExposure(c.cfg)), [], 'nothing to cut when nothing was known');
  assert.deepEqual(noLongerServed({ gmail: false }, { gmail: true }), [], 'turning something ON cuts nothing');
});

test('REVOCATION: a grant changed through the validated update is felt on the very next request', async (t) => {
  const c = await assemble(t, { grants: { defaults: { gmail: { preset: 'custom', allow: ['search'] } } } });
  await c.signIn();
  const { file } = await c.spawn('agent-A');
  const a = c.agent(file);
  assert.equal((await a.post(INIT)).status, 200);
  c.cfg.mcpGrants = applyGrantUpdate(c.cfg.mcpGrants, { id: 'gmail', agentId: 'agent-A', grant: { preset: 'none' } }).grants;
  assert.equal((await a.post(INIT)).status, 403);
  c.cfg.mcpGrants = applyGrantUpdate(c.cfg.mcpGrants, { id: 'gmail', agentId: 'agent-A', grant: { preset: 'custom', allow: ['search'], expiresAt: Date.now() - 1 } }).grants;
  assert.equal((await a.post(INIT)).status, 403, 'an expired grant is no grant');
  assert.ok(c.audit.recent('gmail').some((e) => e.decision === 'deny' && e.agentId === 'agent-A'));
});

// ─── the provider behind the route ───────────────────────────────────────────

test('401 REPLAY with the real engine: the upstream drops our token, the route refreshes and replays, the agent notices nothing', async (t) => {
  const c = await assemble(t, { grants: { defaults: { gmail: { preset: 'custom', allow: ['search'] } } }, idpOpts: { rotate: true } });
  await c.signIn();
  const { file } = await c.spawn('agent-A');
  const a = c.agent(file);
  const first = c.record().accessToken;
  assert.equal((await a.post(INIT)).status, 200);
  c.idp.access.get(first).revoked = true;                       // the provider stops honouring it, although the clock says it is fine
  const r = await a.post(LIST);
  assert.equal(r.status, 200, 'refreshed and replayed');
  assert.equal(c.idp.tokenRequests('refresh_token').length, 1);
  assert.notEqual(c.record().accessToken, first);
  const auths = c.upstreamAuth();
  assert.deepEqual(auths.slice(-2), [`Bearer ${first}`, `Bearer ${c.record().accessToken}`]);
  assert.equal((await a.post(LIST)).status, 200);
  assert.equal(c.idp.tokenRequests('refresh_token').length, 1, 'and the new token simply keeps working');
  assert.equal(JSON.stringify(r.headers).includes(c.record().accessToken), false);
});

test('A DEAD GRANT: the agent is told to sign in again, the provider is not hammered, and the next spawn gets no entry', async (t) => {
  const c = await assemble(t, { grants: { defaults: { gmail: { preset: 'custom', allow: ['search'] } } } });
  await c.signIn();
  const { file } = await c.spawn('agent-A');
  const a = c.agent(file);
  const rec = c.record();
  c.idp.access.get(rec.accessToken).revoked = true;
  c.idp.revokeGrant(rec.refreshToken);                          // the user removed the app's access in their account
  const r = await a.post(INIT);
  assert.equal(r.status, 401);
  assert.equal(json(r).code, 'sign_in_required');
  assert.equal('www-authenticate' in r.headers, false);
  for (let i = 0; i < 5; i++) assert.equal((await a.post(INIT)).status, 401);
  assert.equal(c.idp.tokenRequests('refresh_token').length, 1, 'one attempt, and then it is remembered');
  assert.equal(c.env.controller.status('gmail'), 'needs-signin');
  const next = await c.spawn('agent-B');
  assert.deepEqual(next.mcpIds, [], 'a new agent is not given an entry for an integration that needs a sign-in');
});

test('SIMULTANEOUS: many agents and a second sign-in at once — one refresh, no cross-talk, every flow finishes', async (t) => {
  const c = await assemble(t, { ids: ['gmail', 'google-calendar'], grants: { defaults: { gmail: { preset: 'custom', allow: ['search'] }, 'google-calendar': { preset: 'custom', allow: ['search'] } } } });
  await c.signIn('gmail');
  const agents = [];
  for (let i = 0; i < 6; i++) agents.push(c.agent((await c.spawn(`agent-${i}`)).file));
  c.env.clock.advance(3_600_000);
  c.idp.inject('token', { delayMs: 150, status: 0 });
  const calendar = c.env.controller.signIn('google-calendar');           // a different flow, started in the middle
  const results = await Promise.all([
    ...agents.flatMap((a) => Array.from({ length: 8 }, (_, k) => a.post(k === 0 ? INIT : LIST))),
    calendar
  ]);
  const http = results.slice(0, -1);
  assert.deepEqual([...new Set(http.map((r) => r.status))], [200]);
  assert.deepEqual(results[results.length - 1], { ok: true });
  await Promise.all(c.env.pendingBrowse);
  assert.equal(c.idp.tokenRequests('refresh_token').length, 1, 'forty-eight requests from six agents, one refresh');
  assert.equal(c.env.controller.status('google-calendar'), 'connected');
  assert.notEqual(JSON.parse(c.env.secrets.map.get(mcpOauthRef('google-calendar'))).accessToken, c.record('gmail').accessToken, 'each flow ended with its own tokens');
});

// ─── quit, crash, restart ────────────────────────────────────────────────────

test('QUIT: a refresh already on the wire is allowed to finish and be saved, and a request that arrives meanwhile simply joins it', async (t) => {
  const c = await assemble(t, { idpOpts: { rotate: true }, grants: { defaults: { gmail: { preset: 'read' } } } });
  await c.signIn();
  const before = c.record();
  c.env.clock.advance(3_600_000);
  c.idp.inject('token', { delayMs: 300, status: 0 });
  const inflight = c.env.controller.provider.accessHeaders({ id: 'gmail' });      // a request has started a refresh
  await until(() => c.idp.tokenRequests('refresh_token').length === 1);
  c.env.controller.beginShutdown();                                              // quit begins
  const joined = c.env.controller.provider.accessHeaders({ id: 'gmail' });
  await c.env.controller.drain(3000);
  // the drain itself is what waited: by the time it returns the rotated token is ALREADY saved
  const after = c.record();
  assert.notEqual(after.refreshToken, before.refreshToken, 'the ROTATED refresh token was saved, not lost');
  const [first, second] = await Promise.all([inflight, joined]);
  assert.equal(first.ok && second.ok, true, 'the refresh on the wire completed, for both');
  assert.equal(c.idp.tokenRequests('refresh_token').length, 1, 'and it was the only one');
  assert.equal(c.idp.liveAccessTokens().includes(after.accessToken), true);
  c.env.controller.dispose();
});

test('QUIT: once it has begun, no NEW refresh starts: the provider is not asked, and the caller is told it is unavailable', async (t) => {
  const c = await assemble(t);
  await c.signIn();
  c.env.clock.advance(3_600_000);                                                // the token needs refreshing
  c.env.controller.beginShutdown();
  assert.deepEqual(await c.env.controller.provider.accessHeaders({ id: 'gmail' }), { ok: false, code: 'unavailable' });
  assert.equal(c.idp.tokenRequests('refresh_token').length, 0);
  await c.env.controller.drain(100);                                             // nothing to wait for: returns at once
  c.env.controller.dispose();
});

test('QUIT: a refresh that will not finish does not hold the quit; the drain gives up at its limit', async (t) => {
  const c = await assemble(t);
  await c.signIn();
  c.env.clock.advance(3_600_000);
  c.idp.inject('token', { hang: true });
  const inflight = c.env.controller.provider.accessHeaders({ id: 'gmail' });
  inflight.catch(() => undefined);
  await until(() => c.idp.tokenRequests('refresh_token').length === 1);
  c.env.controller.beginShutdown();
  const started = Date.now();
  await c.env.controller.drain(200);
  assert.ok(Date.now() - started < 1500, 'bounded');
  c.env.controller.dispose();
  assert.equal((await inflight).ok, false, 'disposed: the hung refresh is abandoned, and nobody is left waiting');
});

test('CRASH AND RESTART: the sign-in survives (it was sealed before use); every capability and every agent config is dead', async (t) => {
  const c = await assemble(t, { grants: { defaults: { gmail: { preset: 'custom', allow: ['search'] } } } });
  await c.signIn();
  const A = await c.spawn('agent-A');
  assert.equal((await c.agent(A.file).post(INIT)).status, 200);
  // the app dies; a new run starts on the same encrypted store and the same hive folder
  c.broker.stop();
  const { OAuthController } = loadTs('src/main/oauth/controller.ts');
  const revived = new IntegrationBroker({ getRecord: () => undefined, getSecret: () => undefined }, {
    mcp: {
      resolve: (id) => { const i = mcpIntegrationFor(id, c.cfg); return i ? { ...i, url: `${c.idp.issuer}/mcp` } : undefined; },
      credentials: c.env.controller.provider, grants: () => sanitizeMcpGrants(c.cfg.mcpGrants)
    }
  });
  assert.equal((await revived.start()).ok, true);
  t.after(() => revived.stop());
  assert.equal(c.env.controller.status('gmail'), 'connected', 'no sign-in was lost');
  assert.equal(c.hive.sweepMcpConfigs(), 1, 'the startup sweep removes the old run\'s config');
  assert.equal(fs.existsSync(A.file), false);
  const port = Number(new URL(revived.url()).port);
  const old = await call(port, { method: 'POST', path: '/m/gmail', headers: { authorization: `Bearer ${A.token}`, 'content-type': 'application/json' }, body: INIT });
  assert.equal(old.status, 401, 'a capability from the dead run means nothing to the new one');
  assert.equal(typeof OAuthController, 'function');
});

// ─── nothing leaks ───────────────────────────────────────────────────────────

test('SECRECY: the client secret, the tokens and a tool argument are in no config, argument, environment, response, log or audit entry', async (t) => {
  const captured = [];
  const originals = {};
  for (const m of ['log', 'error', 'warn', 'info']) { originals[m] = console[m]; console[m] = (...a) => captured.push(a.map(String).join(' ')); }
  t.after(() => { for (const m of Object.keys(originals)) console[m] = originals[m]; });

  const c = await assemble(t, { grants: { defaults: { gmail: { preset: 'custom', allow: ['search', 'send'] } } } });
  await c.signIn();
  const A = await c.spawn('agent-A');
  const a = c.agent(A.file);
  const responses = [];
  for (const body of [INIT, LIST, CALL('search'), CALL('send'), CALL('nope'), rpc('weird/method', undefined, 9), '{broken']) responses.push(await a.post(body));
  const rec = c.record();
  c.idp.access.get(rec.accessToken).revoked = true;
  responses.push(await a.post(LIST));
  const [id, secret] = [c.env.secrets.map.get('mcp:gmail:client_id'), c.env.secrets.map.get('mcp:gmail:client_secret')];
  const planted = [secret, rec.accessToken, rec.refreshToken, 'ARGUMENT-DO-NOT-LEAK', c.record().accessToken, c.record().refreshToken].filter(Boolean);
  assert.ok(planted.length >= 5);

  const surfaces = {
    'agent config file': fs.readFileSync(A.file, 'utf8'),
    'spawn arguments': JSON.stringify(A.inj.args),
    'spawn environment': JSON.stringify(A.inj.env),
    'every response and header the agent saw': responses.map((r) => JSON.stringify(r.headers) + r.body.toString('utf8')).join('\n'),
    'the activity log': JSON.stringify(c.audit.recent()),
    'the tools the panel is shown': JSON.stringify(c.broker.mcpTools('gmail')),
    'the grants the panel is shown': JSON.stringify(sanitizeMcpGrants(c.cfg.mcpGrants)),
    'the OAuth engine\'s log': c.env.logs.join('\n'),
    'the console': captured.join('\n'),
    'every other file the hive wrote': (function walk(dir) {
      let out = '';
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) out += walk(p);
        else if (p !== A.file && !p.endsWith('.sock')) { try { out += fs.readFileSync(p, 'utf8'); } catch { /* binary or gone */ } }
      }
      return out;
    })(path.join(c.home, 'hive'))
  };
  for (const [where, text] of Object.entries(surfaces)) {
    for (const secretValue of planted) {
      if (where === 'every response and header the agent saw' && secretValue === 'ARGUMENT-DO-NOT-LEAK') continue;   // an upstream may echo what the agent itself sent
      assert.equal(text.includes(secretValue), false, `${where} leaked ${secretValue.slice(0, 12)}…`);
    }
    assert.equal(text.includes(id) && where !== 'the OAuth engine\'s log' ? text.includes(id) : false, false, `${where} carries the client id`);
  }
  assert.ok(surfaces['the activity log'].includes('agent-A'), 'and the scan is not blind: the log does hold what it should');
  assert.ok(surfaces['agent config file'].includes(A.token), 'nor is it blind to the one value the config is MEANT to hold');
});
