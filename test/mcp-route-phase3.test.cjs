'use strict';

/**
 * The MCP route's Phase 3 behaviour, against a stand-in MCP server that can be told
 * to refuse a token, answer as an event stream, stall, and count what it is sent:
 *
 *   • a 401 is answered by asking the credential provider for a newer credential and
 *     replaying the request ONCE; a second refusal ends it with "sign in again";
 *   • a `tools/list` that arrives as an event stream is filtered like a JSON one, and
 *     one that cannot be read is refused, never passed on;
 *   • how fast and how many: a bucket per agent and integration, a cap on open
 *     streams, a global cap; refusals that cost the upstream nothing;
 *   • an upstream session is closed when its agent ends, and not otherwise;
 *   • the broker can ask the server for its tool list on its own (for Settings).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startUpstream, call, open, until, json, bearer, rpc } = require('./fixtures/broker-helpers.cjs');
const loadTs = require('./load-ts.cjs');

const { IntegrationBroker } = loadTs('src/main/integrationBroker.ts');

const CLASSES = { get_thing: 'read', put_thing: 'write', send_thing: 'destructive' };
const TOOLS = [
  { name: 'get_thing', description: 'reads' },
  { name: 'put_thing', description: 'writes' },
  { name: 'send_thing', description: 'sends' },
  { name: 'mystery_thing', description: 'unclassified' }
];
const INIT = rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } }, 1);
const LIST = (id = 2) => rpc('tools/list', undefined, id);

/** The stand-in MCP server. `b` is what a test changes to make it misbehave. */
async function mcpServer(t) {
  const b = {
    accept: new Set(['T1']),
    tools: TOOLS,
    // how a tools/list is answered: (id, tools, req) -> { type, body, status? }
    list: (id, tools) => ({ type: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id, result: { tools } }) }),
    pages: null,                  // { first: [...], second: [...] } for cursor tests
    stallList: false,
    initStatus: 200
  };
  let n = 0;
  const up = await startUpstream(t, (req, res, entry) => {
    if (!req.headers.authorization || !b.accept.has(req.headers.authorization.replace(/^Bearer /, ''))) {
      res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer resource_metadata="http://upstream.invalid/x"' });
      return res.end('{"error":"upstream says no"}');
    }
    if (req.method === 'DELETE') { res.writeHead(200); return res.end(); }
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.flushHeaders();
      res.write('data: {"jsonrpc":"2.0","method":"notifications/message","params":{}}\n\n');
      entry.res = res;
      res.on('close', () => { entry.closed = true; });
      return;
    }
    let msg; try { msg = JSON.parse(entry.body.toString()); } catch { res.writeHead(400); return res.end(); }
    if (msg.id === undefined) { res.writeHead(202); return res.end(); }            // a notification
    if (msg.method === 'initialize') {
      res.writeHead(b.initStatus, { 'content-type': 'application/json', 'mcp-session-id': `sess-${++n}` });
      return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params?.protocolVersion ?? '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'stand-in', version: '0' } } }));
    }
    if (msg.method === 'tools/list') {
      if (b.stallList) { res.writeHead(200, { 'content-type': 'application/json' }); res.flushHeaders(); entry.res = res; return; }
      if (b.pages) {
        const second = msg.params?.cursor === 'p2';
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: second ? b.pages.second : b.pages.first, ...(second ? {} : { nextCursor: 'p2' }) } }));
      }
      const a = b.list(msg.id, b.tools, req);
      res.writeHead(a.status ?? 200, { 'content-type': a.type });
      return res.end(a.body);
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `called ${msg.params?.name}` }] } }));
  });
  return { up, b };
}

/** A provider that can rotate its token when the route says the old one was refused. */
function fakeProvider(first = 'T1') {
  const p = {
    token: first, next: [], rejectedWith: [], accessCalls: 0, failAccess: null,
    accessHeaders() {
      p.accessCalls++;
      if (p.failAccess) return { ok: false, code: p.failAccess };
      return { ok: true, headers: { Authorization: `Bearer ${p.token}` } };
    },
    rejected(_subject, used) {
      p.rejectedWith.push(used.Authorization);
      if (p.next.length) p.token = p.next.shift();
    }
  };
  return p;
}

