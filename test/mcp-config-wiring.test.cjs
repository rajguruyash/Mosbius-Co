'use strict';

/**
 * The default MCP bundle has to be handed to Claude Code the way Claude Code
 * actually reads it.
 *
 * `mcpServers` is NOT part of the settings-file schema. Writing the bundle into
 * the per-agent settings.json and passing it with `--settings` parsed cleanly and
 * did nothing: every agent spawned with zero MCP servers while the Settings panel
 * showed six of them switched on. Verified against claude 2.1.319 on 2026-11-13 by
 * declaring the same probe server both ways and reading the CLI's own
 * `system`/`init` event — absent under `--settings`, listed under `--mcp-config`.
 *
 * So: the bundle goes in its own file, passed with `--mcp-config`. These tests
 * pin that, and pin that a server needing a credential is never started without
 * one (the catalog used to ship `env: { GITHUB_PERSONAL_ACCESS_TOKEN: '' }`, which
 * would have launched a server guaranteed to fail every call).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');
const {
  MCP_CATALOG, MCP_REMOTE_PACKAGE, mcpNeedsOauthClient, mcpSecretRefs, mcpRedirectUri, mcpTokenRef
} = loadTs('src/shared/mcpCatalog.ts');
const { McpAuthVault } = loadTs('src/main/mcpAuthVault.ts');

function tmpHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mosbius-mcp-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

const agentDir = (home) => path.join(home, 'hive/agents/a1');
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
/** The servers an agent was given. An agent with none has no config file at all, which is
 *  the stricter state (nothing was even written), so absence reads as "no servers". */
const serversOf = (home) => {
  const p = path.join(agentDir(home), 'mcp-config.json');
  return fs.existsSync(p) ? readJson(p).mcpServers : {};
};

async function spawnAgent(home, opts = {}) {
  const hive = new HiveManager(() => home);
  const inj = await hive.ensureAgent({ id: 'a1', name: 'A', provider: 'claude', cwd: home }, opts);
  return inj;
}

test('the settings file carries no mcpServers key — Claude Code would ignore it', async (t) => {
  const home = tmpHome(t);
  await spawnAgent(home);

  const settings = readJson(path.join(agentDir(home), 'settings.json'));
  assert.equal(
    'mcpServers' in settings,
    false,
    'settings.json is not where MCP servers are configured; putting them here is silently a no-op'
  );
});

// Since 2026-11-15 NOTHING is on by default, so a test of the file format has to switch the
// local servers on explicitly, exactly as the user now has to.
const LOCAL_SIX = ['sequential-thinking', 'time', 'fetch', 'context7', 'filesystem', 'git'];
const consentLocal = { mcpDefaults: Object.fromEntries(LOCAL_SIX.map((id) => [id, { enabled: true }])) };

test('nothing is written when nothing was switched on', async (t) => {
  const home = tmpHome(t);
  const inj = await spawnAgent(home);
  assert.equal(inj.args.includes('--mcp-config'), false, 'no consent, so no MCP flag at all');
  assert.equal(fs.existsSync(path.join(agentDir(home), 'mcp-config.json')), false);
});

test('a catalogue default can never switch anything on', () => {
  for (const e of MCP_CATALOG) assert.equal(e.defaultEnabled, false, `${e.id} ships switched on`);
});

// What the app hands the hive for a server it runs for the agent: a broker address and a
// capability. Built here the way index.ts builds it (`mcpBroker`), with fresh capabilities.
const { randomBytes } = require('node:crypto');
const capability = () => randomBytes(32).toString('base64url');
const brokerFor = (ids, port = 41234) => (id) => (ids.includes(id)
  ? { url: `http://127.0.0.1:${port}/m/${id}`, authorization: `Bearer ${capability()}` }
  : undefined);

