'use strict';

/**
 * What an agent's MCP config says when an integration is reached through the in-app
 * broker: the broker's own loopback address and the agent's capability, and NOTHING
 * else. No OAuth token, no client id or secret, no command, no environment.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const loadTs = require('./load-ts.cjs');

const { HiveManager, brokerServerEntry } = loadTs('src/main/hive.ts');

const cap = () => randomBytes(32).toString('base64url');
/** The servers an agent was given. No config file at all is the stricter form of "none". */
const serversOf = (home) => {
  const p = path.join(home, 'hive/agents/a1/mcp-config.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')).mcpServers : {};
};
const URL_OF = (id, port = 41234) => `http://127.0.0.1:${port}/m/${id}`;

function tmpHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mosbius-broker-wiring-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}
const agentDir = (home, id = 'a1') => path.join(home, 'hive', 'agents', id);
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const CONSENT = { gmail: { enabled: true }, slack: { enabled: true } };

async function spawn(home, opts = {}, id = 'a1') {
  const hive = new HiveManager(() => home);
  const inj = await hive.ensureAgent({ id, name: id, provider: 'claude', cwd: home }, opts);
  return { hive, inj };
}

test('brokerServerEntry: exactly the broker\'s own address and a capability-shaped value', () => {
  const token = cap();
  assert.deepEqual(brokerServerEntry('gmail', { url: URL_OF('gmail'), authorization: `Bearer ${token}` }), {
    type: 'http', url: URL_OF('gmail'), headers: { Authorization: `Bearer ${token}` }
  });
  const good = `Bearer ${token}`;
  for (const url of [
    'https://127.0.0.1:41234/m/gmail', 'http://localhost:41234/m/gmail', 'http://127.0.0.1/m/gmail', 'http://127.0.0.1:41234/m/slack',
    'http://127.0.0.1:41234/m/gmail/', 'http://127.0.0.1:41234/m/gmail?x=1', 'http://127.0.0.1:41234/i/gmail', 'http://evil.example:41234/m/gmail',
    'http://127.0.0.1:41234@evil.example/m/gmail', 'https://gmailmcp.googleapis.com/mcp/v1', 'http://127.0.0.1:99999999/m/gmail', ''
  ]) assert.equal(brokerServerEntry('gmail', { url, authorization: good }), null, url);
  for (const authorization of [
    token, `bearer ${token}`, `Bearer ${token}x`, `Bearer ${token.slice(1)}`, `Bearer ${token} `, 'Bearer ya29.a0AfH6SMBx-looks-like-a-google-token.with.dots_and_more',
    `Bearer xoxp-${'1'.repeat(11)}-${'2'.repeat(11)}-${'3'.repeat(11)}-${'a'.repeat(32)}`, `Basic ${token}`, `Bearer ${token}\nX: y`, '', 'Bearer '
  ]) assert.equal(brokerServerEntry('gmail', { url: URL_OF('gmail'), authorization }), null, authorization.slice(0, 40));
});

