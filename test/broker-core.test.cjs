'use strict';

/**
 * The shared core: the order of its checks, what it contains when a route fails,
 * and — the two properties added to the REST broker by the refactor — that
 * revocation cuts a running request off at once and that a hostile request can
 * no longer crash the process.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const loadTs = require('./load-ts.cjs');
const { startUpstream, call, open, until, json, bearer } = require('./fixtures/broker-helpers.cjs');

const { BrokerCore } = loadTs('src/main/broker/core.ts');
const { CapabilityRegistry } = loadTs('src/main/broker/capabilities.ts');
const { IntegrationBroker } = loadTs('src/main/integrationBroker.ts');

const SECRET = 'CORE-TEST-SECRET';

/** A route that records what it is handed and answers `ok`. */
function fakeRoute(over = {}) {
  const route = {
    channel: 'rest',
    handled: [],
    match: (req) => (req.url.startsWith('/r/') ? { tail: req.url.slice(3) } : null),
    handle(ctx) {
      route.handled.push({ agentId: ctx.cap.agentId, match: ctx.match });
      ctx.res.writeHead(200, { 'content-type': 'text/plain' });
      ctx.res.end('handled');
    },
    ...over
  };
  return route;
}

async function startCore(t, routes, notFoundMessage = 'nothing here') {
  const registry = new CapabilityRegistry();
  const core = new BrokerCore({ registry, routes, notFoundMessage });
  const started = await core.start();
  assert.equal(started.ok, true);
  t.after(() => core.dispose());
  return { core, registry, port: started.port };
}

function quietConsole(t) {
  const original = console.error;
  const lines = [];
  console.error = (...a) => lines.push(a.join(' '));
  t.after(() => { console.error = original; });
  return lines;
}

// ─── order of checks ────────────────────────────────────────────────────────

test('the order is: route preflight, then token, then route, then channel, then the handler', async (t) => {
  const order = [];
  const route = fakeRoute({
    preflight: (req) => { order.push('preflight'); return req.headers['x-reject'] ? { status: 418, code: 'teapot', message: 'no' } : null; },
    handle(ctx) { order.push('handle'); ctx.res.end('ok'); }
  });
  const { registry, port } = await startCore(t, [route], 'nf');
  const token = registry.grant('agent', 'rest', []);

  // a preflight rejection beats a missing token: this is how Host/Origin checks run first
  const rej = await call(port, { path: '/r/x', headers: { 'x-reject': '1' } });
  assert.equal(rej.status, 418);
  assert.deepEqual(json(rej), { error: 'no', code: 'teapot' });

  // no token: 401, and the handler never ran
  order.length = 0;
  assert.equal((await call(port, { path: '/r/x' })).status, 401);
  assert.deepEqual(order, ['preflight']);

  // a path no route owns: 401 without a token (no oracle), 404 with one
  assert.equal((await call(port, { path: '/unowned' })).status, 401);
  const nf = await call(port, { path: '/unowned', headers: bearer(token) });
  assert.equal(nf.status, 404);
  assert.deepEqual(json(nf), { error: 'nf', code: 'not_found' });

  order.length = 0;
  assert.equal((await call(port, { path: '/r/x', headers: bearer(token) })).status, 200);
  assert.deepEqual(order, ['preflight', 'handle']);
});

test('a token for the wrong channel is refused exactly like a bad token', async (t) => {
  const route = fakeRoute({ channel: 'mcp' });
  const { registry, port } = await startCore(t, [route]);
  const wrong = registry.grant('agent', 'rest', ['x']);
  const right = registry.grant('agent', 'mcp', ['x']);
  const bad = await call(port, { path: '/r/x', headers: bearer('nope') });
  const mismatch = await call(port, { path: '/r/x', headers: bearer(wrong) });
  assert.equal(mismatch.status, 401);
  assert.deepEqual(json(mismatch), json(bad));
  assert.equal((await call(port, { path: '/r/x', headers: bearer(right) })).status, 200);
  assert.equal(route.handled.length, 1);
});

