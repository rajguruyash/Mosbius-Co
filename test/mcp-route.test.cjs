'use strict';

/**
 * The MCP route foundation, end to end against a stand-in MCP server.
 *
 * Nothing registers this route in the app, and no OAuth provider exists yet, so
 * these tests build the broker the way a later phase will: with `extras.mcp`, a
 * stand-in upstream, and a static credential. What they pin is the security
 * posture the route must have BEFORE anything is allowed to use it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const loadTs = require('./load-ts.cjs');
const { startMcpUpstream, startUpstream, call, open, until, json, bearer, rpc } = require('./fixtures/broker-helpers.cjs');

const { IntegrationBroker } = loadTs('src/main/integrationBroker.ts');

const UP_TOKEN = 'UPSTREAM-TOKEN';
const INIT = rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } }, 1);
const CLASSES = { get_thing: 'read', put_thing: 'write', send_thing: 'destructive' };

async function setup(t, { grants, integ = {}, limits, creds } = {}) {
  const up = await startMcpUpstream(t);
  const events = [];
  const state = {
    grants: grants === undefined ? { defaults: { gmail: { preset: 'read' } } } : grants,
    creds: creds ?? { ok: true, headers: { authorization: `Bearer ${UP_TOKEN}` } }
  };
  const integrations = new Map([['gmail', { id: 'gmail', url: `${up.base}/mcp`, enabled: true, classification: { toolClasses: CLASSES }, ...integ }]]);
  const broker = new IntegrationBroker({ getRecord: () => undefined, getSecret: () => undefined }, {
    mcp: { resolve: (id) => integrations.get(id), credentials: { accessHeaders: () => state.creds }, grants: () => state.grants, audit: (e) => events.push(e), limits }
  });
  const { port } = await broker.start();
  t.after(() => broker.stop());
  const token = broker.grantMcp('agent-A', ['gmail']);
  const headersFor = (tok, extra = {}) => ({ ...bearer(tok), 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...extra });
  const post = (body, extra = {}, tok = token) => call(port, { method: 'POST', path: '/m/gmail', headers: headersFor(tok, extra), body });
  const names = async (extra = {}) => {
    const r = await post(rpc('tools/list', undefined, 9), extra);
    return json(r).result.tools.map((x) => x.name).sort();
  };
  return { up, events, state, integrations, broker, port, token, post, names, headersFor };
}

async function initialize(ctx, tok = ctx.token) {
  const r = await ctx.post(INIT, {}, tok);
  assert.equal(r.status, 200);
  return r.headers['mcp-session-id'];
}

// ─── not enabled in the app ─────────────────────────────────────────────────

test('security: as the app builds the broker today there is no /m route at all', async (t) => {
  const broker = new IntegrationBroker({ getRecord: () => undefined, getSecret: () => undefined });
  const { port } = await broker.start();
  t.after(() => broker.stop());
  const mcp = broker.grantMcp('agent', ['gmail']);
  const rest = broker.grant('agent', ['gmail']);
  for (const tok of [mcp, rest]) {
    const res = await call(port, { method: 'POST', path: '/m/gmail', headers: { ...bearer(tok), 'content-type': 'application/json' }, body: INIT });
    assert.equal(res.status, 404);
    assert.deepEqual(json(res), { error: 'expected /i/<integrationId>/<path>', code: 'not_found' });
  }
  assert.equal((await call(port, { method: 'POST', path: '/m/gmail', body: INIT })).status, 401, 'and without a token it is 401 like any other path');
});

test('security: none of the four OAuth integrations is registered or enabled by default', () => {
  const { MCP_CATALOG } = loadTs('src/shared/mcpCatalog.ts');
  const oauth = MCP_CATALOG.filter((e) => e.tier === 'oauth-bridge');
  assert.deepEqual(oauth.map((e) => e.id).sort(), ['gmail', 'google-calendar', 'google-drive', 'slack']);
  for (const e of oauth) assert.equal(e.defaultEnabled, false, e.id);
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src/main/index.ts'), 'utf8');
  // Phase 3 registers the route and mints capabilities, so what is pinned is HOW narrowly it does so.
  const flat = src.replace(/\s+/g, ' ');
  // the route's credential comes from the one composite provider (OAuth engine, a broker-added header for
  // hosted GitHub, or nothing for an app-run server), and local servers run through the host the app owns
  assert.match(flat, /mcp: \{ resolve: \(id\) => mcpIntegrationFor\(id, brokerConfig\(\)\), [^}]*credentials: createMcpCredentialProvider\(\{ entry: mcpCatalogEntry, token: \(id\) => integrations\.getSecret\(`mcp:\$\{id\}`\), oauth: \{ accessHeaders: \(subject\) => oauthController\.provider\.accessHeaders\(subject\)/);
  assert.match(flat, /hosted: \{ handle: \(integrationId, agentId, body, signal\) => stdioHost\.handle\(integrationId, agentId, body, signal\), close: \(agentId, integrationId\) => stdioHost\.close\(agentId, integrationId\) \}/);
  // exactly one place mints an MCP capability, and only for an agent of one of the THREE CLIs the app wires
  // (Claude Code, Codex, Gemini: each has its own way of being handed it, see the *-broker-wiring tests) with eligible integrations
  assert.equal([...src.matchAll(/grantMcp/g)].length, 1, 'one mint site');
  assert.match(src, /const claudeProvider = isClaudeProvider\(provider\);\s*const codexProvider = provider === 'codex';\s*const geminiProvider = provider === 'gemini';/, 'the three flags mean exactly those three CLIs');
  assert.match(src, /if \(opts\.hive && hive\.enabled\(\) && \(claudeProvider \|\| codexProvider \|\| geminiProvider\) && integrationBroker\.running\(\)\) \{\s*try \{\s*mcpIds = eligibleIntegrationIds\(readConfig\(\), opts\.hive\.id, mcpStatusOf, Date\.now\(\)\);\s*if \(mcpIds\.length > 0\) \{\s*agentCwds\.set\(opts\.hive\.id, opts\.cwd\);[^\n]*\n\s*mcpToken = integrationBroker\.grantMcp\(opts\.hive\.id, mcpIds\);/);
  // Disconnect must cut agent access at once, and so must turning an integration off, back to the bridge, or forgetting its credential
  assert.match(src, /function onMcpDisconnected\(bid: string\): void \{\s*integrationBroker\.revokeIntegration\(bid\);/);
  assert.match(src, /onDisconnected: onMcpDisconnected/);
  assert.match(src, /for \(const id of noLongerServed\(exposure, next\)\) \{\s*try \{ integrationBroker\.revokeIntegration\(id\); \}/, 'switched off in the config');
  assert.match(src, /integrationBroker\.revokeIntegration\(entry\.id\);\s*integrationBroker\.forgetMcpTools\(entry\.id\);\s*\}\s*try \{ setMcpEngineFor/, 'switched back to the bridge');
  assert.match(src, /if \(removed\.ok\) \{ integrationBroker\.revokeIntegration\(entry\.id\); stdioHost\.closeIntegration\(entry\.id\); \}/, 'its credential forgotten');
  // and the route never has a way to hand an agent a credential: nothing in the config an agent reads comes from the vault
  assert.equal(/\bmcpSecret\b/.test(src), false, 'the hive is no longer handed a way to read credentials');
});

// ─── before authentication ──────────────────────────────────────────────────

test('security: methods, browsers and foreign hosts are turned away before any token is even looked at', async (t) => {
  const { port, up } = await setup(t);
  const base = { path: '/m/gmail', headers: { 'content-type': 'application/json' } };
  assert.equal((await call(port, { ...base, method: 'PUT', body: INIT })).status, 405);
  assert.equal((await call(port, { ...base, method: 'OPTIONS' })).status, 405);
  assert.equal((await call(port, { ...base, method: 'HEAD' })).status, 405);
  assert.equal((await call(port, { ...base, method: 'POST', body: INIT, headers: { ...base.headers, origin: 'https://evil.example' } })).status, 403);
  assert.equal((await call(port, { ...base, method: 'POST', body: INIT, headers: { ...base.headers, 'sec-fetch-site': 'cross-site' } })).status, 403);
  // Node's built-in fetch (which the real Gemini CLI uses) sends `Sec-Fetch-Mode: cors` and nothing else of the Fetch
  // Metadata set: a program, not a page. It must be allowed to go on and authenticate (and here it has no pass: 401).
  assert.equal((await call(port, { ...base, method: 'POST', body: INIT, headers: { ...base.headers, 'sec-fetch-mode': 'cors' } })).status, 401);
  // A page's request always carries Sec-Fetch-Site (and -Dest, and -User for a navigation) with the mode, or an Origin;
  // any other mode is a page too.
  for (const extra of [
    { 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-origin' }, { 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'none' },
    { 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' }, { 'sec-fetch-mode': 'cors', 'sec-fetch-user': '?1' },
    { 'sec-fetch-mode': 'cors', origin: 'http://127.0.0.1' }, { 'sec-fetch-mode': 'cors', origin: 'null' },
    { 'sec-fetch-mode': 'navigate' }, { 'sec-fetch-mode': 'no-cors' }, { 'sec-fetch-mode': 'websocket' }, { 'sec-fetch-mode': 'same-origin' },
    { 'sec-fetch-dest': 'document' }, { 'sec-fetch-user': '?1' }
  ]) {
    assert.equal((await call(port, { ...base, method: 'POST', body: INIT, headers: { ...base.headers, ...extra } })).status, 403, JSON.stringify(extra));
  }
  for (const host of ['evil.example', `localhost:${port}`, `127.0.0.1:${port + 1}`, '127.0.0.1', `evil.example:${port}`]) {
    const res = await call(port, { ...base, method: 'POST', body: INIT, host });
    assert.equal(res.status, 421, host);
  }
  assert.equal((await call(port, { ...base, method: 'POST', body: INIT })).status, 401, 'a clean request still has to authenticate');
  assert.equal(up.seen.length, 0);
});

test('a client built on Node\'s own fetch (the real Gemini CLI is one) is not mistaken for a browser: it initializes and lists tools', async (t) => {
  // global fetch adds `Sec-Fetch-Mode: cors` by itself: this is the request the first version of the guard refused
  const { port, token } = await setup(t);
  const url = `http://127.0.0.1:${port}/m/gmail`;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  const init = await fetch(url, { method: 'POST', headers, body: INIT });
  assert.equal(init.status, 200);
  const sid = init.headers.get('mcp-session-id');
  const list = await fetch(url, { method: 'POST', headers: { ...headers, ...(sid ? { 'mcp-session-id': sid } : {}) }, body: rpc('tools/list', undefined, 2) });
  assert.equal(list.status, 200);
  assert.ok((await list.json()).result.tools.length > 0);
  // and the same client with no pass is still refused as before
  assert.equal((await fetch(url, { method: 'POST', headers: { ...headers, authorization: 'Bearer wrong' }, body: INIT })).status, 401);
});

test('looksLikeBrowser: only the lone Sec-Fetch-Mode: cors of a program passes; a page is recognised by what it cannot leave out', () => {
  const { looksLikeBrowser } = loadTs('src/main/broker/mcp-route.ts');
  assert.equal(looksLikeBrowser({}), false);
  assert.equal(looksLikeBrowser({ 'sec-fetch-mode': 'cors' }), false);
  assert.equal(looksLikeBrowser({ 'user-agent': 'node', accept: '*/*', 'sec-fetch-mode': 'cors' }), false);
  for (const h of [
    { origin: 'https://a.example' }, { origin: 'null' }, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-dest': 'empty' }, { 'sec-fetch-user': '?1' },
    { 'sec-fetch-mode': 'navigate' }, { 'sec-fetch-mode': 'no-cors' }, { 'sec-fetch-mode': 'cors, cors' }, { 'sec-fetch-mode': 'CORS' },
    { 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-site' }
  ]) assert.equal(looksLikeBrowser(h), true, JSON.stringify(h));
});

