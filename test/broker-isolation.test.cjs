'use strict';

/**
 * Isolation between agents, channels and integrations, on ONE broker carrying
 * both REST and MCP traffic for several agents at the same time — the situation
 * the shared broker exists for.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { startUpstream, startMcpUpstream, call, open, until, json, bearer, rpc } = require('./fixtures/broker-helpers.cjs');

const { IntegrationBroker } = loadTs('src/main/integrationBroker.ts');

const INIT = rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } }, 1);
const CLASSES = { get_thing: 'read', put_thing: 'write', send_thing: 'destructive' };

/** A broker with two REST integrations (a, b) and two MCP integrations (gmail, slack). */
async function world(t) {
  const restA = await startUpstream(t);
  const restB = await startUpstream(t);
  const gmail = await startMcpUpstream(t, { token: 'GMAIL-UPSTREAM' });
  const slack = await startMcpUpstream(t, { token: 'SLACK-UPSTREAM' });
  const records = new Map([
    ['a', { id: 'a', label: 'A', kind: 'custom-rest', baseUrl: restA.base, authType: 'bearer', secretRef: 'int:a', enabled: true, createdAt: 1, updatedAt: 1 }],
    ['b', { id: 'b', label: 'B', kind: 'custom-rest', baseUrl: restB.base, authType: 'bearer', secretRef: 'int:b', enabled: true, createdAt: 1, updatedAt: 1 }]
  ]);
  const secrets = { 'int:a': 'REST-SECRET-A', 'int:b': 'REST-SECRET-B' };
  const mcpIntegrations = new Map([
    ['gmail', { id: 'gmail', url: `${gmail.base}/mcp`, enabled: true, classification: { toolClasses: CLASSES } }],
    ['slack', { id: 'slack', url: `${slack.base}/mcp`, enabled: true, classification: { toolClasses: CLASSES } }]
  ]);
  const upstreamTokens = { gmail: 'GMAIL-UPSTREAM', slack: 'SLACK-UPSTREAM' };
  const state = { grants: {} };
  const events = [];
  const broker = new IntegrationBroker(
    { getRecord: (id) => records.get(id), getSecret: (ref) => secrets[ref] },
    {
      mcp: {
        resolve: (id) => mcpIntegrations.get(id),
        credentials: { accessHeaders: (i) => ({ ok: true, headers: { authorization: `Bearer ${upstreamTokens[i.id]}` } }) },
        grants: () => state.grants,
        audit: (e) => events.push(e)
      }
    }
  );
  const { port } = await broker.start();
  t.after(() => broker.stop());
  const mcpPost = (token, integration, body, extra = {}) => call(port, {
    method: 'POST', path: `/m/${integration}`,
    headers: { ...bearer(token), 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...extra }, body
  });
  const rest = (token, id, path = 'x') => call(port, { path: `/i/${id}/${path}`, headers: bearer(token) });
  const tools = async (token, integration) => json(await mcpPost(token, integration, rpc('tools/list', undefined, 9))).result.tools.map((x) => x.name).sort();
  return { broker, port, restA, restB, gmail, slack, state, events, secrets, mcpPost, rest, tools, upstreamTokens };
}

test('security: each agent reaches only what its own capabilities list, on each channel', async (t) => {
  const w = await world(t);
  const aRest = w.broker.grant('agent-A', ['a']);
  const bRest = w.broker.grant('agent-B', ['b']);
  const aMcp = w.broker.grantMcp('agent-A', ['gmail']);
  const bMcp = w.broker.grantMcp('agent-B', ['slack']);
  w.state.grants = { defaults: { gmail: { preset: 'read' }, slack: { preset: 'read' } } };

  assert.equal((await w.rest(aRest, 'a')).status, 200);
  assert.equal((await w.rest(aRest, 'b')).status, 403);
  assert.equal((await w.rest(bRest, 'b')).status, 200);
  assert.equal((await w.rest(bRest, 'a')).status, 403);

  assert.equal((await w.mcpPost(aMcp, 'gmail', INIT)).status, 200);
  assert.equal((await w.mcpPost(aMcp, 'slack', INIT)).status, 403);
  assert.equal((await w.mcpPost(bMcp, 'slack', INIT)).status, 200);
  assert.equal((await w.mcpPost(bMcp, 'gmail', INIT)).status, 403);
});

