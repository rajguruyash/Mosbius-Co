'use strict';

/**
 * What a GEMINI agent is given when an integration is reached through the in-app broker.
 *
 * Measured on the real Gemini CLI 0.68.0 (evidence/gemini/gemini-live.json, tools/verify-gemini-live.cjs):
 *   - a SYSTEM settings file, or a system-defaults file, is refused unless every parent directory is owned by root,
 *     so nothing the app writes into a person's own folder can be read through those layers;
 *   - the layer the app can own is the USER layer of an isolated GEMINI_CLI_HOME, so each agent gets a home of its own,
 *     with the person's settings merged in and their login, skills, commands and extensions linked;
 *   - `$NAME` in a header is expanded from the CLI's own environment, so the settings file names a variable and never
 *     holds the capability;
 *   - folder trust is the person's, made in Gemini, so it is shared through GEMINI_CLI_TRUSTED_FOLDERS_PATH.
 * These tests prove what the app WRITES. That the real CLI reads it is shown by the live tool, not here.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const loadTs = require('./load-ts.cjs');

const { HiveManager, codexCapabilityVariable, parseJsonLoose, mergeGeminiSettings, GEMINI_NOT_LINKED } = loadTs('src/main/hive.ts');

const cap = () => randomBytes(32).toString('base64url');
const URL_OF = (id, port = 41234) => `http://127.0.0.1:${port}/m/${id}`;

/** A throwaway home, made the person's home for the length of the test (os.homedir() reads it). */
function tmpHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mosbius-gemini-wiring-'));
  const before = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home; process.env.USERPROFILE = home;
  t.after(() => {
    for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(home, { recursive: true, force: true });
  });
  assert.equal(os.homedir(), home, 'the home redirect worked: nothing of the real home is touched');
  return home;
}
async function spawnGemini(home, opts = {}, id = 'g1') {
  const hive = new HiveManager(() => home);
  const inj = await hive.ensureAgent({ id, name: id, provider: 'gemini', cwd: home }, opts);
  const agentHome = inj.env.GEMINI_CLI_HOME;
  const settingsFile = agentHome ? path.join(agentHome, '.gemini', 'settings.json') : undefined;
  return { hive, inj, agentHome, settingsFile };
}
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    let st; try { st = fs.lstatSync(p); } catch { continue; }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}
const WIRE = (id, token) => ({ mcpDefaults: { [id]: { enabled: true } }, mcpBroker: (cid) => (cid === id ? { url: URL_OF(id), authorization: `Bearer ${token}` } : undefined) });

test('a Gemini agent gets the broker route in the settings of its own Gemini home, naming a variable, and the capability only in that variable', async (t) => {
  const home = tmpHome(t);
  const token = cap();
  const { inj, agentHome, settingsFile } = await spawnGemini(home, WIRE('notion', token));
  const variable = codexCapabilityVariable('notion');
  assert.ok(agentHome && agentHome.startsWith(path.join(home, 'hive', 'agents', 'g1')), 'the home is inside the agent\'s own folder');
  const settings = readJson(settingsFile);
  assert.deepEqual(settings.mcpServers, { 'mosbius-notion': { httpUrl: URL_OF('notion'), headers: { Authorization: `Bearer $${variable}` } } });
  assert.equal(inj.env[variable], token, 'the variable holds the capability and nothing else');
  assert.ok(settings.hooks && settings.hooksConfig.enabled === true, 'the lifecycle hooks are in the same file');
  for (const f of walk(home)) {
    let body; try { body = fs.readFileSync(f, 'utf8'); } catch { continue; }
    assert.equal(body.includes(token), false, `the capability was written to ${path.relative(home, f)}`);
  }
  assert.deepEqual(inj.args.filter((a) => a.includes(token)), []);
  const text = JSON.stringify(settings.mcpServers);
  for (const forbidden of ['command', 'args', '"env"', 'mcp-remote', 'client_secret', 'access_token', 'refresh_token']) {
    assert.equal(text.includes(forbidden), false, forbidden);
  }
});

test('the system settings layer is never used: the real CLI refuses a file it does not find root-owned', async (t) => {
  const home = tmpHome(t);
  const { inj } = await spawnGemini(home, WIRE('notion', cap()));
  assert.equal('GEMINI_CLI_SYSTEM_SETTINGS_PATH' in inj.env, false);
  assert.equal('GEMINI_CLI_SYSTEM_DEFAULTS_PATH' in inj.env, false);
  assert.equal(fs.existsSync(path.join(home, 'hive', 'agents', 'g1', '.gemini-hive', 'system-settings.json')), false, 'and no such file is written');
});

test('folder trust stays the person\'s decision, shared by every agent through their own file', async (t) => {
  const home = tmpHome(t);
  const { inj } = await spawnGemini(home, WIRE('notion', cap()));
  assert.equal(inj.env.GEMINI_CLI_TRUSTED_FOLDERS_PATH, path.join(home, '.gemini', 'trustedFolders.json'));
  // the agent cannot have a copy of it: the file is not linked into its home
  assert.equal(fs.existsSync(path.join(inj.env.GEMINI_CLI_HOME, '.gemini', 'trustedFolders.json')), false);
});

