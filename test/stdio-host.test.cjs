'use strict';

/**
 * F1 — the stdio host, against a real child process (test/fixtures/fake-mcp-stdio.cjs).
 *
 * What must hold: an agent's request becomes JSON-RPC on the child's stdin and the child's answer
 * comes back under the agent's own id; each (agent, integration) has a child of its own; the child
 * sees only the environment it was launched with (the app's environment never leaks in) and the
 * credential only there; the server's own requests to its client are answered by the host
 * (ping, roots) or refused (sampling) and never reach the agent; a crashed, idle or stopped child
 * is started again with the agent's handshake replayed; closing an agent kills its children and
 * their children; limits hold; and the host writes nothing to the console.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { StdioHost, pathToFileUri } = loadTs('src/main/broker/stdio-host.ts');
const { NODE_SECRET_LAUNCHER } = loadTs('src/main/mcpLaunch.ts');
const { execFileSync } = require('node:child_process');
const FAKE = path.join(__dirname, 'fixtures', 'fake-mcp-stdio.cjs');

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 25)); }
  return null;
};

function setup(t, over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mosbius-host-'));
  const log = path.join(dir, 'events.log');
  const launches = [];
  const host = new StdioHost({
    launch: (integrationId, agentId) => {
      launches.push([integrationId, agentId]);
      if (over.unavailable) return undefined;
      return {
        command: process.execPath, args: [FAKE, ...(over.args ?? [])],
        env: { PATH: process.env.PATH, FAKE_LOG: log, ...(over.env ?? {}) },
        cwd: dir, roots: over.roots ?? [dir]
      };
    },
    limits: over.limits
  });
  t.after(() => { host.closeAll(); fs.rmSync(dir, { recursive: true, force: true }); });
  const events = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const rpc = (id, method, params) => JSON.stringify({ jsonrpc: '2.0', ...(id !== undefined ? { id } : {}), method, ...(params ? { params } : {}) });
  const post = async (agent, integ, body) => {
    const r = await host.handle(integ, agent, body);
    return { status: r.status, json: r.body ? JSON.parse(r.body) : undefined };
  };
  const handshake = async (agent = 'a1', integ = 'time') => {
    const init = await post(agent, integ, rpc(7, 'initialize', { protocolVersion: '2025-06-18', capabilities: { sampling: {}, elicitation: {}, roots: {} }, clientInfo: { name: 'claude', version: '9' } }));
    await post(agent, integ, rpc(undefined, 'notifications/initialized'));
    return init;
  };
  return { host, dir, log, events, rpc, post, handshake, launches };
}

test('a request becomes a line on stdin and the answer comes back under the agent\'s own id', async (t) => {
  const h = setup(t);
  const init = await h.handshake();
  assert.equal(init.status, 200);
  assert.equal(init.json.id, 7, 'the agent\'s id, not the host\'s');
  assert.equal(init.json.result.serverInfo.name, 'fake');
  const list = await h.post('a1', 'time', h.rpc('abc', 'tools/list'));
  assert.equal(list.json.id, 'abc');
  assert.deepEqual(list.json.result.tools.map((x) => x.name), ['echo', 'hang', 'slow_write']);
  const call = await h.post('a1', 'time', h.rpc(3, 'tools/call', { name: 'echo', arguments: { x: 1 } }));
  assert.equal(call.json.id, 3);
  assert.equal(JSON.parse(call.json.result.content[0].text).x, 1);
  const seen = h.events().filter((e) => e.ev === 'recv').map((e) => e.id).filter((id) => id !== undefined);
  assert.ok(seen.every((id) => /^h\d+$/.test(id)), `the child only ever saw the host's own ids: ${seen}`);
});

test('the server is told only what the host can serve: the agent\'s sampling and elicitation are not passed on', async (t) => {
  const h = setup(t);
  await h.handshake();
  const init = h.events().find((e) => e.ev === 'recv' && e.method === 'initialize');
  assert.deepEqual(init.params.capabilities, { roots: { listChanged: false } });
  assert.equal(init.params.clientInfo.name, 'claude');
  const bare = setup(t, { roots: [] });
  await bare.handshake();
  assert.deepEqual(bare.events().find((e) => e.method === 'initialize').params.capabilities, {}, 'no roots to offer means none declared');
});

test('a batch is answered as a batch, in order; notifications alone are accepted with nothing back', async (t) => {
  const h = setup(t);
  await h.handshake();
  const batch = await h.post('a1', 'time', JSON.stringify([
    JSON.parse(h.rpc(1, 'tools/call', { name: 'echo', arguments: { n: 1 } })),
    JSON.parse(h.rpc(2, 'tools/call', { name: 'echo', arguments: { n: 2 } })),
    JSON.parse(h.rpc(undefined, 'notifications/initialized'))
  ]));
  assert.equal(batch.status, 200);
  assert.deepEqual(batch.json.map((x) => x.id), [1, 2]);
  const only = await h.post('a1', 'time', h.rpc(undefined, 'notifications/cancelled', { requestId: 1 }));
  assert.deepEqual([only.status, only.json], [202, undefined]);
});

test('bad input is refused without starting anything', async (t) => {
  const h = setup(t);
  for (const bad of ['not json', '[]', '"a string"', '[1,2]', '42']) {
    const r = await h.host.handle('time', 'a1', bad);
    assert.equal(r.status, 400, bad);
  }
  assert.deepEqual(h.host.running(), []);
});

test('each agent, and each integration, has a child of its own', async (t) => {
  const h = setup(t);
  await h.handshake('a1', 'time');
  await h.handshake('a2', 'time');
  await h.handshake('a1', 'fetch');
  const starts = h.events().filter((e) => e.ev === 'start');
  assert.equal(starts.length, 3);
  assert.equal(new Set(starts.map((s) => s.pid)).size, 3, 'three different processes');
  assert.equal(h.host.running().length, 3);
});

test('the child gets exactly the environment it was launched with: the app\'s own never leaks in', async (t) => {
  process.env.MOSBIUS_APP_ONLY_SECRET = 'APP-SECRET-NEVER';
  t.after(() => { delete process.env.MOSBIUS_APP_ONLY_SECRET; });
  const h = setup(t, { env: { FAKE_SECRET: 'THE-SERVERS-OWN-KEY' } });
  await h.handshake();
  const start = h.events().find((e) => e.ev === 'start');
  assert.ok(!start.env.includes('MOSBIUS_APP_ONLY_SECRET'), 'the app\'s environment was not inherited');
  assert.equal(start.secret, 'THE-SERVERS-OWN-KEY', 'the credential reaches the one process that needs it');
  assert.deepEqual(start.env.filter((k) => !['PATH', 'FAKE_LOG', 'FAKE_SECRET', 'PWD', 'SHLVL', '_', 'LC_CTYPE', '__CF_USER_TEXT_ENCODING'].includes(k)), []);
  assert.equal(fs.realpathSync(start.cwd), fs.realpathSync(h.dir));
});

test('the server\'s own requests are answered by the host (ping, roots) or refused (sampling), and never reach the agent', async (t) => {
  const h = setup(t);
  await h.handshake();
  const r = await h.post('a1', 'time', h.rpc(5, 'tools/call', { name: 'ask' }));
  const got = JSON.parse(r.json.result.content[0].text);
  assert.deepEqual(got['ping'].result, {});
  assert.deepEqual(got['roots/list'].result.roots, [{ uri: pathToFileUri(h.dir), name: 'workspace' }]);
  assert.equal(got['sampling/createMessage'].error.code, -32601);
  assert.equal(JSON.stringify(r.json).includes('notifications/message'), false, 'a server notification was not forwarded');
});

test('a line on stdout that is not JSON is ignored, not forwarded and not fatal', async (t) => {
  const h = setup(t);
  await h.handshake();
  const r = await h.post('a1', 'time', h.rpc(5, 'tools/call', { name: 'noise' }));
  assert.equal(r.json.result.content[0].text, 'after noise');
});

test('a request the server never answers times out with a JSON-RPC error and the server stays usable', async (t) => {
  const h = setup(t, { limits: { requestMs: 300 } });
  await h.handshake();
  const slow = await h.post('a1', 'time', h.rpc(5, 'tools/call', { name: 'hang' }));
  assert.equal(slow.json.error.code, -32001);
  assert.equal(slow.json.id, 5);
  const ok = await h.post('a1', 'time', h.rpc(6, 'tools/call', { name: 'echo', arguments: { still: 'up' } }));
  assert.equal(JSON.parse(ok.json.result.content[0].text).still, 'up');
});

test('a child that dies mid-request answers with an error, and the next request restarts it with the handshake replayed', async (t) => {
  const h = setup(t);
  await h.handshake();
  const died = await h.post('a1', 'time', h.rpc(5, 'tools/call', { name: 'die' }));
  assert.equal(died.json.error.code, -32000);
  const again = await h.post('a1', 'time', h.rpc(6, 'tools/call', { name: 'echo', arguments: { back: true } }));
  assert.equal(JSON.parse(again.json.result.content[0].text).back, true);
  const order = h.events().filter((e) => e.ev === 'recv').map((e) => e.method);
  const second = order.slice(order.lastIndexOf('initialize'));
  assert.deepEqual(second.slice(0, 3), ['initialize', 'notifications/initialized', 'tools/call'], 'the new process was introduced to its client before the request');
  assert.equal(h.events().filter((e) => e.ev === 'start').length, 2);
});

test('an idle child is stopped and comes back on demand', async (t) => {
  const h = setup(t, { limits: { idleMs: 150 } });
  await h.handshake();
  const pid = h.events().find((e) => e.ev === 'start').pid;
  assert.ok(await until(() => !alive(pid)), 'the idle child was stopped');
  assert.deepEqual(h.host.running(), []);
  const r = await h.post('a1', 'time', h.rpc(5, 'tools/call', { name: 'echo', arguments: { woke: 1 } }));
  assert.equal(JSON.parse(r.json.result.content[0].text).woke, 1);
});

test('a request that is still being answered is never cut off by the idle timer', async (t) => {
  // The idle time (150 ms) is far shorter than the operation (700 ms): the timer fires twice while the
  // child is mid-request. It must leave the child alone, answer, and only then let it go.
  const h = setup(t, { limits: { idleMs: 150 } });
  await h.handshake();
  const pid = h.events().find((e) => e.ev === 'start').pid;
  const r = await h.post('a1', 'time', h.rpc(9, 'tools/call', { name: 'slow_write', arguments: { ms: 700 } }));
  assert.equal(r.json.result.content[0].text, 'slow_write done', 'the slow request was answered, not cut off');
  assert.equal(h.events().filter((e) => e.ev === 'start').length, 1, 'by the same child: it was never stopped and restarted');
  assert.ok(alive(pid), 'still alive at the moment of the answer');
  assert.ok(await until(() => !alive(pid)), 'and once nothing is waiting, the idle timer stops it as before');
});

test('closing an agent kills its children AND theirs, at once, and only its own', async (t) => {
  const h = setup(t);
  await h.handshake('a1', 'time');
  await h.handshake('a2', 'time');
  const g = await h.post('a1', 'time', h.rpc(5, 'tools/call', { name: 'grandchild' }));
  const grandchild = Number(g.json.result.content[0].text);
  const pids = Object.fromEntries(h.events().filter((e) => e.ev === 'start').map((e, i) => [i, e.pid]));
  assert.ok(alive(grandchild));
  h.host.close('a1');
  assert.ok(await until(() => !alive(pids[0])), 'a1\'s server is gone');
  if (process.platform !== 'win32') assert.ok(await until(() => !alive(grandchild)), 'and so is the process it started');
  assert.ok(alive(pids[1]), 'a2\'s server is untouched');
  assert.deepEqual(h.host.running(), [{ agentId: 'a2', integrationId: 'time' }]);
});

test('closing an integration stops it for every agent; closeAll stops everything and refuses new work', async (t) => {
  const h = setup(t);
  await h.handshake('a1', 'time');
  await h.handshake('a2', 'time');
  await h.handshake('a1', 'fetch');
  h.host.closeIntegration('time');
  assert.deepEqual(h.host.running(), [{ agentId: 'a1', integrationId: 'fetch' }]);
  h.host.closeAll();
  assert.deepEqual(h.host.running(), []);
  assert.equal((await h.host.handle('fetch', 'a1', h.rpc(1, 'tools/list'))).status, 503);
});

test('an aborted request is answered as cancelled and does not stop the server', async (t) => {
  const h = setup(t);
  await h.handshake();
  const ac = new AbortController();
  const p = h.host.handle('time', 'a1', h.rpc(5, 'tools/call', { name: 'hang' }), ac.signal);
  setTimeout(() => ac.abort(), 50);
  const r = JSON.parse((await p).body);
  assert.equal(r.error.message, 'The request was cancelled.');
  assert.equal(h.host.running().length, 1);
});

test('a server that cannot be started is a JSON-RPC error for a request and nothing for a notification', async (t) => {
  const h = setup(t, { unavailable: true });
  const r = await h.post('a1', 'time', h.rpc(1, 'tools/list'));
  assert.equal(r.json.error.code, -32002);
  assert.equal(r.json.id, 1);
  const n = await h.post('a1', 'time', h.rpc(undefined, 'notifications/initialized'));
  assert.equal(n.status, 202);
});

test('limits: too many children per agent, and too many requests waiting on one', async (t) => {
  const h = setup(t, { limits: { maxPerAgent: 2, maxPending: 2, requestMs: 400 } });
  await h.handshake('a1', 'one');
  await h.handshake('a1', 'two');
  const third = await h.post('a1', 'three', h.rpc(1, 'tools/list'));
  assert.equal(third.json.error.code, -32002, 'a third server for the same agent is refused');
  const waits = [1, 2, 3].map((i) => h.host.handle('one', 'a1', h.rpc(100 + i, 'tools/call', { name: 'hang' })));
  const answers = (await Promise.all(waits)).map((x) => JSON.parse(x.body));
  assert.ok(answers.some((a) => a.error.code === -32002), 'the request over the limit was refused straight away');
});

test('the host writes nothing to the console, and never keeps what a server says on stderr anywhere but in memory', async (t) => {
  const calls = [];
  const orig = {};
  for (const k of ['log', 'error', 'warn', 'info', 'debug']) { orig[k] = console[k]; console[k] = (...a) => calls.push([k, a]); }
  t.after(() => { for (const k of Object.keys(orig)) console[k] = orig[k]; });
  const h = setup(t);
  await h.handshake();
  await h.post('a1', 'time', h.rpc(5, 'tools/call', { name: 'noise' }));
  await h.post('a1', 'time', h.rpc(6, 'tools/call', { name: 'die' }));
  for (const k of Object.keys(orig)) console[k] = orig[k];
  assert.deepEqual(calls, []);
});

test('pathToFileUri: absolute paths on either platform', () => {
  assert.equal(pathToFileUri('/Users/a b/proj'), 'file:///Users/a%20b/proj');
  assert.equal(pathToFileUri('C:\\Users\\a\\proj'), 'file:///C:/Users/a/proj');
});

test('A CREDENTIAL TRAVELS ON A PRIVATE PIPE: the server gets it, `ps eww` (arguments and initial environment) never shows it', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mosbius-secret-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'events.log');
  const SECRET = 'PIPE-CANARY-9f8e7d6c5b4a39281706';
  const host = new StdioHost({
    launch: () => ({
      command: process.execPath, args: ['-e', NODE_SECRET_LAUNCHER, FAKE],
      env: { PATH: process.env.PATH, FAKE_LOG: log }, secrets: { NOTION_TOKEN: SECRET }, cwd: dir, roots: [dir]
    })
  });
  t.after(() => host.closeAll());
  const call = async (body) => JSON.parse((await host.handle('notion', 'a1', JSON.stringify(body))).body);
  await call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'a', version: '1' } } });
  const events = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const start = events.find((e) => e.ev === 'start');
  assert.equal(start.secret, SECRET, 'the server received its credential');
  assert.deepEqual(start.args, [], 'and its own arguments are what the catalogue gives it (none here)');
  // the OS can briefly show a process with an empty argument block right after it starts: ask again until it shows
  let view = '';
  await until(() => { view = execFileSync('ps', ['eww', '-p', String(start.pid)], { encoding: 'utf8' }); return view.length > 100; });
  assert.ok(view.length > 100, 'the OS showed the process');
  assert.equal(view.includes(SECRET), false, 'the credential is in neither the argument list nor the initial environment');
  assert.equal(view.includes('NOTION_TOKEN'), false, 'not even the name of the variable is in the initial environment');
  // every other process of this user sees nothing either
  assert.equal(execFileSync('ps', ['-axo', 'args'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).includes(SECRET), false);
});

test('the host refuses to start a server when it cannot give it its credential privately', async (t) => {
  const host = new StdioHost({
    launch: () => ({ command: process.execPath, args: [FAKE], env: { PATH: process.env.PATH }, secrets: { X: 'v' }, cwd: os.tmpdir() }),
    spawn: () => ({ stdin: null, stdout: null, stderr: null, stdio: [null, null, null], kill() {}, on() {}, once() {} })
  });
  t.after(() => host.closeAll());
  const r = JSON.parse((await host.handle('x', 'a1', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }))).body);
  assert.equal(r.error.code, -32002, 'the request is answered with "unavailable", and nothing was started without the pipe');
});
