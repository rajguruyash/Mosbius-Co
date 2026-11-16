'use strict';

/**
 * Characterization tests for the REST integration broker.
 *
 * WHY THESE EXIST: the broker (`src/main/integrationBroker.ts`) had no tests at
 * all, and it is about to become the base of a shared broker that will also
 * carry MCP traffic. A refactor of untested security code cannot be proven
 * behaviour-preserving, so this file pins what the broker does TODAY — the
 * status codes, the exact error bodies, the order the checks run in, which
 * headers cross the boundary in each direction, and what never does.
 *
 * It was written and run against the unmodified broker first. Every assertion
 * here must keep passing, unchanged, through the refactor. Behaviour that was
 * deliberately fixed in that refactor (a malformed %-escape in the integration
 * id crashing the main process, an oversize body resetting the connection
 * instead of answering 413, revocation not stopping an in-flight request) is
 * NOT pinned here; those have their own tests in broker-core.test.cjs.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const zlib = require('node:zlib');
const loadTs = require('./load-ts.cjs');

const { IntegrationBroker } = loadTs('src/main/integrationBroker.ts');

const SECRET = 'S3CRET-VALUE-9f2c';
const MAX_BODY = 10 * 1024 * 1024;

// ─── helpers ────────────────────────────────────────────────────────────────

/** A stand-in upstream that records every request it receives. */
function startUpstream(t, handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const entry = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) };
      seen.push(entry);
      if (handler) return handler(req, res, entry);
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      t.after(() => { server.closeAllConnections?.(); server.close(); });
      resolve({ server, seen, base: `http://127.0.0.1:${server.address().port}`, last: () => seen[seen.length - 1] });
    });
  });
}

function record(over = {}) {
  return {
    id: 'svc', label: 'Svc', kind: 'custom-rest', baseUrl: 'http://127.0.0.1:1', authType: 'bearer',
    secretRef: 'int:svc', enabled: true, createdAt: 1, updatedAt: 1, ...over
  };
}

/** A broker over an in-memory registry and secret store. */
async function startBroker(t, records, secrets = {}) {
  const table = new Map(records.map((r) => [r.id, r]));
  const broker = new IntegrationBroker({
    getRecord: (id) => table.get(id),
    getSecret: (ref) => (ref ? secrets[ref] : undefined)
  });
  const started = await broker.start();
  assert.equal(started.ok, true);
  t.after(() => broker.stop());
  return { broker, table, port: started.port };
}

/** Plain HTTP client that never follows redirects and never retries. */
function call(port, { method = 'GET', path = '/', headers = {}, body, bodyChunks } = {}) {
  // Node's client sends a DELETE body with no framing unless told its length,
  // which the server rightly reads as the start of a second, garbled request.
  if (body !== undefined && !headers['content-length'] && ['GET', 'HEAD', 'DELETE', 'OPTIONS'].includes(method)) {
    headers = { ...headers, 'content-length': String(Buffer.byteLength(body)) };
  }
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', (e) => resolve({ error: e.code || e.message }));
    });
    req.on('error', (e) => resolve({ error: e.code || e.message }));
    if (bodyChunks) { for (const c of bodyChunks) req.write(c); } else if (body !== undefined) req.write(body);
    req.end();
  });
}

const json = (r) => JSON.parse(r.body.toString('utf8'));
const bearer = (token) => ({ authorization: `Bearer ${token}` });

async function setup(t, { rec = {}, secret = SECRET, upstream } = {}) {
  const up = upstream ?? (await startUpstream(t));
  const r = record({ baseUrl: up.base, ...rec });
  const b = await startBroker(t, [r], r.secretRef ? { [r.secretRef]: secret } : {});
  const token = b.broker.grant('worker-1', [r.id]);
  return { ...b, up, token, rec: r };
}

// ─── lifecycle ──────────────────────────────────────────────────────────────