test('nothing about the provider reaches a Gemini agent', async (t) => {
  const home = tmpHome(t);
  const { inj, settingsFile } = await spawnGemini(home, WIRE('notion', cap()));
  const text = JSON.stringify({ args: inj.args, env: inj.env, settings: readJson(settingsFile) });
  for (const forbidden of ['mcp.notion.com', 'refresh_token', 'client_id', 'MCP_REMOTE_CONFIG_DIR']) {
    assert.equal(text.includes(forbidden), false, `${forbidden} must not reach a Gemini agent`);
  }
});

test('consent, a grant and a well-formed entry are all still required', async (t) => {
  const readServers = (r) => readJson(r.settingsFile).mcpServers;
  // no consent
  let home = tmpHome(t);
  let r = await spawnGemini(home, { mcpDefaults: { notion: { enabled: false } }, mcpBroker: () => ({ url: URL_OF('notion'), authorization: `Bearer ${cap()}` }) });
  assert.equal(readServers(r), undefined);
  assert.deepEqual(Object.keys(r.inj.env).filter((k) => k.startsWith('MOSBIUS_MCP_')), []);
  // consent but no grant for this agent (the app returns nothing)
  home = tmpHome(t);
  r = await spawnGemini(home, { mcpDefaults: { notion: { enabled: true } }, mcpBroker: () => undefined });
  assert.equal(readServers(r), undefined);
  // malformed entries
  for (const bad of [
    { url: 'https://mcp.notion.com/mcp', authorization: `Bearer ${cap()}` },
    { url: URL_OF('notion'), authorization: 'Bearer ya29.not-a-capability' },
    { url: URL_OF('linear'), authorization: `Bearer ${cap()}` }
  ]) {
    home = tmpHome(t);
    r = await spawnGemini(home, { mcpDefaults: { notion: { enabled: true } }, mcpBroker: () => bad });
    assert.equal(readServers(r), undefined, JSON.stringify(bad));
    assert.deepEqual(Object.keys(r.inj.env).filter((k) => k.startsWith('MOSBIUS_MCP_')), [], JSON.stringify(bad));
  }
});

test('the person\'s own Gemini setup is carried into the agent\'s home and never written to', async (t) => {
  const home = tmpHome(t);
  const gem = path.join(home, '.gemini');
  fs.mkdirSync(path.join(gem, 'extensions', 'mine'), { recursive: true });
  fs.mkdirSync(path.join(gem, 'history'), { recursive: true });
  fs.mkdirSync(path.join(gem, 'tmp'), { recursive: true });
  const mine = {
    security: { auth: { selectedType: 'oauth-personal' } },
    theme: 'Dracula',
    mcpServers: { mine: { httpUrl: 'https://example.test/mcp' } },
    hooksConfig: { enabled: false, extra: 1 },
    hooks: { BeforeTool: [{ matcher: 'shell', hooks: [{ name: 'mine', type: 'command', command: 'echo mine' }] }] }
  };
  fs.writeFileSync(path.join(gem, 'settings.json'), `// my settings\n${JSON.stringify(mine, null, 2).replace(/\n\}$/, ',\n}')}`);   // comments and a trailing comma are legal for Gemini
  fs.writeFileSync(path.join(gem, 'oauth_creds.json'), '{"refresh_token":"user-login-canary"}');
  fs.writeFileSync(path.join(gem, 'installation_id'), 'abc');
  fs.writeFileSync(path.join(gem, 'trustedFolders.json'), '{}');
  fs.writeFileSync(path.join(gem, 'projects.json'), '{}');
  const before = fs.readdirSync(gem).sort();
  const beforeText = fs.readFileSync(path.join(gem, 'settings.json'), 'utf8');

  const { agentHome, settingsFile } = await spawnGemini(home, WIRE('notion', cap()));
  const merged = readJson(settingsFile);
  assert.equal(merged.security.auth.selectedType, 'oauth-personal', 'their login choice is untouched');
  assert.equal(merged.theme, 'Dracula', 'every other key of theirs is untouched');
  assert.deepEqual(Object.keys(merged.mcpServers).sort(), ['mine', 'mosbius-notion'], 'their server stays beside ours');
  assert.equal(merged.hooksConfig.extra, 1);
  assert.equal(merged.hooksConfig.enabled, true, 'the bridge needs hooks on, so this one is ours');
  assert.equal(merged.hooks.BeforeTool[0].hooks[0].command, 'echo mine', 'their hook runs first');
  assert.ok(/gemini-hook\.cjs/.test(merged.hooks.BeforeTool.at(-1).hooks[0].command), 'ours follows');

  const link = (n) => path.join(agentHome, '.gemini', n);
  for (const name of ['oauth_creds.json', 'installation_id', 'extensions']) {
    assert.ok(fs.lstatSync(link(name)).isSymbolicLink(), `${name} is linked, so the agent is the Gemini they use`);
  }
  assert.equal(fs.readFileSync(link('oauth_creds.json'), 'utf8').includes('user-login-canary'), true);
  for (const name of GEMINI_NOT_LINKED) {
    if (name === 'skills') continue;
    assert.equal(fs.existsSync(link(name)) && fs.lstatSync(link(name)).isSymbolicLink(), false, `${name} is not linked`);
  }
  assert.equal(fs.lstatSync(settingsFile).isSymbolicLink(), false, 'the agent\'s settings are its own file, so writing to it cannot reach theirs');
  assert.ok(fs.lstatSync(path.join(agentHome, '.agents')).isSymbolicLink(), 'the shared skills folder is reachable');
  assert.ok(fs.lstatSync(link('skills')).isSymbolicLink(), 'and so is their Gemini skills folder, before it even exists');
  // theirs, byte for byte
  assert.deepEqual(fs.readdirSync(gem).sort(), before, 'nothing was added to, or removed from, their folder');
  assert.equal(fs.readFileSync(path.join(gem, 'settings.json'), 'utf8'), beforeText);
});