test('security: a token of one channel is no use on the other, for every agent', async (t) => {
  const w = await world(t);
  w.state.grants = { defaults: { gmail: { preset: 'write' } } };
  for (const agent of ['agent-A', 'agent-B', 'agent-C']) {
    const rest = w.broker.grant(agent, ['a', 'gmail']);
    const mcp = w.broker.grantMcp(agent, ['a', 'gmail']);
    assert.notEqual(rest, mcp);
    assert.equal((await w.mcpPost(rest, 'gmail', INIT)).status, 401, `${agent}: REST token on /m`);
    assert.equal((await w.rest(mcp, 'a')).status, 401, `${agent}: MCP token on /i`);
    assert.equal((await w.rest(rest, 'a')).status, 200);
    assert.equal((await w.mcpPost(mcp, 'gmail', INIT)).status, 200);
  }
});

test('security: grants belong to the agent: one agent can be cut off or widened without touching another', async (t) => {
  const w = await world(t);
  const a = w.broker.grantMcp('agent-A', ['gmail']);
  const b = w.broker.grantMcp('agent-B', ['gmail']);
  w.state.grants = { agents: { 'agent-A': { gmail: { preset: 'read' } }, 'agent-B': { gmail: { preset: 'none' } } } };

  assert.equal((await w.mcpPost(b, 'gmail', INIT)).status, 403, 'B has been given nothing');
  assert.equal((await w.mcpPost(a, 'gmail', INIT)).status, 200);
  assert.deepEqual(await w.tools(a, 'gmail'), ['get_thing']);

  w.state.grants.agents['agent-B'].gmail = { preset: 'write' };
  assert.deepEqual(await w.tools(b, 'gmail'), ['get_thing', 'put_thing'], 'B is widened');
  assert.deepEqual(await w.tools(a, 'gmail'), ['get_thing'], 'A is untouched');

  w.state.grants.agents['agent-A'].gmail = { preset: 'none' };
  assert.equal((await w.mcpPost(a, 'gmail', INIT)).status, 403, 'A is cut off');
  assert.deepEqual(await w.tools(b, 'gmail'), ['get_thing', 'put_thing'], 'B carries on');
});

test('security: what one agent calls is not visible to, or usable by, another', async (t) => {
  const w = await world(t);
  const a = w.broker.grantMcp('agent-A', ['gmail']);
  const b = w.broker.grantMcp('agent-B', ['gmail']);
  w.state.grants = { agents: { 'agent-A': { gmail: { preset: 'custom', allow: ['send_thing'] } }, 'agent-B': { gmail: { preset: 'read' } } } };
  assert.equal(json(await w.mcpPost(a, 'gmail', rpc('tools/call', { name: 'send_thing' }, 1))).result.content[0].text, 'called send_thing');
  assert.equal(json(await w.mcpPost(b, 'gmail', rpc('tools/call', { name: 'send_thing' }, 1))).error.code, -32003, "B does not inherit A's named tool");
  assert.deepEqual(await w.tools(b, 'gmail'), ['get_thing']);
});

test('security: revoking one agent kills both of its tokens at once and leaves every other agent working', async (t) => {
  const w = await world(t);
  w.state.grants = { defaults: { gmail: { preset: 'read' } } };
  const a = { rest: w.broker.grant('agent-A', ['a']), mcp: w.broker.grantMcp('agent-A', ['gmail']) };
  const b = { rest: w.broker.grant('agent-B', ['a']), mcp: w.broker.grantMcp('agent-B', ['gmail']) };
  assert.equal((await w.rest(a.rest, 'a')).status, 200);
  assert.equal((await w.mcpPost(a.mcp, 'gmail', INIT)).status, 200);

  w.broker.revoke('agent-A');
  assert.equal((await w.rest(a.rest, 'a')).status, 401);
  assert.equal((await w.mcpPost(a.mcp, 'gmail', INIT)).status, 401);
  assert.equal((await w.rest(b.rest, 'a')).status, 200);
  assert.equal((await w.mcpPost(b.mcp, 'gmail', INIT)).status, 200);
});