test('start binds a loopback port and reports it; start is idempotent', async (t) => {
  const broker = new IntegrationBroker({ getRecord: () => undefined, getSecret: () => undefined });
  assert.equal(broker.running(), false);
  const first = await broker.start();
  t.after(() => broker.stop());
  assert.equal(first.ok, true);
  assert.ok(first.port > 0);
  assert.equal(broker.running(), true);
  assert.equal(broker.url(), `http://127.0.0.1:${first.port}`);
  const again = await broker.start();
  assert.deepEqual(again, { ok: true, port: first.port });
});

test('stop is idempotent, closes the listener and forgets every capability', async (t) => {
  const r = record();
  const broker = new IntegrationBroker({ getRecord: () => r, getSecret: () => SECRET });
  const { port } = await broker.start();
  const token = broker.grant('w', ['svc']);
  broker.stop();
  broker.stop();
  assert.equal(broker.running(), false);
  assert.deepEqual(await call(port, { path: '/i/svc/x', headers: bearer(token) }), { error: 'ECONNREFUSED' });

  // a restart is a clean slate: the old token means nothing any more
  const restarted = await broker.start();
  t.after(() => broker.stop());
  const res = await call(restarted.port, { path: '/i/svc/x', headers: bearer(token) });
  assert.equal(res.status, 401);
});

test('the listener is bound to loopback only', async (t) => {
  const { port } = await startBroker(t, []);
  // reachable on 127.0.0.1 ...
  await new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1', () => { s.destroy(); resolve(); });
    s.on('error', reject);
  });
  // ... and refused on this machine's other IPv4 addresses, where they exist
  const external = Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
  for (const host of external) {
    const code = await new Promise((resolve) => {
      const s = net.connect({ port, host, timeout: 1500 }, () => { s.destroy(); resolve('connected'); });
      s.on('error', (e) => resolve(e.code));
      s.on('timeout', () => { s.destroy(); resolve('timeout'); });
    });
    assert.notEqual(code, 'connected', `broker answered on ${host}`);
  }
});

test('the facade exposes the API index.ts uses', () => {
  const broker = new IntegrationBroker({ getRecord: () => undefined, getSecret: () => undefined });
  for (const m of ['start', 'stop', 'running', 'url', 'grant', 'revoke']) {
    assert.equal(typeof broker[m], 'function', `missing ${m}`);
  }
  assert.equal(broker.running(), false);
  assert.equal(broker.url(), 'http://127.0.0.1:0');
});

// ─── capability authentication ──────────────────────────────────────────────

test('no token and a wrong token are both 401 with the same body', async (t) => {
  const { port } = await setup(t);
  const none = await call(port, { path: '/i/svc/x' });
  const wrong = await call(port, { path: '/i/svc/x', headers: bearer('not-a-real-token') });
  for (const res of [none, wrong]) {
    assert.equal(res.status, 401);
    assert.deepEqual(json(res), { error: 'missing or invalid capability token', code: 'unauthorized' });
    assert.equal(res.headers['content-type'], 'application/json');
  }
});

test('the token is accepted as a Bearer token and as X-MD-Broker-Token', async (t) => {
  const { port, token, up } = await setup(t);
  assert.equal((await call(port, { path: '/i/svc/a', headers: bearer(token) })).status, 200);
  assert.equal((await call(port, { path: '/i/svc/b', headers: { 'x-md-broker-token': token } })).status, 200);
  assert.equal((await call(port, { path: '/i/svc/c', headers: { authorization: `bearer   ${token}  ` } })).status, 200);
  assert.equal(up.seen.length, 3);
});

test('other schemes, an empty bearer and a token with a suffix are refused', async (t) => {
  const { port, token, up } = await setup(t);
  for (const headers of [
    { authorization: `Basic ${token}` },
    { authorization: 'Bearer ' },
    { authorization: token },
    { authorization: `Bearer ${token}x` },
    { 'x-md-broker-token': '' }
  ]) {
    const res = await call(port, { path: '/i/svc/x', headers });
    assert.equal(res.status, 401, JSON.stringify(headers));
  }
  assert.equal(up.seen.length, 0, 'nothing may reach the upstream');
});

