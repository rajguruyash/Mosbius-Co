'use strict';

/**
 * The Stage A spike tool (tools/stage-a-spike.cjs), against a stand-in provider.
 *
 * A pass here proves that the TOOL behaves: that it refuses what it should, keeps every secret out of what
 * it prints and writes, and reports honestly when the provider does something unexpected. It proves nothing
 * about Notion, GitHub or Google: those are verified only by running the tool against them, and the results
 * of those runs are recorded in MOSBIUS_PLATFORM_ROADMAP.md and STAGE_A_VERIFICATION.md.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const spike = require('../tools/stage-a-spike.cjs');
const { startStageAIdp, SENTINEL } = require('./fixtures/stage-a-idp.cjs');

const provider = (idp, over = {}) => ({ strategy: 'dcr', label: 'Standin', mcp: `${idp.base}/mcp`, hosts: [idp.host], ...over });
const capture = () => { const lines = []; return { lines, out: (l) => lines.push(String(l)) }; };

const rawGet = (target, headers = {}) => new Promise((resolve) => {
  const u = new URL(target);
  const req = http.request({ host: '127.0.0.1', port: u.port, path: u.pathname + u.search, method: 'GET', headers }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
  req.on('error', () => resolve(0));
  req.end();
});
/** What a browser sends when it follows a redirect: a top-level navigation. (Node's own fetch labels itself
 *  `cors`, which the loopback listener rightly refuses.) */
