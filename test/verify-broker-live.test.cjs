'use strict';

/**
 * The Phase 4 live gate (tools/verify-broker-live.cjs), run against STAND-INS.
 *
 * What these tests are for: before the gate is pointed at a real provider it has to be shown to
 *   • pass when the broker behaves, on a stand-in that behaves like the real thing,
 *   • FAIL when the broker is broken (a gate that cannot fail is not a gate),
 *   • never put a secret into its output or its evidence, and
 *   • keep its terminal prompt for the client secret from echoing it.
 * Nothing here says anything about Google or Slack.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const { startIdp } = require('./fixtures/oauth-idp.cjs');
const { makeEnv } = require('./fixtures/oauth-env.cjs');
const { startOauthMcpServer } = require('./fixtures/phase3-env.cjs');
const loadTs = require('./load-ts.cjs');
const { runGate, clientIdProblem, clientSecretProblem } = require('../tools/verify-broker-live.cjs');

const { OAuthController } = loadTs('src/main/oauth/controller.ts');
const { safeLog } = loadTs('src/main/oauth/types.ts');
const { disconnectBridged } = loadTs('src/main/mcpDisconnect.ts');
const { McpAuthVault } = loadTs('src/main/mcpAuthVault.ts');
const { mcpCatalogEntry, mcpOauthRef } = loadTs('src/shared/mcpCatalog.ts');

const TOOLS = [
  { name: 'list_things', description: 'lists', annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }, inputSchema: { type: 'object', properties: {} } },
  { name: 'get_thing', description: 'reads one', annotations: { readOnlyHint: true, destructiveHint: false }, inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
  { name: 'create_thing', description: 'writes', annotations: { readOnlyHint: false, destructiveHint: false }, inputSchema: { type: 'object', required: ['name'] } },
  { name: 'delete_thing', description: 'deletes', annotations: { readOnlyHint: false, destructiveHint: true }, inputSchema: { type: 'object', required: ['id'] } },
  { name: 'send_thing', description: 'sends', annotations: { readOnlyHint: false, destructiveHint: true }, inputSchema: { type: 'object', required: ['to'] } }
];
const host = (u) => new URL(u).host;

/** The account-mode gate against a stand-in OAuth provider and a stand-in MCP server. */
async function accountGate(t, over = {}) {
  const idp = await startIdp(t, over.idp);
  const env = await makeEnv(t, idp, { ids: ['gmail'], timeouts: { retryDelaysMs: [0, 0], cooldownMs: 50, refreshMs: 3000 } });
  const mcp = await startOauthMcpServer(t, idp, { tools: over.tools ?? TOOLS });
  const lines = [];
  const captured = { access: [], refresh: [], clientSecret: env.secrets.map.get('mcp:gmail:client_secret') };
  const controllerOver = (secrets, extraOffset = 0) => new OAuthController({
    entry: (id) => mcpCatalogEntry(id),
    secrets,
    fetch: (u, i) => fetch(u, i), openUrl: async () => {}, now: () => env.clock.now + extraOffset, log: safeLog(() => {}),
    policy: { allowInsecureLoopback: true },
    specOverride: () => idp.spec({ scope: mcpCatalogEntry('gmail').spec.oauth.scope }),
    portOverride: () => env.ports.gmail,
    timeouts: { refreshMs: 3000, retryDelaysMs: [0, 0], cooldownMs: 50 }
  });
  const vault = new McpAuthVault(() => fs.mkdtempSync(path.join(os.tmpdir(), 'gate-vault-')), { get: (r) => env.secrets.get(r), set: (r, v) => env.secrets.set(r, v), delete: (r) => env.secrets.delete(r) });
  const res = await runGate({
    id: 'gmail', url: mcp.url, target: 'stand-in',
    provider: env.controller.provider, controller: env.controller,
    allowHosts: [host(idp.issuer), host(mcp.url)], allowInsecureLoopback: true,
    tokenEndpoint: `${idp.issuer}/token`, revokeEndpoint: idp.revokeSpec().url,
    log: (l) => lines.push(l),
    watch: [captured.clientSecret],
    hooks: {
      advanceClock: (ms) => env.clock.advance(ms),
      clientCredentials: () => (env.secrets.map.get('mcp:gmail:client_id') ? { clientId: env.secrets.map.get('mcp:gmail:client_id'), clientSecret: env.secrets.map.get('mcp:gmail:client_secret') } : undefined),
      restartCheck: async () => {
        const c2 = controllerOver({ get: (r) => env.secrets.get(r), set: (r, v) => env.secrets.set(r, v), has: (r) => env.secrets.has(r), readable: () => true });
        const r = { status: c2.status('gmail'), hasTokens: c2.hasTokens('gmail') };
        c2.dispose();
        return r;
      },
      failureProvider: async () => {
        const mem = new Map([
          ['mcp:gmail:client_id', env.secrets.map.get('mcp:gmail:client_id')], ['mcp:gmail:client_secret', 'gate-wrong-client-secret'],
          [mcpOauthRef('gmail'), env.secrets.map.get(mcpOauthRef('gmail'))]
        ]);
        const c3 = controllerOver({ get: (r) => mem.get(r), set: (r, v) => { mem.set(r, v); return { ok: true }; }, has: (r) => mem.has(r), readable: () => true }, 2 * 3_600_000);
        return { provider: c3.provider, status: () => c3.status('gmail'), dispose: () => c3.dispose() };
      },
      disconnect: ({ onDisconnected }) => {
        const rec = env.secrets.map.get(mcpOauthRef('gmail'));
        if (rec) { const j = JSON.parse(rec); captured.access.push(j.accessToken); captured.refresh.push(j.refreshToken); }
        return disconnectBridged({
          cancelSignIn: (x) => env.controller.cancel(x), vault,
          revoke: async () => ({ attempted: 0, confirmed: 0 }),
          secrets: { delete: (r) => env.secrets.delete(r), has: (r) => env.secrets.has(r) },
          broker: { hasTokens: (x) => env.controller.hasTokens(x), revoke: (x) => env.controller.revoke(x), forget: (x) => env.controller.forget(x) },
          onDisconnected
        }, mcpCatalogEntry('gmail'));
      }
    }
  });
  await Promise.all(env.pendingBrowse);
  return { res, lines, env, idp, mcp, captured };
}