test('security: no CORS header is ever sent, so a web page cannot read a response', async (t) => {
  const { post, port } = await setup(t);
  for (const res of [await post(INIT), await call(port, { method: 'POST', path: '/m/gmail', body: INIT }), await post('{bad')]) {
    for (const h of Object.keys(res.headers)) assert.equal(h.startsWith('access-control-'), false, h);
  }
});

test('security: a token of the wrong channel is refused exactly like a bad one', async (t) => {
  const ctx = await setup(t);
  const restToken = ctx.broker.grant('agent-A', ['gmail']);
  const bad = await ctx.post(INIT, {}, 'not-a-token');
  const wrong = await ctx.post(INIT, {}, restToken);
  assert.equal(wrong.status, 401);
  assert.deepEqual(json(wrong), json(bad));
  const onRest = await call(ctx.port, { path: '/i/gmail/x', headers: bearer(ctx.token) });
  assert.equal(onRest.status, 401, 'and the MCP token is no good on the REST route');
  assert.equal(ctx.up.seen.length, 0);
});

// ─── authorization ──────────────────────────────────────────────────────────

test('security: least privilege — no grant, an agent-level none, or an expired grant all mean 403 and nothing upstream', async (t) => {
  const ctx = await setup(t, { grants: {} });
  const denied = async () => {
    const res = await ctx.post(INIT);
    assert.equal(res.status, 403);
    assert.deepEqual(json(res), { error: 'no access has been granted to this agent', code: 'forbidden' });
  };
  await denied();
  ctx.state.grants = undefined;
  await denied();
  ctx.state.grants = { defaults: { gmail: { preset: 'write' } }, agents: { 'agent-A': { gmail: { preset: 'none' } } } };
  await denied();
  ctx.state.grants = { defaults: { gmail: { preset: 'write', expiresAt: Date.now() - 1 } } };
  await denied();
  ctx.state.grants = { defaults: { gmail: { preset: 'bogus' } } };
  await denied();
  assert.equal(ctx.up.seen.length, 0);
  assert.equal(ctx.events.every((e) => e.decision === 'deny'), true);
});