test('security: teardown cuts the REST stream and the MCP stream an agent is running, together', async (t) => {
  const w = await world(t);
  w.state.grants = { defaults: { gmail: { preset: 'read' } } };
  const slow = await startUpstream(t, (req, res) => { res.writeHead(200); res.write('first;'); });
  const records = new Map([['slow', { id: 'slow', label: 'S', kind: 'custom-rest', baseUrl: slow.base, authType: 'none', enabled: true, createdAt: 1, updatedAt: 1 }]]);
  const gmail = await startMcpUpstream(t, { token: 'GMAIL-UPSTREAM' });
  const broker = new IntegrationBroker({ getRecord: (id) => records.get(id), getSecret: () => undefined }, {
    mcp: {
      resolve: () => ({ id: 'gmail', url: `${gmail.base}/mcp`, enabled: true }),
      credentials: { accessHeaders: () => ({ ok: true, headers: { authorization: 'Bearer GMAIL-UPSTREAM' } }) },
      grants: () => ({ defaults: { gmail: { preset: 'read' } } })
    }
  });
  const { port } = await broker.start();
  t.after(() => broker.stop());
  const rest = broker.grant('agent-A', ['slow']);
  const mcp = broker.grantMcp('agent-A', ['gmail']);
  const init = await call(port, { method: 'POST', path: '/m/gmail', headers: { ...bearer(mcp), 'content-type': 'application/json' }, body: INIT });
  const sse = await open(port, { path: '/m/gmail', headers: { ...bearer(mcp), accept: 'text/event-stream', 'mcp-session-id': init.headers['mcp-session-id'] } });
  const restStream = await open(port, { path: '/i/slow/x', headers: bearer(rest) });
  await until(() => sse.text().includes('notifications/message') && restStream.text().includes('first;'));

  const started = Date.now();
  broker.revoke('agent-A');
  assert.ok(await until(() => (sse.events.closed || sse.events.error) && (restStream.events.closed || restStream.events.error)));
  assert.ok(Date.now() - started < 1000);
});

test('security: six agents on both channels at once each see only their own integrations and credentials', async (t) => {
  const w = await world(t);
  w.state.grants = { defaults: { gmail: { preset: 'read' }, slack: { preset: 'read' } } };
  const agents = Array.from({ length: 6 }, (_, i) => {
    const id = `agent-${i}`;
    const restId = i % 2 ? 'a' : 'b';
    const mcpId = i % 2 ? 'gmail' : 'slack';
    return { id, restId, mcpId, rest: w.broker.grant(id, [restId]), mcp: w.broker.grantMcp(id, [mcpId]) };
  });
  // 192 requests are queued, but at most 40 sockets are open at once: a burst of
  // hundreds of simultaneous connects overflows the OS accept backlog (macOS caps it
  // at 128) and resets some of them, which says nothing about the broker.
  const jobs = [];
  const wrong = [];
  let open = 0;
  const waiting = [];
  const gate = async (fn) => {
    while (open >= 40) await new Promise((r) => waiting.push(r));
    open++;
    try { return await fn(); } finally { open--; waiting.shift()?.(); }
  };
  const expectStatus = (label, want) => (r) => { if (r.status !== want) wrong.push(`${label}: wanted ${want}, got ${r.status ?? r.error} ${r.body ? r.body.toString().slice(0, 80) : ''}`); };
  for (const ag of agents) {
    const otherRest = ag.restId === 'a' ? 'b' : 'a';
    const otherMcp = ag.mcpId === 'gmail' ? 'slack' : 'gmail';
    for (let n = 0; n < 8; n++) {
      jobs.push(gate(() => w.rest(ag.rest, ag.restId, `n${n}`)).then(expectStatus(`${ag.id} rest own`, 200)));
      jobs.push(gate(() => w.mcpPost(ag.mcp, ag.mcpId, rpc('ping', undefined, n))).then(expectStatus(`${ag.id} mcp own`, 200)));
      jobs.push(gate(() => w.rest(ag.rest, otherRest, 'nope')).then(expectStatus(`${ag.id} rest other`, 403)));
      jobs.push(gate(() => w.mcpPost(ag.mcp, otherMcp, rpc('ping', undefined, n))).then(expectStatus(`${ag.id} mcp other`, 403)));
    }
  }
  await Promise.all(jobs);
  assert.deepEqual(wrong, []);
  for (const e of w.restA.seen) assert.equal(e.headers.authorization, 'Bearer REST-SECRET-A');
  for (const e of w.restB.seen) assert.equal(e.headers.authorization, 'Bearer REST-SECRET-B');
  for (const e of w.gmail.seen) assert.equal(e.headers.authorization, 'Bearer GMAIL-UPSTREAM');
  for (const e of w.slack.seen) assert.equal(e.headers.authorization, 'Bearer SLACK-UPSTREAM');
  assert.equal(w.restA.seen.length + w.restB.seen.length, 6 * 8);
  assert.equal(w.gmail.seen.length + w.slack.seen.length, 6 * 8);
});