test('every server an agent is given is written as a broker entry and passed with --mcp-config', async (t) => {
  const home = tmpHome(t);
  const inj = await spawnAgent(home, { ...consentLocal, mcpBroker: brokerFor(LOCAL_SIX) });

  const configPath = path.join(agentDir(home), 'mcp-config.json');
  assert.equal(fs.existsSync(configPath), true, 'the bundle must be written somewhere Claude reads');
  const i = inj.args.indexOf('--mcp-config');
  assert.notEqual(i, -1, 'the flag that actually loads MCP servers must be on the command line');
  assert.equal(inj.args[i + 1], configPath);

  const { mcpServers } = readJson(configPath);
  assert.deepEqual(Object.keys(mcpServers).sort(), LOCAL_SIX.map((id) => `mosbius-${id}`).sort());
  for (const [name, server] of Object.entries(mcpServers)) {
    // NOTHING but an address and a capability: the agent is never given a way to start a server
    assert.deepEqual(Object.keys(server).sort(), ['headers', 'type', 'url'], name);
    assert.equal(server.type, 'http');
    assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/m\/[a-z0-9-]+$/, name);
    assert.deepEqual(Object.keys(server.headers), ['Authorization']);
    assert.match(server.headers.Authorization, /^Bearer [A-Za-z0-9_-]{43}$/, name);
    for (const k of ['command', 'args', 'env']) assert.equal(k in server, false, `${name} carries a ${k}`);
  }
});

test('every server id is namespaced so a user\'s own server of the same name survives', async (t) => {
  const home = tmpHome(t);
  await spawnAgent(home, { ...consentLocal, mcpBroker: brokerFor(LOCAL_SIX) });
  const { mcpServers } = readJson(path.join(agentDir(home), 'mcp-config.json'));
  for (const name of Object.keys(mcpServers)) {
    assert.match(name, /^mosbius-/, `${name} would collide with the user's own config`);
  }
});

test('no catalogue server can be launched from an agent\'s config: a server the app does not offer is simply absent', async (t) => {
  // consented to everything, but the app offers a capability for NONE of them (no grant, not installed, no credential)
  const home = tmpHome(t);
  await spawnAgent(home, { mcpDefaults: Object.fromEntries(MCP_CATALOG.map((e) => [e.id, { enabled: true }])) });
  assert.deepEqual(Object.keys(serversOf(home)), [], 'there is no direct-launch fallback');
});

test('a consented server that needs a credential is skipped when the app offers no entry for it', async (t) => {
  const home = tmpHome(t);
  const secretTier = MCP_CATALOG.filter((e) => e.tier === 'secret').map((e) => e.id);
  assert.ok(secretTier.length > 0, 'catalog should still carry credentialed entries');
  const mcpDefaults = Object.fromEntries(secretTier.map((id) => [id, { enabled: true }]));
  await spawnAgent(home, { mcpDefaults }); // consented, but the app (no grant / no credential) offers nothing
  const mcpServers = serversOf(home);
  for (const id of secretTier) assert.equal(`mosbius-${id}` in mcpServers, false, `${id} was consented but cannot work`);
});

test('A STORED CREDENTIAL NEVER REACHES THE AGENT: not in its config, whatever the server', async (t) => {
  const home = tmpHome(t);
  const TOKENS = { notion: 'ntn_AGENT_MUST_NEVER_SEE_THIS', github: 'ghp_AGENT_MUST_NEVER_SEE_THIS', 'brave-search': 'BSA_AGENT_MUST_NEVER_SEE_THIS' };
  // the only thing the hive is given is a way to ask for a broker entry; even an old-style
  // `mcpSecret` option, if a caller still passed one, is ignored
  const inj = await spawnAgent(home, {
    mcpDefaults: Object.fromEntries(Object.keys(TOKENS).map((id) => [id, { enabled: true }])),
    mcpBroker: brokerFor(Object.keys(TOKENS)),
    mcpSecret: (id) => TOKENS[id]
  });
  const configText = fs.readFileSync(path.join(agentDir(home), 'mcp-config.json'), 'utf8');
  const everything = [configText, JSON.stringify(inj)];
  const walk = (d) => { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); fs.statSync(p).isDirectory() ? walk(p) : everything.push(fs.readFileSync(p, 'utf8')); } };
  walk(home);
  for (const [id, token] of Object.entries(TOKENS)) {
    for (const blob of everything) assert.equal(blob.includes(token), false, `${id}'s token reached a file or the spawn arguments`);
  }
  const { mcpServers } = JSON.parse(configText);
  assert.deepEqual(Object.keys(mcpServers).sort(), ['mosbius-brave-search', 'mosbius-github', 'mosbius-notion']);
  for (const s of Object.values(mcpServers)) assert.equal('env' in s, false, 'no environment variable can carry a key');
});

