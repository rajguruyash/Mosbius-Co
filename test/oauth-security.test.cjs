'use strict';

/**
 * Security properties of the in-app OAuth engine, checked across every code path:
 *
 *   • no secret — client secret, authorization code, PKCE verifier, state, access or
 *     refresh token, or anything a provider or an attacker typed — appears in a log
 *     line, console output, an error or status result, a page shown in the browser,
 *     a process argument, or an agent's configuration;
 *   • the engine starts no process;
 *   • tokens exist in one place only: the encrypted store, under the record's ref;
 *   • the engine switch defaults to the bridge, and the app never relaxes the rules
 *     that exist for the test suite.
 *
 * The leak scan works by planting recognisable secrets, driving success AND failure
 * through every path, and then searching everything that could have carried them.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const { startIdp } = require('./fixtures/oauth-idp.cjs');
const { makeEnv, rawGet, browse, until } = require('./fixtures/oauth-env.cjs');
const loadTs = require('./load-ts.cjs');

const { safeLog } = loadTs('src/main/oauth/types.ts');
const { engineFor, sanitizeMcpEngine } = loadTs('src/main/mcpEngine.ts');
const { MCP_CATALOG, mcpCatalogEntry, mcpOauthRef, mcpSecretRefs } = loadTs('src/shared/mcpCatalog.ts');
const { disconnectBridged } = loadTs('src/main/mcpDisconnect.ts');
const { McpAuthVault } = loadTs('src/main/mcpAuthVault.ts');
const { HiveManager } = loadTs('src/main/hive.ts');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const OAUTH_SOURCES = fs.readdirSync(path.join(root, 'src/main/oauth')).filter((n) => n.endsWith('.ts')).map((n) => `src/main/oauth/${n}`);

// ─── the leak scan ──────────────────────────────────────────────────────────

/** Everything we planted or that was issued, which must never show up in output. */
function secretsOf(idp, extra = []) {
  const found = new Set(extra);
  for (const r of idp.log) {
    for (const k of ['code', 'code_verifier', 'refresh_token', 'client_secret']) if (r.form?.[k]) found.add(r.form[k]);
    if (r.form?.token) found.add(r.form.token);
  }
  for (const k of idp.access.keys()) found.add(k);
  for (const k of idp.grants.keys()) found.add(k);
  return [...found].filter((s) => s && s.length >= 8);
}

const HOSTILE = ['HOSTILE-CODE-9f3a', 'HOSTILE-STATE-77be', 'HOSTILE-DESC-c41d', 'HOSTILE-ISS-02aa'];