test('each route is reached only by its own channel, on a core that hosts several', async (t) => {
  const rest = fakeRoute({ channel: 'rest', match: (req) => (req.url.startsWith('/a/') ? { x: 1 } : null) });
  const mcp = fakeRoute({ channel: 'mcp', match: (req) => (req.url.startsWith('/b/') ? { x: 2 } : null) });
  const { registry, port } = await startCore(t, [rest, mcp]);
  const rt = registry.grant('agent', 'rest', []);
  const mt = registry.grant('agent', 'mcp', []);
  assert.equal((await call(port, { path: '/a/1', headers: bearer(rt) })).status, 200);
  assert.equal((await call(port, { path: '/a/1', headers: bearer(mt) })).status, 401);
  assert.equal((await call(port, { path: '/b/1', headers: bearer(mt) })).status, 200);
  assert.equal((await call(port, { path: '/b/1', headers: bearer(rt) })).status, 401);
});

test('the handler receives the capability and the route match', async (t) => {
  const route = fakeRoute();
  const { registry, port } = await startCore(t, [route]);
  const token = registry.grant('agent-7', 'rest', ['svc']);
  await call(port, { path: '/r/some/tail', headers: bearer(token) });
  assert.deepEqual(route.handled, [{ agentId: 'agent-7', match: { tail: 'some/tail' } }]);
});

// ─── containment ────────────────────────────────────────────────────────────

test('a route that throws, or rejects, costs the caller a fixed 500 and leaks nothing', async (t) => {
  const lines = quietConsole(t);
  const sync = fakeRoute({ match: (req) => (req.url === '/sync' ? {} : null), handle() { throw new Error(`boom with ${SECRET} inside`); } });
  const asyncR = fakeRoute({ match: (req) => (req.url === '/async' ? {} : null), async handle() { throw new Error(`async boom ${SECRET}`); } });
  const ok = fakeRoute();
  const { registry, port } = await startCore(t, [sync, asyncR, ok]);
  const token = registry.grant('agent', 'rest', []);
  for (const path of ['/sync', '/async']) {
    const res = await call(port, { path, headers: bearer(token) });
    assert.equal(res.status, 500);
    assert.deepEqual(json(res), { error: 'internal error', code: 'internal' });
    assert.equal(res.body.toString().includes(SECRET), false);
  }
  assert.equal((await call(port, { path: '/r/still-alive', headers: bearer(token) })).status, 200, 'the server survived');
  assert.equal(lines.some((l) => l.includes(SECRET)), false, 'the exception text is not even logged');
});

test('a route whose match() throws is contained too', async (t) => {
  quietConsole(t);
  const bad = fakeRoute({ match: () => { throw new Error('match bug'); } });
  const { registry, port } = await startCore(t, [bad]);
  const token = registry.grant('agent', 'rest', []);
  assert.equal((await call(port, { path: '/x', headers: bearer(token) })).status, 500);
  assert.equal((await call(port, { path: '/x', headers: bearer(token) })).status, 500, 'and again');
});

test('a malformed %-escape in the integration id is a 400, not a crash of the process', async (t) => {
  // Before the refactor this threw a URIError out of the request handler: any
  // worker holding a capability could take the main process down with one request.
  const up = await startUpstream(t);
  const broker = new IntegrationBroker({
    getRecord: () => ({ id: 'svc', label: 'S', kind: 'custom-rest', baseUrl: up.base, authType: 'bearer', secretRef: 'int:svc', enabled: true, createdAt: 1, updatedAt: 1 }),
    getSecret: () => SECRET
  });
  const { port } = await broker.start();
  t.after(() => broker.stop());
  const token = broker.grant('w', ['svc']);
  const crashes = [];
  const onCrash = (e) => crashes.push(e);
  process.on('uncaughtException', onCrash);
  t.after(() => process.off('uncaughtException', onCrash));
  for (const path of ['/i/%ZZ/x', '/i/%/x', '/i/%E0%A4%A/x', '/i/%C0%AF/x']) {
    const res = await call(port, { path, headers: bearer(token) });
    assert.equal(res.status, 400, path);
    assert.deepEqual(json(res), { error: 'invalid integration id', code: 'bad_request' });
  }
  assert.deepEqual(crashes, []);
  assert.equal((await call(port, { path: '/i/svc/fine', headers: bearer(token) })).status, 200);
  assert.equal(up.seen.length, 1);
});