test('authentication is checked before the route: a bad path without a token is 401, not 404', async (t) => {
  const { port } = await setup(t);
  assert.equal((await call(port, { path: '/nothing/here' })).status, 401);
  assert.equal((await call(port, { path: '/i/' })).status, 401);
});

test('grant mints a fresh 256-bit base64url token and re-granting replaces the old one', async (t) => {
  const { broker, port } = await setup(t);
  const a = broker.grant('w-a', ['svc']);
  const b = broker.grant('w-b', ['svc']);
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, b);
  const a2 = broker.grant('w-a', ['svc']);
  assert.notEqual(a, a2);
  assert.equal((await call(port, { path: '/i/svc/x', headers: bearer(a) })).status, 401, 'the replaced token is dead');
  assert.equal((await call(port, { path: '/i/svc/x', headers: bearer(a2) })).status, 200);
  assert.equal((await call(port, { path: '/i/svc/x', headers: bearer(b) })).status, 200, 'other workers are untouched');
});

test('revoke takes effect on the very next request, only for that worker, and is idempotent', async (t) => {
  const { broker, port } = await setup(t);
  const a = broker.grant('w-a', ['svc']);
  const b = broker.grant('w-b', ['svc']);
  assert.equal((await call(port, { path: '/i/svc/x', headers: bearer(a) })).status, 200);
  broker.revoke('w-a');
  broker.revoke('w-a');
  broker.revoke('never-existed');
  assert.equal((await call(port, { path: '/i/svc/x', headers: bearer(a) })).status, 401);
  assert.equal((await call(port, { path: '/i/svc/x', headers: bearer(b) })).status, 200);
});

// ─── routing and authorization ──────────────────────────────────────────────

test('a path outside /i/<id>/<path> is 404 with the expected-route message', async (t) => {
  const { port, token } = await setup(t);
  for (const path of ['/', '/i', '/i/', '/j/svc/x', '/I/svc/x', '/x/i/svc/x']) {
    const res = await call(port, { path, headers: bearer(token) });
    assert.equal(res.status, 404, path);
    assert.deepEqual(json(res), { error: 'expected /i/<integrationId>/<path>', code: 'not_found' });
  }
});

test('an integration outside the worker capability is 403, whether or not it exists', async (t) => {
  const up = await startUpstream(t);
  const a = record({ id: 'a', secretRef: 'int:a', baseUrl: up.base });
  const b = record({ id: 'b', secretRef: 'int:b', baseUrl: up.base });
  const { broker, port } = await startBroker(t, [a, b], { 'int:a': 'A', 'int:b': 'B' });
  const token = broker.grant('w', ['a']);
  const denied = await call(port, { path: '/i/b/x', headers: bearer(token) });
  assert.equal(denied.status, 403);
  assert.deepEqual(json(denied), { error: 'integration not in this worker capability', code: 'forbidden' });
  const ghost = await call(port, { path: '/i/ghost/x', headers: bearer(token) });
  assert.equal(ghost.status, 403, 'no existence oracle for ids outside the capability');
  assert.equal(up.seen.length, 0);
});

test('an allowed id with no registry record is 404 unknown integration', async (t) => {
  const { broker, port } = await startBroker(t, []);
  const token = broker.grant('w', ['ghost']);
  const res = await call(port, { path: '/i/ghost/x', headers: bearer(token) });
  assert.equal(res.status, 404);
  assert.deepEqual(json(res), { error: 'unknown integration', code: 'not_found' });
});

test('a disabled integration is 403, and the registry is read live on every request', async (t) => {
  const { port, token, table, up } = await setup(t);
  assert.equal((await call(port, { path: '/i/svc/x', headers: bearer(token) })).status, 200);
  table.get('svc').enabled = false;
  const res = await call(port, { path: '/i/svc/x', headers: bearer(token) });
  assert.equal(res.status, 403);
  assert.deepEqual(json(res), { error: 'integration is disabled', code: 'forbidden' });
  table.get('svc').enabled = true;
  assert.equal((await call(port, { path: '/i/svc/x', headers: bearer(token) })).status, 200);
  assert.equal(up.seen.length, 2);
});