test('LEAK SCAN: every path, success and failure, leaves no secret in any log, result, page, argument or console line', async (t) => {
  const spawned = [];
  for (const fn of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    const real = childProcess[fn];
    childProcess[fn] = (...args) => { spawned.push([fn, args[0]]); return real.apply(childProcess, args); };
    t.after(() => { childProcess[fn] = real; });
  }
  const consoleLines = [];
  for (const m of ['log', 'info', 'warn', 'error', 'debug']) {
    const real = console[m];
    console[m] = (...a) => { consoleLines.push(a.map(String).join(' ')); };
    t.after(() => { console[m] = real; });
  }

  const idp = await startIdp(t, { rotate: true });
  const env = await makeEnv(t, idp, { ids: ['gmail', 'google-calendar', 'google-drive'], browser: null, timeouts: { timeoutMs: 400, exchangeTimeoutMs: 250, retryDelaysMs: [0] } });
  const results = [];     // every value any engine call returned to its caller (failures; successes carry no token)
  const pages = [];       // every page a browser was shown
  const record = (r) => { results.push(JSON.stringify(r)); return r; };

  // 1. a successful sign-in, with hostile junk thrown at the listener while it waits
  const a = env.controller.signIn('gmail');
  await until(() => env.opened.length === 1);
  const port = env.ports.gmail;
  const state = new URL(env.opened[0]).searchParams.get('state');
  for (const q of [
    `?state=${HOSTILE[1]}&code=${HOSTILE[0]}&error_description=${HOSTILE[2]}&iss=${HOSTILE[3]}`,
    `?state=${state}x&code=${HOSTILE[0]}`, `?${HOSTILE[2]}=1`
  ]) pages.push((await rawGet(port, `/oauth/callback${q}`)).body);
  const done = await browse(env.opened[0], env);
  pages.push(done.callback.body);
  record(await a);

  // 2. the user refuses, the provider errors, the exchange fails in several ways
  const attempt = async (id) => {
    const before = env.opened.length;
    const p = env.controller.signIn(id);
    await until(() => env.opened.length > before);
    const landed = await browse(env.opened[env.opened.length - 1], env);
    if (landed.callback) pages.push(landed.callback.body);
    return record(await p);
  };
  idp.consent = 'deny';
  await attempt('google-calendar');
  idp.consent = 'approve';
  for (const injected of [{ status: 400, body: { error: 'invalid_grant' } }, { status: 500, body: {} }, { status: 200, body: { access_token: 'bad token' } }]) {
    idp.inject('token', injected);
    await attempt('google-drive');
  }

  // 3. refresh: success with rotation, a transient failure, a permanent one
  env.clock.advance(3600_000);
  record(await env.controller.provider.accessHeaders({ id: 'gmail' }).then((r) => (r.ok ? { ok: true } : r)));
  env.clock.advance(3600_000);
  idp.inject('token', { status: 503, body: {} }, 2);
  record(await env.controller.provider.accessHeaders({ id: 'gmail' }));
  env.clock.advance(1000);
  const rt = JSON.parse(env.secrets.map.get(mcpOauthRef('gmail'))).refreshToken;
  idp.revokeGrant(rt);
  env.clock.advance(3600_000);
  record(await env.controller.provider.accessHeaders({ id: 'gmail' }));
  record({ status: env.controller.status('gmail') });

  // 4. tokens that cannot be stored; then disconnect
  env.secrets.failSet = true;
  const d = env.controller.signIn('google-drive');
  await until(() => env.opened.length > 2);
  await browse(env.opened[env.opened.length - 1], env);
  record(await d);
  env.secrets.failSet = false;
  const vaultBase = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'md-leak-')), 'mcp-auth');
  t.after(() => fs.rmSync(path.dirname(vaultBase), { recursive: true, force: true }));
  record(await disconnectBridged({
    cancelSignIn: (id) => env.controller.cancel(id),
    vault: new McpAuthVault(() => vaultBase, { get: env.secrets.get, set: env.secrets.set, delete: (r) => env.secrets.delete(r) }),
    revoke: async () => ({ attempted: 0, confirmed: 0 }),
    secrets: { delete: (r) => env.secrets.delete(r), has: (r) => env.secrets.has(r) },
    broker: { hasTokens: (id) => env.controller.hasTokens(id), revoke: (id) => env.controller.revoke(id), forget: (id) => env.controller.forget(id) }
  }, mcpCatalogEntry('gmail')));

  // ── now search everything that could have carried a secret
  const planted = secretsOf(idp, ['SECRET-gmail-DO-NOT-LEAK', 'SECRET-google-calendar-DO-NOT-LEAK', 'SECRET-google-drive-DO-NOT-LEAK']);
  assert.ok(planted.length >= 8, 'the scan has real secrets to look for');
  const urlSecrets = planted.filter((s) => !s.startsWith('client-'));
  const channels = {
    'log lines': env.logs.join('\n'),
    'console output': consoleLines.join('\n'),
    'results returned to callers': results.join('\n'),
    'pages shown in the browser': pages.join('\n'),
    'URLs opened in the browser': env.opened.join('\n')
  };
  for (const [name, text] of Object.entries(channels)) {
    for (const secret of urlSecrets) assert.equal(text.includes(secret), false, `${name} contain a secret (${secret.slice(0, 6)}…)`);
    for (const h of HOSTILE) assert.equal(text.includes(h), false, `${name} echo what an attacker sent (${h})`);
    assert.equal(/secret-looking description/.test(text), false, `${name} carry a provider's free text`);
    assert.equal(/Bearer /.test(text), false, `${name} contain an Authorization value`);
  }
  assert.ok(env.logs.length > 10, 'and there was plenty logged to scan');
  assert.deepEqual(spawned, [], 'the engine started no process, so there are no process arguments to leak into');
});

test('LEAK SCAN: the planted secrets DO appear where they belong — the scan is not blind', async (t) => {
  const idp = await startIdp(t);
  const env = await makeEnv(t, idp);
  await env.controller.signIn('gmail');
  const rec = JSON.parse(env.secrets.map.get(mcpOauthRef('gmail')));
  const req = idp.tokenRequests()[0];
  // the token request body legitimately carries the secret and the code; the scan must be able to find them
  assert.equal(JSON.stringify(req).includes('SECRET-gmail-DO-NOT-LEAK'), true);
  assert.equal(idp.access.has(rec.accessToken), true);
  assert.ok(secretsOf(idp).includes(rec.refreshToken));
});