async function setup(t, { provider, grants, limits, enabled = true, integ } = {}) {
  const { up, b } = await mcpServer(t);
  const clock = { t: 1_700_000_000_000 };
  const prov = provider ?? fakeProvider();
  const state = { grants: grants ?? { defaults: { gmail: { preset: 'write' } } }, enabled };
  const audit = [];
  const broker = new IntegrationBroker({ getRecord: () => undefined, getSecret: () => undefined }, {
    mcp: {
      resolve: (id) => (id === 'gmail' ? { id: 'gmail', url: `${up.base}/mcp`, enabled: state.enabled, classification: { toolClasses: CLASSES }, ...integ } : undefined),
      credentials: prov, grants: () => state.grants, now: () => clock.t, audit: (e) => audit.push(e), limits
    }
  });
  const { port } = await broker.start();
  t.after(() => broker.stop());
  const hdr = (tok, extra = {}) => ({ ...bearer(tok), 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...extra });
  const post = (tok, body = INIT, extra = {}) => call(port, { method: 'POST', path: '/m/gmail', headers: hdr(tok, extra), body });
  return { up, b, broker, port, prov, state, clock, audit, post, hdr };
}

const upstreamTokens = (up) => up.seen.filter((r) => r.method !== 'GET').map((r) => (r.headers.authorization ?? '').replace(/^Bearer /, ''));

// ─── 401: refresh once, replay once ──────────────────────────────────────────

test('401: the provider is told, hands over a newer credential, and the request is replayed ONCE — with the same body', async (t) => {
  const { up, b, broker, prov, post } = await setup(t);
  const cap = broker.grantMcp('agent-A', ['gmail']);
  b.accept = new Set(['T2']); prov.next = ['T2'];
  const big = JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'ping', params: { pad: 'x'.repeat(150_000) } });
  const r = await post(cap, big);
  assert.equal(r.status, 200);
  assert.equal(up.seen.length, 2, 'refused once, replayed once');
  assert.deepEqual(upstreamTokens(up), ['T1', 'T2']);
  assert.deepEqual(prov.rejectedWith, ['Bearer T1'], 'the provider is told which credential was refused');
  assert.equal(up.seen[0].body.equals(up.seen[1].body), true, 'the replay carries the very same bytes');
  assert.equal(up.seen[1].body.length, Buffer.byteLength(big));
});

test('401 that persists: the agent is told to sign in again, no WWW-Authenticate, and there is no loop', async (t) => {
  const { up, b, broker, prov, post } = await setup(t);
  const cap = broker.grantMcp('agent-A', ['gmail']);
  b.accept = new Set();                       // nothing is ever good enough
  prov.next = ['T2', 'T3', 'T4'];
  const r = await post(cap, INIT);
  assert.equal(r.status, 401);
  assert.deepEqual(json(r), { error: 'sign in to this integration again', code: 'sign_in_required' });
  assert.equal('www-authenticate' in r.headers, false, 'the agent\'s CLI must never be sent off to do its own OAuth');
  assert.equal(JSON.stringify(r.headers).includes('upstream.invalid'), false);
  assert.equal(r.body.toString().includes('upstream says no'), false, 'the upstream\'s own text is not passed on either');
  assert.equal(up.seen.length, 2, 'one try, one replay, then stop');
  assert.equal(prov.rejectedWith.length, 1, 'the provider is asked once, not once per try');
  // and the next request starts over: still two upstream calls, never a growing number
  await post(cap, INIT);
  assert.equal(up.seen.length, 4);
});

test('401 when the provider has nothing newer: no pointless replay', async (t) => {
  const { up, b, broker, prov, post } = await setup(t);
  const cap = broker.grantMcp('agent-A', ['gmail']);
  b.accept = new Set(['T2']);                 // T1 is refused and the provider keeps handing out T1
  const r = await post(cap, INIT);
  assert.equal(r.status, 401);
  assert.equal(up.seen.length, 1);
  assert.equal(prov.rejectedWith.length, 1);
});

test('401 and the provider can no longer produce a credential: the agent hears why, and nothing more is sent', async (t) => {
  const { up, b, broker, prov, post } = await setup(t);
  const cap = broker.grantMcp('agent-A', ['gmail']);
  b.accept = new Set(['T2']);
  prov.rejected = (_s, used) => { prov.rejectedWith.push(used.Authorization); prov.failAccess = 'sign_in_required'; };
  const r = await post(cap, INIT);
  assert.equal(r.status, 401);
  assert.equal(json(r).code, 'sign_in_required');
  assert.equal(up.seen.length, 1);
  prov.failAccess = 'unavailable';
  assert.equal((await post(cap, INIT)).status, 503, 'a provider that is merely unavailable is 503, not "sign in"');
});