test('grants are read live: an edit applies to the very next request', async (t) => {
  const ctx = await setup(t);
  assert.equal((await ctx.post(INIT)).status, 200);
  ctx.state.grants = {};
  assert.equal((await ctx.post(INIT)).status, 403);
  ctx.state.grants = { agents: { 'agent-A': { gmail: { preset: 'read' } } } };
  assert.equal((await ctx.post(INIT)).status, 200);
});

test('an integration outside the capability, unknown, or disabled is refused', async (t) => {
  const ctx = await setup(t);
  const narrow = ctx.broker.grantMcp('agent-N', ['something-else']);
  const outside = await ctx.post(INIT, {}, narrow);
  assert.equal(outside.status, 403);
  assert.deepEqual(json(outside), { error: 'integration not in this agent capability', code: 'forbidden' });

  const ghost = ctx.broker.grantMcp('agent-G', ['ghost']);
  const res = await call(ctx.port, { method: 'POST', path: '/m/ghost', headers: ctx.headersFor(ghost), body: INIT });
  assert.equal(res.status, 404);
  assert.deepEqual(json(res), { error: 'unknown integration', code: 'not_found' });

  ctx.integrations.get('gmail').enabled = false;
  const off = await ctx.post(INIT);
  assert.equal(off.status, 403);
  assert.deepEqual(json(off), { error: 'integration is disabled', code: 'forbidden' });
  assert.equal(ctx.up.seen.length, 0);
});