test('TOKENS EXIST IN ONE PLACE: the sealed record. Nothing else in the store holds them, the record holds no client secret, and the engine writes no file', async (t) => {
  // Watch the file system for the whole of a sign-in and a refresh: the engine may write NOTHING itself.
  const writes = [];
  for (const fn of ['writeFileSync', 'appendFileSync', 'mkdirSync', 'renameSync', 'copyFileSync', 'createWriteStream']) {
    const real = fs[fn];
    fs[fn] = function patched(...args) { if (!String(args[0]).startsWith('/dev/')) writes.push(`${fn} ${String(args[0])}`); return real.apply(this, args); };
    t.after(() => { fs[fn] = real; });
  }
  const idp = await startIdp(t);
  const env = await makeEnv(t, idp);
  writes.length = 0;                                             // from here on, only the engine is running
  await env.controller.signIn('gmail');
  env.clock.advance(3600_000);
  await env.controller.provider.accessHeaders({ id: 'gmail' });
  assert.deepEqual(writes, [], 'the engine wrote a file');

  const rec = JSON.parse(env.secrets.map.get(mcpOauthRef('gmail')));
  const holders = [...env.secrets.map.entries()].filter(([, v]) => v.includes(rec.accessToken) || v.includes(rec.refreshToken)).map(([k]) => k);
  assert.deepEqual(holders, [mcpOauthRef('gmail')]);
  assert.equal(env.secrets.map.get(mcpOauthRef('gmail')).includes('SECRET-gmail'), false);
  assert.deepEqual(Object.keys(rec).sort(), ['accessToken', 'clientFingerprint', 'expiresAt', 'obtainedAt', 'refreshToken', 'scope', 'v']);
});

test('the in-app engine writes no files at all: it has no filesystem access of its own', () => {
  for (const f of OAUTH_SOURCES) {
    const src = read(f);
    assert.equal(/from 'node:fs'|from 'fs'|require\('(node:)?fs'\)/.test(src), false, `${f} touches the file system`);
  }
});

// ─── agents ─────────────────────────────────────────────────────────────────

test('AGENT CONFIGURATION: with the in-app engine on, nothing about the integration — and no secret — reaches an agent', async (t) => {
  const idp = await startIdp(t);
  const env = await makeEnv(t, idp);
  await env.controller.signIn('gmail');
  const rec = JSON.parse(env.secrets.map.get(mcpOauthRef('gmail')));
  const planted = [rec.accessToken, rec.refreshToken, 'SECRET-gmail-DO-NOT-LEAK', 'client-gmail', idp.tokenRequests()[0].form.code, idp.tokenRequests()[0].form.code_verifier];

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-agentcfg-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  // exactly what index.ts hands the hive for an integration on the in-app engine
  const inj = await hive.ensureAgent({ id: 'a1', name: 'A', provider: 'claude', cwd: home }, {
    mcpDefaults: { gmail: { enabled: true } },
    mcpSecret: (catalogId, field) => env.secrets.get(field ? `mcp:${catalogId}:${field}` : `mcp:${catalogId}`),
    mcpBridge: () => undefined,
    denyReadPaths: []
  });

  const files = [];
  const walk = (d) => { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); fs.statSync(p).isDirectory() ? walk(p) : files.push(p); } };
  walk(home);
  assert.ok(files.length > 0);
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    for (const s of planted) assert.equal(text.includes(s), false, `${path.relative(home, f)} contains a secret`);
  }
  for (const s of planted) {
    assert.equal(JSON.stringify(inj).includes(s), false, 'the spawn arguments / environment carry a secret');
    assert.equal(JSON.stringify(inj.args).includes(s), false);
  }
  // Nothing else is switched on any more (no default servers), so "no entry" shows up as no
  // config file at all, which is the stricter state.
  const cfgPath = path.join(home, 'hive/agents/a1/mcp-config.json');
  const servers = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')).mcpServers : {};
  assert.equal(Object.keys(servers).some((k) => /gmail/.test(k)), false, 'no bridge, no entry: nothing is wired to an agent in this phase');
});

// ─── what the Settings panel can learn ──────────────────────────────────────