test('an integration reached through the broker is written as an http server with the capability and nothing else', async (t) => {
  const home = tmpHome(t);
  const token = cap();
  const asked = [];
  const { inj } = await spawn(home, {
    mcpDefaults: CONSENT,
    mcpBroker: (id) => { asked.push(id); return id === 'gmail' ? { url: URL_OF('gmail'), authorization: `Bearer ${token}` } : undefined; }
  });
  const file = path.join(agentDir(home), 'mcp-config.json');
  const { mcpServers } = readJson(file);
  assert.deepEqual(mcpServers['mosbius-gmail'], { type: 'http', url: URL_OF('gmail'), headers: { Authorization: `Bearer ${token}` } });
  assert.deepEqual(Object.keys(mcpServers['mosbius-gmail']).sort(), ['headers', 'type', 'url'], 'no command, no args, no env');
  assert.equal('mosbius-slack' in mcpServers, false, 'consented but not given an entry: not written');
  assert.ok(asked.includes('gmail') && asked.includes('slack'), 'the app is asked about each consented integration');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'owner-only, like a key file');
  // nothing about the OAuth engine, the bridge or the provider is anywhere in the file…
  const text = fs.readFileSync(file, 'utf8');
  for (const forbidden of ['mcp-remote', 'client_secret', 'client_id', 'access_token', 'refresh_token', 'MCP_REMOTE_CONFIG_DIR', 'googleapis.com', 'slack.com']) {
    assert.equal(text.includes(forbidden), false, `${forbidden} must not be in an agent's config`);
  }
  // …and this entry has no way to start a process or carry an environment
  const entryText = JSON.stringify(mcpServers['mosbius-gmail']);
  for (const forbidden of ['npx', 'command', 'args', 'env']) assert.equal(entryText.includes(forbidden), false, forbidden);
  // and nothing the agent is spawned with carries it
  assert.deepEqual(inj.args.filter((a) => a.includes(token)), []);
  assert.equal(JSON.stringify(inj.env).includes(token), false);
  assert.equal(inj.args.includes('--mcp-config'), true);
});

test('consent still decides: an integration the user has not switched on is not written, whatever the app offers', async (t) => {
  const home = tmpHome(t);
  const { inj } = await spawn(home, {
    mcpDefaults: { gmail: { enabled: false } },
    mcpBroker: () => ({ url: URL_OF('gmail'), authorization: `Bearer ${cap()}` })
  });
  const mcpServers = serversOf(home);
  for (const id of ['gmail', 'slack', 'google-drive', 'google-calendar']) assert.equal(`mosbius-${id}` in mcpServers, false, id);
  assert.deepEqual(Object.keys(mcpServers), [], 'and nothing else was switched on, so nothing is written');
  assert.equal(inj.args.includes('--mcp-config'), false, 'no servers means no MCP flag either');
});

test('a malformed entry from the app is refused rather than written', async (t) => {
  for (const bad of [
    { url: 'https://gmailmcp.googleapis.com/mcp/v1', authorization: `Bearer ${cap()}` },
    { url: URL_OF('gmail'), authorization: 'Bearer ya29.not-a-capability' },
    { url: URL_OF('slack'), authorization: `Bearer ${cap()}` }
  ]) {
    const home = tmpHome(t);
    await spawn(home, { mcpDefaults: CONSENT, mcpBroker: (id) => (id === 'gmail' ? bad : undefined) });
    const mcpServers = serversOf(home);
    assert.equal('mosbius-gmail' in mcpServers, false, JSON.stringify(bad));
  }
});

test('an integration on the broker never reaches the bridge or the secret store', async (t) => {
  const home = tmpHome(t);
  let bridgeAsked = 0, secretAsked = [];
  await spawn(home, {
    mcpDefaults: { gmail: { enabled: true } },
    mcpBroker: () => ({ url: URL_OF('gmail'), authorization: `Bearer ${cap()}` }),
    mcpBridge: () => { bridgeAsked++; return { configDir: '/x', clientInfoFile: '/x/c.json' }; },
    mcpSecret: (id, field) => { secretAsked.push(`${id}:${field}`); return 'SHOULD-NOT-BE-READ'; }
  });
  assert.equal(bridgeAsked, 0, 'no runtime folder, no token file, no client file for it');
  assert.equal(secretAsked.filter((s) => s.startsWith('gmail')).length, 0);
  const { mcpServers } = readJson(path.join(agentDir(home), 'mcp-config.json'));
  assert.equal(JSON.stringify(mcpServers).includes('SHOULD-NOT-BE-READ'), false);
  assert.equal(mcpServers['mosbius-gmail'].type, 'http');
});