test('a provider of fixed secrets (no `rejected`) gets the upstream\'s 401 passed through, minus WWW-Authenticate', async (t) => {
  const { up, b, broker, post } = await setup(t, { provider: { accessHeaders: () => ({ ok: true, headers: { Authorization: 'Bearer T1' } }) } });
  const cap = broker.grantMcp('agent-A', ['gmail']);
  b.accept = new Set();
  const r = await post(cap, INIT);
  assert.equal(r.status, 401);
  assert.equal('www-authenticate' in r.headers, false);
  assert.equal(up.seen.length, 1, 'no replay without a provider that can do better');
});

test('a replay that works on initialize still binds the session to the agent that asked', async (t) => {
  const { b, broker, prov, post, hdr, port } = await setup(t);
  const a = broker.grantMcp('agent-A', ['gmail']);
  const other = broker.grantMcp('agent-B', ['gmail']);
  b.accept = new Set(['T2']); prov.next = ['T2'];
  const r = await post(a, INIT);
  assert.equal(r.status, 200);
  const sid = r.headers['mcp-session-id'];
  assert.ok(sid);
  assert.equal((await post(a, LIST(), { 'mcp-session-id': sid })).status, 200);
  assert.equal((await post(other, LIST(), { 'mcp-session-id': sid })).status, 404, 'not B\'s session');
});

test('401 on a tools/list: refreshed, replayed, and the answer is still filtered', async (t) => {
  const { b, broker, prov, post } = await setup(t, { grants: { defaults: { gmail: { preset: 'read' } } } });
  const cap = broker.grantMcp('agent-A', ['gmail']);
  b.accept = new Set(['T2']); prov.next = ['T2'];
  const r = await post(cap, LIST());
  assert.equal(r.status, 200);
  assert.deepEqual(json(r).result.tools.map((x) => x.name), ['get_thing']);
});

// ─── tools/list as an event stream ───────────────────────────────────────────

const sseOf = (...events) => ({ type: 'text/event-stream', body: events.join('') });
const dataEvent = (o, extra = '') => `${extra}data: ${typeof o === 'string' ? o : JSON.stringify(o)}\n\n`;

test('tools/list as events: noise before the answer is dropped, the answer is filtered, the form is kept', async (t) => {
  const { b, broker, post } = await setup(t, { grants: { defaults: { gmail: { preset: 'read' } } } });
  const cap = broker.grantMcp('agent-A', ['gmail']);
  b.list = (id, tools) => sseOf(
    ': keep-alive\n\n',
    dataEvent({ jsonrpc: '2.0', method: 'notifications/progress', params: { token: 'x' } }, 'event: message\n'),
    dataEvent({ jsonrpc: '2.0', id: 999, method: 'sampling/createMessage', params: {} }),
    dataEvent({ jsonrpc: '2.0', id: 77, result: { tools: [{ name: 'someone_elses' }] } }),
    dataEvent({ jsonrpc: '2.0', id, result: { tools, nextCursor: 'more' } }, 'id: 5\nevent: message\n'),
    dataEvent({ jsonrpc: '2.0', id, result: { tools: [{ name: 'a_second_answer' }] } })
  );
  const r = await post(cap, LIST(2));
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /^text\/event-stream/);
  const text = r.body.toString();
  const events = text.split('\n\n').filter(Boolean);
  assert.equal(events.length, 1, 'only the filtered answer goes back: no progress note, no server request, no other answer');
  const msg = JSON.parse(events[0].split('\n').find((l) => l.startsWith('data: ')).slice(6));
  assert.equal(msg.id, 2);
  assert.deepEqual(msg.result.tools.map((x) => x.name), ['get_thing']);
  assert.equal(msg.result.nextCursor, 'more');
  for (const leak of ['send_thing', 'put_thing', 'mystery_thing', 'someone_elses', 'a_second_answer', 'sampling', 'progress']) assert.equal(text.includes(leak), false, leak);
});