test('the status the Settings panel receives is booleans and fixed words — never a token', async (t) => {
  const idp = await startIdp(t);
  const env = await makeEnv(t, idp);
  const allowed = new Set(['unconfigured', 'signed-out', 'connected', 'needs-signin', 'unavailable']);
  assert.ok(allowed.has(env.controller.status('gmail')));
  await env.controller.signIn('gmail');
  const rec = JSON.parse(env.secrets.map.get(mcpOauthRef('gmail')));
  const status = env.controller.status('gmail');
  assert.ok(allowed.has(status));
  assert.equal(JSON.stringify(status).includes(rec.accessToken), false);
  const main = read('src/main/index.ts');
  const slice = main.slice(main.indexOf("ipcMain.handle('mcp:secretStatus'"), main.indexOf("ipcMain.handle('mcp:clearSecret'"));
  assert.equal(/\.tokens\(|accessToken|refreshToken|getSecret/.test(slice), false, 'the status handler can reach a token');
  const signIn = main.slice(main.indexOf("ipcMain.handle('mcp:signIn'"), main.indexOf('async function disconnectMcp'));
  assert.match(signIn, /return oauthController\.signIn\(entry\.id\)/, 'sign-in returns only {ok, error}');
});

// ─── the log backstop ───────────────────────────────────────────────────────

test('safeLog keeps codes, numbers and flags and replaces everything that looks like a secret', () => {
  const lines = [];
  const log = safeLog((l) => lines.push(JSON.parse(l)));
  log({
    event: 'signin.end', id: 'google-calendar', ok: false, error: 'invalid-callback', hits: 12, port: 33101,
    token: 'ya29.' + 'A0ARrdaM-abcdefghijklmnopqrstuvwxyz', code: '4/0AVeryRealLookingAuthorizationCode', state: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    refresh: '1//0gAbCdEf', text: 'line one\nline two', url: 'https://x.example/cb?code=abc', huge: 'a'.repeat(500), 'bad key!': 'x', nothing: undefined
  });
  assert.deepEqual(lines[0], {
    event: 'signin.end', id: 'google-calendar', ok: false, error: 'invalid-callback', hits: 12, port: 33101,
    token: '[redacted]', code: '[redacted]', state: '[redacted]', refresh: '[redacted]', text: '[redacted]', url: '[redacted]', huge: '[redacted]'
  });
});

// ─── the engine switch ──────────────────────────────────────────────────────

test('ENGINE SWITCH: everything is the bridge unless an integration is explicitly switched', () => {
  const bridged = MCP_CATALOG.filter((e) => e.spec.transport === 'bridge');
  assert.equal(bridged.length, 4);
  for (const e of bridged) {
    assert.equal(engineFor(undefined, e), 'bridge', e.id);
    assert.equal(engineFor({}, e), 'bridge');
    assert.equal(engineFor({ mcpEngine: {} }, e), 'bridge');
    assert.equal(engineFor({ mcpEngine: { [e.id]: 'bridge' } }, e), 'bridge');
    assert.equal(engineFor({ mcpEngine: { [e.id]: 'broker' } }, e), 'broker');
    for (const junk of ['Broker', 'BROKER', 'broker ', 'in-app', true, 1, null, {}, ['broker']]) assert.equal(engineFor({ mcpEngine: { [e.id]: junk } }, e), 'bridge', JSON.stringify(junk));
  }
  assert.equal(engineFor({ mcpEngine: { gmail: 'broker' } }, mcpCatalogEntry('slack')), 'bridge', 'one integration\'s switch is not another\'s');
});

test('ENGINE SWITCH: only an integration that HAS an in-app sign-in can be switched, and a bad id cannot', () => {
  for (const id of ['notion', 'github', 'time', 'filesystem']) {
    const e = mcpCatalogEntry(id);
    if (e) assert.equal(engineFor({ mcpEngine: { [id]: 'broker' } }, e), 'bridge', id);
  }
  assert.equal(engineFor({ mcpEngine: { nope: 'broker' } }, undefined), 'bridge');
  assert.deepEqual(sanitizeMcpEngine({ gmail: 'broker', slack: 'bridge', notion: 'broker', nope: 'broker', 'google-drive': 'weird', __proto__: { slack: 'broker' } }), { gmail: 'broker', slack: 'bridge' });
  for (const junk of [null, undefined, 5, 'broker', [], [['gmail', 'broker']]]) assert.deepEqual(sanitizeMcpEngine(junk), {});
});

test('ENGINE SWITCH: it defaults to the bridge in the shipped config, and nothing is switched on by default', () => {
  const cfg = read('src/main/config.ts');
  assert.match(cfg, /mcpEngine: \{\},/, 'the default config switches nothing');
  for (const e of MCP_CATALOG.filter((x) => x.spec.transport === 'bridge')) {
    assert.equal(e.defaultEnabled, false, `${e.id} ships switched on`);
    assert.equal(e.tier, 'oauth-bridge');
  }
});

test('ENGINE SWITCH: the app routes sign-in, status and agent wiring by it, and the bridge path is untouched when it is off', () => {
  const main = read('src/main/index.ts');
  const bridgeFn = main.slice(main.indexOf('mcpBridge: (catalogId: string) =>'), main.indexOf('denyReadPaths:'));
  assert.match(bridgeFn, /engineFor\(readConfig\(\), entry\) === 'broker'\) return undefined/, 'an integration on the in-app engine never reaches mcp-remote');
  const signIn = main.slice(main.indexOf("ipcMain.handle('mcp:signIn'"));
  const brokerAt = signIn.indexOf("=== 'broker') return oauthController.signIn");
  const bridgeAt = signIn.indexOf('mcpOauthClient(entry.id)');
  assert.ok(brokerAt > 0 && brokerAt < bridgeAt, 'the in-app engine is chosen before the bridge path begins');
  assert.match(main, /oauthController\.dispose\(\)/);
  // Phase 3: quitting no longer aborts a refresh that is on the wire. `beginShutdown` (after the agents
  // are gone, before the quit) stops waiting sign-ins and starts no NEW refresh; the final step, in
  // `will-quit`, gives a refresh already on the wire a bounded moment to finish and be saved, and only
  // then drops the tokens held in memory.
  const quit = main.slice(main.indexOf('function teardownAndQuit('), main.indexOf("ipcMain.handle('app:confirmClose'"));
  assert.ok(quit.indexOf('oauthController.beginShutdown()') > quit.indexOf('ptyManager.killAll()'), 'listeners close after the agents are gone');
  assert.ok(quit.indexOf('oauthController.beginShutdown()') < quit.indexOf('app.quit()'));
  assert.equal(quit.includes('oauthController.dispose()'), false, 'the quit itself must not abort a refresh on the wire');
  const willQuit = main.slice(main.indexOf("app.on('will-quit'"));
  assert.ok(willQuit.indexOf('oauthController.drain(') > 0, 'a refresh on the wire gets time to finish');
  assert.ok(willQuit.indexOf('oauthController.dispose()') > willQuit.indexOf('oauthController.drain('), 'and the tokens in memory are dropped after it, not before');
  assert.ok(willQuit.indexOf('oauthController.dispose()') < willQuit.indexOf('app.exit(0)'));
});