const stepOf = (res, n) => res.steps.find((s) => s.n === n);

test('ACCOUNT MODE against a well-behaved stand-in: every step runs and passes, nothing is skipped', async (t) => {
  const { res, lines, idp, mcp } = await accountGate(t);
  const bad = res.steps.filter((s) => s.ok !== true);
  assert.deepEqual(bad.map((s) => `${s.n} ${s.step} :: ${s.detail}`), [], lines.join('\n'));
  assert.equal(res.ok, true);
  assert.equal(res.skipped, 0);
  assert.ok(res.steps.length >= 38, `the checklist is the whole checklist (${res.steps.length} steps)`);
  // sanity: it really did go through the provider and the server
  assert.ok(idp.tokenRequests('authorization_code').length >= 1 && idp.tokenRequests('refresh_token').length >= 2);
  assert.ok(mcp.seen.some((r) => r.rpc && r.rpc.method === 'tools/call' && r.rpc.params.name === 'list_things'));
});

test('ACCOUNT MODE: only the ONE chosen read-only tool is ever called upstream; no write tool, ever', async (t) => {
  const { res, mcp } = await accountGate(t);
  assert.equal(res.ok, true);
  const called = mcp.seen.filter((r) => r.rpc && r.rpc.method === 'tools/call').map((r) => r.rpc.params.name);
  assert.ok(called.length >= 4);
  assert.deepEqual([...new Set(called)], ['list_things'], `upstream tool calls: ${[...new Set(called)]}`);
  assert.equal(stepOf(res, '4.2').ok, true);
  assert.match(stepOf(res, '4.2').step, /list_things/, 'the first read-only tool with no required argument');
});

test('ACCOUNT MODE: the evidence records the real tool shapes and what the broker does with each', async (t) => {
  const { res } = await accountGate(t);
  const byName = Object.fromEntries(res.facts.tools.map((x) => [x.name, x]));
  assert.deepEqual(Object.keys(byName).sort(), TOOLS.map((x) => x.name).sort());
  for (const x of res.facts.tools) assert.equal(x.classNow, 'destructive', 'nothing is pinned, so today every tool is unclassified');
  assert.equal(byName.list_things.classIfAnnotationsTrusted, 'read');
  assert.equal(byName.create_thing.classIfAnnotationsTrusted, 'write');
  assert.equal(byName.delete_thing.classIfAnnotationsTrusted, 'destructive');
  assert.deepEqual(byName.get_thing.requiredArgs, ['id']);
  assert.equal(res.facts.framing.toolsList.contentType.startsWith('application/json'), true);
  assert.equal(res.facts.framing.toolsList.streamed, false);
});

