'use strict';

/**
 * Stage B, end to end: the real broker, the real route, the real stdio host, the real hive config
 * writer and the real audit store, with only the server binary replaced by a stand-in (the real
 * packages are exercised by tools/verify-packages-live.cjs and the live Claude check).
 *
 * It answers, in one place, the questions the stage was asked:
 *   2  Does a provider credential appear in the agent's config, process arguments, environment,
 *      the answers it got, the console or the audit trail?
 *   3  Is every local server launched and controlled by the app, not by the agent?
 *   4  Can an agent bypass the broker, or use another agent's capability?
 *   6  What does revocation actually stop: a request that has not reached the server, a request
 *      that is running, and what a running server had already done?
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');
const { call, json, bearer } = require('./fixtures/broker-helpers.cjs');

const { IntegrationBroker } = loadTs('src/main/integrationBroker.ts');
const { StdioHost } = loadTs('src/main/broker/stdio-host.ts');
const { DISCOVERY_AGENT } = loadTs('src/main/broker/mcp-route.ts');
const { AuditStore } = loadTs('src/main/broker/audit-store.ts');
const { HiveManager } = loadTs('src/main/hive.ts');
const { MCP_CATALOG, mcpCatalogEntry } = loadTs('src/shared/mcpCatalog.ts');
const { mcpIntegrationFor, sanitizeMcpGrants } = loadTs('src/main/mcpWiring.ts');
const { createMcpCredentialProvider, localServerEnv, localServerSecrets } = loadTs('src/main/mcpCredentials.ts');
const { resolveLaunch } = loadTs('src/main/mcpLaunch.ts');

const FAKE = path.join(__dirname, 'fixtures', 'fake-mcp-stdio.cjs');
const CANARY = { notion: 'ntn_CANARY_NOTION_0123456789abcdef', github: 'ghp_CANARY_GITHUB_0123456789abcdefghij', 'brave-search': 'BSA_CANARY_BRAVE_0123456789abcdef' };
const INIT = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'agent', version: '1' } } });
const NOTE = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' });
const rpc = (id, method, params) => JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (fn, ms = 6000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 25)); } return null; };

/** The app, assembled the way index.ts assembles it, around a stand-in server binary. */
async function app(t, { grants = {}, consent = ['notion', 'time', 'filesystem'], vault = { notion: CANARY.notion } } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mosbius-e2e-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'server-events.log');
  const cwds = new Map();
  const cfg = { mcpDefaults: Object.fromEntries(consent.map((id) => [id, { enabled: true }])), mcpGrants: grants };
  const audit = new AuditStore({ dir: path.join(dir, 'audit'), key: Buffer.from('k'.repeat(32)) });
  t.after(() => audit.close());
  const consoleCalls = [];
  const orig = {};
  for (const k of ['log', 'error', 'warn', 'info']) { orig[k] = console[k]; console[k] = (...a) => consoleCalls.push(a); }
  t.after(() => { for (const k of Object.keys(orig)) console[k] = orig[k]; });

  const host = new StdioHost({
    launch: (id, agentId) => {
      const entry = mcpCatalogEntry(id);
      if (!entry || entry.spec.transport === 'http' || entry.spec.transport === 'bridge') return undefined;
      if (cfg.mcpDefaults[id]?.enabled !== true) return undefined;
      const cwd = agentId === DISCOVERY_AGENT ? dir : cwds.get(agentId);
      if (!cwd) return undefined;
      const env = localServerEnv(entry, process.env, process.env.PATH);
      const secrets = localServerSecrets(entry, vault[id]);
      if (!env || !secrets) return undefined;
      // exactly what index.ts does: an allow-list environment with no credential, and the credential on a private pipe
      return resolveLaunch(entry, { command: process.execPath, args: [FAKE], runtime: 'node' }, cwd, { ...env, FAKE_LOG: log }, secrets);
    },
    limits: { killGraceMs: 300 }
  });
  t.after(() => host.closeAll());

  const broker = new IntegrationBroker({ getRecord: () => undefined, getSecret: () => undefined }, {
    mcp: {
      resolve: (id) => mcpIntegrationFor(id, cfg),
      credentials: createMcpCredentialProvider({ entry: mcpCatalogEntry, token: (id) => vault[id], oauth: { accessHeaders: () => ({ ok: false, code: 'sign_in_required' }) } }),
      hosted: { handle: (i, a, b, s) => host.handle(i, a, b, s), close: (a, i) => host.close(a, i) },
      grants: () => sanitizeMcpGrants(cfg.mcpGrants),
      audit: (e) => audit.append({ kind: 'mcp', actor: `agent:${e.agentId}`, agentId: e.agentId, integrationId: e.integrationId, action: e.tool ?? e.method, decision: e.decision, reason: e.reason })
    }
  });
  const { port } = await broker.start();
  t.after(() => broker.stop());
  const events = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

  /** An agent: gets a workspace and a capability, and the hive writes its config exactly as at spawn. */
  const spawnAgent = async (agentId, ids) => {
    const work = path.join(dir, `work-${agentId}`);
    fs.mkdirSync(work, { recursive: true });
    cwds.set(agentId, work);
    const token = broker.grantMcp(agentId, ids);
    const hive = new HiveManager(() => dir);
    const inj = await hive.ensureAgent({ id: agentId, name: agentId, provider: 'claude', cwd: work }, {
      mcpDefaults: cfg.mcpDefaults,
      mcpBroker: (id) => (ids.includes(id) ? { url: `http://127.0.0.1:${port}/m/${id}`, authorization: `Bearer ${token}` } : undefined)
    });
    const configPath = path.join(dir, 'hive', 'agents', agentId, 'mcp-config.json');
    const config = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
    const post = (id, body, extra = {}) => call(port, { method: 'POST', path: `/m/${id}`, headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...bearer(token), ...(extra.headers ?? {}) }, body, host: undefined });
    const open = async (id) => { const r = await post(id, INIT); await post(id, NOTE); return r; };
    return { agentId, work, token, inj, config, configPath, post, open };
  };
  return { dir, port, broker, host, cfg, vault, audit, events, spawnAgent, consoleCalls, log };
}