test('an integration on the bridge is written exactly as before when the app offers no broker entry', async (t) => {
  const home = tmpHome(t);
  await spawn(home, {
    mcpDefaults: { gmail: { enabled: true } },
    mcpBroker: () => undefined,
    mcpBridge: () => ({ configDir: path.join(home, 'vault', 'gmail'), clientInfoFile: path.join(home, 'vault', 'gmail', 'client.json') })
  });
  const { mcpServers } = readJson(path.join(agentDir(home), 'mcp-config.json'));
  assert.equal(mcpServers['mosbius-gmail'].type, 'stdio');
  assert.equal(mcpServers['mosbius-gmail'].command, 'npx');
  assert.ok(mcpServers['mosbius-gmail'].args.some((a) => a.startsWith('mcp-remote@')), 'the mcp-remote fallback is intact');
});

test('no integration offered: the MCP config of an earlier run is removed, so no capability lingers', async (t) => {
  const home = tmpHome(t);
  const token = cap();
  await spawn(home, { mcpDefaults: { gmail: { enabled: true }, ...Object.fromEntries(['sequential-thinking', 'time', 'fetch', 'context7', 'filesystem', 'git'].map((i) => [i, { enabled: false }])) }, mcpBroker: () => ({ url: URL_OF('gmail'), authorization: `Bearer ${token}` }) });
  const file = path.join(agentDir(home), 'mcp-config.json');
  assert.equal(fs.existsSync(file), true);
  await spawn(home, { mcpDefaults: Object.fromEntries(['gmail', 'sequential-thinking', 'time', 'fetch', 'context7', 'filesystem', 'git'].map((i) => [i, { enabled: false }])) });
  assert.equal(fs.existsSync(file), false);
});

test('removeMcpConfig removes one agent\'s config only; sweepMcpConfigs removes every agent\'s', async (t) => {
  const home = tmpHome(t);
  const opts = { mcpDefaults: { gmail: { enabled: true } }, mcpBroker: () => ({ url: URL_OF('gmail'), authorization: `Bearer ${cap()}` }) };
  const { hive } = await spawn(home, opts, 'a1');
  await spawn(home, opts, 'a2');
  await spawn(home, opts, 'a3');
  const f = (id) => path.join(agentDir(home, id), 'mcp-config.json');
  assert.equal(hive.removeMcpConfig('a1'), true);
  assert.equal(fs.existsSync(f('a1')), false);
  assert.equal(fs.existsSync(f('a2')), true);
  assert.equal(hive.removeMcpConfig('a1'), false, 'nothing left to remove');
  for (const bad of ['', '../a2', 'a2/../a3', '..', '/etc', 'a\0b', 'x'.repeat(200)]) assert.equal(hive.removeMcpConfig(bad), false, JSON.stringify(bad));
  assert.equal(fs.existsSync(f('a2')), true, 'a path-shaped id did not escape');
  assert.equal(hive.sweepMcpConfigs(), 2);
  assert.equal(fs.existsSync(f('a2')) || fs.existsSync(f('a3')), false);
  assert.equal(hive.sweepMcpConfigs(), 0);
});

test('an agent may not read another agent\'s MCP config: it holds that agent\'s capability', async (t) => {
  const home = tmpHome(t);
  const opts = { mcpDefaults: { gmail: { enabled: true } }, mcpBroker: () => ({ url: URL_OF('gmail'), authorization: `Bearer ${cap()}` }) };
  await spawn(home, opts, 'a2');
  await spawn(home, opts, 'a1');
  const settings = readJson(path.join(agentDir(home, 'a1'), 'settings.json'));
  const denied = settings.sandbox.filesystem.denyRead;
  const f = (id) => path.join(agentDir(home, id), 'mcp-config.json');
  assert.ok(denied.includes(f('a1')), 'its own');
  assert.ok(denied.includes(f('a2')), 'an existing neighbour\'s, named for the sandbox');
  const pattern = path.join(home, 'hive', 'agents', '*', 'mcp-config.json');
  assert.ok(denied.includes(pattern), 'and a pattern for the neighbours that do not exist yet');
  assert.ok(settings.permissions.deny.includes(`Read(/${pattern})`), 'which the file tools\' rules carry too');
  assert.ok(settings.permissions.deny.includes(`Read(/${f('a2')})`));
});