test('the integration id is percent-decoded before it is matched', async (t) => {
  const { port, token, up } = await setup(t);
  const res = await call(port, { path: '/i/s%76c/x', headers: bearer(token) });
  assert.equal(res.status, 200);
  assert.equal(up.last().url, '/x');
});

// ─── path confinement ───────────────────────────────────────────────────────

test('traversal, absolute URLs and host overrides never reach the upstream', async (t) => {
  const { port, token, up } = await setup(t);
  const bad = [
    '/i/svc/../etc/passwd',
    '/i/svc/a/../../b',
    '/i/svc/%2e%2e/etc',
    '/i/svc/%2E%2E/etc',
    '/i/svc/a/%2e%2e/%2e%2e/b',
    '/i/svc/http://evil.example/x',
    '/i/svc/https://evil.example/x',
    '/i/svc///evil.example/x',
    '/i/svc/\\evil.example/x',
    '/i/svc/%ZZ'
  ];
  for (const path of bad) {
    const res = await call(port, { path, headers: bearer(token) });
    assert.equal(res.status, 400, path);
    assert.deepEqual(json(res), { error: 'invalid or out-of-bounds path', code: 'bad_request' }, path);
  }
  assert.equal(up.seen.length, 0, 'nothing may reach the upstream');
});

test('the path is joined under the integration base path and the query is forwarded', async (t) => {
  const up = await startUpstream(t);
  const { broker, port } = await startBroker(t, [record({ baseUrl: `${up.base}/api/v2` })], { 'int:svc': SECRET });
  const token = broker.grant('w', ['svc']);
  await call(port, { path: '/i/svc/items/42?expand=owner&limit=5', headers: bearer(token) });
  assert.equal(up.last().url, '/api/v2/items/42?expand=owner&limit=5');
  await call(port, { path: '/i/svc', headers: bearer(token) });
  assert.equal(up.last().url, '/api/v2/');
  await call(port, { path: '/i/svc/a%20b/c?q=%2e%2e', headers: bearer(token) });
  assert.equal(up.last().url, '/api/v2/a%20b/c?q=%2e%2e', 'a query is not a path');
});

// ─── credential injection ───────────────────────────────────────────────────

test('bearer: the secret is injected as Authorization: Bearer', async (t) => {
  const { port, token, up } = await setup(t);
  await call(port, { path: '/i/svc/x', headers: { 'x-md-broker-token': token } });
  assert.equal(up.last().headers.authorization, `Bearer ${SECRET}`);
});

test('header: the secret goes under the configured header name, lower-cased', async (t) => {
  const { port, token, up } = await setup(t, { rec: { authType: 'header', authHeader: 'X-Api-Key' } });
  await call(port, { path: '/i/svc/x', headers: bearer(token) });
  assert.equal(up.last().headers['x-api-key'], SECRET);
  assert.equal(up.last().headers.authorization, undefined, 'the capability is not the credential');
});

test('github: bearer plus the GitHub API headers', async (t) => {
  const { port, token, up } = await setup(t, { rec: { authType: 'github', kind: 'github' } });
  await call(port, { path: '/i/svc/x', headers: bearer(token) });
  const h = up.last().headers;
  assert.equal(h.authorization, `Bearer ${SECRET}`);
  assert.equal(h.accept, 'application/vnd.github+json');
  assert.equal(h['x-github-api-version'], '2022-11-28');
});

test('none: nothing is injected and no secret is needed', async (t) => {
  const { port, token, up } = await setup(t, { rec: { authType: 'none', secretRef: undefined } });
  const res = await call(port, { path: '/i/svc/x', headers: { 'x-md-broker-token': token } });
  assert.equal(res.status, 200);
  assert.equal(up.last().headers.authorization, undefined);
});