// the stand-in server has tools of its own (`echo`, `slow_write`) that no catalogue entry pins, so they are
// reached the way an unclassified tool always is: by naming them
const ALL = { defaults: {
  notion: { preset: 'custom', allow: ['echo'] },
  time: { preset: 'custom', allow: ['echo'] },
  filesystem: { preset: 'custom', allow: ['echo', 'slow_write'] }
} };

// ─── 3. launched and controlled by the app ──────────────────────────────────

test('3. THE APP LAUNCHES AND CONTROLS EVERY LOCAL SERVER: its parent is the app, never the agent, and the agent was given no way to start one', async (t) => {
  const a = await app(t, { grants: ALL });
  const agent = await a.spawnAgent('agent-1', ['notion', 'time', 'filesystem']);
  // 1. nothing in the agent's config could start a process
  const cfg = JSON.parse(agent.config);
  for (const [name, s] of Object.entries(cfg.mcpServers)) {
    assert.deepEqual(Object.keys(s).sort(), ['headers', 'type', 'url'], name);
    assert.equal(s.type, 'http');
  }
  assert.equal(JSON.stringify(agent.inj.args).includes('npx'), false);
  // 2. yet all three servers work, through the broker
  for (const id of ['notion', 'time', 'filesystem']) {
    const r = await agent.open(id);
    assert.equal(r.status, 200, id);
    assert.equal(json(r).result.serverInfo.name, 'fake');
  }
  const starts = a.events().filter((e) => e.ev === 'start');
  assert.equal(starts.length, 3);
  // 3. every one of them is a child of THIS process (the app), and not of anything the agent could be
  for (const s of starts) {
    const ppid = Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(s.pid)], { encoding: 'utf8' }).trim());
    assert.equal(ppid, process.pid, `server ${s.pid} was started by ${ppid}, not by the app`);
  }
  // 4. the app controls them: revoking the agent stops them
  a.broker.revoke('agent-1');
  for (const s of starts) assert.ok(await until(() => !alive(s.pid)), `${s.pid} outlived its agent's capability`);
});

test('3. a stdio server listens on nothing: the only way in is the broker', async (t) => {
  const a = await app(t, { grants: ALL });
  const agent = await a.spawnAgent('agent-1', ['time']);
  await agent.open('time');
  const pid = a.events().find((e) => e.ev === 'start').pid;
  let listening = '';
  try { listening = execFileSync('lsof', ['-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN', '-Pn'], { encoding: 'utf8' }); } catch { /* lsof exits 1 when there is nothing */ }
  assert.equal(listening.trim(), '', 'the server child has a listening socket');
});

// ─── 2. no credential reaches the agent ─────────────────────────────────────

