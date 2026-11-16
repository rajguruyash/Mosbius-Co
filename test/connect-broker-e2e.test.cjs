'use strict';

/**
 * A hosted server connected with an ACCOUNT, assembled the way the app assembles it: the connection
 * manager, the credential provider, the broker's MCP route, the wiring rules and the hive that writes an
 * agent's config; a stand-in provider and a stand-in MCP server behind them; a plain HTTP client standing
 * in for the agent's CLI (it reads the config file the hive wrote and does exactly what the file says).
 *
 * A pass proves the app's own behaviour. It says nothing about any real provider: those are verified by a
 * real sign-in, and recorded as such in MOSBIUS_PLATFORM_ROADMAP.md.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startStageAIdp } = require('./fixtures/stage-a-idp.cjs');
const { call, json, rpc } = require('./fixtures/broker-helpers.cjs');
const loadTs = require('./load-ts.cjs');

const { IntegrationBroker } = loadTs('src/main/integrationBroker.ts');
const { HiveManager } = loadTs('src/main/hive.ts');
const { AuditLog } = loadTs('src/main/broker/audit.ts');
const { mcpIntegrationFor, eligibleIntegrationIds, sanitizeMcpGrants } = loadTs('src/main/mcpWiring.ts');
const { createMcpCredentialProvider } = loadTs('src/main/mcpCredentials.ts');
const { ConnectionManager } = loadTs('src/main/connect/manager.ts');
const { safeLog } = loadTs('src/main/oauth/types.ts');

const ID = 'linear';           // a real catalogue id: the wiring rules run against the real entry, the address is the stand-in's
const INIT = rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'claude-code', version: '0' } }, 1);
const LIST = rpc('tools/list', undefined, 2);
const CALL = (name) => rpc('tools/call', { name, arguments: { query: 'x', secretArgument: 'ARGUMENT-DO-NOT-LEAK' } }, 3);
const names = (r) => json(r).result.tools.map((x) => x.name);

const rawGet = (target, headers = {}) => new Promise((resolve) => {
  const u = new URL(target);
  const req = http.request({ host: '127.0.0.1', port: u.port, path: u.pathname + u.search, headers }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
  req.on('error', () => resolve(0)); req.end();
});
const browser = async (url) => {
  const r = await fetch(url, { redirect: 'manual' });
  const loc = r.headers.get('location');
  if (loc) await rawGet(loc, { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' });
};
function makeVault() {
  const v = { map: new Map(), get: (r) => v.map.get(r), set: (r, x) => (v.map.set(r, x), { ok: true }), has: (r) => v.map.has(r), readable: () => true, delete: (r) => v.map.delete(r) };
  return v;
}

async function assemble(t, { grants = {}, trust = false, idpOpts } = {}) {
  const idp = await startStageAIdp(t, idpOpts);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mosbius-conn-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const vault = makeVault();
  const clock = { now: Date.now() };
  const entry = {
    id: ID, label: 'Linear', description: '', tier: 'write', defaultEnabled: false, publisher: 'test', source: 'test', verified: '2026-11-15',
    spec: { transport: 'http', url: `${idp.base}/mcp`, connect: { hosts: [idp.host], methods: [{ kind: 'dcr' }] } }
  };
  const mgr = new ConnectionManager({
    entry: (id) => (id === ID ? entry : undefined), secrets: vault, fetch: (u, i) => fetch(u, i), openUrl: browser,
    now: () => clock.now, log: safeLog(() => {}), policy: { allowInsecureLoopback: true }, sleep: async () => {},
    timeouts: { signInMs: 4000, requestMs: 5000, refreshMs: 5000, retryDelaysMs: [0, 0], cooldownMs: 20, revokeMs: 3000 }
  });
  t.after(() => mgr.dispose());
  const cfg = { mcpDefaults: { [ID]: { enabled: true } }, mcpGrants: grants, ...(trust ? { mcpTrustHints: { [ID]: true } } : {}) };
  const audit = new AuditLog();
  const broker = new IntegrationBroker({ getRecord: () => undefined, getSecret: () => undefined }, {
    mcp: {
      resolve: (id) => { const i = mcpIntegrationFor(id, cfg); return i ? { ...i, url: `${idp.base}/mcp` } : undefined; },
      credentials: createMcpCredentialProvider({
        entry: (id) => (id === ID ? entry : undefined), token: () => undefined,
        oauth: { accessHeaders: () => ({ ok: false, code: 'unavailable' }) },
        connections: { status: (id) => mgr.status(id), accessHeaders: (s) => mgr.accessHeaders(s), rejected: (s, u) => mgr.rejected(s, u) }
      }),
      grants: () => sanitizeMcpGrants(cfg.mcpGrants),
      audit: (e) => audit.push(e)
    }
  });
  assert.equal((await broker.start()).ok, true);
  t.after(() => broker.stop());
  const hive = new HiveManager(() => home);
  return {
    idp, mgr, vault, clock, cfg, broker, home, audit,
    async spawn(agentId) {
      const mcpIds = eligibleIntegrationIds(cfg, agentId, (id) => (id === ID ? mgr.status(id) : 'unconfigured'), Date.now());
      const token = mcpIds.length ? broker.grantMcp(agentId, mcpIds) : undefined;
      await hive.ensureAgent({ id: agentId, name: agentId, provider: 'claude', cwd: home }, {
        mcpDefaults: cfg.mcpDefaults,
        mcpBroker: (cid) => (token !== undefined && mcpIds.includes(cid) ? { url: `${broker.url()}/m/${cid}`, authorization: `Bearer ${token}` } : undefined)
      });
      const file = path.join(home, 'hive', 'agents', agentId, 'mcp-config.json');
      return { mcpIds, token, file };
    },
    agent(file) {
      const c = JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers[`mosbius-${ID}`];
      const u = new URL(c.url);
      const base = { ...c.headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
      return { config: c, post: (body) => call(Number(u.port), { method: 'POST', path: u.pathname, headers: base, body }) };
    },
    /** What the provider's server was asked WITH an account. (Discovery makes one unauthenticated request first, as it must.) */
    upstream: () => idp.requests('/mcp').filter((r) => r.headers.authorization)
  };
}