test('tools/list as events: CRLF, a byte-order mark, multi-line data and a charset in the type all read correctly', async (t) => {
  const { b, broker, post } = await setup(t, { grants: { defaults: { gmail: { preset: 'read' } } } });
  const cap = broker.grantMcp('agent-A', ['gmail']);
  b.list = (id, tools) => {
    const json = JSON.stringify({ jsonrpc: '2.0', id, result: { tools } });
    const half = Math.floor(json.length / 2);
    // the JSON is legal split across two data lines only where a newline is whitespace; do that between tokens
    const spaced = JSON.stringify({ jsonrpc: '2.0', id, result: { tools } }, null, 1).split('\n');
    return { type: 'text/event-stream; charset=utf-8', body: `﻿${spaced.map((l) => `data: ${l}`).join('\r\n')}\r\n\r\n` + `: ${half}\r\n` };
  };
  const r = await post(cap, LIST(3));
  assert.equal(r.status, 200);
  const data = r.body.toString().split('\n').find((l) => l.startsWith('data: '));
  assert.deepEqual(JSON.parse(data.slice(6)).result.tools.map((x) => x.name), ['get_thing']);
});

test('tools/list as events that cannot be trusted is REFUSED, never passed on', async (t) => {
  const { b, broker, post } = await setup(t, { grants: { defaults: { gmail: { preset: 'write' } } } });
  const cap = broker.grantMcp('agent-A', ['gmail']);
  const everything = (text) => TOOLS.some((x) => text.includes(x.name));
  const cases = {
    'no events at all': () => sseOf(),
    'only comments': () => sseOf(': nothing here\n\n'),
    'the answer is for another id': (id, tools) => sseOf(dataEvent({ jsonrpc: '2.0', id: id + 1, result: { tools } })),
    'the answer is a string id where a number was asked': (id, tools) => sseOf(dataEvent({ jsonrpc: '2.0', id: String(id), result: { tools } })),
    'the event was never finished': (id, tools) => sseOf(`data: ${JSON.stringify({ jsonrpc: '2.0', id, result: { tools } })}\n`),
    'data that is not JSON': () => sseOf(dataEvent('{ not json')),
    'a batch where one answer was expected': (id, tools) => sseOf(dataEvent([{ jsonrpc: '2.0', id, result: { tools } }])),
    'a request carrying the right id': (id, tools) => sseOf(dataEvent({ jsonrpc: '2.0', id, method: 'x', result: { tools } }))
  };
  let i = 10;
  for (const [name, make] of Object.entries(cases)) {
    b.list = make;
    const r = await post(cap, LIST(i++));
    assert.equal(r.status, 502, name);
    assert.equal(everything(r.body.toString()), false, `${name}: no tool name may leak`);
  }
  // an error answer in a stream goes back as an error, in the same form
  b.list = (id) => sseOf(dataEvent({ jsonrpc: '2.0', id, error: { code: -32000, message: 'upstream tool list failed' } }));
  const err = await post(cap, LIST(40));
  assert.equal(err.status, 200);
  assert.match(err.body.toString(), /upstream tool list failed/);
});

test('a tools/list that stalls after its headers is abandoned at the listing deadline', async (t) => {
  const { up, b, broker, post } = await setup(t, { limits: { listingMs: 200 } });
  const cap = broker.grantMcp('agent-A', ['gmail']);
  b.stallList = true;
  const started = Date.now();
  const r = await Promise.race([post(cap, LIST()), new Promise((resolve) => setTimeout(() => resolve({ status: 'still waiting after 4 s' }), 4000))]);
  assert.equal(r.status, 502, 'a list that stalls is refused at the deadline, not waited for');
  assert.ok(Date.now() - started < 3000, 'not held for ever');
  const entry = up.seen.find((x) => x.res);
  assert.ok(await until(() => entry.res.destroyed || entry.res.writableEnded || entry.res.socket?.destroyed), 'the upstream connection is let go');
});

test('a tools/list bigger than the cap is refused', async (t) => {
  const { b, broker, post } = await setup(t, { limits: { maxListingBytes: 400 } });
  const cap = broker.grantMcp('agent-A', ['gmail']);
  b.tools = Array.from({ length: 50 }, (_, i) => ({ name: `tool_${i}`, description: 'x'.repeat(50) }));
  const r = await post(cap, LIST());
  assert.equal(r.status, 502);
});

// ─── how fast, how many ──────────────────────────────────────────────────────

