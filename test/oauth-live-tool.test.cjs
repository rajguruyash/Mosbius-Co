'use strict';

/**
 * tools/verify-oauth-live.cjs is what the owner will run against real accounts, so
 * its own logic is tested here against stand-ins: that it reports honestly, makes
 * only the calls it says it makes, and never prints a secret. (It has NOT been run
 * against Google or Slack from this suite; that is its whole purpose.)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { startIdp } = require('./fixtures/oauth-idp.cjs');
const { makeEnv } = require('./fixtures/oauth-env.cjs');
const { checkMetadata, liveCheck, parseArgs } = require('../tools/verify-oauth-live.cjs');
const loadTs = require('./load-ts.cjs');
const { MCP_CATALOG, mcpCatalogEntry, mcpOauthRef } = loadTs('src/shared/mcpCatalog.ts');
const { disconnectBridged } = loadTs('src/main/mcpDisconnect.ts');
const { McpAuthVault } = loadTs('src/main/mcpAuthVault.ts');

// ─── endpoint drift ─────────────────────────────────────────────────────────

const GOOGLE = {
  issuer: 'https://accounts.google.com', authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  token_endpoint: 'https://oauth2.googleapis.com/token', revocation_endpoint: 'https://oauth2.googleapis.com/revoke',
  code_challenge_methods_supported: ['plain', 'S256'], token_endpoint_auth_methods_supported: ['client_secret_post'],
  grant_types_supported: ['authorization_code', 'refresh_token'], authorization_response_iss_parameter_supported: true
};
const SLACK = {
  issuer: 'https://mcp.slack.com', authorization_endpoint: 'https://slack.com/oauth/v2_user/authorize',
  token_endpoint: 'https://slack.com/api/oauth.v2.user.access', code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['client_secret_post'], grant_types_supported: ['authorization_code', 'refresh_token']
};
const fakeFetch = (docs) => async (url) => {
  const base = url.replace(/\/\.well-known\/.*$/, '');
  const doc = docs[base];
  return doc ? { status: 200, json: async () => doc } : { status: 404, json: async () => ({}) };
};
const failed = (rows) => rows.filter((r) => !r.ok).map((r) => r.check);

test('drift check: what the catalogue pins matches what is published', async () => {
  const rows = await checkMetadata({ fetchFn: fakeFetch({ 'https://accounts.google.com': GOOGLE, 'https://mcp.slack.com': SLACK }), catalogue: MCP_CATALOG });
  assert.deepEqual(failed(rows), []);
  assert.ok(rows.length >= 18);
});

test('drift check: every kind of difference is caught', async () => {
  const run = (google, slack = SLACK) => checkMetadata({ fetchFn: fakeFetch({ 'https://accounts.google.com': google, 'https://mcp.slack.com': slack }), catalogue: MCP_CATALOG });
  assert.ok(failed(await run({ ...GOOGLE, token_endpoint: 'https://evil.example/token' })).some((c) => /token endpoint/.test(c)));
  assert.ok(failed(await run({ ...GOOGLE, authorization_endpoint: 'https://accounts.google.com/new' })).some((c) => /authorization endpoint/.test(c)));
  assert.ok(failed(await run({ ...GOOGLE, code_challenge_methods_supported: ['plain'] })).some((c) => /S256/.test(c)));
  assert.ok(failed(await run({ ...GOOGLE, token_endpoint_auth_methods_supported: ['private_key_jwt'] })).some((c) => /client_secret_post/.test(c)));
  assert.ok(failed(await run({ ...GOOGLE, authorization_response_iss_parameter_supported: false })).some((c) => /iss policy/.test(c)), 'the catalogue requires iss; the provider no longer promises it');
  assert.ok(failed(await run({ ...GOOGLE, revocation_endpoint: 'https://elsewhere.example/revoke' })).some((c) => /revocation/.test(c)));
  assert.ok(failed(await run({ ...GOOGLE, issuer: 'https://other.example' })).some((c) => /issuer/.test(c)));
  assert.ok(failed(await run(GOOGLE, { ...SLACK, grant_types_supported: ['authorization_code'] })).some((c) => /refresh_token grant/.test(c)));
});

test('drift check: an unreachable provider is a failure, not a silent pass', async () => {
  const rows = await checkMetadata({ fetchFn: async () => { throw new Error('offline'); }, catalogue: MCP_CATALOG });
  assert.ok(failed(rows).length >= 2);
  assert.ok(rows.every((r) => !r.ok));
});

test('arguments are parsed without surprises', () => {
  const a = parseArgs(['gmail', '--refresh', '--call', 'search', '--args', '{"q":"x"}', '--user-data', '/tmp/d', '--disconnect']);
  assert.deepEqual(a.positional, ['gmail']);
  assert.equal(a.flags.has('refresh'), true);
  assert.equal(a.flags.has('disconnect'), true);
  assert.deepEqual(a.values, { call: 'search', args: '{"q":"x"}', 'user-data': '/tmp/d' });
});

// ─── the live check itself, on a stand-in ───────────────────────────────────

async function rig(t, idpOpts) {
  const idp = await startIdp(t, idpOpts);
  const env = await makeEnv(t, idp);
  const real = mcpCatalogEntry('gmail');
  const entry = { ...real, spec: { ...real.spec, url: `${idp.issuer}/mcp` } };
  const lines = [];
  const run = (over = {}) => liveCheck({
    controller: env.controller, entry, fetchFn: (u, i) => fetch(u, i), log: (l) => lines.push(l),
    disconnect: () => disconnectBridged({
      cancelSignIn: (x) => env.controller.cancel(x),
      vault: new McpAuthVault(() => require('node:path').join(require('node:os').tmpdir(), `md-live-${process.pid}`), { get: env.secrets.get, set: env.secrets.set, delete: (r) => env.secrets.delete(r) }),
      revoke: async () => ({ attempted: 0, confirmed: 0 }),
      secrets: { delete: (r) => env.secrets.delete(r), has: (r) => env.secrets.has(r) },
      broker: { hasTokens: (x) => env.controller.hasTokens(x), revoke: (x) => env.controller.revoke(x), forget: (x) => env.controller.forget(x) }
    }, mcpCatalogEntry('gmail')),
    ...over
  });
  return { idp, env, lines, run };
}
const ok = (steps) => steps.every((s) => s.ok);

test('live check: sign-in, token accepted, a read-only call — and ONLY what it says it did', async (t) => {
  const { idp, env, run } = await rig(t);
  const steps = await run();
  assert.equal(ok(steps), true, JSON.stringify(steps.filter((s) => !s.ok)));
  const names = steps.map((s) => s.step);
  assert.ok(names.some((n) => /real sign-in in the browser/.test(n)));
  assert.ok(names.some((n) => /read-only MCP call succeeds \(tools\/list\)/.test(n)));
  assert.equal(names.some((n) => /refresh works|disconnect/.test(n)), false, 'it did not refresh or disconnect unasked');
  assert.deepEqual([...new Set(idp.requests('/mcp').map((r) => JSON.parse(r.rawBody).method))].sort(), ['initialize', 'tools/list'], 'no tool was called');
  assert.equal(idp.requests('/revoke').length, 0);
  assert.equal(env.controller.status('gmail'), 'connected');
});

test('live check: --refresh forces one real refresh and says whether the provider rotated', async (t) => {
  const { idp, run } = await rig(t, { rotate: true });
  const steps = await run({ doRefresh: true });
  assert.equal(ok(steps), true, JSON.stringify(steps.filter((s) => !s.ok)));
  assert.equal(idp.tokenRequests('refresh_token').length, 1);
  assert.match(steps.find((s) => /rotation observed/.test(s.step)).detail, /ROTATED/);
});

test('live check: --call makes exactly the one tool call it was told to', async (t) => {
  const { idp, run } = await rig(t);
  const steps = await run({ call: { tool: 'search', args: { q: 'hello' } } });
  assert.equal(ok(steps), true);
  const calls = idp.requests('/mcp').map((r) => JSON.parse(r.rawBody)).filter((b) => b.method === 'tools/call');
  assert.deepEqual(calls.map((c) => c.params), [{ name: 'search', arguments: { q: 'hello' } }]);
});

test('live check: --disconnect revokes, wipes, and proves the engine then refuses to produce a credential', async (t) => {
  const { idp, env, run } = await rig(t);
  const steps = await run({ doDisconnect: true });
  assert.equal(ok(steps), true, JSON.stringify(steps.filter((s) => !s.ok)));
  assert.match(steps.find((s) => /disconnect$/.test(s.step)).detail, /revoked at the provider and wiped/);
  assert.equal(idp.liveAccessTokens().length, 0);
  assert.equal(env.secrets.map.has(mcpOauthRef('gmail')), false);
});

test('live check: a server that rejects the token is a FAILED step, and the token is marked rejected', async (t) => {
  const { idp, run } = await rig(t);
  idp.inject('mcp', { status: 401, body: { error: 'invalid_token' } });
  const steps = await run();
  assert.equal(steps.find((s) => /accepts the token/.test(s.step)).ok, false);
  assert.equal(ok(steps), false, 'nothing is called verified when a step failed');
});

test('live check: tools with no annotations are flagged, because the permission model would treat them as destructive', async (t) => {
  const { idp, run } = await rig(t);
  idp.inject('mcp', { status: 200, body: { jsonrpc: '2.0', id: 1, result: { ok: true } } });
  idp.inject('mcp', { status: 200, body: { jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'mystery' }, { name: 'ok', annotations: { readOnlyHint: true } }] } } });
  const steps = await run();
  const flagged = steps.find((s) => /carry annotations/.test(s.step));
  assert.equal(flagged.ok, false);
  assert.match(flagged.detail, /1 without hints/);
});

test('live check: it stops, honestly, when there is no OAuth client or the sign-in fails', async (t) => {
  const idp = await startIdp(t);
  const env = await makeEnv(t, idp);
  env.secrets.map.delete('mcp:gmail:client_secret');
  const real = mcpCatalogEntry('gmail');
  const steps = await liveCheck({ controller: env.controller, entry: { ...real, spec: { ...real.spec, url: `${idp.issuer}/mcp` } }, fetchFn: fetch, disconnect: async () => ({ ok: true }) });
  assert.equal(steps.length, 1);
  assert.equal(steps[0].ok, false);
  assert.equal(idp.log.length, 0, 'nothing was sent anywhere');

  env.secrets.map.set('mcp:gmail:client_secret', 'wrong-secret');
  const steps2 = await liveCheck({ controller: env.controller, entry: { ...real, spec: { ...real.spec, url: `${idp.issuer}/mcp` } }, fetchFn: fetch, disconnect: async () => ({ ok: true }) });
  assert.equal(steps2.find((s) => /real sign-in/.test(s.step)).ok, false);
  assert.equal(steps2.length, 2, 'it did not go on to call a server it has no token for');
  await Promise.all(env.pendingBrowse);
});

test('live check: nothing it prints is a secret', async (t) => {
  const { idp, env, lines, run } = await rig(t);
  const steps = await run({ doRefresh: true, doDisconnect: true, call: { tool: 'search', args: {} } });
  const text = [...lines, ...steps.map((s) => `${s.step} ${s.detail}`)].join('\n');
  const secrets = [...idp.access.keys(), ...idp.grants.keys(), 'SECRET-gmail-DO-NOT-LEAK', idp.tokenRequests()[0].form.code, idp.tokenRequests()[0].form.code_verifier];
  for (const s of secrets) assert.equal(text.includes(s), false, `the report contains ${s.slice(0, 8)}…`);
  assert.equal(/Bearer /.test(text), false);
  void env;
});