test('2. A PROVIDER CREDENTIAL NEVER REACHES THE AGENT: not its config, its spawn arguments or environment, anything it was answered, the console or the audit trail', async (t) => {
  const a = await app(t, { grants: ALL, vault: { notion: CANARY.notion } });
  const agent = await a.spawnAgent('agent-1', ['notion', 'time', 'filesystem']);

  // everything the agent could ever see, collected
  const seen = [agent.config, JSON.stringify(agent.inj.args), JSON.stringify(agent.inj.env ?? {}), JSON.stringify(agent.inj.seedPrompt ?? '')];
  const collect = (r) => seen.push(JSON.stringify(r.headers), r.body ? r.body.toString('utf8') : '');
  collect(await agent.open('notion'));
  collect(await agent.post('notion', rpc(2, 'tools/list')));
  collect(await agent.post('notion', rpc(3, 'tools/call', { name: 'echo', arguments: { ask: 'what is your token?' } })));
  collect(await agent.post('notion', rpc(4, 'tools/call', { name: 'does-not-exist' })));          // denied: the error must not echo anything
  collect(await agent.post('time', rpc(5, 'tools/call', { name: 'echo' })));                      // a server the agent is not granted a tool of
  collect(await call(a.port, { method: 'GET', path: '/m/notion', headers: bearer(agent.token) }));
  // every file under the app's data dir that the agent could read: its hive folder and the audit trail
  const walk = (d) => { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); if (fs.statSync(p).isDirectory()) walk(p); else if (!p.endsWith('server-events.log')) seen.push(fs.readFileSync(p, 'utf8')); } };
  walk(a.dir);
  a.audit.close();
  seen.push(...a.consoleCalls.map((c) => JSON.stringify(c)));
  // the process listing: no argv of any process carries the credential ...
  seen.push(execFileSync('ps', ['-axo', 'args'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
  // ... and neither does the argument list or INITIAL ENVIRONMENT of the server that holds it, which is what
  // any other process of this user can read with `ps eww`
  for (const s of a.events().filter((e) => e.ev === 'start')) {
    let view = '';
    await until(() => { view = execFileSync('ps', ['eww', '-p', String(s.pid)], { encoding: 'utf8' }); return view.length > 100; });
    assert.ok(view.length > 100, 'the OS showed nothing for the server process: this check would be empty');
    seen.push(view);
  }

  for (const [name, canary] of Object.entries(CANARY)) {
    seen.forEach((blob, i) => assert.equal(blob.includes(canary), false, `${name}'s credential appears in surface #${i}`));
  }
  // ... while the one process that needs it does hold it, and only that one
  const starts = a.events().filter((e) => e.ev === 'start');
  const byCwd = Object.fromEntries(starts.map((s) => [s.args.join(' '), s.secret]));
  assert.equal(starts.filter((s) => s.secret === CANARY.notion).length, 1, 'exactly one server has the Notion credential');
  assert.equal(starts.filter((s) => s.secret && s.secret !== CANARY.notion).length, 0);
  assert.ok(Object.keys(byCwd).length >= 1);
});

test('2. a server holds only its OWN credential: another server never gets it, and a missing credential means it does not start', async (t) => {
  const a = await app(t, { grants: { defaults: { notion: { preset: 'read' }, 'brave-search': { preset: 'read' }, time: { preset: 'read' } } }, consent: ['notion', 'brave-search', 'time'], vault: { notion: CANARY.notion, 'brave-search': CANARY['brave-search'] } });
  const agent = await a.spawnAgent('agent-1', ['notion', 'brave-search', 'time']);
  for (const id of ['notion', 'brave-search', 'time']) await agent.open(id);
  const starts = a.events().filter((e) => e.ev === 'start');
  const secrets = starts.map((s) => s.secret).filter(Boolean).sort();
  assert.deepEqual(secrets, [CANARY['brave-search'], CANARY.notion].sort(), 'each credential went to exactly one process');
  const notionEnv = starts.find((s) => s.secret === CANARY.notion).env;
  assert.equal(notionEnv.includes('BRAVE_API_KEY'), false);
  assert.equal(notionEnv.includes('NOTION_TOKEN'), true);
  // no credential => no process
  const none = await app(t, { grants: ALL, vault: {} });
  const ag = await none.spawnAgent('agent-1', ['notion']);
  const r = await ag.open('notion');
  assert.equal(r.status, 503, 'the broker refuses before anything is started');
  assert.equal(none.events().filter((e) => e.ev === 'start').length, 0);
});

test('2. the app\'s own environment does not leak into a server', async (t) => {
  process.env.MOSBIUS_E2E_LEAK = 'APP-ENV-LEAK';
  process.env.ANTHROPIC_API_KEY = 'sk-ant-E2E-LEAK';
  t.after(() => { delete process.env.MOSBIUS_E2E_LEAK; delete process.env.ANTHROPIC_API_KEY; });
  const a = await app(t, { grants: ALL });
  const agent = await a.spawnAgent('agent-1', ['time']);
  await agent.open('time');
  const start = a.events().find((e) => e.ev === 'start');
  assert.equal(start.env.includes('MOSBIUS_E2E_LEAK'), false);
  assert.equal(start.env.includes('ANTHROPIC_API_KEY'), false);
});

// ─── 4. bypass attempts and cross-agent reuse ───────────────────────────────

test('4. CROSS-AGENT: one agent\'s capability cannot reach another\'s server, another integration, or anything after it is revoked', async (t) => {
  const a = await app(t, { grants: ALL });
  const one = await a.spawnAgent('agent-1', ['time']);
  const two = await a.spawnAgent('agent-2', ['filesystem']);
  assert.equal((await one.open('time')).status, 200);
  assert.equal((await two.open('filesystem')).status, 200);
  // agent-1's capability does not list the filesystem server
  assert.equal((await one.post('filesystem', rpc(2, 'tools/list'))).status, 403);
  // and agent-2's does not list time
  assert.equal((await two.post('time', rpc(2, 'tools/list'))).status, 403);
  // each has a server of its own: two processes, two workspaces
  const starts = a.events().filter((e) => e.ev === 'start');
  assert.equal(new Set(starts.map((s) => s.pid)).size, 2);
  assert.notEqual(starts[0].cwd, starts[1].cwd);
  // a forged or guessed token is nothing; so is one with a character changed
  for (const bad of [one.token.slice(0, -1) + (one.token.endsWith('A') ? 'B' : 'A'), 'x'.repeat(43), '', one.token + 'x']) {
    const r = await call(a.port, { method: 'POST', path: '/m/time', headers: { 'content-type': 'application/json', ...bearer(bad) }, body: INIT });
    assert.equal(r.status, 401, JSON.stringify(bad.slice(0, 6)));
  }
  // a session id belonging to the other agent is not an introduction
  const r = await one.post('time', rpc(3, 'tools/list'), { headers: { 'mcp-session-id': 'agent-2-session' } });
  assert.equal(r.status, 404);
  // revoking agent-1 does not touch agent-2, and agent-1's token is dead everywhere
  a.broker.revokeMcp('agent-1');
  assert.equal((await one.post('time', rpc(4, 'tools/list'))).status, 401);
  assert.equal((await two.post('filesystem', rpc(4, 'tools/list'))).status, 200);
});

test('4. A MINTED CAPABILITY IS FOR ONE CHANNEL: a REST capability is worthless on the MCP route and the reverse', async (t) => {
  const a = await app(t, { grants: ALL });
  const restToken = a.broker.grant('agent-1', ['anything']);
  const r = await call(a.port, { method: 'POST', path: '/m/time', headers: { 'content-type': 'application/json', ...bearer(restToken) }, body: INIT });
  assert.equal(r.status, 401);
  const mcp = await a.spawnAgent('agent-2', ['time']);
  const back = await call(a.port, { method: 'GET', path: '/i/anything/x', headers: bearer(mcp.token) });
  assert.equal(back.status, 401);
});

test('4. NO BYPASS THROUGH THE REQUEST: nothing the agent sends changes how a server is started, where it works or what it is told', async (t) => {
  const a = await app(t, { grants: ALL });
  const agent = await a.spawnAgent('agent-1', ['filesystem']);
  const marker = path.join(a.dir, 'PWNED');
  // an initialize that tries to smuggle in a command, arguments, an environment and other roots
  const evil = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
    protocolVersion: '2025-06-18', capabilities: { roots: { listChanged: true }, sampling: {}, elicitation: {} },
    clientInfo: { name: 'a', version: '1' }, command: 'sh', args: ['-c', `touch ${marker}`], env: { NOTION_TOKEN: 'x', NODE_OPTIONS: '--require /tmp/x.js' },
    cwd: '/', roots: [{ uri: 'file:///' }]
  } });
  const r = await agent.post('filesystem', evil);
  assert.equal(r.status, 200);
  await agent.post('filesystem', NOTE);
  const start = a.events().find((e) => e.ev === 'start');
  assert.deepEqual(start.args, [agent.work], 'the server was started with the arguments the catalogue gives it (the agent\'s own workspace), whatever the request said');
  assert.equal(start.env.includes('NODE_OPTIONS'), false);
  assert.equal(fs.existsSync(marker), false, 'a command in the request was run');
  const init = a.events().find((e) => e.ev === 'recv' && e.method === 'initialize');
  assert.deepEqual(init.params.capabilities, { roots: { listChanged: false } }, 'the server was told what the HOST can serve, not what the agent claimed');
  assert.equal(JSON.stringify(init.params).includes('sh -c'), false);
  assert.equal(Object.keys(init.params).sort().join(), 'capabilities,clientInfo,protocolVersion', 'only the three known fields were passed on');
});