const navigate = (target, headers = {}) => rawGet(target, { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', ...headers });
/** A browser: asks the authorization endpoint, then follows its redirect to the loopback listener.
 *  `before` may send forged requests to that listener first. */
const browser = (before) => async (url) => {
  const r = await fetch(url, { redirect: 'manual' });
  const loc = r.headers.get('location');
  if (!loc) return;
  if (before) await before(loc);
  await navigate(loc);
};
const statusOf = (res, id) => res.steps.find((s) => s.id === id)?.status;
const detailOf = (res, id) => res.steps.find((s) => s.id === id)?.detail ?? '';
const setup = (extra = {}) => { const c = capture(); return { c, d: { insecureLoopbackForTests: true, out: c.out, openUrl: browser(), signInTimeoutMs: 8000, ...extra } }; };
const tmpFile = (t, name) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-a-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return path.join(dir, name); };
const everything = (idp) => [...idp.secretsSeen(), ...idp.codes.keys(), ...idp.regTokens.values()];

// ─── the table and the policy ───────────────────────────────────────────────

test('every pinned provider points only at hosts it lists, over https', () => {
  for (const [id, p] of Object.entries(spike.PROVIDERS)) {
    assert.ok(['dcr', 'device', 'pkce', 'byo'].includes(p.strategy), id);
    const policy = spike.makePolicy(p);
    for (const k of ['mcp', 'deviceEndpoint', 'tokenEndpoint', 'authorizationEndpoint', 'revokeEndpoint']) {
      if (p[k]) assert.doesNotThrow(() => policy.check(p[k], k), `${id}.${k}`);
    }
  }
});

test('the policy refuses http, a host that is not listed, credentials in an address, and a non-address', () => {
  const policy = spike.makePolicy({ label: 'X', hosts: ['mcp.example.com'] });
  assert.doesNotThrow(() => policy.check('https://mcp.example.com/x', 'a'));
  for (const bad of ['http://mcp.example.com/x', 'https://evil.example/x', 'https://u:p@mcp.example.com/x', 'https://mcp.example.com.evil.example/x', 'not an address', 'file:///etc/passwd']) {
    assert.throws(() => policy.check(bad, 'a'), /./, bad);
  }
});

// ─── metadata: public GETs only ─────────────────────────────────────────────

test('metadata: discovery goes 401 → resource metadata → authorization server, and reports what it found', async (t) => {
  const idp = await startStageAIdp(t);
  const { c, d } = setup();
  const res = await spike.runMetadata(provider(idp), {}, d);
  assert.equal(res.code, 0);
  for (const id of ['discover.unauthenticated', 'discover.resource', 'discover.authorization_server', 'discover.issuer', 'discover.pkce', 'discover.public_client', 'discover.registration', 'discover.revocation']) {
    assert.equal(statusOf(res, id), 'PASS', id);
  }
  assert.deepEqual(res.facts.discovery.pkce, ['S256']);
  assert.ok(res.facts.discovery.tokenAuthMethods.includes('none'));
  assert.equal(res.facts.discovery.issParameterSupported, true);
  assert.equal(res.facts.discovery.revocationSeparateFromToken, true);
  // it asked, it did not register or sign in to anything
  assert.equal(idp.requests('/register').length, 0);
  assert.equal(idp.requests('/authorize').length, 0);
  assert.equal(idp.requests('/token').length, 0);
  assert.ok(c.lines.length > 0);
});

test('metadata: a server that publishes no resource metadata is read through its pinned authorization server (Atlassian)', async (t) => {
  const idp = await startStageAIdp(t, { noResourceMetadata: true });
  const without = await spike.runMetadata(provider(idp), {}, setup().d);
  assert.equal(without.code, 1, 'with no resource metadata and no pinned authorization server there is nothing to go on');
  assert.equal(statusOf(without, 'discover.resource'), 'FAIL');
  const res = await spike.runMetadata(provider(idp, { authorizationServer: idp.base }), {}, setup().d);
  assert.equal(res.code, 0);
  assert.equal(statusOf(res, 'discover.resource'), 'INFO');
  assert.equal(statusOf(res, 'discover.registration'), 'PASS');
  const live = await spike.runDcr(provider(idp, { authorizationServer: idp.base }), {}, setup().d);
  assert.equal(live.code, 0, 'a full run works the same way');
  assert.equal(idp.requests('/authorize')[0].query.resource, `${idp.base}/mcp`, 'the resource named is the pinned MCP address');
});

test('metadata: a metadata document that points an endpoint at another host is refused, and nothing is sent there', async (t) => {
  const idp = await startStageAIdp(t, { evilTokenHost: true });
  const { d } = setup();
  const res = await spike.runMetadata(provider(idp), {}, d);
  assert.equal(res.code, 1);
  assert.match(detailOf(res, 'discover.token_endpoint'), /evil\.example is not one of/);
});

test('metadata: with the production policy a plain-http provider is refused before anything is sent', async (t) => {
  const idp = await startStageAIdp(t);
  const { d } = setup({ insecureLoopbackForTests: false });
  const res = await spike.runMetadata(provider(idp), {}, d);
  assert.equal(res.code, 1);
  assert.match(detailOf(res, 'discover'), /only https/);
  assert.equal(idp.log.length, 0, 'not a single request was made');
});

// ─── dcr ────────────────────────────────────────────────────────────────────

test('dcr: register, sign in, exchange with NO secret, call a read-only tool, refresh, revoke, unregister', async (t) => {
  const idp = await startStageAIdp(t);
  const evidence = tmpFile(t, 'evidence.json');
  const { c, d } = setup({ sleep: async () => {} });
  const res = await spike.runDcr(provider(idp), { tool: 'search', args: { query: 'x' }, evidence }, d);
  assert.equal(res.code, 0, c.lines.join('\n'));
  for (const id of ['register', 'callback', 'token', 'mcp.initialize', 'mcp.tools_list', 'mcp.tool_call', 'refresh', 'refresh.access', 'revoke', 'unregister', 'leak.scan']) {
    assert.equal(statusOf(res, id), 'PASS', `${id}: ${detailOf(res, id)}`);
  }

  // what was SENT, by the stand-in's own record
  const reg = JSON.parse(idp.requests('/register')[0].rawBody);
  assert.equal(reg.client_name, spike.CLIENT_NAME);
  assert.equal(reg.token_endpoint_auth_method, 'none', 'a public client');
  assert.equal(reg.redirect_uris.length, 1);
  assert.match(reg.redirect_uris[0], /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  const auth = idp.requests('/authorize')[0].query;
  assert.equal(auth.code_challenge_method, 'S256');
  assert.equal(auth.resource, idp.base, 'RFC 8707: the resource is named');
  assert.equal(auth.redirect_uri, reg.redirect_uris[0]);
  const tokens = idp.requests('/token');
  assert.equal(tokens.length, 3, 'the exchange, one refresh, and the check after revocation that the refresh token is dead');
  assert.equal(tokens[2].form.refresh_token, tokens[1].form.refresh_token, 'the same refresh token, presented again after it was revoked');
  for (const r of tokens) {
    assert.equal('client_secret' in r.form, false, 'no client secret travelled');
    assert.equal(r.form.resource, idp.base);
  }
  assert.equal(tokens[0].form.code_verifier.length, 43);
  assert.equal(idp.requests('/revoke')[0].form.token_type_hint, 'refresh_token');
  assert.equal(idp.requests('/register/' + [...idp.regTokens.keys()][0]).length, 0, 'the client was removed, so it is no longer there to remove');
  assert.equal(idp.log.some((r) => r.method === 'DELETE' && r.path.startsWith('/register/')), true);

  // the MCP conversation
  const calls = idp.mcpCalls.filter((m) => m.method);
  assert.deepEqual(calls.slice(0, 4).map((m) => m.method), ['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
  assert.ok(calls[2].session && calls[2].session.startsWith('sess-'), 'the session id is carried');
  assert.equal(calls[2].version, '2025-06-18');
  assert.deepEqual(res.facts['mcp.tools'], { count: 5, read: 2, write: 1, destructiveOrUnsaid: 2, unannotated: 1, names: ['search', 'fetch', 'create_page', 'delete_page', 'mystery'] });
  assert.equal(res.facts.refresh.rotated, false);
  assert.equal(res.facts.revoke.accessAfter, 401);

  // what was KEPT: facts, and nothing secret
  const text = fs.readFileSync(evidence, 'utf8');
  for (const secret of everything(idp)) { assert.equal(text.includes(secret), false); assert.equal(c.lines.join('\n').includes(secret), false); }
  assert.equal((fs.statSync(evidence).mode & 0o777), 0o600);
  assert.ok(JSON.parse(text).facts.registration.fields.includes('client_id'));
});

test('dcr: what a tool returned is counted, never shown', async (t) => {
  const idp = await startStageAIdp(t);
  const evidence = tmpFile(t, 'evidence.json');
  const { c, d } = setup();
  const res = await spike.runDcr(provider(idp), { tool: 'search', evidence }, d);
  assert.equal(statusOf(res, 'mcp.tool_call'), 'PASS');
  assert.match(detailOf(res, 'mcp.tool_call'), /1 item\(s\), \d+ bytes \(the content is not shown\)/);
  assert.equal(c.lines.join('\n').includes(SENTINEL), false);
  assert.equal(fs.readFileSync(evidence, 'utf8').includes(SENTINEL), false);
  assert.equal(res.facts['mcp.call'].items, 1);
});

test('dcr: a tool that writes is never called, and neither is one the server did not describe unless it is asked for by name', async (t) => {
  const idp = await startStageAIdp(t);
  for (const tool of ['create_page', 'delete_page', 'mystery']) {
    const { d } = setup();
    const res = await spike.runDcr(provider(idp), { tool }, d);
    assert.equal(statusOf(res, 'mcp.tool_call'), 'SKIP', tool);
  }
  assert.equal(idp.mcpCalls.filter((m) => m.method === 'tools/call').length, 0, 'not one tools/call reached the server');
  const { d } = setup();
  const ok = await spike.runDcr(provider(idp), { tool: 'mystery', allowUnannotated: true }, d);
  assert.equal(statusOf(ok, 'mcp.tool_call'), 'PASS', 'an undescribed tool is called only on an explicit flag');
  const missing = await spike.runDcr(provider(idp), { tool: 'no_such_tool' }, setup().d);
  assert.equal(statusOf(missing, 'mcp.tool_call'), 'FAIL');
});

test('dcr: an event-stream answer is understood too', async (t) => {
  const idp = await startStageAIdp(t, { sse: true });
  const { d } = setup();
  const res = await spike.runDcr(provider(idp), { tool: 'fetch' }, d);
  assert.equal(res.code, 0);
  assert.equal(statusOf(res, 'mcp.tools_list'), 'PASS');
  assert.equal(statusOf(res, 'mcp.tool_call'), 'PASS');
});

test('dcr: a rotating refresh token is noticed, and presenting the old one is reported (reuse kills the grant when the provider says so)', async (t) => {
  const idp = await startStageAIdp(t, { rotate: true, reuseDetection: true });
  const { d } = setup();
  const res = await spike.runDcr(provider(idp), { reuseProbe: true }, d);
  assert.equal(res.facts.refresh.rotated, true);
  assert.match(detailOf(res, 'refresh'), /ROTATED/);
  assert.equal(res.facts.reuse.oldRefreshError, 'invalid_grant');
  assert.equal(res.facts.reuse.newAccessAfter, 401);
  assert.match(detailOf(res, 'refresh.reuse'), /reuse killed the grant/);
});

test('dcr: a provider that demands a client secret from a public client fails the exchange, and the run stops there', async (t) => {
  const idp = await startStageAIdp(t, { tokenAuth: 'secret-required' });
  const { c, d } = setup();
  const res = await spike.runDcr(provider(idp), { tool: 'search' }, d);
  assert.equal(res.code, 1);
  assert.equal(statusOf(res, 'register.public'), 'WARN', 'it issued a secret to a client that asked for none');
  assert.equal(statusOf(res, 'token'), 'FAIL');
  assert.match(detailOf(res, 'token'), /invalid_client/);
  assert.equal(res.steps.some((s) => s.id.startsWith('mcp.')), false, 'no MCP call was attempted');
  assert.equal(statusOf(res, 'unregister'), 'PASS', 'the test client is removed even after a failure');
  const issued = [...idp.clients.values()].length;
  assert.equal(issued, 0);
  for (const r of idp.requests('/token')) assert.equal('client_secret' in r.form, false);
  assert.equal(c.lines.join('\n').includes('secret-'), false, 'the issued secret was never shown');
});

test('dcr: a provider that refuses an http loopback redirect fails at registration, and no sign-in is attempted', async (t) => {
  const idp = await startStageAIdp(t, { dcr: 'no-http-loopback' });
  let opened = 0;
  const { d } = setup({ openUrl: async () => { opened++; } });
  const res = await spike.runDcr(provider(idp), {}, d);
  assert.equal(res.code, 1);
  assert.equal(statusOf(res, 'register'), 'FAIL');
  assert.match(detailOf(res, 'register'), /invalid_redirect_uri/);
  assert.equal(opened, 0);
  assert.equal(idp.requests('/authorize').length, 0);
});

test('dcr: a provider with no registration endpoint is reported, not poked', async (t) => {
  const idp = await startStageAIdp(t, { dcr: 'none' });
  let opened = 0;
  const { d } = setup({ openUrl: async () => { opened++; } });
  const res = await spike.runDcr(provider(idp), {}, d);
  assert.equal(res.code, 1);
  assert.equal(statusOf(res, 'requirements'), 'FAIL');
  assert.equal(opened, 0);
  assert.equal(idp.requests('/register').length, 0);
});

test('dcr: forged requests to the loopback address are refused, and the genuine redirect still completes the sign-in', async (t) => {
  const idp = await startStageAIdp(t);
  const forged = async (loc) => {
    const u = new URL(loc);
    const wrongState = new URL(loc); wrongState.searchParams.set('state', 'x'.repeat(43));
    const wrongPath = new URL(loc); wrongPath.pathname = '/elsewhere';
    const dup = new URL(loc); dup.searchParams.append('code', 'second');
    assert.equal(await rawGet(wrongState.toString()), 400);
    assert.equal(await rawGet(wrongPath.toString()), 404);
    assert.equal(await rawGet(loc, { Host: 'evil.example' }), 400);
    assert.equal(await rawGet(dup.toString()), 400);
    assert.equal(await rawGet(loc, { 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' }), 400, 'a script\'s request is not a navigation');
    const post = await fetch(loc, { method: 'POST' });
    assert.equal(post.status, 405);
    assert.equal(u.hostname, '127.0.0.1');
  };
  const { d } = setup({ openUrl: browser(forged) });
  const res = await spike.runDcr(provider(idp), {}, d);
  assert.equal(res.code, 0);
  assert.equal(statusOf(res, 'callback'), 'PASS');
  const reasons = /refused: (.*)$/.exec(detailOf(res, 'callback.rejected'))[1].split(', ').sort();
  assert.deepEqual(reasons, ['duplicate-param', 'host', 'method', 'not-navigation', 'path', 'state']);
  assert.equal(idp.requests('/token').length >= 1, true);
});

test('dcr: a wrong or missing iss on the redirect ends the sign-in before any code is exchanged', async (t) => {
  for (const issParam of ['wrong', 'missing']) {
    const idp = await startStageAIdp(t, { issParam });
    const { d } = setup();
    const res = await spike.runDcr(provider(idp), {}, d);
    assert.equal(res.code, 1, issParam);
    assert.match(detailOf(res, 'callback'), issParam === 'wrong' ? /iss-mismatch/ : /iss-missing/);
    assert.equal(idp.requests('/token').length, 0, 'no code was exchanged');
  }
  // a provider that does not advertise iss may leave it out
  const idp = await startStageAIdp(t, { issParam: 'missing', issSupported: false });
  const res = await spike.runDcr(provider(idp), {}, setup().d);
  assert.equal(res.code, 0);
});

test('dcr: a redirect with the wrong state is ignored and the sign-in times out rather than being accepted', async (t) => {
  const idp = await startStageAIdp(t, { stateParam: 'wrong' });
  const { d } = setup({ signInTimeoutMs: 400 });
  const res = await spike.runDcr(provider(idp), {}, d);
  assert.equal(res.code, 1);
  assert.match(detailOf(res, 'callback'), /timeout/);
  assert.match(detailOf(res, 'callback.rejected'), /state/);
  assert.equal(idp.requests('/token').length, 0);
});

test('dcr: a revocation that is accepted but does not take effect is reported as a warning, not a pass', async (t) => {
  const idp = await startStageAIdp(t, { revokeKillsAccess: false });
  const res = await spike.runDcr(provider(idp), {}, setup().d);
  assert.equal(statusOf(res, 'revoke'), 'WARN');
  assert.match(detailOf(res, 'revoke'), /did not take effect at once/);
  assert.equal(res.facts.revoke.accessAfter, 200);
});

test('dcr: --no-open prints the address to open by hand, and that is the one place a state is shown', async (t) => {
  const idp = await startStageAIdp(t);
  const { c, d } = setup({ openUrl: async () => { throw new Error('must not be called'); } });
  const run = spike.runDcr(provider(idp), { noOpen: true }, d);
  let url;
  for (let i = 0; i < 100 && !url; i++) { url = c.lines.find((l) => l.startsWith(idp.base + '/authorize')); if (!url) await new Promise((r) => setTimeout(r, 20)); }
  assert.ok(url, 'the address was printed');
  assert.match(url, /code_challenge=/);
  await browser()(url);
  const res = await run;
  assert.equal(res.code, 0);
  const state = new URL(url).searchParams.get('state');
  assert.equal(res.lines === undefined, true);
  assert.equal(c.lines.filter((l) => l.includes(state)).length, 1, 'the state appears once, in the address, and nowhere else');
  assert.equal(JSON.stringify(res.evidence).includes(state), false);
});

test('the leak guard is not blind: a line that would show a secret is withheld, and the run fails', () => {
  const printed = [];
  const rec = spike.makeRecorder((l) => printed.push(l));
  rec.track('access_token', 'SUPERSECRETTOKENVALUE');
  rec.say('here it is: SUPERSECRETTOKENVALUE');
  assert.equal(rec.blocked, 1);
  assert.equal(printed.join('\n').includes('SUPERSECRETTOKENVALUE'), false);
  rec.facts.leak = 'SUPERSECRETTOKENVALUE';
  // finish() is exercised through a run in the tests above; here only the scan itself
  assert.deepEqual(rec.found('x SUPERSECRETTOKENVALUE y'), ['access_token']);
});

// ─── device flow ────────────────────────────────────────────────────────────

const deviceProvider = (idp) => ({ strategy: 'device', label: 'StandinGH', mcp: `${idp.base}/mcp`, hosts: [idp.host], deviceEndpoint: `${idp.base}/login/device/code`, tokenEndpoint: `${idp.base}/login/oauth/access_token`, scope: 'repo' });

test('device: pending, then slow_down (the wait grows), then success; a refresh needs no client secret', async (t) => {
  const idp = await startStageAIdp(t);
  idp.device.expiring = true;
  const waits = [];
  const { c, d } = setup({ sleep: async (ms) => { waits.push(ms); } });
  const res = await spike.runDevice(deviceProvider(idp), { clientId: 'Iv1.stand-in-client', tool: 'search' }, d);
  assert.equal(res.code, 0, c.lines.join('\n'));
  assert.deepEqual(waits, [5000, 10000, 10000], 'one wait before each of three polls: the server\'s interval first, then the larger one slow_down asked for');
  assert.equal(res.facts.token.slowDowns, 1);
  assert.equal(res.facts.token.polls, 3);
  assert.equal(statusOf(res, 'refresh'), 'PASS');
  assert.equal(res.facts.refresh.rotated, true);
  assert.equal(statusOf(res, 'mcp.tool_call'), 'PASS');
  assert.equal(statusOf(res, 'revoke'), 'INFO');
  assert.match(detailOf(res, 'revoke'), /need the app's client SECRET/);
  assert.ok(c.lines.some((l) => l.includes('ABCD-1234')), 'the code to type is shown');
  for (const secret of [...everything(idp), idp.device.deviceCode]) assert.equal(c.lines.join('\n').includes(secret), false);
  for (const r of idp.log.filter((x) => x.path.startsWith('/login'))) assert.equal('client_secret' in r.form, false);
});

test('device: when refresh needs the secret the tool says so', async (t) => {
  const idp = await startStageAIdp(t);
  idp.device.expiring = true; idp.device.secretForRefresh = true;
  const res = await spike.runDevice(deviceProvider(idp), { clientId: 'Iv1.stand-in-client' }, setup({ sleep: async () => {} }).d);
  assert.equal(statusOf(res, 'refresh'), 'FAIL');
  assert.match(detailOf(res, 'refresh'), /incorrect_client_credentials/);
});

test('device: a non-expiring token has nothing to refresh, and that is said', async (t) => {
  const idp = await startStageAIdp(t);
  const res = await spike.runDevice(deviceProvider(idp), { clientId: 'Iv1.stand-in-client' }, setup({ sleep: async () => {} }).d);
  assert.equal(res.code, 0);
  assert.equal(statusOf(res, 'refresh'), 'INFO');
});

test('device: flow disabled, denied, expired and a missing client id are each a clear failure', async (t) => {
  for (const [mode, expect] of [['disabled', /device_flow_disabled.*Enable Device Flow/], ['denied', /access_denied/], ['expired', /expired_token/]]) {
    const idp = await startStageAIdp(t);
    idp.device.mode = mode;
    const res = await spike.runDevice(deviceProvider(idp), { clientId: 'Iv1.stand-in-client' }, setup({ sleep: async () => {} }).d);
    assert.equal(res.code, 1, mode);
    assert.match(detailOf(res, mode === 'disabled' ? 'device_code' : 'device_poll'), expect, mode);
  }
  const idp = await startStageAIdp(t);
  const res = await spike.runDevice(deviceProvider(idp), {}, setup().d);
  assert.equal(statusOf(res, 'setup'), 'FAIL');
  assert.equal(idp.log.length, 0);
});

// ─── authorization code + PKCE with your own client (Google) ────────────────

const pkceProvider = (idp, over = {}) => ({
  strategy: 'pkce', label: 'StandinG', mcp: `${idp.base}/mcp`, hosts: [idp.host], issuer: idp.base,
  authorizationEndpoint: `${idp.base}/authorize`, tokenEndpoint: `${idp.base}/token`, revokeEndpoint: `${idp.base}/revoke`,
  authorizeParams: { access_type: 'offline', prompt: 'consent' }, issRequired: true, scope: 'cal.read cal.events', ...over
});
const CLIENT = 'desktop-client-id.apps.test';
const SECRET = 'GOCSPX-' + 'stand-in-secret-value-0001';   // two pieces: see test/audit-store.test.cjs (push protection)

test('pkce: without the secret a provider that wants one says so, and the tool tells you how to learn more', async (t) => {
  const idp = await startStageAIdp(t, { tokenAuth: 'secret-required' });
  idp.addClient({ id: CLIENT, secret: SECRET, loopbackAnyPort: true });
  const res = await spike.runPkce(pkceProvider(idp), { clientId: CLIENT, secret: 'none' }, setup().d);
  assert.equal(res.code, 1);
  assert.equal(statusOf(res, 'token'), 'FAIL');
  assert.match(detailOf(res, 'token'), /invalid_request/);
  assert.match(detailOf(res, 'token'), /--secret prompt/);
  assert.equal(res.facts.token.secretSent, false);
});

test('pkce: with the secret typed at the hidden prompt the exchange works, and the secret is shown nowhere', async (t) => {
  const idp = await startStageAIdp(t, { tokenAuth: 'secret-required' });
  idp.addClient({ id: CLIENT, secret: SECRET, loopbackAnyPort: true });
  const evidence = tmpFile(t, 'evidence.json');
  const asked = [];
  const { c, d } = setup({ promptSecret: async (label, o) => { asked.push([label, o]); return SECRET; } });
  const res = await spike.runPkce(pkceProvider(idp), { clientId: CLIENT, secret: 'prompt', tool: 'search', evidence }, d);
  assert.equal(res.code, 0, c.lines.join('\n'));
  assert.equal(asked.length, 1);
  assert.equal(asked[0][1].hidden, true, 'the prompt does not echo');
  assert.equal(res.facts.token.secretSent, true);
  assert.equal(statusOf(res, 'refresh'), 'PASS');
  assert.equal(res.facts.refresh.secretSent, true, 'the refresh carried the secret too');
  assert.equal(statusOf(res, 'revoke'), 'PASS');
  const all = c.lines.join('\n') + fs.readFileSync(evidence, 'utf8');
  assert.equal(all.includes(SECRET), false, 'the client secret is in neither the output nor the evidence');
  const carrying = idp.log.filter((r) => r.rawBody.includes(SECRET));
  assert.deepEqual([...new Set(carrying.map((r) => r.path))], ['/token'], 'it travelled only in the token request body');
  const authReq = idp.requests('/authorize')[0].query;
  assert.equal(authReq.access_type, 'offline');
  assert.equal(authReq.scope, 'cal.read cal.events');
  assert.match(authReq.redirect_uri, /^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/);
});

test('pkce: a provider whose public client needs no secret passes without one', async (t) => {
  const idp = await startStageAIdp(t);
  idp.addClient({ id: CLIENT, secret: null, loopbackAnyPort: true });
  const res = await spike.runPkce(pkceProvider(idp), { clientId: CLIENT, secret: 'none' }, setup().d);
  assert.equal(res.code, 0);
  assert.equal(res.facts.token.secretSent, false);
});

test('pkce: an authorization address on a host the provider is not pinned to is refused before the browser opens', async (t) => {
  const idp = await startStageAIdp(t);
  let opened = 0;
  const { d } = setup({ openUrl: async () => { opened++; } });
  const res = await spike.runPkce(pkceProvider(idp, { authorizationEndpoint: 'https://evil.example/auth' }), { clientId: CLIENT }, d);
  assert.equal(res.code, 1);
  assert.match(detailOf(res, 'run'), /evil\.example is not one of/);
  assert.equal(opened, 0);
});

test('pkce: a fixed redirect port (for a Web client whose redirect URI is registered exactly) is used as given', async (t) => {
  const idp = await startStageAIdp(t);
  idp.addClient({ id: CLIENT, secret: null, loopbackAnyPort: true });
  const free = await new Promise((resolve) => { const s = http.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  const res = await spike.runPkce(pkceProvider(idp), { clientId: CLIENT, redirectPort: free }, setup().d);
  assert.equal(res.code, 0);
  assert.equal(new URL(idp.requests('/authorize')[0].query.redirect_uri).port, String(free));
});

test('pkce: --secret prompt without a terminal is a clear refusal, not a read from a pipe', async (t) => {
  const idp = await startStageAIdp(t);
  const { d } = setup({ promptSecret: async () => { throw new Error('this needs a terminal'); } });
  const res = await spike.runPkce(pkceProvider(idp), { clientId: CLIENT, secret: 'prompt' }, d);
  assert.equal(res.code, 1);
  assert.match(detailOf(res, 'setup'), /needs a terminal/);
  assert.equal(idp.log.length, 0);
});

// ─── the command line ───────────────────────────────────────────────────────

test('the command line: options are read, bad JSON and unknown providers are usage errors, and nothing goes out', async () => {
  const args = spike.parseArgs(['dcr', 'notion', '--tool', 'notion-search', '--args', '{"query":"x"}', '--no-open', '--reuse-probe', '--evidence', '/tmp/e.json']);
  assert.deepEqual(args._, ['dcr', 'notion']);
  const o = spike.optionsFrom(args);
  assert.equal(o.tool, 'notion-search');
  assert.deepEqual(o.args, { query: 'x' });
  assert.equal(o.noOpen, true);
  assert.equal(o.reuseProbe, true);
  assert.equal(o.secret, 'none');
  assert.throws(() => spike.optionsFrom(spike.parseArgs(['dcr', 'notion', '--args', '{nope'])), /must be JSON/);
  const quiet = console.error; console.error = () => {};
  try {
    assert.equal(await spike.main(['dcr', 'no-such-provider']), 2);
    assert.equal(await spike.main(['dcr', 'github']), 2, 'github uses the device method');
    assert.equal(await spike.main(['device', 'notion']), 2);
    assert.equal(await spike.main(['bogus']), 2);
    assert.equal(await spike.main(['dcr', 'notion', '--args', '{bad']), 2);
  } finally { console.error = quiet; }
});