test('only /m/<id> exactly is a route; the agent cannot steer the path or the query upstream', async (t) => {
  const ctx = await setup(t);
  for (const path of ['/m', '/m/', '/m/gmail/', '/m/gmail/extra', '/m/gmail/../x', '/m/gm%20ail', '/m/%67mail', '/m/gmail%2f..', `/m/${'a'.repeat(65)}`]) {
    const res = await call(ctx.port, { method: 'POST', path, headers: ctx.headersFor(ctx.token), body: INIT });
    assert.equal(res.status, 404, path);
  }
  assert.equal(ctx.up.seen.length, 0);
  const ok = await call(ctx.port, { method: 'POST', path: '/m/gmail?target=http://evil.example/&x=1', headers: ctx.headersFor(ctx.token), body: INIT });
  assert.equal(ok.status, 200);
  assert.equal(ctx.up.last().url, '/mcp', 'the upstream path is fixed and the query is dropped');
});

// ─── what crosses to the upstream ───────────────────────────────────────────

test('security: the broker credential is injected; the agent credential, cookies and strangers never go upstream', async (t) => {
  const ctx = await setup(t);
  const res = await ctx.post(INIT, { cookie: 'a=b', 'x-evil': '1', origin2: 'x', 'x-forwarded-for': '1.2.3.4', 'mcp-protocol-version': '2025-03-26' });
  assert.equal(res.status, 200);
  const h = ctx.up.last().headers;
  assert.equal(h.authorization, `Bearer ${UP_TOKEN}`);
  assert.equal(JSON.stringify(h).includes(ctx.token), false, 'the capability token must never be forwarded');
  for (const gone of ['cookie', 'x-evil', 'origin2', 'x-forwarded-for']) assert.equal(h[gone], undefined, gone);
  assert.equal(h['mcp-protocol-version'], '2025-03-26');
  assert.equal(h['content-type'], 'application/json');
  assert.equal(h['user-agent'], 'mosbius-co-broker/1');

  // X-MD-Broker-Token, when present, is what the core authenticates with: a bogus one
  // next to a good Authorization header is a bad token, not a way round it
  const bogus = await ctx.post(INIT, { 'x-md-broker-token': 'smuggled' });
  assert.equal(bogus.status, 401);
  assert.equal(ctx.up.calls().length, 1);
});

test('security: only an allow-list of upstream headers comes back, and WWW-Authenticate never does', async (t) => {
  const ctx = await setup(t);
  const res = await ctx.post(INIT);
  assert.equal(res.status, 200);
  assert.ok(res.headers['mcp-session-id']);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers['set-cookie'], undefined);
  assert.equal(res.headers['x-internal'], undefined);

  // the agent's CLI must not be handed a challenge that starts an OAuth flow of its own
  ctx.state.creds = { ok: true, headers: { authorization: 'Bearer WRONG' } };
  const unauth = await ctx.post(INIT);
  assert.equal(unauth.status, 401);
  assert.equal(unauth.headers['www-authenticate'], undefined);
});

test('an upstream redirect is refused and an unreachable upstream is a fixed 502', async (t) => {
  const ctx = await setup(t);
  ctx.up.config.redirect = true;
  const redirect = await ctx.post(INIT);
  assert.equal(redirect.status, 502);
  assert.deepEqual(json(redirect), { error: 'upstream redirect refused', code: 'bad_gateway' });
  assert.equal(redirect.headers.location, undefined);

  const dead = http.createServer();
  await new Promise((r) => dead.listen(0, '127.0.0.1', r));
  const deadPort = dead.address().port;
  await new Promise((r) => dead.close(r));
  ctx.integrations.get('gmail').url = `http://127.0.0.1:${deadPort}/mcp`;
  const down = await ctx.post(INIT);
  assert.equal(down.status, 502);
  assert.deepEqual(json(down), { error: 'upstream request failed', code: 'bad_gateway' });
  assert.equal(down.body.toString().includes(String(deadPort)), false, 'no URL or error text leaks');
});