test('a missing secret is 503 no_secret and nothing is forwarded', async (t) => {
  const up = await startUpstream(t);
  const { broker, port } = await startBroker(t, [record({ baseUrl: up.base })], {});
  const token = broker.grant('w', ['svc']);
  const res = await call(port, { path: '/i/svc/x', headers: bearer(token) });
  assert.equal(res.status, 503);
  assert.deepEqual(json(res), { error: 'no secret configured for this integration', code: 'no_secret' });
  assert.equal(up.seen.length, 0);
});

test('the injected credential always wins over anything the worker sends', async (t) => {
  const { port, token, up } = await setup(t);
  await call(port, {
    path: '/i/svc/x',
    headers: { 'x-md-broker-token': token, authorization: 'Bearer EVIL-WORKER-VALUE' }
  });
  assert.equal(up.last().headers.authorization, `Bearer ${SECRET}`);

  const h = await setup(t, { rec: { authType: 'header', authHeader: 'X-Api-Key' } });
  await call(h.port, { path: '/i/svc/x', headers: { ...bearer(h.token), 'X-Api-Key': 'EVIL-WORKER-VALUE' } });
  assert.equal(h.up.last().headers['x-api-key'], SECRET);
});

test('each integration is injected with its own secret under concurrent load from several workers', async (t) => {
  const upA = await startUpstream(t);
  const upB = await startUpstream(t);
  const recs = [
    record({ id: 'a', secretRef: 'int:a', baseUrl: upA.base }),
    record({ id: 'b', secretRef: 'int:b', baseUrl: upB.base })
  ];
  const { broker, port } = await startBroker(t, recs, { 'int:a': 'SECRET-A', 'int:b': 'SECRET-B' });
  const tokens = ['w1', 'w2', 'w3'].map((w) => broker.grant(w, ['a', 'b']));
  const jobs = [];
  for (let i = 0; i < 30; i++) {
    const id = i % 2 ? 'a' : 'b';
    jobs.push(call(port, { path: `/i/${id}/n${i}`, headers: bearer(tokens[i % 3]) }));
  }
  const results = await Promise.all(jobs);
  assert.ok(results.every((r) => r.status === 200));
  for (const e of upA.seen) assert.equal(e.headers.authorization, 'Bearer SECRET-A');
  for (const e of upB.seen) assert.equal(e.headers.authorization, 'Bearer SECRET-B');
  assert.equal(upA.seen.length + upB.seen.length, 30);
});

// ─── what crosses the boundary on the way in ────────────────────────────────

test('the worker credential, cookies and Host never reach the upstream; ordinary headers do', async (t) => {
  const { port, token, up } = await setup(t);
  await call(port, {
    path: '/i/svc/x',
    headers: {
      'x-md-broker-token': token, cookie: 'session=abc', 'x-custom': 'kept', accept: 'application/json',
      'content-type': 'application/json', 'user-agent': 'worker-agent/9'
    },
    method: 'POST',
    body: '{"a":1}'
  });
  const h = up.last().headers;
  assert.equal(h['x-md-broker-token'], undefined);
  assert.equal(h.cookie, undefined);
  assert.equal(h['x-custom'], 'kept');
  assert.equal(h.accept, 'application/json');
  assert.equal(h['content-type'], 'application/json');
  assert.equal(h['user-agent'], 'worker-agent/9');
  assert.match(h.host, /^127\.0\.0\.1:\d+$/);
  assert.notEqual(h.host, `127.0.0.1:${port}`, 'Host is the upstream, not the broker');
  assert.equal(JSON.stringify(h).includes(token), false, 'the capability token must never be forwarded');
});

test('a default User-Agent is supplied when the worker sends none', async (t) => {
  const { port, token, up } = await setup(t);
  await call(port, { path: '/i/svc/x', headers: bearer(token) });
  assert.equal(up.last().headers['user-agent'], 'mosbius-co-broker/1');
});

