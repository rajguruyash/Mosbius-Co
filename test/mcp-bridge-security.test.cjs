'use strict';

/**
 * Gaps the 2026-11-14 security audit of the OAuth bridge found, each pinned so
 * it cannot quietly come back.
 *
 *  1. An agent's `mcp-config.json` was not ignored, so the hive — which runs
 *     `git add -A` on every change — committed whatever credential it held into
 *     history, and the memory miner would have indexed it for every agent.
 *  2. The OAuth client rode in the bridge's environment, where `ps eww` shows it.
 *  3. "Forget" left the tokens on disk.
 *  4. The redirect host differed by platform from the one the user was told to
 *     register.
 *  5. Linux without a keyring "encrypts" with a hard-coded key.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');
const { McpAuthVault } = loadTs('src/main/mcpAuthVault.ts');
const {
  MCP_CATALOG, MCP_CALLBACK_HOST, mcpRedirectUri, mcpTokenRef, defaultMcpDefaults
} = loadTs('src/shared/mcpCatalog.ts');

// 43 base64url characters, the shape of a capability the broker mints: a handle, but one that must
// still never be committed or indexed
const CAP = 'AUDITCAPABILITY' + 'x'.repeat(28);
const SECRETS = ['AUDIT-CLIENT-ID', 'AUDIT-CLIENT-SECRET', 'AUDIT-GITHUB-TOKEN', 'AUDIT-ACCESS', 'AUDIT-REFRESH', CAP];
const TOKEN_FILE = 'd'.repeat(32) + '_tokens.json';
const BRIDGED = MCP_CATALOG.filter((e) => e.spec.transport === 'bridge');
const read = (rel) => fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');

function tmpHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mosbius-audit-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

/** Spawn an agent with Gmail signed in (the bridge) and GitHub switched on and reachable through the
 *  broker — every kind of credential the catalogue can touch. The GitHub token is in the app's store
 *  and is NOT handed to the hive at all any more (there is no option to), only a capability is. */
async function spawnWithEverything(home) {
  const store = new Map([[mcpTokenRef('gmail'), JSON.stringify({
    files: { [TOKEN_FILE]: JSON.stringify({ access_token: 'AUDIT-ACCESS', refresh_token: 'AUDIT-REFRESH' }) }
  })]]);
  const vault = new McpAuthVault(() => path.join(home, 'userData', 'mcp-auth'), {
    get: (r) => store.get(r), set: (r, v) => { store.set(r, v); return { ok: true }; }, delete: (r) => store.delete(r)
  });
  const hive = new HiveManager(() => home);
  const inj = await hive.ensureAgent({ id: 'a1', name: 'A', provider: 'claude', cwd: home }, {
    mcpDefaults: { gmail: { enabled: true }, github: { enabled: true } },
    mcpBroker: (id) => (id === 'github' ? { url: 'http://127.0.0.1:41234/m/github', authorization: `Bearer ${CAP}` } : undefined),
    mcpBridge: (id) => (id === 'gmail'
      ? vault.checkout('gmail', 'pty-1', { clientId: 'AUDIT-CLIENT-ID', clientSecret: 'AUDIT-CLIENT-SECRET' }, 'scope')
      : undefined),
    denyReadPaths: [vault.root(), path.join(home, 'userData', 'integration-secrets.json')]
  });
  return { hive, inj, vault, hiveRoot: path.join(home, 'hive'), agentDir: path.join(home, 'hive/agents/a1') };
}

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });

test('no credential is ever committed to the hive repository', async (t) => {
  const home = tmpHome(t);
  const { hive, hiveRoot, agentDir } = await spawnWithEverything(home);
  const cfg = path.join(agentDir, 'mcp-config.json');
  const text = fs.readFileSync(cfg, 'utf8');
  assert.match(text, /"mosbius-github"/, 'precondition: the config really does hold an entry for the credentialed server');
  assert.match(text, new RegExp(CAP), 'precondition: ... carrying the capability');
  assert.equal(text.includes('AUDIT-GITHUB-TOKEN'), false, 'and not its token: the app holds that');

  hive.commit('audit probe');

  const tracked = git(hiveRoot, 'ls-files').split('\n');
  assert.equal(tracked.some((f) => f.endsWith('mcp-config.json')), false, 'the agent MCP config is tracked by git');
  // Search every object the repository has ever stored, not just HEAD.
  const everything = git(hiveRoot, 'rev-list', '--all', '--objects')
    .split('\n').map((l) => l.split(' ')[0]).filter(Boolean)
    .map((sha) => { try { return git(hiveRoot, 'cat-file', '-p', sha); } catch { return ''; } }).join('\n');
  for (const secret of SECRETS) {
    assert.equal(everything.includes(secret), false, `${secret} is in the hive's git history`);
  }
});