test('spawning the same agent again leaves a working home: links are refreshed, a real file the agent made is not touched', async (t) => {
  const home = tmpHome(t);
  const gem = path.join(home, '.gemini');
  fs.mkdirSync(gem, { recursive: true });
  fs.writeFileSync(path.join(gem, 'oauth_creds.json'), '{}');
  const first = await spawnGemini(home, WIRE('notion', cap()));
  fs.writeFileSync(path.join(first.agentHome, '.gemini', 'GEMINI.md'), 'the agent wrote this');
  fs.writeFileSync(path.join(gem, 'google_accounts.json'), '{}');           // appears between runs
  const second = await spawnGemini(home, WIRE('notion', cap()));
  assert.equal(second.agentHome, first.agentHome);
  assert.ok(fs.lstatSync(path.join(second.agentHome, '.gemini', 'google_accounts.json')).isSymbolicLink(), 'a new file of theirs is linked on the next spawn');
  assert.equal(fs.readFileSync(path.join(second.agentHome, '.gemini', 'GEMINI.md'), 'utf8'), 'the agent wrote this');
});

test('parseJsonLoose reads settings the way Gemini does, and never throws', () => {
  assert.deepEqual(parseJsonLoose('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJsonLoose('// c\n{ /* x */ "a": 1, "b": [1,2,], }'), { a: 1, b: [1, 2] });
  assert.deepEqual(parseJsonLoose('{"url":"http://x.test//not-a-comment","s":"a \\" // still a string"}'), { url: 'http://x.test//not-a-comment', s: 'a " // still a string' });
  for (const bad of ['', 'not json', '[1,2]', '"text"', 'null', '{"a":', undefined, null, 5]) assert.deepEqual(parseJsonLoose(bad), {}, String(bad));
});

test('mergeGeminiSettings keeps what is theirs and adds only what is ours', () => {
  const ours = { hooksConfig: { enabled: true, notifications: false }, hooks: { BeforeTool: [{ ours: 1 }] }, mcpServers: {} };
  const out = mergeGeminiSettings({ a: 1, mcpServers: { mine: { url: 'x' } }, hooks: { AfterTool: [{ theirs: 1 }], BeforeTool: [{ theirs: 2 }] } }, ours);
  assert.equal(out.a, 1);
  assert.deepEqual(out.hooks.BeforeTool, [{ theirs: 2 }, { ours: 1 }]);
  assert.deepEqual(out.hooks.AfterTool, [{ theirs: 1 }]);
  assert.deepEqual(out.mcpServers, { mine: { url: 'x' } });
  assert.equal('mcpServers' in mergeGeminiSettings({}, ours), false, 'no servers means no key');
  // hostile shapes in their file do not break it
  for (const user of [{ hooks: 'x', hooksConfig: 5, mcpServers: [] }, { hooks: [], mcpServers: 'x' }]) {
    const m = mergeGeminiSettings(user, ours);
    assert.deepEqual(m.hooks.BeforeTool, [{ ours: 1 }]);
    assert.equal(m.hooksConfig.enabled, true);
  }
});

test('Codex and Claude agents get no Gemini environment, and Gemini gets no Codex flags', async (t) => {
  const home = tmpHome(t);
  const opts = WIRE('notion', cap());
  const hive = new HiveManager(() => home);
  const codex = await hive.ensureAgent({ id: 'c1', name: 'c1', provider: 'codex', cwd: home }, opts);
  for (const k of ['GEMINI_CLI_HOME', 'GEMINI_CLI_SYSTEM_SETTINGS_PATH', 'GEMINI_CLI_TRUSTED_FOLDERS_PATH']) assert.equal(k in codex.env, false, k);
  const { inj } = await spawnGemini(home, opts, 'g2');
  assert.equal(inj.args.some((a) => a.startsWith('mcp_servers.') || a === '-c'), false);
});