test('credential failures map to fixed answers and nothing goes upstream', async (t) => {
  const ctx = await setup(t);
  const expect = { no_secret: [503, 'no_secret'], sign_in_required: [401, 'sign_in_required'], unavailable: [503, 'unavailable'] };
  for (const [code, [status, label]] of Object.entries(expect)) {
    ctx.state.creds = { ok: false, code };
    const res = await ctx.post(INIT);
    assert.equal(res.status, status, code);
    assert.equal(json(res).code, label);
    assert.equal(res.headers['www-authenticate'], undefined);
  }
  assert.equal(ctx.up.seen.length, 0);
});

// ─── JSON-RPC policy ────────────────────────────────────────────────────────

test('security: tools/list shows exactly the tools the grant allows', async (t) => {
  const ctx = await setup(t);
  const cases = [
    [{ preset: 'read' }, ['get_thing']],
    [{ preset: 'write' }, ['get_thing', 'put_thing']],
    [{ preset: 'write', deny: ['put_thing'] }, ['get_thing']],
    [{ preset: 'custom', allow: ['send_thing'] }, ['send_thing']],
    [{ preset: 'read', allow: ['send_thing'] }, ['get_thing', 'send_thing']],
    [{ preset: 'custom', allow: ['mystery_thing', 'get_thing'] }, ['get_thing', 'mystery_thing']],
    [{ preset: 'custom' }, []]
  ];
  for (const [grant, expected] of cases) {
    ctx.state.grants = { defaults: { gmail: grant } };
    assert.deepEqual(await ctx.names(), expected, JSON.stringify(grant));
  }
  // a tool nobody has classified is treated as destructive: no preset shows it
  for (const preset of ['read', 'write']) {
    ctx.state.grants = { defaults: { gmail: { preset } } };
    assert.equal((await ctx.names()).includes('mystery_thing'), false, preset);
  }
});

test('security: no preset ever shows or runs a destructive tool', async (t) => {
  const ctx = await setup(t);
  for (const preset of ['read', 'write']) {
    ctx.state.grants = { defaults: { gmail: { preset } } };
    assert.equal((await ctx.names()).includes('send_thing'), false, preset);
    const call_ = await ctx.post(rpc('tools/call', { name: 'send_thing', arguments: {} }, 5));
    assert.equal(json(call_).error.code, -32003);
  }
  assert.equal(ctx.up.calls().filter((e) => e.body.toString().includes('"tools/call"')).length, 0);
});

test('the pagination cursor survives filtering', async (t) => {
  const ctx = await setup(t);
  const r = await ctx.post(rpc('tools/list', undefined, 3));
  assert.equal(json(r).result.nextCursor, 'page-2');
});

test('security: tools/call is refused for an unlisted tool, an ungranted tool, and a malformed call — and never forwarded', async (t) => {
  const ctx = await setup(t, { grants: { defaults: { gmail: { preset: 'write' } } } });
  const callTool = (params, id = 5) => ctx.post(rpc('tools/call', params, id));
  const before = () => ctx.up.calls().length;

  // never listed: refused, because its class is unknown
  let n = before();
  let r = await callTool({ name: 'get_thing' });
  assert.equal(json(r).error.code, -32003);
  assert.match(json(r).error.message, /not known; list tools first/);
  assert.equal(before(), n);

  await ctx.names();                               // now the broker has seen the tools
  n = before();
  r = await callTool({ name: 'get_thing', arguments: { q: 'x' } });
  assert.equal(json(r).result.content[0].text, 'called get_thing');
  r = await callTool({ name: 'put_thing' }, 6);
  assert.equal(json(r).result.content[0].text, 'called put_thing');
  assert.equal(json(r).id, 6);
  assert.equal(before(), n + 2);

  n = before();
  r = await callTool({ name: 'send_thing' });
  assert.equal(r.status, 200, 'a denial is a JSON-RPC error the model can read, not an HTTP failure');
  assert.equal(json(r).error.code, -32003);
  assert.match(json(r).error.message, /"send_thing" is not granted to this agent/);
  assert.equal(json(r).id, 5);
  for (const bad of [{}, { name: 5 }, { name: '' }, { name: 'x'.repeat(300) }, null, 'str']) {
    r = await callTool(bad);
    assert.equal(json(r).error.code, -32003, JSON.stringify(bad));
  }
  assert.equal(before(), n, 'none of those reached the upstream');
});