test('an oversize upload is answered 413 and never forwarded (it used to reset the connection)', async (t) => {
  const up = await startUpstream(t);
  const broker = new IntegrationBroker({
    getRecord: () => ({ id: 'svc', label: 'S', kind: 'custom-rest', baseUrl: up.base, authType: 'bearer', secretRef: 'int:svc', enabled: true, createdAt: 1, updatedAt: 1 }),
    getSecret: () => SECRET
  });
  const { port } = await broker.start();
  t.after(() => broker.stop());
  const token = broker.grant('w', ['svc']);
  const res = await call(port, { method: 'POST', path: '/i/svc/big', headers: bearer(token), body: Buffer.alloc(10 * 1024 * 1024 + 1, 1) });
  assert.equal(res.status, 413);
  assert.deepEqual(json(res), { error: 'request body too large', code: 'payload_too_large' });
  assert.equal(up.seen.length, 0);
  assert.equal((await call(port, { path: '/i/svc/after', headers: bearer(token) })).status, 200, 'and the broker carries on');
});

// ─── immediate revocation ───────────────────────────────────────────────────

/** An upstream that streams one chunk, then waits, and records when its client leaves. */
async function slowUpstream(t) {
  const state = { closed: 0, opened: 0 };
  const up = await startUpstream(t, (req, res) => {
    state.opened++;
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.write('first;');
    res.on('close', () => { state.closed++; });
    // deliberately never finishes on its own
  });
  return { up, state };
}

function restBroker(t, records, secrets) {
  const table = new Map(records.map((r) => [r.id, r]));
  const broker = new IntegrationBroker({ getRecord: (id) => table.get(id), getSecret: (ref) => secrets[ref] });
  return broker.start().then(({ port }) => { t.after(() => broker.stop()); return { broker, port }; });
}
const rec = (id, base) => ({ id, label: id, kind: 'custom-rest', baseUrl: base, authType: 'bearer', secretRef: `int:${id}`, enabled: true, createdAt: 1, updatedAt: 1 });

test('revoking a worker cuts a request it is running, immediately, and stops the upstream call', async (t) => {
  const { up, state } = await slowUpstream(t);
  const { broker, port } = await restBroker(t, [rec('svc', up.base)], { 'int:svc': SECRET });
  const token = broker.grant('w', ['svc']);
  const stream = await open(port, { path: '/i/svc/slow', headers: bearer(token) });
  assert.equal(stream.status, 200);
  await until(() => stream.text().includes('first;'));

  const before = Date.now();
  broker.revoke('w');
  const cut = await until(() => stream.events.closed || stream.events.ended || stream.events.error);
  assert.ok(cut, 'the stream was still open after revocation');
  assert.ok(Date.now() - before < 1000, 'cut within a second');
  assert.equal(stream.events.ended && !stream.events.error, false, 'the client must not see a clean end that looks like a complete answer');
  assert.ok(await until(() => state.closed === 1), 'the upstream request was abandoned too');
  assert.equal((await call(port, { path: '/i/svc/again', headers: bearer(token) })).status, 401);
});