test('the miner is told to skip the agent MCP config, so it is never indexed into shared memory', async (t) => {
  const home = tmpHome(t);
  const { agentDir } = await spawnWithEverything(home);
  const ignore = fs.readFileSync(path.join(agentDir, '.gitignore'), 'utf8').split('\n');
  assert.ok(ignore.includes('mcp-config.json'));
  // memory.ts writes the same list for agents that are not running; the two
  // copies are pinned equal by mine-ignore-sync.test.cjs — pin the line itself here.
  assert.match(read('src/main/memory.ts'), /MINE_IGNORE_LINES = \[[^\]]*'mcp-config\.json'/);
});

test('a config that an older build already committed is dropped from the index', async (t) => {
  const home = tmpHome(t);
  const { hive, hiveRoot, agentDir } = await spawnWithEverything(home);
  // Recreate the bug: force-add the file as a build without the ignore line did.
  git(hiveRoot, 'add', '-f', 'agents/a1/mcp-config.json');
  git(hiveRoot, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'old build');
  assert.ok(git(hiveRoot, 'ls-files').includes('mcp-config.json'), 'precondition');

  const fresh = new HiveManager(() => home);   // the one-time pass runs once per process
  fs.writeFileSync(path.join(agentDir, 'memory.md'), 'changed\n');
  fresh.commit('next commit');
  assert.equal(git(hiveRoot, 'ls-files').includes('mcp-config.json'), false,
    'git keeps recording a file it already tracks, whatever .gitignore says');
  assert.ok(fs.existsSync(path.join(agentDir, 'mcp-config.json')), 'the file itself must stay: the agent is using it');
});

test('a bridged server puts no secret in the agent config, its arguments or its environment', async (t) => {
  const home = tmpHome(t);
  const { inj, agentDir } = await spawnWithEverything(home);
  const cfgText = fs.readFileSync(path.join(agentDir, 'mcp-config.json'), 'utf8');
  const gmail = JSON.parse(cfgText).mcpServers['mosbius-gmail'];
  assert.ok(gmail, 'precondition: gmail is configured');
  const bridgeText = JSON.stringify(gmail);
  for (const secret of ['AUDIT-CLIENT-ID', 'AUDIT-CLIENT-SECRET', 'AUDIT-ACCESS', 'AUDIT-REFRESH']) {
    assert.equal(bridgeText.includes(secret), false, `${secret} is in the bridge's config`);
    assert.equal(JSON.stringify(inj).includes(secret), false, `${secret} is in the agent's own arguments or environment`);
  }
  assert.deepEqual(Object.keys(gmail.env), ['MCP_REMOTE_CONFIG_DIR']);
  assert.equal(JSON.stringify(inj).includes('AUDIT-GITHUB-TOKEN'), false, 'a token rode in on the agent command line');
});