test('ACCOUNT MODE: a provider that streams its tool list is handled and recorded as streamed', async (t) => {
  const idp = await startIdp(t);
  const env = await makeEnv(t, idp, { ids: ['gmail'], timeouts: { retryDelaysMs: [0, 0], cooldownMs: 50 } });
  const mcp = await startOauthMcpServer(t, idp, { tools: TOOLS, listAsStream: true });
  const res = await runGate({
    id: 'gmail', url: mcp.url, target: 'stand-in', provider: env.controller.provider, controller: env.controller,
    allowHosts: [host(idp.issuer), host(mcp.url)], allowInsecureLoopback: true, tokenEndpoint: `${idp.issuer}/token`,
    hooks: { advanceClock: (ms) => env.clock.advance(ms) }, log: () => {}
  });
  await Promise.all(env.pendingBrowse);
  assert.equal(res.facts.framing.toolsList.streamed, true);
  assert.equal(stepOf(res, '5.2').ok, true, '…and the filtered list still comes back as exactly one tool');
  assert.equal(res.facts.tools.length, TOOLS.length);
});

test('THE EVIDENCE AND THE OUTPUT hold no secret: not the client secret, not a token, not a capability', async (t) => {
  const { res, lines, captured } = await accountGate(t);
  const everything = JSON.stringify(res) + lines.join('\n');
  assert.ok(captured.access.length && captured.refresh.length && captured.clientSecret);
  for (const s of [...captured.access, ...captured.refresh, captured.clientSecret]) assert.equal(everything.includes(s), false, 'a secret reached the output');
  assert.equal(stepOf(res, 'N.1').ok, true);
  assert.match(stepOf(res, 'N.1').detail, /searched \d+ secret values/);
  assert.equal(/Bearer\s+\S{12,}/.test(everything), false, 'no bearer value of any kind is printed');
});

test('THE LEAK SCAN IS NOT BLIND: a planted secret that the run saw gets the gate to FAIL', async (t) => {
  const PLANT = 'SECRET-PLANTED-xyz-9876543210';
  // a server that (wrongly) echoes the credential it was given into a tool result, which an agent then sees
  const srv = http.createServer((req, res) => {
    const chunks = []; req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const m = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      res.writeHead(200, { 'content-type': 'application/json' });
      if (m.method === 'tools/list') return res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'echo', annotations: { readOnlyHint: true, destructiveHint: false }, inputSchema: { type: 'object' } }] } }));
      if (m.method === 'tools/call') return res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: `you sent ${req.headers.authorization}` }] } }));
      res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: {} }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => { srv.closeAllConnections?.(); srv.close(); });
  const url = `http://127.0.0.1:${srv.address().port}/mcp`;
  const res = await runGate({
    id: 'gmail', url, target: 'stand-in', allowHosts: [host(url)], allowInsecureLoopback: true,
    provider: { accessHeaders: () => ({ ok: true, headers: { Authorization: `Bearer ${PLANT}` } }) },
    watch: [PLANT], log: () => {}
  });
  assert.equal(stepOf(res, 'N.1').ok, false, 'the scan must find a secret that an agent was shown');
  assert.equal(res.ok, false);
});

// ─── no account: what can be checked with no credentials at all ──────────────

/** A server like Google's: initialize and tools/list are open, a tool call needs a token, and says so with a 401. */
async function openListServer(t, { tools = TOOLS, listOpen = true } = {}) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    const chunks = []; req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let m = {}; try { m = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { /* noop */ }
      seen.push({ method: req.method, rpc: m.method, tool: m.params && m.params.name, auth: req.headers.authorization });
      const deny = () => { res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer error="invalid_token"' }); res.end(JSON.stringify({ id: m.id, jsonrpc: '2.0', result: { content: [{ text: 'Request had invalid authentication credentials. See https://developers.google.com/identity' }], isError: true } })); };
      if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
      if (m.method === 'initialize') { res.writeHead(200, { 'content-type': 'application/json; charset=UTF-8' }); return res.end(JSON.stringify({ id: m.id, jsonrpc: '2.0', result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'StatelessServer' } } })); }
      if (m.method === 'tools/list') { if (!listOpen) return deny(); res.writeHead(200, { 'content-type': 'application/json; charset=UTF-8' }); return res.end(JSON.stringify({ id: m.id, jsonrpc: '2.0', result: { tools } })); }
      if (m.method === 'tools/call') return deny();
      res.writeHead(202); res.end();
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => { srv.closeAllConnections?.(); srv.close(); });
  return { url: `http://127.0.0.1:${srv.address().port}/mcp`, seen };
}
const noCredentials = { accessHeaders: () => ({ ok: true, headers: {} }) };