test('a hosted HTTP server (GitHub) is a broker entry too: the agent\'s header is a capability, never the token', async (t) => {
  const home = tmpHome(t);
  await spawnAgent(home, { mcpDefaults: { github: { enabled: true } }, mcpBroker: brokerFor(['github']), mcpSecret: () => 'ghp_NOT_FOR_THE_AGENT' });
  const server = readJson(path.join(agentDir(home), 'mcp-config.json')).mcpServers['mosbius-github'];
  assert.equal(server.type, 'http');
  assert.notEqual(server.url, 'https://api.githubcopilot.com/mcp/', 'the agent talks to the broker, not to GitHub');
  assert.match(server.headers.Authorization, /^Bearer [A-Za-z0-9_-]{43}$/);
  assert.equal(JSON.stringify(server).includes('ghp_'), false);
});

test('no entry is ever written that is not exactly a broker URL and a capability', async (t) => {
  for (const bad of [
    { url: 'https://api.githubcopilot.com/mcp/', authorization: `Bearer ${capability()}` },     // an upstream address
    { url: 'http://127.0.0.1:41234/m/github', authorization: 'Bearer ghp_a_real_looking_token' }, // not a capability
    { url: 'http://127.0.0.1:41234/m/github', authorization: '' }                                // empty
  ]) {
    const home = tmpHome(t);
    await spawnAgent(home, { mcpDefaults: { github: { enabled: true } }, mcpBroker: (id) => (id === 'github' ? bad : undefined) });
    assert.deepEqual(Object.keys(serversOf(home)), [], JSON.stringify(bad));
  }
});

test('the config file is owner-only', { skip: process.platform === 'win32' }, async (t) => {
  const home = tmpHome(t);
  await spawnAgent(home, { mcpDefaults: { notion: { enabled: true } }, mcpBroker: brokerFor(['notion']) });
  const mode = fs.statSync(path.join(agentDir(home), 'mcp-config.json')).mode & 0o777;
  assert.equal(mode, 0o600, 'it holds this agent\'s capability: not for group or world');
});

// ─── Bridged servers: the user's own OAuth client, via mcp-remote ────────────
//
// Gmail, Calendar, Drive and Slack all publish a first-party server that a
// Claude Code agent cannot sign in to, because it registers its OAuth client
// with the service on the spot and none of these services allow that. The
// bridge carries a client the USER registered instead. These tests pin the
// things that make that safe: it is skipped until BOTH halves are stored AND
// the user has signed in, nothing secret reaches the agent's config, argument
// vector or environment, and the right scopes go out.

const BRIDGED = MCP_CATALOG.filter((e) => e.spec.transport === 'bridge');
const FAKE_TOKENS = JSON.stringify({ access_token: 'TEST-ACCESS-TOKEN', refresh_token: 'TEST-REFRESH-TOKEN' });
const TOKEN_FILE = 'a'.repeat(32) + '_tokens.json';

/**
 * Consent to a server, optionally store its OAuth client, and optionally have
 * signed in. Wired the way src/main/index.ts wires it: a real vault over an
 * in-memory stand-in for the encrypted store.
 */
function withClient(id, { consent = true, clientId, clientSecret, signedIn = true, home } = {}) {
  const store = new Map();
  if (signedIn) store.set(mcpTokenRef(id), JSON.stringify({ files: { [TOKEN_FILE]: FAKE_TOKENS } }));
  const vault = new McpAuthVault(() => path.join(home, 'vault'), {
    get: (ref) => store.get(ref),
    set: (ref, v) => { store.set(ref, v); return { ok: true }; },
    delete: (ref) => { store.delete(ref); }
  });
  const entry = MCP_CATALOG.find((e) => e.id === id);
  return {
    vault,
    mcpDefaults: consent ? { [id]: { enabled: true } } : {},
    mcpBridge: (catalogId) => {
      if (catalogId !== id) return undefined;
      const client = { clientId: (clientId ?? '').trim(), clientSecret: (clientSecret ?? '').trim() };
      return vault.checkout(id, 'pty-1', client, entry.spec.scope);
    }
  };
}

test('the four bridged services are in the catalog, off, and need a client', () => {
  const ids = BRIDGED.map((e) => e.id).sort();
  assert.deepEqual(ids, ['gmail', 'google-calendar', 'google-drive', 'slack']);
  for (const e of BRIDGED) {
    assert.equal(e.tier, 'oauth-bridge');
    assert.equal(e.defaultEnabled, false, `${e.id} must never ship switched on`);
    assert.equal(mcpNeedsOauthClient(e), true);
    assert.deepEqual(mcpSecretRefs(e), [`mcp:${e.id}:client_id`, `mcp:${e.id}:client_secret`]);
    assert.ok(e.spec.url.startsWith('https://'), `${e.id} must be reached over TLS`);
    assert.ok(e.secretHelp, `${e.id} must tell the user how to register the client`);
  }
});