test('a tool named in allow is callable even before it has been listed', async (t) => {
  const ctx = await setup(t, { grants: { defaults: { gmail: { preset: 'custom', allow: ['send_thing'] } } } });
  const r = await ctx.post(rpc('tools/call', { name: 'send_thing' }, 4));
  assert.equal(json(r).result.content[0].text, 'called send_thing');
});

test('security: a batch is all or nothing', async (t) => {
  const ctx = await setup(t);
  const mixed = JSON.stringify([
    { jsonrpc: '2.0', id: 1, method: 'ping' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'send_thing' } },
    { jsonrpc: '2.0', method: 'notifications/initialized' }
  ]);
  const res = await ctx.post(mixed);
  assert.equal(res.status, 200);
  const answers = json(res);
  assert.equal(Array.isArray(answers), true);
  assert.deepEqual(answers.map((a) => a.id), [1, 2], 'every request is answered; the notification is not');
  assert.ok(answers.every((a) => a.error.code === -32003));
  assert.match(answers[0].error.message, /refused together with another request/);
  assert.equal(ctx.up.seen.length, 0, 'not even the harmless half went upstream');

  const fine = await ctx.post(JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', id: 2, method: 'ping' }]));
  assert.deepEqual(json(fine).map((a) => a.id), [1, 2]);
  assert.equal(ctx.up.seen.length, 1);
});

test('security: unknown methods are denied; a denied notification is dropped with a 202', async (t) => {
  const ctx = await setup(t);
  for (const method of ['sampling/createMessage', 'roots/list', 'admin/reset', 'tasks/get', 'elicitation/create']) {
    const r = await ctx.post(rpc(method, {}, 8));
    assert.equal(json(r).error.code, -32003, method);
  }
  const note = await ctx.post(rpc('admin/reset'));
  assert.equal(note.status, 202);
  assert.equal(note.body.length, 0);
  assert.equal(ctx.up.seen.length, 0);

  // what is allowed does pass
  assert.equal((await ctx.post(rpc('notifications/initialized'))).status, 202);
  assert.equal((await ctx.post(JSON.stringify({ jsonrpc: '2.0', id: 'srv-1', result: { ok: true } }))).status, 202, "a client's answer to a server request passes");
  assert.equal(ctx.up.seen.length, 2);
});

test('resources and prompts need the read or write preset', async (t) => {
  const ctx = await setup(t);
  assert.equal(json(await ctx.post(rpc('resources/list', {}, 1))).result !== undefined, true);
  assert.equal(json(await ctx.post(rpc('prompts/list', {}, 2))).result !== undefined, true);
  ctx.state.grants = { defaults: { gmail: { preset: 'custom', allow: ['get_thing'] } } };
  assert.equal(json(await ctx.post(rpc('resources/read', { uri: 'x://y' }, 3))).error.code, -32003);
  assert.equal(json(await ctx.post(rpc('prompts/get', { name: 'p' }, 4))).error.code, -32003);
});

test('bad bodies: invalid JSON, invalid shapes and oversize uploads', async (t) => {
  const ctx = await setup(t, { integ: { maxBodyBytes: 2000 } });
  const bad = await ctx.post('{not json');
  assert.equal(bad.status, 400);
  assert.equal(json(bad).error.code, -32700);
  const shape = await ctx.post(JSON.stringify({ jsonrpc: '1.0', id: 1, method: 'ping' }));
  assert.equal(shape.status, 400);
  assert.equal(json(shape).error.code, -32600);
  const big = await ctx.post(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(3000) } }));
  assert.equal(big.status, 413);
  assert.equal(json(big).code, 'payload_too_large');
  assert.equal(ctx.up.seen.length, 0);
});

test('a tool list streamed as events is filtered like a JSON one; an unreadable one is refused; an upstream error answer passes; a weird list is empty', async (t) => {
  const ctx = await setup(t, { grants: { defaults: { gmail: { preset: 'write' } } } });
  // Phase 1 refused a streamed list outright ("not supported yet"). Phase 3 reads it, finds the
  // answer to THIS request in the stream and filters it; what is refused is a list it cannot read.
  ctx.up.config.listAs = 'sse';
  const sse = await ctx.post(rpc('tools/list', undefined, 1));
  assert.equal(sse.status, 200);
  assert.match(sse.headers['content-type'], /^text\/event-stream/);
  const data = sse.body.toString().split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)));
  assert.equal(data.length, 1, 'exactly one event comes back: the filtered answer');
  assert.deepEqual(data[0].result.tools.map((x) => x.name), ['get_thing', 'put_thing'], 'the write preset: no destructive and no unclassified tool, even in a stream');
  for (const name of ['send_thing', 'mystery_thing']) assert.equal(sse.body.toString().includes(name), false, 'no tool name may leak');

  ctx.up.config.listAs = 'malformed';
  const mal = await ctx.post(rpc('tools/list', undefined, 2));
  assert.equal(mal.status, 502);
  assert.equal(mal.body.toString().includes('get_thing'), false);

  ctx.up.config.listAs = 'error';
  const err = await ctx.post(rpc('tools/list', undefined, 3));
  assert.equal(json(err).error.message, 'upstream tool list failed');

  ctx.up.config.listAs = 'weird';
  const weird = await ctx.post(rpc('tools/list', undefined, 4));
  assert.deepEqual(json(weird).result, { tools: [] });
});