test('NO ACCOUNT, a Google-like server: everything that needs no account passes; everything that does is SKIPPED, not passed', async (t) => {
  const s = await openListServer(t);
  const res = await runGate({ id: 'gmail', url: s.url, target: 'stand-in', provider: noCredentials, allowHosts: [host(s.url)], allowInsecureLoopback: true, log: () => {} });
  assert.deepEqual(res.steps.filter((x) => x.ok === false).map((x) => `${x.n} ${x.detail}`), []);
  assert.equal(res.ok, true);
  for (const n of ['1.1', '1.3', '10.1', '10.3', '10.5', '11.1', '11.4']) assert.equal(stepOf(res, n).ok, null, `${n} must be SKIPPED without an account`);
  for (const n of ['2.1', '2.4', '3.1', '3.2', '5.2', '6.1', '6.2', '7.1', '7.3', '7.4', '8.1', '8.2', '8.3', '9.1', '10.2']) assert.equal(stepOf(res, n).ok, true, `${n}: ${stepOf(res, n).step}`);
  assert.equal(res.facts.tools.length, TOOLS.length);
  assert.equal(res.facts.probes.get.status, 405);
});

test('NO ACCOUNT, a Slack-like server that wants a token for everything: the steps that need one are skipped, the refusals still pass', async (t) => {
  const s = await openListServer(t, { listOpen: false });
  const res = await runGate({ id: 'slack', url: s.url, target: 'stand-in', provider: noCredentials, allowHosts: [host(s.url)], allowInsecureLoopback: true, log: () => {} });
  assert.equal(res.ok, true, res.steps.filter((x) => x.ok === false).map((x) => `${x.n} ${x.detail}`).join('; '));
  assert.equal(stepOf(res, '2.4').ok, null);
  assert.equal(res.facts.tools.length, 0);
  for (const n of ['3.1', '3.2', '8.1', '8.2', '8.3']) assert.equal(stepOf(res, n).ok, true, `${n}: ${stepOf(res, n).step}`);
  assert.equal(s.seen.some((r) => r.rpc === 'tools/call'), false, 'no tool call went upstream while nothing was granted');
});

// ─── the gate must FAIL when the broker is broken ────────────────────────────

test('SENSITIVITY: a broker that lets ungranted tools through makes the gate FAIL', async (t) => {
  const { McpRoute } = loadTs('src/main/broker/mcp-route.ts');
  const original = McpRoute.prototype.decide;
  McpRoute.prototype.decide = function () { return { allow: true }; };           // the bug under test: everything is permitted
  t.after(() => { McpRoute.prototype.decide = original; });
  const s = await openListServer(t);
  const res = await runGate({ id: 'gmail', url: s.url, target: 'stand-in', provider: noCredentials, allowHosts: [host(s.url)], allowInsecureLoopback: true, log: () => {} });
  McpRoute.prototype.decide = original;
  assert.equal(res.ok, false);
  assert.equal(stepOf(res, '8.1').ok, false, 'the ungranted tools were not refused');
  assert.equal(stepOf(res, '8.2').ok, false, 'and they reached the provider');
  assert.ok(s.seen.filter((r) => r.rpc === 'tools/call').length > 3, 'the stand-in saw them');
});

test('SENSITIVITY: a broker that serves an agent with no grant makes the gate FAIL', async (t) => {
  const perms = loadTs('src/main/broker/permissions.ts');
  const original = perms.effectiveGrant;
  perms.effectiveGrant = () => ({ preset: 'write' });                            // the bug under test: no grant means "write"
  t.after(() => { perms.effectiveGrant = original; });
  const s = await openListServer(t);
  const res = await runGate({ id: 'gmail', url: s.url, target: 'stand-in', provider: noCredentials, allowHosts: [host(s.url)], allowInsecureLoopback: true, log: () => {} });
  perms.effectiveGrant = original;
  assert.equal(res.ok, false);
  assert.equal(stepOf(res, '3.1').ok, false, 'deny-by-default was not enforced');
});

test('SENSITIVITY: a broker that hands out ONE capability to two agents makes the isolation step FAIL', async (t) => {
  const { CapabilityRegistry } = loadTs('src/main/broker/capabilities.ts');
  const original = CapabilityRegistry.prototype.grant;
  let shared;
  CapabilityRegistry.prototype.grant = function (agentId, channel, ids) { const tok = original.call(this, agentId, channel, ids); if (channel === 'mcp') { shared = shared ?? tok; return shared; } return tok; };
  t.after(() => { CapabilityRegistry.prototype.grant = original; });
  const s = await openListServer(t);
  const res = await runGate({ id: 'gmail', url: s.url, target: 'stand-in', provider: noCredentials, allowHosts: [host(s.url)], allowInsecureLoopback: true, log: () => {} });
  CapabilityRegistry.prototype.grant = original;
  assert.equal(res.ok, false, 'B holding A\'s capability can do what A can');
});