test('methods, query strings and binary bodies are forwarded intact', async (t) => {
  const { port, token, up } = await setup(t);
  const binary = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255, 10, 13, 0]);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const res = await call(port, { method, path: '/i/svc/r?x=1', headers: bearer(token), body: binary });
    assert.equal(res.status, 200, method);
    assert.equal(up.last().method, method);
    assert.deepEqual(up.last().body, binary);
  }
  await call(port, { method: 'GET', path: '/i/svc/r', headers: bearer(token) });
  assert.equal(up.last().method, 'GET');
  assert.equal(up.last().body.length, 0);
});

test('a chunked request body (no Content-Length) is buffered and forwarded whole', async (t) => {
  const { port, token, up } = await setup(t);
  const res = await call(port, {
    method: 'POST', path: '/i/svc/x', headers: bearer(token),
    bodyChunks: [Buffer.from('hello '), Buffer.from('chunked '), Buffer.from('world')]
  });
  assert.equal(res.status, 200);
  assert.equal(up.last().body.toString(), 'hello chunked world');
  assert.equal(up.last().headers['content-length'], '19');
});

test('a body of exactly 10 MiB is forwarded; one byte more is never forwarded', async (t) => {
  const { port, token, up } = await setup(t);
  const exact = await call(port, { method: 'POST', path: '/i/svc/big', headers: bearer(token), body: Buffer.alloc(MAX_BODY, 7) });
  assert.equal(exact.status, 200);
  assert.equal(up.last().body.length, MAX_BODY);

  const before = up.seen.length;
  const over = await call(port, { method: 'POST', path: '/i/svc/big', headers: bearer(token), body: Buffer.alloc(MAX_BODY + 1, 7) });
  // Today the connection is reset instead of answering; the contract that must
  // survive any change is that the oversize body reaches nobody and the call
  // does not succeed.
  assert.ok(over.error || over.status === 413, `unexpected outcome ${JSON.stringify({ s: over.status, e: over.error })}`);
  assert.equal(up.seen.length, before, 'the oversize body must not be forwarded');
});

// ─── what crosses the boundary on the way out ───────────────────────────────

test('upstream status, content-type and custom headers pass through; 4xx and 5xx are not rewritten', async (t) => {
  for (const status of [201, 204, 400, 404, 429, 500, 503]) {
    const up = await startUpstream(t, (req, res) => {
      res.writeHead(status, { 'content-type': 'application/json', 'x-upstream': `s${status}`, 'retry-after': '7' });
      res.end(status === 204 ? undefined : JSON.stringify({ status }));
    });
    const { port, token } = await setup(t, { upstream: up });
    const res = await call(port, { path: '/i/svc/x', headers: bearer(token) });
    assert.equal(res.status, status);
    assert.equal(res.headers['x-upstream'], `s${status}`);
    assert.equal(res.headers['retry-after'], '7');
    if (status !== 204) assert.equal(res.headers['content-type'], 'application/json');
  }
});

test('Set-Cookie never reaches the worker', async (t) => {
  const up = await startUpstream(t, (req, res) => {
    res.writeHead(200, { 'set-cookie': ['sid=1; HttpOnly', 'b=2'], 'content-type': 'text/plain' });
    res.end('ok');
  });
  const { port, token } = await setup(t, { upstream: up });
  const res = await call(port, { path: '/i/svc/x', headers: bearer(token) });
  assert.equal(res.status, 200);
  assert.equal(res.headers['set-cookie'], undefined);
});

test('a compressed upstream body arrives decoded, with the encoding and length headers dropped', async (t) => {
  const up = await startUpstream(t, (req, res) => {
    const body = zlib.gzipSync('hello from upstream');
    res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip', 'content-length': String(body.length) });
    res.end(body);
  });
  const { port, token } = await setup(t, { upstream: up });
  const res = await call(port, { path: '/i/svc/x', headers: bearer(token) });
  assert.equal(res.status, 200);
  assert.equal(res.body.toString(), 'hello from upstream');
  assert.equal(res.headers['content-encoding'], undefined);
});