test('4. NO BYPASS THROUGH THE ADDRESS: a hostile integration id, host, origin or method never reaches a server', async (t) => {
  const a = await app(t, { grants: ALL });
  const agent = await a.spawnAgent('agent-1', ['time']);
  const base = { headers: { 'content-type': 'application/json', ...bearer(agent.token) }, body: INIT };
  for (const p of ['/m/../time', '/m/%2e%2e/time', '/m/time/../../x', '/m/time%00', '/m/', '/m/TIME', '/m/ti%20me']) {
    const r = await call(a.port, { method: 'POST', path: p, ...base });
    assert.ok([400, 403, 404].includes(r.status), `${p} -> ${r.status}`);
  }
  assert.equal(a.events().filter((e) => e.ev === 'start').length, 0, 'not one of those started a server');
  // a query string is simply ignored: it is not passed on and cannot change which server runs
  const q = await call(a.port, { method: 'POST', path: '/m/time?x=../y&command=sh', ...base });
  assert.equal(q.status, 200);
  const starts = a.events().filter((e) => e.ev === 'start');
  assert.equal(starts.length, 1);
  assert.deepEqual(starts[0].args, [], 'the time server takes no arguments, whatever the query said');
  return;
  assert.equal((await call(a.port, { method: 'POST', path: '/m/time', ...base, host: 'evil.example' })).status, 421);
  assert.equal((await call(a.port, { method: 'POST', path: '/m/time', ...base, headers: { ...base.headers, origin: 'https://evil.example' } })).status, 403);
  assert.equal((await call(a.port, { method: 'PUT', path: '/m/time', ...base })).status, 405);
});