// ─── sessions ───────────────────────────────────────────────────────────────

test('security: an upstream session belongs to the agent that opened it', async (t) => {
  const ctx = await setup(t);
  const tokenB = ctx.broker.grantMcp('agent-B', ['gmail']);
  const sidA = await initialize(ctx);
  const sidB = await initialize(ctx, tokenB);
  assert.notEqual(sidA, sidB);

  const useAs = (tok, sid) => ctx.post(rpc('ping', undefined, 1), { 'mcp-session-id': sid }, tok);
  assert.equal((await useAs(ctx.token, sidA)).status, 200);
  assert.equal((await useAs(tokenB, sidB)).status, 200);
  const stolen = await useAs(tokenB, sidA);
  assert.equal(stolen.status, 404);
  assert.deepEqual(json(stolen), { error: 'unknown session', code: 'session_not_found' });
  assert.equal((await useAs(ctx.token, 'made-up-session')).status, 404);
  assert.equal((await useAs(ctx.token, sidB)).status, 404);
});

test('security: revoking an agent drops its sessions, and a new capability cannot inherit them', async (t) => {
  const ctx = await setup(t);
  const sid = await initialize(ctx);
  ctx.broker.revoke('agent-A');
  const fresh = ctx.broker.grantMcp('agent-A', ['gmail']);
  const res = await ctx.post(rpc('ping', undefined, 1), { 'mcp-session-id': sid }, fresh);
  assert.equal(res.status, 404);
});

test('DELETE ends a session and forgets it', async (t) => {
  const ctx = await setup(t);
  const sid = await initialize(ctx);
  const del = await call(ctx.port, { method: 'DELETE', path: '/m/gmail', headers: { ...bearer(ctx.token), 'mcp-session-id': sid } });
  assert.equal(del.status, 200);
  assert.equal(ctx.up.last().method, 'DELETE');
  assert.equal(ctx.up.last().headers.authorization, `Bearer ${UP_TOKEN}`);
  const again = await ctx.post(rpc('ping', undefined, 1), { 'mcp-session-id': sid });
  assert.equal(again.status, 404);
});

// ─── streaming, limits, revocation ──────────────────────────────────────────

test('GET opens a stream that passes through incrementally, with the same header allow-list', async (t) => {
  const ctx = await setup(t);
  const sid = await initialize(ctx);
  const stream = await open(ctx.port, { path: '/m/gmail', headers: { ...bearer(ctx.token), accept: 'text/event-stream', 'mcp-session-id': sid } });
  assert.equal(stream.status, 200);
  assert.equal(stream.headers['content-type'], 'text/event-stream');
  assert.equal(stream.headers['set-cookie'], undefined);
  assert.equal(stream.headers['x-internal'], undefined);
  assert.ok(await until(() => stream.text().includes('notifications/message')));
  const live = ctx.up.seen.find((e) => e.method === 'GET');
  live.res.write('data: {"jsonrpc":"2.0","method":"notifications/message","params":{"n":2}}\n\n');
  assert.ok(await until(() => stream.text().includes('"n":2')), 'a later event arrives without waiting for the stream to end');
  stream.req.destroy();
  assert.ok(await until(() => live.closed), 'the upstream stream is released when the client leaves');
});

test('a GET without a known session is refused', async (t) => {
  const ctx = await setup(t);
  const bad = await call(ctx.port, { path: '/m/gmail', headers: { ...bearer(ctx.token), 'mcp-session-id': 'nope', accept: 'text/event-stream' } });
  assert.equal(bad.status, 404);
});

test('security: revoking the agent cuts a running stream at once; so does revoking the integration', async (t) => {
  for (const how of ['agent', 'integration']) {
    const ctx = await setup(t);
    const sid = await initialize(ctx);
    const stream = await open(ctx.port, { path: '/m/gmail', headers: { ...bearer(ctx.token), accept: 'text/event-stream', 'mcp-session-id': sid } });
    await until(() => stream.text().includes('notifications/message'));
    const live = ctx.up.seen.find((e) => e.method === 'GET');
    const started = Date.now();
    if (how === 'agent') ctx.broker.revoke('agent-A'); else ctx.broker.revokeIntegration('gmail');
    assert.ok(await until(() => stream.events.closed || stream.events.error), `${how}: still open`);
    assert.ok(Date.now() - started < 1000);
    assert.ok(await until(() => live.closed), `${how}: upstream not released`);
    const after = await ctx.post(rpc('ping', undefined, 1));
    assert.equal(after.status, how === 'agent' ? 401 : 403);
  }
});