test('redirects are handed back to the worker, never followed', async (t) => {
  const up = await startUpstream(t, (req, res) => {
    if (req.url === '/hop') { res.writeHead(302, { location: '/elsewhere' }); return res.end(); }
    res.writeHead(200); res.end('landed');
  });
  const { port, token } = await setup(t, { upstream: up });
  const res = await call(port, { path: '/i/svc/hop', headers: bearer(token) });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/elsewhere');
  assert.deepEqual(up.seen.map((e) => e.url), ['/hop'], 'the redirect target must not be requested');
});

test('the response is streamed through, not buffered', async (t) => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const up = await startUpstream(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.write('first-chunk;');
    gate.then(() => res.end('second-chunk'));
  });
  const { port, token } = await setup(t, { upstream: up });
  const outcome = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ timedOut: true }), 5000);
    const chunks = [];
    const req = http.request({ host: '127.0.0.1', port, path: '/i/svc/x', headers: bearer(token), agent: false }, (res) => {
      res.on('data', (c) => {
        chunks.push(c);
        // the upstream will not finish until the worker has seen the first chunk
        if (Buffer.concat(chunks).toString().includes('first-chunk;')) release();
      });
      res.on('end', () => { clearTimeout(timer); resolve({ body: Buffer.concat(chunks).toString() }); });
    });
    req.on('error', (e) => { clearTimeout(timer); resolve({ error: e.code }); });
    req.end();
  });
  assert.equal(outcome.timedOut, undefined, 'the broker held the response back until the upstream finished');
  assert.equal(outcome.body, 'first-chunk;second-chunk');
});

test('HEAD gets headers and no body', async (t) => {
  const { port, token } = await setup(t);
  const res = await call(port, { method: 'HEAD', path: '/i/svc/x', headers: bearer(token) });
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 0);
});

test('an unreachable upstream is 502 bad_gateway', async (t) => {
  const dead = http.createServer();
  await new Promise((r) => dead.listen(0, '127.0.0.1', r));
  const port = dead.address().port;
  await new Promise((r) => dead.close(r));
  const r = record({ baseUrl: `http://127.0.0.1:${port}` });
  const b = await startBroker(t, [r], { 'int:svc': SECRET });
  const token = b.broker.grant('w', ['svc']);
  const res = await call(b.port, { path: '/i/svc/x', headers: bearer(token) });
  assert.equal(res.status, 502);
  const body = json(res);
  assert.equal(body.code, 'bad_gateway');
  assert.match(body.error, /^upstream request failed: /);
});

// ─── secrecy ────────────────────────────────────────────────────────────────

test('neither the secret nor the capability token ever appears in a broker-generated response', async (t) => {
  const up = await startUpstream(t);
  const dead = http.createServer();
  await new Promise((r) => dead.listen(0, '127.0.0.1', r));
  const deadPort = dead.address().port;
  await new Promise((r) => dead.close(r));
  const recs = [
    record({ id: 'ok', secretRef: 'int:ok', baseUrl: up.base }),
    record({ id: 'off', secretRef: 'int:off', baseUrl: up.base, enabled: false }),
    record({ id: 'nosecret', secretRef: 'int:nosecret', baseUrl: up.base }),
    record({ id: 'dead', secretRef: 'int:dead', baseUrl: `http://127.0.0.1:${deadPort}` })
  ];
  const { broker, port } = await startBroker(t, recs, { 'int:ok': SECRET, 'int:off': SECRET, 'int:dead': SECRET });
  const token = broker.grant('w', ['ok', 'off', 'nosecret', 'dead']);
  const paths = ['/i/ok/..', '/i/off/x', '/i/nosecret/x', '/i/dead/x', '/i/ghost/x', '/zzz', '/i/ok/http://evil.example'];
  for (const path of paths) {
    for (const headers of [bearer(token), {}, bearer('x'.repeat(43))]) {
      const res = await call(port, { path, headers });
      if (res.error) continue;
      const text = res.body.toString() + JSON.stringify(res.headers);
      assert.equal(text.includes(SECRET), false, `${path} leaked the secret`);
      assert.equal(text.includes(token), false, `${path} leaked the capability token`);
    }
  }
});