test('a bridged server is skipped until BOTH halves of the client are stored', async (t) => {
  for (const half of [
    {},
    { clientId: 'id-only' },
    { clientSecret: 'secret-only' },
    { clientId: '  ', clientSecret: '  ' }   // whitespace is not a credential
  ]) {
    const home = tmpHome(t);
    await spawnAgent(home, withClient('gmail', { ...half, home }));
    const cfgPath = path.join(agentDir(home), 'mcp-config.json');
    const servers = fs.existsSync(cfgPath) ? readJson(cfgPath).mcpServers : {};
    assert.equal(
      'mosbius-gmail' in servers, false,
      `half a client (${JSON.stringify(half)}) started a server that could only fail every call`
    );
    assert.equal(fs.existsSync(path.join(home, 'vault')), false, 'half a client was written to disk');
  }
});

test('a bridged server is skipped until the user has signed in', async (t) => {
  const home = tmpHome(t);
  await spawnAgent(home, withClient('gmail', { clientId: 'x', clientSecret: 'y', signedIn: false, home }));
  const cfgPath = path.join(agentDir(home), 'mcp-config.json');
  const servers = fs.existsSync(cfgPath) ? readJson(cfgPath).mcpServers : {};
  // Started without tokens, mcp-remote opens the user's browser on its own.
  assert.equal('mosbius-gmail' in servers, false, 'an agent spawn must never start a sign-in');
  assert.equal(fs.existsSync(path.join(home, 'vault')), false, 'the client was written out for nothing');
});

test('a bridged server is still skipped when it was never consented to', async (t) => {
  const home = tmpHome(t);
  await spawnAgent(home, withClient('gmail', { consent: false, clientId: 'x', clientSecret: 'y', home }));
  const mcpServers = serversOf(home);
  assert.equal('mosbius-gmail' in mcpServers, false, 'a stored credential is not consent');
  assert.equal(fs.existsSync(path.join(home, 'vault')), false, 'nothing is written out for a server that is off');
});

test('a consented bridged server runs mcp-remote against the real endpoint', async (t) => {
  const home = tmpHome(t);
  await spawnAgent(home, withClient('gmail', { clientId: 'the-id', clientSecret: 'the-secret', home }));

  const { mcpServers } = readJson(path.join(agentDir(home), 'mcp-config.json'));
  const s = mcpServers['mosbius-gmail'];
  assert.ok(s, 'gmail should be configured once it has a full client');
  assert.equal(s.type, 'stdio');
  assert.equal(s.command, 'npx');
  assert.ok(s.args.includes(MCP_REMOTE_PACKAGE), 'the bridge is what makes this reachable at all');
  assert.ok(s.args.includes('https://gmailmcp.googleapis.com/mcp/v1'));
  // a FIXED loopback port straight after the URL: left to itself the bridge derives one
  // from a hash of the URL and may walk to the next if it is busy, which is a redirect
  // URI nobody could have registered in advance
  assert.equal(s.args[s.args.indexOf('https://gmailmcp.googleapis.com/mcp/v1') + 1], '33101');
  // http-only: these endpoints are Streamable HTTP, and letting the bridge fall
  // back to SSE would just fail slower.
  assert.deepEqual(s.args.slice(s.args.indexOf('--transport'), s.args.indexOf('--transport') + 2),
    ['--transport', 'http-only']);
  // the scopes Google documents for the Gmail server
  const metaArg = s.args[s.args.indexOf('--static-oauth-client-metadata') + 1];
  assert.ok(metaArg.startsWith('@'), 'the scopes go over as a file, so no shell ever has to quote JSON');
  const meta = fs.readFileSync(metaArg.slice(1), 'utf8');
  assert.match(meta, /gmail\.readonly/);
  assert.match(meta, /gmail\.compose/);
});