test('SAFETY: the gate refuses to talk to any host it was not told about', async (t) => {
  const s = await openListServer(t);
  const res = await runGate({ id: 'gmail', url: s.url, target: 'stand-in', provider: noCredentials, allowHosts: ['127.0.0.1:1'], allowInsecureLoopback: true, log: () => {} });
  assert.equal(res.calls, 0, 'nothing was sent to a host outside the allow-list');
  assert.equal(s.seen.length, 0);
});

// ─── the terminal prompt ────────────────────────────────────────────────────

test('the client secret prompt does not echo what is typed (driven through a real pseudo-terminal)', () => {
  const py = `
import os, pty, sys, time, select
tool = ${JSON.stringify(path.join(__dirname, '..', 'tools', 'verify-broker-live.cjs'))}
code = "const {promptLine}=require(" + repr(tool).replace("'", '"') + ");(async()=>{const id=await promptLine('ID: ');const s=await promptLine('SECRET: ',{hidden:true});console.log('GOT id='+id.length+' secret='+s.length);process.exit(0)})()"
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[1], [sys.argv[1], '-e', code])
out = b''
def pump(t=1.0):
    global out
    end = time.time() + t
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.1)
        if r:
            try: out += os.read(fd, 4096)
            except OSError: return
pump(1.5)
os.write(fd, b'client-id-123\\r'); pump(0.6)
os.write(fd, b'S3cr3t-VALUE-never-echoed\\r'); pump(1.5)
sys.stdout.write(out.decode('utf8', 'replace'))
`;
  const r = spawnSync('python3', ['-c', py, process.execPath], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /GOT id=13 secret=25/, 'both values were read');
  assert.equal(r.stdout.includes('S3cr3t-VALUE-never-echoed'), false, 'the secret was echoed to the terminal');
  assert.equal(r.stdout.includes('client-id-123'), true, 'the (non-secret) client id is echoed, as typed text is');
});

test('the prompt refuses to run without a terminal rather than reading a secret from a pipe', async () => {
  const { promptLine } = require('../tools/verify-broker-live.cjs');
  await assert.rejects(promptLine('x: ', { hidden: true, input: { isTTY: false } }), /needs a terminal/);
});

test('INPUT CHECK: text pasted from the wrong place is refused as a client ID or secret before anything is stored or a browser is opened', () => {
  // Invented IDs and secrets in the shapes the checks accept or refuse, written in two pieces so that no complete
  // client-ID or secret-shaped literal sits in the source: GitHub push protection reads a whole one as a real credential.
  const GOOGLE = '.apps.googleusercontent.com';
  const goodGoogle = ['123456789012-abc123def456_ghi' + GOOGLE, '1-a' + GOOGLE];
  for (const v of goodGoogle) assert.equal(clientIdProblem('google-calendar', v), null, v);
  for (const id of ['gmail', 'google-drive']) assert.equal(clientIdProblem(id, goodGoogle[0]), null);
  assert.equal(clientIdProblem('slack', '1234567890123.1234567890123'), null);
  const wrong = [
    '', '   ', 'No integration credentials are stored here, so the real-account steps will need you.',
    'https://console.cloud.google.com/apis/credentials', '/Users/me/client.json', 'my-client-id', '123456789012-abc' + GOOGLE + ' extra',
    '123456789012-abc' + GOOGLE + '\n', 'x'.repeat(300), '1234567890123.1234567890123'
  ];
  for (const v of wrong) assert.ok(clientIdProblem('gmail', v), JSON.stringify(v).slice(0, 60));
  assert.ok(clientIdProblem('slack', goodGoogle[0]), 'a Google ID is not a Slack ID');
  assert.ok(clientIdProblem('slack', 'a sentence with spaces'));
  // the reason never contains what was typed
  for (const v of wrong.filter((x) => x.trim())) assert.equal((clientIdProblem('gmail', v) || '').includes(v.trim()), false);
  for (const v of ['GOCSPX-' + 'abcdefghijklmnopqrstuvwxyz12', 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4', '12345678']) assert.equal(clientSecretProblem(v), null, v);
  for (const v of ['', 'short', 'two words here that are long enough', 'x'.repeat(300), 'line\nbreak-with-long-text']) assert.ok(clientSecretProblem(v), JSON.stringify(v).slice(0, 40));
});