test('re-granting an agent replaces only that channel and leaves the other agents alone', async (t) => {
  const w = await world(t);
  w.state.grants = { defaults: { gmail: { preset: 'read' } } };
  const rest1 = w.broker.grant('agent-A', ['a']);
  const mcp1 = w.broker.grantMcp('agent-A', ['gmail']);
  const other = w.broker.grantMcp('agent-B', ['gmail']);
  const rest2 = w.broker.grant('agent-A', ['a']);
  assert.equal((await w.rest(rest1, 'a')).status, 401);
  assert.equal((await w.rest(rest2, 'a')).status, 200);
  assert.equal((await w.mcpPost(mcp1, 'gmail', INIT)).status, 200, "A's MCP token is untouched");
  assert.equal((await w.mcpPost(other, 'gmail', INIT)).status, 200);
});

test('disconnecting an integration removes it from every agent at once and leaves the others', async (t) => {
  const w = await world(t);
  w.state.grants = { defaults: { gmail: { preset: 'read' }, slack: { preset: 'read' } } };
  const a = w.broker.grantMcp('agent-A', ['gmail', 'slack']);
  const b = w.broker.grantMcp('agent-B', ['gmail']);
  assert.equal(w.broker.revokeIntegration('gmail'), 2);
  assert.equal((await w.mcpPost(a, 'gmail', INIT)).status, 403);
  assert.equal((await w.mcpPost(b, 'gmail', INIT)).status, 403);
  assert.equal((await w.mcpPost(a, 'slack', INIT)).status, 200, 'the same agent still has its other integration');
});

test('a crash and restart: capabilities are gone, grants (plain config) are not, and nothing carries over', async (t) => {
  const w = await world(t);
  w.state.grants = { defaults: { gmail: { preset: 'read' } } };
  const rest = w.broker.grant('agent-A', ['a']);
  const mcp = w.broker.grantMcp('agent-A', ['gmail']);
  assert.equal((await w.rest(rest, 'a')).status, 200);
  assert.equal((await w.mcpPost(mcp, 'gmail', INIT)).status, 200);

  w.broker.stop();
  const restarted = await w.broker.start();
  assert.equal(restarted.ok, true);
  assert.equal((await call(restarted.port, { path: '/i/a/x', headers: bearer(rest) })).status, 401);
  assert.equal((await call(restarted.port, { method: 'POST', path: '/m/gmail', headers: { ...bearer(mcp), 'content-type': 'application/json' }, body: INIT })).status, 401);

  // the agent gets fresh capabilities at its next spawn, and its grants are still there
  const fresh = w.broker.grantMcp('agent-A', ['gmail']);
  assert.equal((await call(restarted.port, { method: 'POST', path: '/m/gmail', headers: { ...bearer(fresh), 'content-type': 'application/json' }, body: INIT })).status, 200);
});

test('security: no response and no audit record anywhere contains a capability token or an upstream credential', async (t) => {
  const w = await world(t);
  w.state.grants = { defaults: { gmail: { preset: 'write' } } };
  const secretsSeen = [];
  const rest = w.broker.grant('agent-A', ['a', 'b']);
  const mcp = w.broker.grantMcp('agent-A', ['gmail', 'slack']);
  const mcpB = w.broker.grantMcp('agent-B', ['gmail']);
  secretsSeen.push(rest, mcp, mcpB, 'REST-SECRET-A', 'REST-SECRET-B', 'GMAIL-UPSTREAM', 'SLACK-UPSTREAM');
  const responses = [
    await w.rest(rest, 'a'), await w.rest(rest, 'b'), await w.rest(rest, 'zzz'), await w.rest('bogus', 'a'),
    await w.mcpPost(mcp, 'gmail', INIT), await w.mcpPost(mcp, 'slack', INIT), await w.mcpPost(mcp, 'gmail', rpc('tools/list', undefined, 1)),
    await w.mcpPost(mcp, 'gmail', rpc('tools/call', { name: 'send_thing' }, 2)), await w.mcpPost(mcpB, 'slack', INIT), await w.mcpPost('bogus', 'gmail', INIT)
  ];
  for (const r of responses) {
    const text = r.body.toString() + JSON.stringify(r.headers);
    for (const s of secretsSeen) assert.equal(text.includes(s), false, `a response leaked ${s.slice(0, 6)}…`);
  }
  const audit = JSON.stringify(w.events);
  for (const s of secretsSeen) assert.equal(audit.includes(s), false);
});