test('RATE: a burst, then a refusal with the wait; the bucket refills with time; each agent has its own', async (t) => {
  const { up, broker, clock, post } = await setup(t, { limits: { ratePerSec: 2, burst: 3 } });
  const a = broker.grantMcp('agent-A', ['gmail']);
  const b2 = broker.grantMcp('agent-B', ['gmail']);
  const ping = (tok, id) => post(tok, rpc('ping', undefined, id));
  for (let i = 0; i < 3; i++) assert.equal((await ping(a, i + 1)).status, 200);
  const over = await ping(a, 4);
  assert.equal(over.status, 429);
  assert.deepEqual(json(over), { error: 'too many requests, slow down', code: 'rate_limited' });
  assert.equal(over.headers['retry-after'], '1');
  assert.equal(up.seen.length, 3, 'the refused one never reached the upstream');
  assert.equal((await ping(b2, 1)).status, 200, 'another agent is not slowed down by it');
  clock.t += 500;                              // two per second: one token back
  assert.equal((await ping(a, 5)).status, 200);
  assert.equal((await ping(a, 6)).status, 429);
  clock.t += 10_000;
  for (let i = 0; i < 3; i++) assert.equal((await ping(a, 10 + i)).status, 200, 'a full bucket again, but never more than the burst');
  assert.equal((await ping(a, 20)).status, 429);
});

test('RATE: a request that is refused for another reason does not use a token', async (t) => {
  const { state, broker, post } = await setup(t, { grants: {}, limits: { ratePerSec: 1, burst: 2 } });
  const cap = broker.grantMcp('agent-A', ['gmail']);
  for (let i = 0; i < 10; i++) assert.equal((await post(cap, rpc('ping', undefined, i + 1))).status, 403, 'no grant');
  state.grants = { defaults: { gmail: { preset: 'read' } } };
  assert.equal((await post(cap, rpc('ping', undefined, 1))).status, 200);
  assert.equal((await post(cap, rpc('ping', undefined, 2))).status, 200, 'both tokens of the burst are still there');
  assert.equal((await post(cap, rpc('ping', undefined, 3))).status, 429);
});

test('STREAMS: an agent may hold only a few event streams open on one integration; closing one frees a slot', async (t) => {
  const { up, broker, port, hdr } = await setup(t, { limits: { maxStreams: 2, maxInflight: 20 } });
  const a = broker.grantMcp('agent-A', ['gmail']);
  const b2 = broker.grantMcp('agent-B', ['gmail']);
  const get = (tok) => open(port, { path: '/m/gmail', headers: { ...hdr(tok), accept: 'text/event-stream' } });
  const s1 = await get(a); const s2 = await get(a);
  assert.equal(s1.status, 200); assert.equal(s2.status, 200);
  // an OPEN request, so that a broker that wrongly lets it through fails this assertion instead of hanging the test
  const third = await open(port, { path: '/m/gmail', headers: { ...hdr(a), accept: 'text/event-stream' } });
  assert.equal(third.status, 429, 'the third stream is refused');
  assert.ok(await until(() => third.events.ended), 'and answered, not held open');
  assert.equal(JSON.parse(third.text()).code, 'too_many_streams');
  third.req.destroy(); third.res.destroy();
  const other = await get(b2);
  assert.equal(other.status, 200, 'another agent has its own');
  s1.req.destroy(); s1.res.destroy();
  let freed = null;
  for (let i = 0; i < 40 && !freed; i++) {
    const g = await get(a);
    if (g.status === 200) freed = g; else await new Promise((r) => setTimeout(r, 25));
  }
  assert.ok(freed, 'the slot came back');
  for (const s of [s2, other, freed]) { s.req.destroy(); s.res.destroy(); }
  assert.equal(up.seen.filter((r) => r.method === 'GET').length >= 3, true);
});

test('GLOBAL: the whole broker runs only so many requests at once, whoever they are for', async (t) => {
  const { broker, port, hdr } = await setup(t, { limits: { maxGlobalInflight: 2, maxStreams: 4 } });
  const caps = ['a', 'b', 'c'].map((n) => broker.grantMcp(`agent-${n}`, ['gmail']));
  const get = (tok) => open(port, { path: '/m/gmail', headers: { ...hdr(tok), accept: 'text/event-stream' } });
  const s1 = await get(caps[0]); const s2 = await get(caps[1]);
  const refused = await open(port, { path: '/m/gmail', headers: { ...hdr(caps[2]), accept: 'text/event-stream' } });
  assert.equal(refused.status, 429, 'the third request is refused');
  assert.ok(await until(() => refused.events.ended), 'and answered, not held open');
  assert.equal(JSON.parse(refused.text()).error, 'the broker is busy');
  refused.req.destroy(); refused.res.destroy();
  for (const s of [s1, s2]) { s.req.destroy(); s.res.destroy(); }
});