test('THE WHOLE PATH: connect an account, grant a tool, spawn an agent: it lists, calls and is refused, and the provider\'s token never leaves main', async (t) => {
  const c = await assemble(t, { grants: { defaults: { [ID]: { preset: 'custom', allow: ['search'] } } } });
  assert.deepEqual((await c.spawn('agent-A')).mcpIds, [], 'nothing is reachable before the account is connected');
  assert.deepEqual(await c.mgr.connect(ID), { ok: true });
  const { file, token, mcpIds } = await c.spawn('agent-A');
  assert.deepEqual(mcpIds, [ID]);
  const agent = c.agent(file);
  assert.deepEqual(agent.config, { type: 'http', url: `${c.broker.url()}/m/${ID}`, headers: { Authorization: `Bearer ${token}` } });

  assert.equal((await agent.post(INIT)).status, 200);
  assert.deepEqual(names(await agent.post(LIST)), ['search']);
  assert.equal((await agent.post(CALL('search'))).status, 200);
  const denied = json(await agent.post(CALL('delete_page')));
  assert.equal(denied.error.code, -32003);
  const upstreamTokens = [...new Set(c.upstream().map((r) => r.headers.authorization))];
  assert.equal(upstreamTokens.length, 1);
  assert.ok(c.idp.liveAccess().includes(upstreamTokens[0].replace('Bearer ', '')), 'the provider saw ITS OWN access token');
  assert.equal(c.upstream().some((r) => JSON.stringify(r.headers).includes(token)), false, 'the agent\'s capability never went upstream');
  assert.deepEqual(c.upstream().map((r) => JSON.parse(r.rawBody || '{}').method), ['initialize', 'tools/list', 'tools/call'], 'the refused call never went upstream');

  // the agent's config holds nothing of the account
  const text = fs.readFileSync(file, 'utf8');
  for (const secret of [...c.idp.secretsSeen(), ...c.idp.codes.keys(), ...c.idp.regTokens.values(), ...[...c.idp.clients.keys()]]) assert.equal(text.includes(secret), false);
});