test('revoking one integration cuts only the requests aimed at it', async (t) => {
  const a = await slowUpstream(t);
  const b = await slowUpstream(t);
  const { broker, port } = await restBroker(t, [rec('a', a.up.base), rec('b', b.up.base)], { 'int:a': 'A', 'int:b': 'B' });
  const token = broker.grant('w', ['a', 'b']);
  const sa = await open(port, { path: '/i/a/x', headers: bearer(token) });
  const sb = await open(port, { path: '/i/b/x', headers: bearer(token) });
  await until(() => sa.text().includes('first;') && sb.text().includes('first;'));

  assert.equal(broker.revokeIntegration('a'), 1);
  assert.ok(await until(() => sa.events.closed || sa.events.error), 'integration a was cut');
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(sb.events.closed, false, 'integration b keeps streaming');
  assert.equal((await call(port, { path: '/i/a/y', headers: bearer(token) })).status, 403, 'a is gone from the capability');
  const again = await open(port, { path: '/i/b/y', headers: bearer(token) });
  assert.equal(again.status, 200, 'b is still reachable with the same token');
  again.req.destroy();
  sb.req.destroy();
});

test('stop cuts every running request and refuses new ones', async (t) => {
  const { up, state } = await slowUpstream(t);
  const { broker, port } = await restBroker(t, [rec('svc', up.base)], { 'int:svc': SECRET });
  const token = broker.grant('w', ['svc']);
  const stream = await open(port, { path: '/i/svc/slow', headers: bearer(token) });
  await until(() => stream.text().includes('first;'));
  broker.stop();
  assert.ok(await until(() => stream.events.closed || stream.events.error));
  assert.ok(await until(() => state.closed === 1));
  assert.deepEqual(await call(port, { path: '/i/svc/x', headers: bearer(token) }), { error: 'ECONNREFUSED' });
});

test('a client that goes away abandons the upstream call instead of leaving it open', async (t) => {
  const { up, state } = await slowUpstream(t);
  const { broker, port } = await restBroker(t, [rec('svc', up.base)], { 'int:svc': SECRET });
  const token = broker.grant('w', ['svc']);
  const stream = await open(port, { path: '/i/svc/slow', headers: bearer(token) });
  await until(() => stream.text().includes('first;'));
  stream.req.destroy();
  assert.ok(await until(() => state.closed === 1), 'the upstream connection was released');
});

test('re-granting a worker cuts the requests running under its old token', async (t) => {
  const { up } = await slowUpstream(t);
  const { broker, port } = await restBroker(t, [rec('svc', up.base)], { 'int:svc': SECRET });
  const old = broker.grant('w', ['svc']);
  const stream = await open(port, { path: '/i/svc/slow', headers: bearer(old) });
  await until(() => stream.text().includes('first;'));
  const fresh = broker.grant('w', ['svc']);
  assert.ok(await until(() => stream.events.closed || stream.events.error));
  assert.equal((await call(port, { path: '/i/svc/x', headers: bearer(old) })).status, 401);
  const next = await open(port, { path: '/i/svc/x', headers: bearer(fresh) });
  assert.equal(next.status, 200);
  next.req.destroy();
});

// ─── lifecycle ──────────────────────────────────────────────────────────────

test('the core is idempotent to start and stop, and reports where it is', async (t) => {
  const registry = new CapabilityRegistry();
  const core = new BrokerCore({ registry, routes: [], notFoundMessage: 'nf' });
  assert.equal(core.running(), false);
  assert.equal(core.url(), 'http://127.0.0.1:0');
  const a = await core.start();
  const b = await core.start();
  assert.deepEqual(b, { ok: true, port: a.port });
  assert.equal(core.port(), a.port);
  assert.equal(core.url(), `http://127.0.0.1:${a.port}`);
  core.stop();
  core.stop();
  assert.equal(core.running(), false);
  const again = await core.start();
  assert.equal(again.ok, true);
  core.dispose();
});

test('a port that is taken is reported, not thrown', async (t) => {
  const holder = http.createServer();
  await new Promise((r) => holder.listen(0, '127.0.0.1', r));
  t.after(() => holder.close());
  const core = new BrokerCore({ registry: new CapabilityRegistry(), routes: [], notFoundMessage: 'nf' });
  const res = await core.start(holder.address().port);
  assert.equal(res.ok, false);
  assert.match(res.error, /EADDRINUSE/);
  assert.equal(core.running(), false);
});