// ─── sessions are closed when their agent ends ───────────────────────────────

test('SESSIONS: when an agent ends, the upstream is told (DELETE, with the credential, bound to nothing else); a quit or a disconnect says nothing', async (t) => {
  const { up, broker, post } = await setup(t);
  const a = broker.grantMcp('agent-A', ['gmail']);
  const other = broker.grantMcp('agent-B', ['gmail']);
  const sidA = (await post(a, INIT)).headers['mcp-session-id'];
  const sidB = (await post(other, INIT)).headers['mcp-session-id'];
  assert.ok(sidA && sidB && sidA !== sidB);

  broker.revokeMcp('agent-A');
  const del = await until(() => up.seen.find((r) => r.method === 'DELETE'));
  assert.ok(del, 'the upstream was told');
  assert.equal(del.headers['mcp-session-id'], sidA, 'A\'s session, and only A\'s');
  assert.equal(del.headers.authorization, 'Bearer T1', 'with the broker\'s credential, never the agent\'s');
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(up.seen.filter((r) => r.method === 'DELETE').length, 1, 'B was not touched');

  broker.revokeIntegration('gmail');           // Disconnect: the credential is going away, so no courtesy call
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(up.seen.filter((r) => r.method === 'DELETE').length, 1);

  const c = broker.grantMcp('agent-C', ['gmail']);
  await post(c, INIT);
  broker.stop();                                // quit
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(up.seen.filter((r) => r.method === 'DELETE').length, 1, 'nothing is sent while the app is quitting');
});

test('SESSIONS: respawning an agent (a new capability for the same id) closes the old process\'s session', async (t) => {
  const { up, broker, post } = await setup(t);
  const first = broker.grantMcp('agent-A', ['gmail']);
  const sid = (await post(first, INIT)).headers['mcp-session-id'];
  const second = broker.grantMcp('agent-A', ['gmail']);
  assert.notEqual(first, second);
  const del = await until(() => up.seen.find((r) => r.method === 'DELETE'));
  assert.equal(del.headers['mcp-session-id'], sid);
  assert.equal((await post(first, INIT)).status, 401, 'and the old capability is dead');
});

// ─── tool discovery for the Settings panel ───────────────────────────────────

test('DISCOVERY: the broker lists the server\'s tools itself — initialize, initialized, every page, then closes — and names their classes', async (t) => {
  const { up, b, broker } = await setup(t);
  b.pages = { first: [TOOLS[0], TOOLS[1]], second: [TOOLS[2], TOOLS[3]] };
  const r = await broker.discoverMcpTools('gmail');
  assert.equal(r.ok, true);
  assert.deepEqual(r.tools.map((x) => [x.name, x.class]), [
    ['get_thing', 'read'], ['mystery_thing', 'destructive'], ['put_thing', 'write'], ['send_thing', 'destructive']
  ]);
  const posts = up.seen.filter((x) => x.method === 'POST').map((x) => JSON.parse(x.body.toString()));
  assert.deepEqual(posts.map((m) => m.method), ['initialize', 'notifications/initialized', 'tools/list', 'tools/list']);
  assert.equal(posts[3].params.cursor, 'p2');
  const sid = up.seen.find((x) => x.method === 'POST' && x.headers['mcp-session-id'])?.headers['mcp-session-id'];
  assert.ok(sid, 'the session id the server gave is used for the rest');
  assert.equal(up.seen.filter((x) => x.method === 'POST' && x.headers['mcp-protocol-version']).length >= 3, true, 'the negotiated version is sent after initialize');
  assert.ok(await until(() => up.seen.find((x) => x.method === 'DELETE')), 'and the session is closed');
  assert.deepEqual(broker.mcpTools('gmail').map((x) => x.name), ['get_thing', 'mystery_thing', 'put_thing', 'send_thing']);
});

test('DISCOVERY: what it learns lets a call be classed without any agent having listed tools first', async (t) => {
  const { broker, post } = await setup(t, { grants: { defaults: { gmail: { preset: 'write' } } } });
  const cap = broker.grantMcp('agent-A', ['gmail']);
  const call1 = (name) => post(cap, rpc('tools/call', { name, arguments: {} }, 5));
  assert.match(json(await call1('get_thing')).error.message, /list tools first/, 'before discovery nothing is known');
  assert.equal((await broker.discoverMcpTools('gmail')).ok, true);
  assert.ok(json(await call1('get_thing')).result, 'a read tool now passes the write preset');
  assert.match(json(await call1('send_thing')).error.message, /not granted/, 'a destructive one still does not');
});