test('a silent stream is cut after the idle limit; concurrent requests are capped', async (t) => {
  const ctx = await setup(t, { limits: { idleMs: 150, maxInflight: 2 } });
  ctx.up.config.silentStream = true;
  const sid = await initialize(ctx);
  const get = () => open(ctx.port, { path: '/m/gmail', headers: { ...bearer(ctx.token), accept: 'text/event-stream', 'mcp-session-id': sid } });
  const first = await get();
  assert.equal(first.status, 200);
  assert.ok(await until(() => first.events.closed || first.events.error, 2000), 'the idle limit did not cut the stream');

  ctx.up.config.silentStream = false;
  const a = await get();
  const b = await get();
  assert.deepEqual([a.status, b.status], [200, 200]);
  const c = await get();
  assert.equal(c.status, 429);
  a.req.destroy();
  assert.ok(await until(async () => (await get().then((x) => { x.req?.destroy(); return x.status; })) === 200), 'a slot frees up when a stream ends');
  b.req.destroy();
});

// ─── audit ──────────────────────────────────────────────────────────────────

test('security: the audit trail records who did what, and never a body, a parameter, a header or a credential', async (t) => {
  const ctx = await setup(t, { grants: { defaults: { gmail: { preset: 'write' } } } });
  await initialize(ctx);
  await ctx.names();
  await ctx.post(rpc('tools/call', { name: 'put_thing', arguments: { note: 'ARGUMENT-SECRET-123' } }, 2));
  await ctx.post(rpc('tools/call', { name: 'send_thing', arguments: { note: 'ARGUMENT-SECRET-123' } }, 3));
  await ctx.post(rpc('tools/call', { name: 'bad\u0000name\n' + 'x'.repeat(500) }, 4));
  const text = JSON.stringify(ctx.events);
  for (const forbidden of ['ARGUMENT-SECRET-123', UP_TOKEN, ctx.token, 'Bearer']) assert.equal(text.includes(forbidden), false, forbidden);
  assert.ok(ctx.events.length >= 5);
  for (const e of ctx.events) {
    assert.equal(e.agentId, 'agent-A');
    assert.equal(e.integrationId, 'gmail');
    assert.ok(['allow', 'deny'].includes(e.decision));
    assert.equal(typeof e.at, 'number');
    if (e.tool) { assert.ok(e.tool.length <= 128); assert.equal(/[\u0000-\u001f]/.test(e.tool), false); }
  }
  const sends = ctx.events.filter((e) => e.tool === 'send_thing');
  assert.deepEqual(sends.map((e) => e.decision), ['deny']);
  assert.deepEqual(ctx.events.filter((e) => e.tool === 'put_thing').map((e) => e.decision), ['allow']);
});

test('a broken audit observer cannot break a request', async (t) => {
  const up = await startMcpUpstream(t);
  const broker = new IntegrationBroker({ getRecord: () => undefined, getSecret: () => undefined }, {
    mcp: {
      resolve: () => ({ id: 'gmail', url: `${up.base}/mcp`, enabled: true }),
      credentials: { accessHeaders: () => ({ ok: true, headers: { authorization: `Bearer ${UP_TOKEN}` } }) },
      grants: () => ({ defaults: { gmail: { preset: 'read' } } }),
      audit: () => { throw new Error('observer bug'); }
    }
  });
  const { port } = await broker.start();
  t.after(() => broker.stop());
  const token = broker.grantMcp('a', ['gmail']);
  const res = await call(port, { method: 'POST', path: '/m/gmail', headers: { ...bearer(token), 'content-type': 'application/json' }, body: INIT });
  assert.equal(res.status, 200);
});

test('nothing in any response, across all of the above, ever contains a credential or a capability token', async (t) => {
  const ctx = await setup(t);
  const other = ctx.broker.grantMcp('agent-O', ['gmail']);
  const responses = [];
  for (const body of [INIT, rpc('tools/list', undefined, 1), rpc('tools/call', { name: 'send_thing' }, 2), '{bad', rpc('admin/reset', {}, 3)]) {
    responses.push(await ctx.post(body));
    responses.push(await ctx.post(body, {}, 'x'.repeat(43)));
  }
  ctx.state.creds = { ok: true, headers: { authorization: 'Bearer WRONG' } };
  responses.push(await ctx.post(INIT));
  for (const r of responses) {
    const text = r.body.toString() + JSON.stringify(r.headers);
    for (const secret of [UP_TOKEN, ctx.token, other, 'WRONG']) assert.equal(text.includes(secret), false);
  }
});

// keep a handle on startUpstream so the unused-import lint of the helper stays honest
void startUpstream;