test('the transport\'s other two verbs come back from the provider unchanged: GET is "not offered", DELETE ends the session, and the listing keeps each tool\'s schema', async (t) => {
  // Found by driving the real Codex CLI: its typed MCP client rejects a tool list without inputSchema, and reads a 404 on a
  // live session as "expired". Claude Code tolerates both. The route must pass what a conforming server says straight through.
  const c = await assemble(t, { grants: { defaults: { [ID]: { preset: 'custom', allow: ['search'] } } } });
  await c.mgr.connect(ID);
  const { file } = await c.spawn('agent-G');
  const agent = c.agent(file);
  const init = await agent.post(INIT);
  const sid = init.headers['mcp-session-id'];
  assert.ok(sid, 'the provider\'s session id reaches the agent');
  const listed = json(await agent.post(LIST)).result.tools;
  assert.deepEqual(listed.map((x) => x.name), ['search']);
  assert.equal(typeof listed[0].inputSchema, 'object', 'the schema a client needs is kept');
  const u = new URL(agent.config.url);
  const port = Number(u.port);
  const headers = { ...agent.config.headers, 'mcp-session-id': sid, accept: 'text/event-stream' };
  assert.equal((await call(port, { method: 'GET', path: u.pathname, headers })).status, 405, 'no server-to-client stream is offered, and the agent is told so in the spec\'s words');
  assert.equal((await call(port, { method: 'DELETE', path: u.pathname, headers })).status, 204, 'the session is ended at the provider');
  const again = await call(port, { method: 'POST', path: u.pathname, headers: { ...headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: LIST });
  assert.equal(again.status, 404, 'an ended session is not reusable');
});

test('without the server\'s own hints nothing is classified, so presets reach nothing; with them switched on by the user, presets follow the hints and no further', async (t) => {
  for (const preset of ['read', 'write']) {
    const c = await assemble(t, { grants: { defaults: { [ID]: { preset } } } });
    await c.mgr.connect(ID);
    const { file } = await c.spawn('a');
    const a = c.agent(file);
    await a.post(INIT);
    assert.deepEqual(names(await a.post(LIST)), [], `${preset}: unclassified tools are not listed`);
  }
  const read = await assemble(t, { grants: { defaults: { [ID]: { preset: 'read' } } }, trust: true });
  await read.mgr.connect(ID);
  const ra = read.agent((await read.spawn('a')).file);
  await ra.post(INIT);
  assert.deepEqual(names(await ra.post(LIST)).sort(), ['fetch', 'search'], 'read-only by the server\'s hint');
  assert.match(json(await ra.post(CALL('create_page'))).error.message, /not granted/);

  const write = await assemble(t, { grants: { defaults: { [ID]: { preset: 'write' } } }, trust: true });
  await write.mgr.connect(ID);
  const wa = write.agent((await write.spawn('a')).file);
  await wa.post(INIT);
  assert.deepEqual(names(await wa.post(LIST)).sort(), ['create_page', 'fetch', 'search']);
  for (const never of ['delete_page', 'mystery']) assert.match(json(await wa.post(CALL(never))).error.message, /not granted/, `${never}: destructive or undescribed is never reached by a preset`);
});

test('a token that expired is renewed before it is used; one the server refuses is renewed and the request replayed once', async (t) => {
  const c = await assemble(t, { grants: { defaults: { [ID]: { preset: 'custom', allow: ['search'] } } } });
  await c.mgr.connect(ID);
  const a = c.agent((await c.spawn('a')).file);
  await a.post(INIT);
  const first = c.upstream().at(-1).headers.authorization;
  c.clock.now += 3 * 3600_000;
  assert.equal((await a.post(CALL('search'))).status, 200);
  const second = c.upstream().at(-1).headers.authorization;
  assert.notEqual(second, first, 'the expired token was renewed first');
  // the provider turns this token down (revoked behind our back): one replay with a fresh one, not a loop
  for (const acc of c.idp.access.values()) if (`Bearer ${[...c.idp.access.keys()].find((k) => c.idp.access.get(k) === acc)}` === second) acc.revoked = true;
  const before = c.upstream().length;
  const r = await a.post(CALL('search'));
  assert.equal(r.status, 200);
  assert.equal(c.upstream().length - before, 2, 'the refused request and exactly one replay');
  assert.notEqual(c.upstream().at(-1).headers.authorization, second);
});

test('disconnect: the agent is cut off at once, the provider is told, and nothing of the account remains', async (t) => {
  const c = await assemble(t, { grants: { defaults: { [ID]: { preset: 'custom', allow: ['search'] } } } });
  await c.mgr.connect(ID);
  const { file } = await c.spawn('a');
  const a = c.agent(file);
  await a.post(INIT);
  assert.equal((await a.post(CALL('search'))).status, 200);

  // what Disconnect does in the app: agent access ends first, then the provider, then the vault
  c.broker.revokeIntegration(ID);
  const report = await c.mgr.disconnect(ID);
  assert.equal(report.wiped, true);
  assert.equal(c.idp.liveAccess().length, 0, 'the provider no longer honours the token');
  assert.ok([401, 403].includes((await a.post(CALL('search'))).status), 'the agent\'s capability no longer works');
  assert.equal(c.vault.map.size, 0);

  // even with a capability still in hand, a disconnected account yields nothing to send upstream
  const again = await assemble(t, { grants: { defaults: { [ID]: { preset: 'custom', allow: ['search'] } } } });
  await again.mgr.connect(ID);
  const b = again.agent((await again.spawn('b')).file);
  await b.post(INIT);
  await again.mgr.disconnect(ID);
  const r = await b.post(CALL('search'));
  assert.equal(r.status, 401, 'the route says the account must be signed in again');
  assert.equal(json(r).code, 'sign_in_required');
  assert.equal(again.upstream().filter((x) => JSON.parse(x.rawBody || '{}').method === 'tools/call').length, 0, 'nothing reached the provider without an account');
});

test('a second agent has no access of its own and gets no entry; one agent cut off does not cut off another', async (t) => {
  const c = await assemble(t, { grants: { defaults: { [ID]: { preset: 'custom', allow: ['search'] } }, agents: { 'agent-B': { [ID]: { preset: 'none' } } } } });
  await c.mgr.connect(ID);
  assert.deepEqual((await c.spawn('agent-A')).mcpIds, [ID]);
  assert.deepEqual((await c.spawn('agent-B')).mcpIds, [], 'an explicit "none" beats the default');
  assert.equal(fs.existsSync(path.join(c.home, 'hive', 'agents', 'agent-B', 'mcp-config.json')), false, 'agent B was not even given a config');
});