test('DISCOVERY: descriptions are shown as plain text, short; the credential is the broker\'s own; one run at a time', async (t) => {
  const { up, b, broker } = await setup(t);
  b.tools = [{ name: 'get_thing', description: `  reads\u0000\u0007 a\n\nthing ${'y'.repeat(900)}` }, { name: 5 }, null, { description: 'nameless' }, { name: 'x'.repeat(300) }];
  const [r1, r2] = await Promise.all([broker.discoverMcpTools('gmail'), broker.discoverMcpTools('gmail')]);
  assert.equal(r1.ok && r2.ok, true);
  assert.deepEqual(r1.tools.map((x) => x.name), ['get_thing'], 'entries that are not a named tool (or are absurdly long) are skipped');
  const d = r1.tools[0].description;
  assert.equal(/[\u0000-\u001f]/.test(d), false);
  assert.ok(d.length <= 300);
  assert.equal(up.seen.filter((x) => x.method === 'POST' && JSON.parse(x.body.toString()).method === 'initialize').length, 1, 'two callers, one discovery');
  assert.deepEqual([...new Set(upstreamTokens(up))], ['T1']);
});

test('DISCOVERY refuses what it must: unknown, disabled, signed out, upstream down, an answer that is not one', async (t) => {
  const ctx = await setup(t);
  const { broker, b, prov, state } = ctx;
  assert.deepEqual(await broker.discoverMcpTools('nope'), { ok: false, code: 'unknown' });
  state.enabled = false;
  assert.deepEqual(await broker.discoverMcpTools('gmail'), { ok: false, code: 'disabled' });
  state.enabled = true;
  prov.failAccess = 'sign_in_required';
  assert.deepEqual(await broker.discoverMcpTools('gmail'), { ok: false, code: 'sign_in_required' });
  prov.failAccess = 'unavailable';
  assert.deepEqual(await broker.discoverMcpTools('gmail'), { ok: false, code: 'unavailable' });
  prov.failAccess = null;
  b.initStatus = 500;
  assert.deepEqual(await broker.discoverMcpTools('gmail'), { ok: false, code: 'upstream' });
  b.initStatus = 200;
  b.list = () => ({ type: 'application/json', body: '{"jsonrpc":"2.0","id":2,"result":{"tools":"nope"}}' });
  assert.deepEqual(await broker.discoverMcpTools('gmail'), { ok: false, code: 'upstream' });
  b.list = (id) => ({ type: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: id + 5, result: { tools: [] } }) });
  assert.deepEqual(await broker.discoverMcpTools('gmail'), { ok: false, code: 'upstream' }, 'an answer to some other id is not the answer');
  b.accept = new Set();
  assert.deepEqual(await broker.discoverMcpTools('gmail'), { ok: false, code: 'sign_in_required' }, 'a credential the server refuses, with nothing newer, is a sign-in problem');
});

test('DISCOVERY: a 401 is refreshed and replayed, and the later calls use the newer credential', async (t) => {
  const { up, b, broker, prov } = await setup(t);
  b.accept = new Set(['T2']); prov.next = ['T2'];
  const r = await broker.discoverMcpTools('gmail');
  assert.equal(r.ok, true);
  assert.deepEqual(upstreamTokens(up).slice(0, 2), ['T1', 'T2']);
  assert.equal(prov.rejectedWith.length, 1, 'one refusal, not one per call');
  assert.deepEqual([...new Set(upstreamTokens(up).slice(1))], ['T2']);
});

test('DISCOVERY: a server that never answers is given up on, and a redirect is not followed', async (t) => {
  const ctx = await setup(t, { limits: { discoveryMs: 300, headersMs: 300 } });
  ctx.b.stallList = true;
  const started = Date.now();
  const r = await ctx.broker.discoverMcpTools('gmail');
  assert.equal(r.ok, false);
  assert.ok(Date.now() - started < 4000);

  const ctx2 = await setup(t);
  const target = await startUpstream(t);
  ctx2.up.server.removeAllListeners('request');
  ctx2.up.server.on('request', (req, res) => { res.writeHead(302, { location: `${target.base}/stolen` }); res.end(); });
  const r2 = await ctx2.broker.discoverMcpTools('gmail');
  assert.equal(r2.ok, false);
  assert.equal(target.seen.length, 0, 'the credential was not sent along a redirect');
});