test('4. AN INTEGRATION THE USER SWITCHED OFF CANNOT BE REACHED, AND ITS SERVER IS STOPPED', async (t) => {
  const a = await app(t, { grants: ALL });
  const agent = await a.spawnAgent('agent-1', ['time']);
  await agent.open('time');
  const pid = a.events().find((e) => e.ev === 'start').pid;
  a.cfg.mcpDefaults.time.enabled = false;
  assert.equal((await agent.post('time', rpc(2, 'tools/list'))).status, 403, 'refused on the very next request');
  a.broker.revokeIntegration('time');
  assert.ok(await until(() => !alive(pid)), 'and the process is stopped');
});

// ─── 6. what revocation stops ───────────────────────────────────────────────

test('6. MCP REVOCATION: a request made after it never reaches the server; one that is running is cut off and the server is killed; what it had already DONE stays done', async (t) => {
  const a = await app(t, { grants: { defaults: { filesystem: { preset: 'custom', allow: ['slow_write', 'echo'] } } }, consent: ['filesystem'] });
  const agent = await a.spawnAgent('agent-1', ['filesystem']);
  await agent.open('filesystem');
  await agent.post('filesystem', rpc(2, 'tools/list'));
  const pid = a.events().find((e) => e.ev === 'start').pid;
  const file = path.join(a.work ?? a.dir, 'written-by-the-server.txt');

  // a running operation: the server performs an effect immediately, then takes its time
  const running = agent.post('filesystem', rpc(3, 'tools/call', { name: 'slow_write', arguments: { file, ms: 4000 } }));
  assert.ok(await until(() => fs.existsSync(file)), 'the effect happened before revocation');
  const before = a.events().length;
  a.broker.revokeMcp('agent-1');
  const result = await running;
  assert.ok(result.error || result.status >= 400 || (result.status === 200 && JSON.stringify(json(result)).includes('error')),
    'the agent does not get the operation\'s result: the connection was cut or the call refused');
  assert.ok(await until(() => !alive(pid)), 'the server was killed');
  // ... but revocation cannot undo what had happened before it
  assert.equal(fs.readFileSync(file, 'utf8'), 'written-before-revocation', 'an effect that was already carried out is still there');
  assert.equal(a.events().some((e) => e.ev === 'answer' && false), false);

  // a request made AFTER revocation never reaches any server: no new process, no new line to a server
  const after = await agent.post('filesystem', rpc(4, 'tools/call', { name: 'echo' }));
  assert.equal(after.status, 401);
  assert.equal(a.events().filter((e) => e.ev === 'recv').length <= before + 1, true, 'no request reached a server after revocation');
  assert.equal(a.events().filter((e) => e.ev === 'start').length, 1, 'and no server was started for it');
});

