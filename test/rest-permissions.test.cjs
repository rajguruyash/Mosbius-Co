'use strict';

/**
 * F3 — the REST permission model, as pure functions.
 *
 * It must behave exactly like the MCP one: no grant is no access, a preset reaches only what
 * its name says, a destructive request is reachable only by being named, `deny` always wins,
 * and everything unclear fails closed. Classification is by the request itself (method, path,
 * and for GraphQL the document), never by anything the caller says about it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const R = loadTs('src/main/broker/rest-permissions.ts');
const P = loadTs('src/main/broker/permissions.ts');

const body = (o) => Buffer.from(JSON.stringify(o));
const g = (preset, extra = {}) => ({ preset, ...extra });

test('classification by method', () => {
  for (const m of ['GET', 'get', 'HEAD', 'OPTIONS']) assert.equal(R.classifyRestRequest(m, '/x'), 'read', m);
  for (const m of ['POST', 'PUT', 'PATCH', 'post']) assert.equal(R.classifyRestRequest(m, '/x'), 'write', m);
  assert.equal(R.classifyRestRequest('DELETE', '/x'), 'destructive');
  for (const m of ['TRACE', 'CONNECT', 'PURGE', 'LINK', 'MKCOL', 'PROPFIND', '']) {
    assert.equal(R.classifyRestRequest(m, '/x'), 'destructive', `${m || '(empty)'} is a method the broker has no word for`);
  }
});

test('GraphQL: a POST to /graphql is a read only when every document is a plain query', () => {
  const q = (query) => R.classifyRestRequest('POST', '/graphql', body({ query }));
  assert.equal(q('{ viewer { id } }'), 'read');
  assert.equal(q('query Me { viewer { id name } }'), 'read');
  assert.equal(q('  query($id: ID!) { issue(id: $id) { title } }'), 'read');
  assert.equal(q('query A { a } fragment F on T { b }'), 'read');
  assert.equal(q('mutation { issueDelete(id: "1") { success } }'), 'write');
  assert.equal(q('MUTATION { x }'), 'write', 'keywords are case-insensitive for our purposes');
  assert.equal(q('subscription { changed }'), 'write');
  assert.equal(q('query A { a } mutation B { b }'), 'write', 'one mutation makes the whole document a write');
  assert.equal(q('query { a(note: "this is not a mutation") }'), 'read', 'a keyword inside a string is just text');
  assert.equal(q('query { a } # mutation { b }'), 'read', 'or inside a comment');
  assert.equal(q('query { a(x: """mutation""") }'), 'read');
  assert.equal(q('query { mutationLog { id } }'), 'read', 'a field whose name merely contains the word');
  assert.equal(q('DROP TABLE users'), 'write', 'something that is not a document is never a read');
  assert.equal(q(''), 'write');
  assert.equal(q(undefined), 'write');
  assert.equal(R.classifyRestRequest('POST', '/graphql', Buffer.from('not json')), 'write');
  assert.equal(R.classifyRestRequest('POST', '/graphql', undefined), 'write');
  assert.equal(R.classifyRestRequest('POST', '/graphql', body([{ query: '{ a }' }, { query: 'mutation { b }' }])), 'write', 'a batch is only as safe as its worst entry');
  assert.equal(R.classifyRestRequest('POST', '/graphql', body([{ query: '{ a }' }, { query: '{ b }' }])), 'read');
  assert.equal(R.classifyRestRequest('POST', '/graphql', body([])), 'write');
  assert.equal(R.classifyRestRequest('POST', '/v1/graphql/', body({ query: '{ a }' })), 'read', 'a trailing slash does not change what it is');
  assert.equal(R.classifyRestRequest('POST', '/not-graphql-at-all', body({ query: '{ a }' })), 'write', 'only a /graphql path gets the query exemption');
  assert.equal(R.classifyRestRequest('PUT', '/graphql', body({ query: '{ a }' })), 'write');
  // Linear-style: /graphql is in the BASE url, so the path relative to the base is just '/'
  assert.equal(R.classifyRestRequest('POST', '/', body({ query: '{ viewer { id } }' }), '/graphql'), 'read');
  assert.equal(R.classifyRestRequest('POST', '/', body({ query: 'mutation { x }' }), '/graphql'), 'write');
  assert.equal(R.classifyRestRequest('POST', '/', body({ query: '{ viewer { id } }' }), '/v1/other'), 'write');
});

test('relative path: taken from the integration\'s own base, no query, no double slashes', () => {
  const rel = (base, u) => R.relativeRestPath(base, new URL(u));
  assert.equal(rel('https://api.github.com', 'https://api.github.com/repos/a/b?per_page=5'), '/repos/a/b');
  assert.equal(rel('https://x.atlassian.net/rest/api/3', 'https://x.atlassian.net/rest/api/3/issue/ABC-1'), '/issue/ABC-1');
  assert.equal(rel('https://x.atlassian.net/rest/api/3/', 'https://x.atlassian.net/rest/api/3'), '/');
  assert.equal(rel('https://api.linear.app/graphql', 'https://api.linear.app/graphql'), '/');
  assert.equal(rel('https://h.example', 'https://h.example//a///b'), '/a/b');
});

test('patterns: exact, method wildcard, prefix', () => {
  const m = R.restPatternMatches;
  assert.equal(m('GET /repos/a/b', 'GET', '/repos/a/b'), true);
  assert.equal(m('GET /repos/a/b', 'get', '/repos/a/b/'), true);
  assert.equal(m('GET /repos/a/b', 'POST', '/repos/a/b'), false);
  assert.equal(m('GET /repos/a/b', 'GET', '/repos/a/bc'), false, 'exact means exact');
  assert.equal(m('* /search/*', 'POST', '/search/code'), true);
  assert.equal(m('GET /repos/*', 'GET', '/repos'), true);
  assert.equal(m('GET /repos/*', 'GET', '/repos/a/b/c'), true);
  assert.equal(m('GET /repos/*', 'GET', '/reposX'), false);
  assert.equal(m('DELETE /*', 'DELETE', '/anything/at/all'), true);
  assert.equal(m('DELETE /*', 'GET', '/anything'), false);
  for (const bad of ['', 'GET', '/repos', 'GET repos', 'GET  ', '* ', 'FOO BAR BAZ']) assert.equal(m(bad, 'GET', '/repos'), false, JSON.stringify(bad));
});

test('presets: none reaches nothing, read reads, write reads and writes, neither reaches a destructive request', () => {
  const ok = (grant, method, path, b) => R.restRequestAllowed(grant, method, path, b).allow;
  for (const [m, p] of [['GET', '/x'], ['POST', '/x'], ['DELETE', '/x'], ['TRACE', '/x']]) assert.equal(ok(g('none'), m, p), false);
  assert.equal(ok(g('read'), 'GET', '/x'), true);
  assert.equal(ok(g('read'), 'POST', '/x'), false);
  assert.equal(ok(g('read'), 'DELETE', '/x'), false);
  assert.equal(ok(g('write'), 'GET', '/x'), true);
  for (const m of ['POST', 'PUT', 'PATCH']) assert.equal(ok(g('write'), m, '/x'), true, m);
  assert.equal(ok(g('write'), 'DELETE', '/x'), false, 'a preset never reaches a DELETE');
  assert.equal(ok(g('write'), 'PURGE', '/x'), false, 'nor a method it does not know');
  assert.equal(ok(g('custom'), 'GET', '/x'), false, 'custom is exactly its allow list');
});

test('allow names a request, deny beats everything, and a destructive request is reachable only by name', () => {
  const ok = (grant, method, path) => R.restRequestAllowed(grant, method, path).allow;
  const w = g('write', { allow: ['DELETE /things/1'] });
  assert.equal(ok(w, 'DELETE', '/things/1'), true, 'named, so reachable');
  assert.equal(ok(w, 'DELETE', '/things/2'), false, 'only that one');
  assert.equal(ok(g('read', { allow: ['POST /search'] }), 'POST', '/search'), true, 'a read grant can name one write');
  assert.equal(ok(g('write', { deny: ['POST /admin/*'] }), 'POST', '/admin/users'), false);
  assert.equal(ok(g('write', { deny: ['POST /admin/*'] }), 'POST', '/things'), true);
  assert.equal(ok(g('write', { allow: ['POST /admin/x'], deny: ['* /admin/*'] }), 'POST', '/admin/x'), false, 'deny wins over allow');
  assert.equal(ok(g('custom', { allow: ['GET /a', 'POST /b'] }), 'GET', '/a'), true);
  assert.equal(ok(g('custom', { allow: ['GET /a', 'POST /b'] }), 'GET', '/b'), false);
});

test('GraphQL goes through the same grants: read grant reaches a query and not a mutation', () => {
  const q = body({ query: '{ viewer { id } }' });
  const m = body({ query: 'mutation { x }' });
  assert.equal(R.restRequestAllowed(g('read'), 'POST', '/', undefined).allow, false);
  assert.equal(R.restRequestAllowed(g('read'), 'POST', '/graphql', q).allow, true);
  assert.equal(R.restRequestAllowed(g('read'), 'POST', '/graphql', m).allow, false);
  assert.equal(R.restRequestAllowed(g('write'), 'POST', '/graphql', m).allow, true);
});

test('the verdict says why, with a class and the name it goes by', () => {
  const v = R.restRequestAllowed(g('read'), 'DELETE', '/repos/a');
  assert.deepEqual([v.allow, v.cls, v.name], [false, 'destructive', 'DELETE /repos/a']);
  assert.match(v.reason, /destructive|more than read/);
});

test('a grant that has expired is no grant (same rule as MCP, through effectiveGrant)', () => {
  const grants = { defaults: { api: { preset: 'write', expiresAt: 1000 } } };
  assert.equal(P.effectiveGrant(grants, 'a', 'api', 999).preset, 'write');
  assert.equal(P.effectiveGrant(grants, 'a', 'api', 1000).preset, 'none');
});

test('audit path: no query, opaque ids replaced, bounded', () => {
  assert.equal(R.auditablePath('/repos/a/b/issues'), '/repos/a/b/issues');
  assert.equal(R.auditablePath('/files/' + 'A'.repeat(40)), '/files/…');
  assert.equal(R.auditablePath('/v1/tokens/ghp_' + 'x'.repeat(36)), '/v1/tokens/…');
  assert.ok(R.auditablePath('/' + 'seg/'.repeat(100)).length <= 120);
});

test('method-override headers are named so the route can strip them', () => {
  assert.deepEqual([...R.METHOD_OVERRIDE_HEADERS].sort(), ['x-http-method', 'x-http-method-override', 'x-method-override']);
});