// ─── what the Access section is allowed to see ───────────────────────────────

test('AUDIT: metadata only — who, which integration, which method or tool, allowed or not — and never an argument or a credential', async (t) => {
  const { audit, broker, post } = await setup(t, { grants: { defaults: { gmail: { preset: 'read' } } } });
  const cap = broker.grantMcp('agent-A', ['gmail']);
  await post(cap, INIT);
  await post(cap, LIST(2));
  await post(cap, rpc('tools/call', { name: 'send_thing', arguments: { to: 'secret@example.com', body: 'SENSITIVE-ARGUMENT' } }, 3));
  assert.ok(audit.length >= 3);
  const text = JSON.stringify(audit);
  for (const forbidden of ['SENSITIVE-ARGUMENT', 'secret@example.com', 'T1', cap]) assert.equal(text.includes(forbidden), false, forbidden);
  const denied = audit.find((e) => e.tool === 'send_thing');
  assert.equal(denied.decision, 'deny');
  assert.equal(denied.agentId, 'agent-A');
  assert.deepEqual(Object.keys(denied).sort(), ['agentId', 'at', 'decision', 'integrationId', 'method', 'reason', 'tool']);
});

// ─── what the broker checks is what the upstream reads ───────────────────────

test('A REPEATED KEY is refused: the broker reads the last value, a first-wins server would read the first, so neither is trusted', async (t) => {
  const { up, broker, post } = await setup(t, { grants: { defaults: { gmail: { preset: 'custom', allow: ['get_thing'] } } } });
  const cap = broker.grantMcp('agent-A', ['gmail']);
  await post(cap, LIST(1));                                         // so the tools are known
  const before = up.seen.length;
  // checked as `get_thing` (granted) by a last-wins reader; a first-wins server would run `send_thing`
  const sneaky = '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"send_thing","name":"get_thing","arguments":{}}}';
  const r = await post(cap, sneaky);
  assert.equal(r.status, 400);
  assert.equal(json(r).error.code, -32600);
  assert.equal(up.seen.length, before, 'nothing reached the upstream');
  // …in a batch, an escaped spelling of the same key, and nested in the arguments too
  for (const body of [
    `[{"jsonrpc":"2.0","id":1,"method":"ping"},${sneaky}]`,
    '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"na\\u006de":"send_thing","name":"get_thing"}}',
    '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"get_thing","arguments":{"to":"a","to":"b"}}}'
  ]) assert.equal((await post(cap, body)).status, 400, body.slice(0, 80));
  assert.equal(up.seen.length, before);
  // an honest message with the same key in different objects is fine
  const fine = await post(cap, '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"get_thing","arguments":{"name":"x"}}}');
  assert.equal(fine.status, 200);
  assert.ok(json(fine).result);
});

test('A TOOL LIST INSIDE A BATCH is refused (its answer could not be filtered), all of the batch with it; asked alone it is filtered as ever', async (t) => {
  const { up, broker, post } = await setup(t, { grants: { defaults: { gmail: { preset: 'read' } } } });
  const cap = broker.grantMcp('agent-A', ['gmail']);
  const body = JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { jsonrpc: '2.0', method: 'notifications/initialized' }]);
  const r = await post(cap, body);
  assert.equal(r.status, 200);
  const answers = json(r);
  assert.deepEqual(answers.map((a) => a.id), [1, 2]);
  assert.ok(answers.every((a) => a.error.code === -32003));
  assert.match(answers[1].error.message, /tools\/list cannot be part of a batch/);
  assert.equal(up.seen.length, 0, 'not even the harmless parts went upstream');
  for (const name of ['get_thing', 'put_thing', 'send_thing', 'mystery_thing']) assert.equal(r.body.toString().includes(name), false, 'no tool name came back');
  const plain = await post(cap, JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', id: 2, method: 'ping' }]));
  assert.ok(plain.status < 300, 'a batch without a tool list still passes');
  assert.equal(up.seen.length, 1, 'and reaches the upstream');
  assert.deepEqual(json(await post(cap, LIST(3))).result.tools.map((x) => x.name), ['get_thing'], 'alone, the list is filtered as ever (the read preset: the read tool only)');
});