test('the agent is denied reads of the vault, the secret file and its own MCP config', async (t) => {
  const home = tmpHome(t);
  const { vault, agentDir } = await spawnWithEverything(home);
  const settings = JSON.parse(fs.readFileSync(path.join(agentDir, 'settings.json'), 'utf8'));
  // Phase 3: the MCP config can carry this agent's capability for the in-app broker, which works
  // within THAT agent's grants, so no agent may read another's either (a pattern for the ones that
  // do not exist yet; the sandbox is also given each one that does).
  const others = path.join(home, 'hive', 'agents', '*', 'mcp-config.json');
  const want = [vault.root(), path.join(home, 'userData', 'integration-secrets.json'), path.join(agentDir, 'mcp-config.json'), others];
  // OS-enforced for sandboxed shell commands…
  assert.deepEqual(settings.sandbox.filesystem.denyRead, want);
  // …and by rule for the file tools, which run outside the sandbox. `//` is
  // Claude Code's spelling of an absolute path in a permission rule.
  for (const p of want) {
    assert.ok(settings.permissions.deny.includes(`Read(/${p})`), `no Read rule for ${p}`);
    assert.ok(settings.permissions.deny.includes(`Read(/${p}/**)`), `no Read rule under ${p}`);
  }
  for (const rule of settings.permissions.deny) assert.match(rule, /^Read\(\/\//);
  // the vault must not also be somewhere the agent is told it may write
  assert.equal(settings.sandbox.filesystem.allowWrite.some((d) => vault.root().startsWith(d + path.sep) || d === vault.root()), false);
});

test('every bridged server ships switched off', () => {
  const defaults = defaultMcpDefaults();
  for (const e of BRIDGED) {
    assert.equal(e.defaultEnabled, false);
    assert.equal(defaults[e.id].enabled, false, `${e.id} is on by default`);
  }
});

test('the redirect address is the IPv4 loopback literal, the same on every platform', () => {
  assert.equal(MCP_CALLBACK_HOST, '127.0.0.1');
  assert.equal(mcpRedirectUri(33101), 'http://127.0.0.1:33101/oauth/callback');
  for (const e of BRIDGED) {
    assert.ok(e.secretHelp.includes(`http://127.0.0.1:${e.spec.callbackPort}/oauth/callback`));
    assert.equal(/localhost/.test(e.secretHelp), false, `${e.id} still tells the user to register localhost`);
  }
  // what the user is told on the site and in the README must be the same address
  for (const doc of ['README.md', 'website/index.html', 'website/js/integrations.js', 'website/js/ecosystem.js', 'website/js/catalogue.js']) {
    assert.equal(/localhost:3310\d/.test(read(doc)), false, `${doc} still shows a localhost redirect address`);
  }
});

test('disconnect revokes, purges the vault and deletes the client — and Forget cannot bypass it', () => {
  // The orchestration lives in mcpDisconnect.ts so a failed delete can be tested
  // (see mcp-disconnect.test.cjs); index.ts only wires the real collaborators in.
  const mod = read('src/main/mcpDisconnect.ts');
  const fn = mod.slice(mod.indexOf('export async function disconnectBridged'));
  const order = ['deps.cancelSignIn(', 'deps.vault.readTokens(', 'deps.revoke(', 'deps.vault.purge(', 'removeSecrets('];
  let at = -1;
  for (const step of order) {
    const next = fn.indexOf(step);
    assert.ok(next > at, `disconnect is missing "${step}", or does it out of order`);
    at = next;
  }
  // revocation uses only the catalogue's URL — never one read from stored state
  assert.match(fn, /deps\.revoke\(entry\.spec\.revoke,/);
  const main = read('src/main/index.ts');
  const wired = main.slice(main.indexOf('async function disconnectMcp'), main.indexOf("ipcMain.handle('mcp:disconnect'"));
  assert.match(wired, /disconnectBridged\(/);
  assert.match(wired, /cancelSignIn: \(sid\) => \{ cancelMcpSignIn\(sid\);/);
  assert.match(wired, /oauthController\.cancel\(sid\)/, 'the in-app engine\'s waiting sign-in is cancelled too');
  assert.match(wired, /revokeAtProvider\(spec, tokens,/);
  assert.match(wired, /vault: mcpVault/);
  assert.match(wired, /secrets: secretRemover/);
  // the older "Forget" IPC must route a bridged server through the same path
  const clear = main.slice(main.indexOf("ipcMain.handle('mcp:clearSecret'"), main.indexOf("ipcMain.handle('mcp:signIn'"));
  assert.match(clear, /transport === 'bridge'\) return disconnectMcp\(/);
});

test('plaintext tokens are sealed when an agent ends, when the app quits and when it starts', () => {
  const main = read('src/main/index.ts');
  const teardown = main.slice(main.indexOf('function teardownPty('), main.indexOf('function teardownPty(') + 600);
  assert.match(teardown, /mcpVault\.release\(id\)/);
  const quit = main.slice(main.indexOf('function teardownAndQuit('), main.indexOf("ipcMain.handle('app:confirmClose'"));
  assert.ok(quit.indexOf('mcpVault.sweep()') > quit.indexOf('ptyManager.killAll()'), 'sweep must run after the agents are gone');
  const ready = main.slice(main.indexOf('app.whenReady().then('));
  assert.ok(ready.indexOf('mcpVault.sweep()') > 0 && ready.indexOf('mcpVault.sweep()') < ready.indexOf('bootstrapHiveServices();'),
    'a crash leaves plaintext behind; it must be sealed before any agent starts');
});

test('the status the settings panel receives is booleans only', () => {
  const main = read('src/main/index.ts');
  const status = main.slice(main.indexOf("ipcMain.handle('mcp:secretStatus'"), main.indexOf("ipcMain.handle('mcp:clearSecret'"));
  assert.equal(/getSecret|readTokens/.test(status), false, 'a stored value is being read on the way to the renderer');
  assert.match(status, /connected:/);
});

test('the sign-in never logs or returns what the bridge printed', () => {
  const src = read('src/main/agentManager.ts');
  const fn = src.slice(src.indexOf('export async function runMcpSignIn'));
  assert.equal(/console\.(log|error|warn|info)/.test(fn), false, 'the child output carries the authorisation URL');
  assert.equal(/open', \['-a', 'Terminal'/.test(fn), false, 'the sign-in is back in a terminal window');
  assert.equal(/--debug/.test(fn), false);
  // every failure is one of a fixed set of codes
  for (const m of fn.matchAll(/error: ([^}\n]+?) \}/g)) {
    assert.match(m[1], /^('in-progress'|'port-busy'|'no-npx'|'timeout'|'failed'|portBusy \? 'port-busy' : 'failed'|McpSignInError)$/, m[1]);
  }
});

// ─── the encrypted store itself ──────────────────────────────────────────────

// load-ts caches a module by file, so integrations.ts is loaded ONCE against a
// stand-in for electron whose behaviour each test swaps.
const fakeElectron = { userData: '', safeStorage: null };
{
  const electron = require.resolve('electron');
  require.cache[electron] = {
    id: electron, filename: electron, loaded: true,
    exports: {
      app: { getPath: () => fakeElectron.userData },
      safeStorage: new Proxy({}, {
        get: (_t, key) => fakeElectron.safeStorage[key],
        has: (_t, key) => key in fakeElectron.safeStorage
      })
    }
  };
}
const integrations = loadTs('src/main/integrations.ts');

function loadIntegrations(t, safeStorage) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'mosbius-store-'));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  fakeElectron.userData = userData;
  fakeElectron.safeStorage = safeStorage;
  return { userData, mod: integrations };
}

const fakeCipher = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from('enc:' + Buffer.from(s).toString('hex')),
  decryptString: (b) => Buffer.from(String(b).slice(4), 'hex').toString()
};

test('a secret is stored as ciphertext in an owner-only file', (t) => {
  const { userData, mod } = loadIntegrations(t, fakeCipher);
  assert.deepEqual(mod.setSecret('mcp:gmail:client_secret', 'PLAINTEXT-SECRET'), { ok: true });
  const file = path.join(userData, 'integration-secrets.json');
  assert.equal(mod.secretsFilePath(), file);
  assert.equal(fs.readFileSync(file, 'utf8').includes('PLAINTEXT-SECRET'), false);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(mod.getSecret('mcp:gmail:client_secret'), 'PLAINTEXT-SECRET');
});

test('Linux with no keyring is treated as no encryption at all', (t) => {
  // Electron's `basic_text` backend uses a key hard-coded in Chromium and still
  // answers isEncryptionAvailable() === true.
  const { userData, mod } = loadIntegrations(t, { ...fakeCipher, getSelectedStorageBackend: () => 'basic_text' });
  const res = mod.setSecret('mcp:gmail:client_secret', 'PLAINTEXT-SECRET');
  assert.equal(res.ok, false);
  assert.match(res.error, /refusing to store/);
  assert.equal(fs.existsSync(path.join(userData, 'integration-secrets.json')), false);
});

test('a real Linux keyring is still accepted', (t) => {
  const { mod } = loadIntegrations(t, { ...fakeCipher, getSelectedStorageBackend: () => 'gnome_libsecret' });
  assert.equal(mod.setSecret('mcp:x', 'v').ok, true);
});