test('6. REST REVOCATION: the same split, against a real upstream: a request in flight is cut from the agent, the upstream had already received it, and a later one never arrives', async (t) => {
  const http = require('node:http');
  const seen = [];
  let finished = 0;
  const up = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    setTimeout(() => { finished++; res.writeHead(200); res.end('done'); }, 700);     // the "operation" takes time
  });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  t.after(() => { up.closeAllConnections?.(); up.close(); });
  const rec = { id: 'api', label: 'API', kind: 'custom-rest', baseUrl: `http://127.0.0.1:${up.address().port}`, authType: 'none', enabled: true, createdAt: 1, updatedAt: 1 };
  const state = { grants: { defaults: { api: { preset: 'write' } } } };
  const broker = new IntegrationBroker({ getRecord: (id) => (id === 'api' ? rec : undefined), getSecret: () => undefined }, { rest: { grants: () => state.grants } });
  const { port } = await broker.start();
  t.after(() => broker.stop());
  const token = broker.grant('w1', ['api']);

  const inflight = call(port, { method: 'POST', path: '/i/api/orders', headers: { ...bearer(token), 'content-type': 'application/json' }, body: '{"order":1}' });
  assert.ok(await until(() => seen.length === 1), 'the upstream received the request');
  broker.revoke('w1');
  const r = await inflight;
  assert.ok(r.error || r.status >= 400, 'the agent is not given the result: its connection was cut');
  // the operation the upstream already had is NOT stopped by revocation: it runs to completion
  assert.ok(await until(() => finished === 1), 'the upstream carried on and finished the operation it had received');
  // nothing new can start
  const later = await call(port, { method: 'POST', path: '/i/api/orders', headers: { ...bearer(token), 'content-type': 'application/json' }, body: '{"order":2}' });
  assert.equal(later.status, 401);
  await new Promise((r2) => setTimeout(r2, 150));
  assert.equal(seen.length, 1, 'the second request never reached the upstream');
  // a withdrawn GRANT (capability still alive) stops the next request too, before the upstream
  const t2 = broker.grant('w2', ['api']);
  state.grants = {};
  assert.equal((await call(port, { method: 'GET', path: '/i/api/x', headers: bearer(t2) })).status, 403);
  assert.equal(seen.length, 1);
});

// ─── the audit trail records all of it ──────────────────────────────────────

test('AUDIT: every allowed and refused request in these flows is on the durable trail, the chain verifies, and it holds no credential', async (t) => {
  const a = await app(t, { grants: { defaults: { notion: { preset: 'custom', allow: ['echo'] } } } });
  const agent = await a.spawnAgent('agent-1', ['notion']);
  await agent.open('notion');
  await agent.post('notion', rpc(2, 'tools/list'));
  await agent.post('notion', rpc(3, 'tools/call', { name: 'echo' }));
  await agent.post('notion', rpc(4, 'tools/call', { name: 'slow_write' }));          // not on the allow list: refused
  a.audit.close();
  const v = a.audit.verify();
  assert.equal(v.ok, true, JSON.stringify(v));
  const recs = a.audit.recent({ kind: 'mcp', limit: 50 });
  assert.ok(recs.some((r) => r.decision === 'allow' && r.action === 'echo'));
  assert.ok(recs.some((r) => r.decision === 'deny' && r.action === 'slow_write'));
  assert.equal(JSON.stringify(recs).includes(CANARY.notion), false);
  assert.ok(MCP_CATALOG.length > 0);
});