// ─── source hygiene ─────────────────────────────────────────────────────────

test('SOURCE: the engine is Electron-free, process-free, environment-free and silent', () => {
  assert.ok(OAUTH_SOURCES.length >= 9);
  for (const f of OAUTH_SOURCES) {
    const src = read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.equal(/from 'electron'|require\('electron'\)/.test(src), false, `${f} imports electron`);
    assert.equal(/child_process/.test(src), false, `${f} can start a process`);
    assert.equal(/process\.env|process\.argv/.test(src), false, `${f} reads the environment or arguments`);
    assert.equal(/console\./.test(src), false, `${f} writes to the console`);
    assert.equal(/\beval\(|new Function\(|\brequire\(/.test(src), false, `${f} evaluates code`);
    assert.equal(/localStorage|sessionStorage|document\.|window\./.test(src), false, `${f} touches renderer state`);
  }
  const main = read('src/main/mcpDisconnect.ts') + read('src/main/mcpEngine.ts');
  assert.equal(/child_process|console\./.test(main), false);
});

test('SOURCE: the secret values only ever travel in a request body, and never in a URL', () => {
  for (const f of ['src/main/oauth/flow.ts', 'src/main/oauth/provider.ts']) {
    const src = read(f);
    for (const m of src.matchAll(/searchParams\.set\('([a-z_]+)'/g)) {
      assert.equal(/secret|verifier|token|^code$/.test(m[1]), false, `${f} puts ${m[1]} in a URL`);
    }
  }
  // the secret (when the client has one: a public client has none) goes into the form body, next to the verifier
  assert.match(read('src/main/oauth/flow.ts'), /\.\.\.\(client\.clientSecret \? \{ client_secret: client\.clientSecret \} : \{\}\), code_verifier: verifier/);
  assert.match(read('src/main/oauth/provider.ts'), /\.\.\.\(client\.clientSecret \? \{ client_secret: client\.clientSecret \} : \{\}\)/);
});

test('SOURCE: every request the engine makes refuses redirects', () => {
  const http = read('src/main/oauth/http.ts');
  assert.match(http, /redirect: 'error'/);
  for (const f of OAUTH_SOURCES.filter((n) => !n.endsWith('http.ts'))) {
    const code = read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.equal(/\bfetch\(/.test(code), false, `${f} calls fetch directly instead of through http.send`);
  }
});

test('the OAuth callback binds the loopback address only', () => {
  assert.match(read('src/main/oauth/flow.ts'), /host: MCP_CALLBACK_HOST/);
  assert.equal(read('src/shared/mcpCatalog.ts').includes("export const MCP_CALLBACK_HOST = '127.0.0.1'"), true);
});
