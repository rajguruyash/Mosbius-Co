'use strict';

/**
 * F3 — per-agent, per-request grants on the REST broker, end to end.
 *
 * A real IntegrationBroker over loopback, a recording upstream, and grants that the test edits
 * between requests (the route re-reads them every time, which is what makes revocation
 * immediate). What must hold: no grant means the upstream is never contacted AND the secret is
 * never read; a preset reaches only what its name says; a DELETE needs to be named; deny beats
 * allow; a per-agent entry beats the default; taking a grant away stops the very next request;
 * a method-override header cannot change what a request is; and every decision is recorded
 * without a body, a query, a header or a credential.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { startUpstream, call, json, bearer } = require('./fixtures/broker-helpers.cjs');

const { IntegrationBroker } = loadTs('src/main/integrationBroker.ts');

const SECRET = 'REST-SECRET-CANARY-0123456789';

async function setup(t, { grants, integration = {} } = {}) {
  const up = await startUpstream(t);
  const state = { grants };
  let secretReads = 0;
  const events = [];
  const rec = {
    id: 'api', label: 'API', kind: 'custom-rest', baseUrl: up.base, authType: 'bearer', secretRef: 'int:api', enabled: true,
    createdAt: 1, updatedAt: 1, ...integration
  };
  const broker = new IntegrationBroker({
    getRecord: (id) => (id === 'api' ? rec : undefined),
    getSecret: () => { secretReads++; return SECRET; }
  }, { rest: { grants: () => state.grants, audit: (e) => events.push(e) } });
  const { port } = await broker.start();
  t.after(() => broker.stop());
  const tokenFor = (agent, ids = ['api']) => broker.grant(agent, ids);
  const req = (token, method, path, extra = {}) => call(port, { method, path: `/i/api${path}`, headers: { ...bearer(token), ...(extra.headers ?? {}) }, body: extra.body });
  return { up, state, broker, port, events, tokenFor, req, rec, secretReads: () => secretReads };
}

test('NO GRANT: the request is refused, the upstream is never contacted and the secret is never read', async (t) => {
  const s = await setup(t, { grants: {} });
  const tok = s.tokenFor('w1');
  const r = await s.req(tok, 'GET', '/things');
  assert.equal(r.status, 403);
  assert.equal(s.up.seen.length, 0, 'nothing reached the upstream');
  assert.equal(s.secretReads(), 0, 'the credential was not even read');
  assert.equal(s.events.length, 1);
  assert.deepEqual([s.events[0].decision, s.events[0].method, s.events[0].path, s.events[0].agentId, s.events[0].integrationId], ['deny', 'GET', '/things', 'w1', 'api']);
});

test('READ: GET goes through with the credential injected; POST and DELETE are refused before the upstream', async (t) => {
  const s = await setup(t, { grants: { defaults: { api: { preset: 'read' } } } });
  const tok = s.tokenFor('w1');
  const ok = await s.req(tok, 'GET', '/things?limit=2');
  assert.equal(ok.status, 200);
  assert.equal(s.up.last().headers.authorization, `Bearer ${SECRET}`, 'the broker injected the credential');
  assert.equal((await s.req(tok, 'POST', '/things', { body: '{}' })).status, 403);
  assert.equal((await s.req(tok, 'DELETE', '/things/1')).status, 403);
  assert.deepEqual(s.up.seen.map((x) => x.method), ['GET'], 'only the read was ever sent upstream');
});

test('WRITE: POST, PUT and PATCH go through; DELETE does not', async (t) => {
  const s = await setup(t, { grants: { defaults: { api: { preset: 'write' } } } });
  const tok = s.tokenFor('w1');
  for (const m of ['POST', 'PUT', 'PATCH']) assert.equal((await s.req(tok, m, '/things/1', { body: '{"a":1}' })).status, 200, m);
  assert.equal((await s.req(tok, 'DELETE', '/things/1')).status, 403);
  assert.deepEqual(s.up.seen.map((x) => x.method), ['POST', 'PUT', 'PATCH']);
});

test('A DELETE is reachable only by naming it, and only that one', async (t) => {
  const s = await setup(t, { grants: { defaults: { api: { preset: 'write', allow: ['DELETE /things/1'] } } } });
  const tok = s.tokenFor('w1');
  assert.equal((await s.req(tok, 'DELETE', '/things/1')).status, 200);
  assert.equal((await s.req(tok, 'DELETE', '/things/2')).status, 403);
  assert.equal((await s.req(tok, 'DELETE', '/things/1/children')).status, 403);
});

test('DENY beats ALLOW and the preset', async (t) => {
  const s = await setup(t, { grants: { defaults: { api: { preset: 'write', allow: ['POST /admin/x'], deny: ['* /admin/*'] } } } });
  const tok = s.tokenFor('w1');
  assert.equal((await s.req(tok, 'POST', '/admin/x', { body: '{}' })).status, 403);
  assert.equal((await s.req(tok, 'GET', '/admin/users')).status, 403);
  assert.equal((await s.req(tok, 'POST', '/things', { body: '{}' })).status, 200);
});

test('CUSTOM: exactly the allow list', async (t) => {
  const s = await setup(t, { grants: { defaults: { api: { preset: 'custom', allow: ['GET /a', 'POST /b'] } } } });
  const tok = s.tokenFor('w1');
  assert.equal((await s.req(tok, 'GET', '/a')).status, 200);
  assert.equal((await s.req(tok, 'POST', '/b', { body: '{}' })).status, 200);
  assert.equal((await s.req(tok, 'GET', '/b')).status, 403);
  assert.equal((await s.req(tok, 'GET', '/c')).status, 403);
});

test('PER AGENT: an agent\'s own entry beats the default, even when it says none', async (t) => {
  const s = await setup(t, { grants: { defaults: { api: { preset: 'read' } }, agents: { w2: { api: { preset: 'none' } }, w3: { api: { preset: 'write' } } } } });
  const t1 = s.tokenFor('w1');
  const t2 = s.tokenFor('w2');
  const t3 = s.tokenFor('w3');
  assert.equal((await s.req(t1, 'GET', '/x')).status, 200, 'w1 gets the default');
  assert.equal((await s.req(t1, 'POST', '/x', { body: '{}' })).status, 403);
  assert.equal((await s.req(t2, 'GET', '/x')).status, 403, 'w2 was cut off by name');
  assert.equal((await s.req(t3, 'POST', '/x', { body: '{}' })).status, 200, 'w3 has more');
});

test('IMMEDIATE REVOCATION: taking the grant away stops the very next request, with no restart', async (t) => {
  const s = await setup(t, { grants: { defaults: { api: { preset: 'write' } } } });
  const tok = s.tokenFor('w1');
  assert.equal((await s.req(tok, 'POST', '/x', { body: '{}' })).status, 200);
  s.state.grants = { defaults: { api: { preset: 'read' } } };
  assert.equal((await s.req(tok, 'POST', '/x', { body: '{}' })).status, 403, 'write was withdrawn');
  assert.equal((await s.req(tok, 'GET', '/x')).status, 200, 'read remains');
  s.state.grants = {};
  assert.equal((await s.req(tok, 'GET', '/x')).status, 403, 'and now nothing');
});

test('an expired grant is no grant', async (t) => {
  const s = await setup(t, { grants: { defaults: { api: { preset: 'write', expiresAt: Date.now() + 60_000 } } } });
  const tok = s.tokenFor('w1');
  assert.equal((await s.req(tok, 'GET', '/x')).status, 200);
  s.state.grants = { defaults: { api: { preset: 'write', expiresAt: Date.now() - 1 } } };
  assert.equal((await s.req(tok, 'GET', '/x')).status, 403);
});

test('REVOKING THE CAPABILITY still ends everything (the original guarantee holds beside the grants)', async (t) => {
  const s = await setup(t, { grants: { defaults: { api: { preset: 'write' } } } });
  const tok = s.tokenFor('w1');
  assert.equal((await s.req(tok, 'GET', '/x')).status, 200);
  s.broker.revoke('w1');
  assert.equal((await s.req(tok, 'GET', '/x')).status, 401);
});

test('a capability that does not list the integration is refused before any grant is looked at', async (t) => {
  const s = await setup(t, { grants: { defaults: { api: { preset: 'write' } } } });
  const tok = s.tokenFor('w1', ['something-else']);
  assert.equal((await s.req(tok, 'GET', '/x')).status, 403);
  assert.equal(s.events.length, 0, 'it never got as far as a decision');
});

test('A METHOD-OVERRIDE HEADER cannot turn a permitted request into a forbidden one', async (t) => {
  const s = await setup(t, { grants: { defaults: { api: { preset: 'write' } } } });
  const tok = s.tokenFor('w1');
  const r = await s.req(tok, 'POST', '/things/1', {
    body: '{}', headers: { 'x-http-method-override': 'DELETE', 'X-Method-Override': 'DELETE', 'x-http-method': 'DELETE', 'content-type': 'application/json' }
  });
  assert.equal(r.status, 200);
  const sent = s.up.last();
  assert.equal(sent.method, 'POST');
  for (const h of ['x-http-method-override', 'x-method-override', 'x-http-method']) assert.equal(h in sent.headers, false, `${h} reached the upstream`);
});

test('GRAPHQL: a query is a read, a mutation is a write, judged by the document itself', async (t) => {
  const s = await setup(t, { grants: { defaults: { api: { preset: 'read' } } }, integration: { baseUrl: undefined } });
  s.rec.baseUrl = `${s.up.base}/graphql`;
  const tok = s.tokenFor('w1');
  const json = { 'content-type': 'application/json' };
  const q = await s.req(tok, 'POST', '', { body: JSON.stringify({ query: '{ viewer { id } }' }), headers: json });
  assert.equal(q.status, 200, 'a plain query goes through a read grant');
  const m = await s.req(tok, 'POST', '', { body: JSON.stringify({ query: 'mutation { issueDelete(id: "1") { success } }' }), headers: json });
  assert.equal(m.status, 403, 'a mutation does not');
  s.state.grants = { defaults: { api: { preset: 'write' } } };
  const m2 = await s.req(tok, 'POST', '', { body: JSON.stringify({ query: 'mutation { x }' }), headers: json });
  assert.equal(m2.status, 200, 'but a write grant lets it through');
  assert.equal(s.up.seen.length, 2);
  assert.equal(JSON.parse(s.up.seen[0].body.toString()).query, '{ viewer { id } }', 'and the body arrived intact');
});

test('AUDIT: every decision is recorded with method and path only: no query, no body, no header, no credential', async (t) => {
  const s = await setup(t, { grants: { defaults: { api: { preset: 'read' } } } });
  const tok = s.tokenFor('w1');
  await s.req(tok, 'GET', `/files/${'A'.repeat(40)}?access_token=QUERY-CANARY-123456`);
  await s.req(tok, 'POST', '/things', { body: JSON.stringify({ note: 'BODY-CANARY-654321' }), headers: { 'content-type': 'application/json', 'x-canary': 'HEADER-CANARY-777' } });
  assert.deepEqual(s.events.map((e) => [e.decision, e.method, e.path]), [['allow', 'GET', '/files/…'], ['deny', 'POST', '/things']]);
  const text = JSON.stringify(s.events);
  for (const c of ['QUERY-CANARY-123456', 'BODY-CANARY-654321', 'HEADER-CANARY-777', SECRET, 'access_token']) assert.equal(text.includes(c), false, `${c} leaked into the audit events`);
  for (const e of s.events) assert.deepEqual(Object.keys(e).sort(), ['agentId', 'at', 'decision', 'integrationId', 'method', 'path', 'reason']);
});

test('the credential never reaches the worker, whatever the grant', async (t) => {
  const s = await setup(t, { grants: { defaults: { api: { preset: 'write' } } } });
  const tok = s.tokenFor('w1');
  const r = await s.req(tok, 'GET', '/x');
  assert.equal(r.body.toString().includes(SECRET), false);
  assert.equal(JSON.stringify(r.headers).includes(SECRET), false);
  const denied = await s.req(tok, 'DELETE', '/x');
  assert.equal(denied.body.toString().includes(SECRET), false);
  assert.ok(json(denied).error, 'a refusal is an ordinary JSON error');
});

test('a disabled integration is refused whatever the grant', async (t) => {
  const s = await setup(t, { grants: { defaults: { api: { preset: 'write' } } } });
  const tok = s.tokenFor('w1');
  s.rec.enabled = false;
  assert.equal((await s.req(tok, 'GET', '/x')).status, 403);
  assert.equal(s.up.seen.length, 0);
});