test('the OAuth client never reaches the argument vector', async (t) => {
  const home = tmpHome(t);
  const clientId = 'MOSBIUS-TEST-CLIENT-ID';
  const clientSecret = 'MOSBIUS-TEST-CLIENT-SECRET';
  await spawnAgent(home, withClient('gmail', { clientId, clientSecret, home }));

  const cfgPath = path.join(agentDir(home), 'mcp-config.json');
  const s = readJson(cfgPath).mcpServers['mosbius-gmail'];

  // `ps` shows every process's arguments to every user on the machine.
  for (const arg of s.args) {
    assert.equal(arg.includes(clientId), false, `the client id leaked into an argument: ${arg}`);
    assert.equal(arg.includes(clientSecret), false, 'the client secret leaked into an argument');
  }
  // Stricter than it used to be: the values are not in the ENVIRONMENT either
  // (`ps eww` shows that to every process the user runs), and so not anywhere
  // in the agent's config file. They sit in a 0600 file inside the 0700 vault.
  const whole = fs.readFileSync(cfgPath, 'utf8');
  for (const secret of [clientId, clientSecret, 'TEST-ACCESS-TOKEN', 'TEST-REFRESH-TOKEN']) {
    assert.equal(whole.includes(secret), false, `${secret} is in the agent's MCP config`);
  }
  assert.deepEqual(Object.keys(s.env), ['MCP_REMOTE_CONFIG_DIR'], 'the environment carries a path and nothing else');
  const info = s.args[s.args.indexOf('--static-oauth-client-info') + 1];
  assert.ok(info.startsWith('@'), 'the client is handed over as a file reference');
  const infoFile = info.slice(1);
  assert.ok(infoFile.startsWith(s.env.MCP_REMOTE_CONFIG_DIR + path.sep), 'the client file lives inside the vault');
  assert.deepEqual(readJson(infoFile), { client_id: clientId, client_secret: clientSecret });

  // and both the file holding the client and the config are owner-only
  assert.equal(fs.statSync(infoFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(s.env.MCP_REMOTE_CONFIG_DIR).mode & 0o777, 0o700);
  assert.equal(fs.statSync(cfgPath).mode & 0o777, 0o600);
});

test('Slack asks for no fixed scopes, because it grants them per tool', async (t) => {
  const home = tmpHome(t);
  await spawnAgent(home, withClient('slack', { clientId: 'a', clientSecret: 'b', home }));
  const s = readJson(path.join(agentDir(home), 'mcp-config.json')).mcpServers['mosbius-slack'];
  assert.ok(s.args.includes('https://mcp.slack.com/mcp'));
  assert.equal(s.args.includes('--static-oauth-client-metadata'), false,
    'pinning scopes up front would fight Slack\'s own per-tool consent');
});

test('the landing page still names these as needing your own OAuth client', () => {
  // The page used to type these four names into its own script. It now draws every card from the generated catalogue
  // (website/js/catalogue.js, written by tools/build-website.cjs from the app's own provider data), so the names and the
  // way each connects are read from there; what must stay true is unchanged: the four are named, each as needing an
  // OAuth app of your own, and the old vague reason is not back anywhere on the page.
  const vm = require('node:vm');
  const read = (rel) => fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');
  const sandbox = { window: {} };
  vm.runInNewContext(read('website/js/catalogue.js'), sandbox);
  const providers = sandbox.window.MOSBIUS_CATALOGUE.groups.flatMap((g) => g.providers);
  for (const name of ['Gmail', 'Google Calendar', 'Google Drive', 'Slack']) {
    const p = providers.find((x) => x.label === name);
    assert.ok(p, `the site stopped naming ${name}`);
    assert.ok(p.ways.includes('own-app'), `the site no longer says ${name} needs an OAuth app of your own`);
    assert.ok(p.connectsBy.includes('an OAuth app you register'), `${name}: the words the site shows for how it connects`);
  }
  for (const f of ['website/index.html', 'website/js/integrations.js', 'website/js/ecosystem.js', 'website/js/catalogue.js']) {
    assert.equal(/needs OAuth'/.test(read(f)), false, `the old vague reason is back in ${f}`);
  }
  assert.match(read('website/js/integrations.js'), /'own-app': 'Your own OAuth app'/, 'the page says it in words too: each of these shows "Your own OAuth app"');
});

test('every bridged server has its own fixed port, and tells the user the redirect URI to register', () => {
  const ports = BRIDGED.map((e) => e.spec.callbackPort);
  assert.equal(new Set(ports).size, ports.length, 'two services share a callback port');
  for (const e of BRIDGED) {
    assert.ok(Number.isInteger(e.spec.callbackPort) && e.spec.callbackPort > 1024 && e.spec.callbackPort < 65536);
    assert.ok(
      e.secretHelp.includes(mcpRedirectUri(e.spec.callbackPort)),
      `${e.id}: the help text must name the exact redirect URI, or the user cannot register it`
    );
  }
});
