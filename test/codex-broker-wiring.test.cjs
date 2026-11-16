'use strict';

/**
 * What a CODEX agent is given when an integration is reached through the in-app broker.
 *
 * Codex reads no agent-side MCP file of ours, so the broker route goes on its command line
 * (`-c mcp_servers.<name>.url=…`) and the capability goes into ONE environment variable that
 * Codex itself reads as the bearer token (`bearer_token_env_var`). The checks here:
 *   - the address is the broker's own loopback route and the variable holds a capability only;
 *   - Codex is told to keep the variable out of every shell command the agent runs (`shell_environment_policy.exclude`);
 *     its own default does NOT do this (measured on 0.142.2: tokens, keys and secrets stay in that shell), so the
 *     exclusion is explicit, and the user's own exclusions are kept;
 *   - consent, a well-formed entry and a grant are all still required, exactly as for Claude;
 *   - nothing about the provider (OAuth tokens, client ids, upstream URLs) is anywhere an agent can read;
 *   - the capability is not written into the agent's isolated CODEX_HOME or any other file.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const loadTs = require('./load-ts.cjs');

const { HiveManager, codexCapabilityVariable, codexUserShellExcludes, CODEX_CAPABILITY_PATTERN } = loadTs('src/main/hive.ts');
const { MCP_CATALOG } = loadTs('src/shared/mcpCatalog.ts');

const cap = () => randomBytes(32).toString('base64url');
const URL_OF = (id, port = 41234) => `http://127.0.0.1:${port}/m/${id}`;

function tmpHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mosbius-codex-wiring-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

async function spawnCodex(home, opts = {}, id = 'c1') {
  const hive = new HiveManager(() => home);
  const inj = await hive.ensureAgent({ id, name: id, provider: 'codex', cwd: home }, opts);
  return { hive, inj };
}

/** Every regular file under a directory, so a secret can be searched for anywhere an agent could read. */
function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    let st;
    try { st = fs.lstatSync(p); } catch { continue; }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

test('every capability variable is a legal name, unique, and matched by the pattern Codex is told to exclude', () => {
  const seen = new Set();
  const re = new RegExp(`^${CODEX_CAPABILITY_PATTERN.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace('*', '.*')}$`);
  for (const e of MCP_CATALOG) {
    const v = codexCapabilityVariable(e.id);
    assert.match(v, /^[A-Z][A-Z0-9_]*$/, `${e.id} -> ${v}`);
    assert.ok(re.test(v), `${v} must be matched by ${CODEX_CAPABILITY_PATTERN}`);
    assert.equal(seen.has(v), false, `${v} is used twice`);
    seen.add(v);
  }
  assert.equal(codexCapabilityVariable('google-calendar'), 'MOSBIUS_MCP_SECRET_TOKEN_GOOGLE_CALENDAR');
});

test('codexUserShellExcludes reads what a user\'s own config already excludes, and nothing it cannot read', () => {
  assert.deepEqual(codexUserShellExcludes(''), []);
  assert.deepEqual(codexUserShellExcludes('model = "o3"\n[other]\nexclude = ["NOPE"]\n'), [], 'a different table is not read');
  assert.deepEqual(codexUserShellExcludes('[shell_environment_policy]\ninherit = "all"\n'), [], 'no exclude key');
  assert.deepEqual(codexUserShellExcludes('[shell_environment_policy]\nexclude = ["AWS_*", \'AZURE_*\']\n'), ['AWS_*', 'AZURE_*']);
  assert.deepEqual(codexUserShellExcludes('[shell_environment_policy]\ninherit = "all"\nexclude = [\n  "AWS_*", # keep out\n  "GCP_*",\n]\n[next]\nexclude = ["NOPE"]\n'), ['AWS_*', 'GCP_*']);
  assert.deepEqual(codexUserShellExcludes('shell_environment_policy = { inherit = "all", exclude = ["AWS_*"] }\n'), ['AWS_*']);
  assert.deepEqual(codexUserShellExcludes('[shell_environment_policy]\nexclude = ["A\\"B"]\n'), ['A"B']);
  assert.deepEqual(codexUserShellExcludes(undefined), []);
  assert.deepEqual(codexUserShellExcludes(null), []);
});

test('a Codex agent gets the broker route on its command line and the capability in one variable', async (t) => {
  const home = tmpHome(t);
  const token = cap();
  const { inj } = await spawnCodex(home, {
    mcpDefaults: { notion: { enabled: true } },
    mcpBroker: (id) => (id === 'notion' ? { url: URL_OF('notion'), authorization: `Bearer ${token}` } : undefined)
  });
  const variable = codexCapabilityVariable('notion');
  assert.equal(inj.env[variable], token, 'the variable holds the capability and only the capability');
  const a = inj.args;
  const urlAt = a.indexOf(`mcp_servers.mosbius-notion.url=${JSON.stringify(URL_OF('notion'))}`);
  const varAt = a.indexOf(`mcp_servers.mosbius-notion.bearer_token_env_var=${JSON.stringify(variable)}`);
  assert.ok(urlAt > 0 && a[urlAt - 1] === '-c', 'the address is passed as a -c override');
  // and Codex is told to keep it out of the shell it runs for the model
  const exAt = a.indexOf(`shell_environment_policy.exclude=${JSON.stringify([CODEX_CAPABILITY_PATTERN]).replace(/","/g, '", "')}`);
  assert.ok(exAt > 0 && a[exAt - 1] === '-c', 'the capability is excluded from the agent\'s shell');
  // ...and the shell snapshot, which would put it back, is off for this agent
  const snapAt = a.indexOf('features.shell_snapshot=false');
  assert.ok(snapAt > 0 && a[snapAt - 1] === '-c', 'the shell snapshot is off, or the exclusion does nothing');
  assert.ok(varAt > 0 && a[varAt - 1] === '-c', 'the variable NAME is passed, never its value');
  // the capability itself is nowhere in the command line
  assert.deepEqual(a.filter((x) => x.includes(token)), []);
  // and these come before the positional prompt, so Codex does not read them as a prompt
  const promptAt = a.findIndex((x) => /HIVE PROTOCOL/.test(x));
  assert.ok(promptAt === -1 || (urlAt < promptAt && varAt < promptAt));
});

test('nothing about the provider reaches a Codex agent: no upstream address, no OAuth material', async (t) => {
  const home = tmpHome(t);
  const token = cap();
  const { inj } = await spawnCodex(home, {
    mcpDefaults: { notion: { enabled: true } },
    mcpBroker: () => ({ url: URL_OF('notion'), authorization: `Bearer ${token}` })
  });
  const text = JSON.stringify({ args: inj.args, env: inj.env });
  for (const forbidden of ['mcp.notion.com', 'access_token', 'refresh_token', 'client_secret', 'client_id', 'mcp-remote', 'MCP_REMOTE_CONFIG_DIR']) {
    assert.equal(text.includes(forbidden), false, `${forbidden} must not reach a Codex agent`);
  }
});

test('the capability is written to no file: not the isolated CODEX_HOME, not the agent folder', async (t) => {
  const home = tmpHome(t);
  const token = cap();
  const { inj } = await spawnCodex(home, {
    mcpDefaults: { notion: { enabled: true } },
    mcpBroker: () => ({ url: URL_OF('notion'), authorization: `Bearer ${token}` })
  });
  assert.ok(inj.env.CODEX_HOME, 'a Codex agent runs in its own isolated home');
  for (const f of walk(home)) {
    let body;
    try { body = fs.readFileSync(f, 'utf8'); } catch { continue; }
    assert.equal(body.includes(token), false, `the capability was written to ${path.relative(home, f)}`);
  }
  // Claude's MCP config file is not produced for a Codex agent
  assert.equal(fs.existsSync(path.join(home, 'hive', 'agents', 'c1', 'mcp-config.json')), false);
});

test('the user\'s own shell exclusions are kept, not replaced', async (t) => {
  const home = tmpHome(t);
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'), '[shell_environment_policy]\ninherit = "all"\nexclude = ["AWS_*", "GCP_*"]\n');
  const before = process.env.HOME;
  process.env.HOME = home;
  try {
    const { inj } = await spawnCodex(home, {
      mcpDefaults: { notion: { enabled: true } },
      mcpBroker: () => ({ url: URL_OF('notion'), authorization: `Bearer ${cap()}` })
    });
    assert.ok(inj.args.includes('shell_environment_policy.exclude=["AWS_*", "GCP_*", "MOSBIUS_MCP_*"]'), JSON.stringify(inj.args.filter((x) => x.startsWith('shell_env'))));
  } finally {
    if (before === undefined) delete process.env.HOME; else process.env.HOME = before;
  }
});

test('an agent with nothing wired is left exactly as it was: no shell policy change', async (t) => {
  const home = tmpHome(t);
  const { inj } = await spawnCodex(home, { mcpDefaults: { notion: { enabled: true } }, mcpBroker: () => undefined });
  assert.deepEqual(inj.args.filter((x) => x.startsWith('shell_environment_policy') || x.startsWith('features.')), []);
});

test('consent still decides: an integration the user has not switched on adds nothing', async (t) => {
  const home = tmpHome(t);
  const { inj } = await spawnCodex(home, {
    mcpDefaults: { notion: { enabled: false } },
    mcpBroker: () => ({ url: URL_OF('notion'), authorization: `Bearer ${cap()}` })
  });
  assert.deepEqual(inj.args.filter((x) => x.startsWith('mcp_servers.')), []);
  assert.deepEqual(Object.keys(inj.env).filter((k) => k.startsWith('MOSBIUS_MCP_')), []);
});

test('no grant means no entry: the app returns nothing for an integration this agent may not use', async (t) => {
  const home = tmpHome(t);
  const { inj } = await spawnCodex(home, {
    mcpDefaults: { notion: { enabled: true }, linear: { enabled: true } },
    mcpBroker: (id) => (id === 'linear' ? { url: URL_OF('linear'), authorization: `Bearer ${cap()}` } : undefined)
  });
  assert.ok(inj.args.some((x) => x.startsWith('mcp_servers.mosbius-linear.url=')));
  assert.equal(inj.args.some((x) => x.includes('mosbius-notion')), false, 'consented but not granted: not wired');
  assert.equal(codexCapabilityVariable('notion') in inj.env, false);
});

test('a malformed entry from the app is refused rather than wired', async (t) => {
  for (const bad of [
    { url: 'https://mcp.notion.com/mcp', authorization: `Bearer ${cap()}` },           // the real server, not the broker
    { url: URL_OF('notion'), authorization: 'Bearer ya29.not-a-capability' },           // a provider-shaped token
    { url: URL_OF('linear'), authorization: `Bearer ${cap()}` },                        // a route for another integration
    { url: 'http://127.0.0.1:41234@evil.example/m/notion', authorization: `Bearer ${cap()}` }
  ]) {
    const home = tmpHome(t);
    const { inj } = await spawnCodex(home, { mcpDefaults: { notion: { enabled: true } }, mcpBroker: () => bad });
    assert.deepEqual(inj.args.filter((x) => x.startsWith('mcp_servers.')), [], JSON.stringify(bad));
    assert.deepEqual(Object.keys(inj.env).filter((k) => k.startsWith('MOSBIUS_MCP_')), [], JSON.stringify(bad));
  }
});

test('two integrations get two variables and two routes; each holds only its own capability', async (t) => {
  const home = tmpHome(t);
  const tokens = { notion: cap(), linear: cap() };
  const { inj } = await spawnCodex(home, {
    mcpDefaults: { notion: { enabled: true }, linear: { enabled: true } },
    mcpBroker: (id) => (tokens[id] ? { url: URL_OF(id), authorization: `Bearer ${tokens[id]}` } : undefined)
  });
  // the broker mints one capability per agent, so the same value could be shared, but the wiring must not
  // depend on that: each variable carries what the app returned for ITS integration.
  assert.equal(inj.env[codexCapabilityVariable('notion')], tokens.notion);
  assert.equal(inj.env[codexCapabilityVariable('linear')], tokens.linear);
  assert.notEqual(codexCapabilityVariable('notion'), codexCapabilityVariable('linear'));
});

test('a Gemini or Claude agent does not get Codex flags, and a Codex agent gets no Claude flags', async (t) => {
  const home = tmpHome(t);
  const opts = { mcpDefaults: { notion: { enabled: true } }, mcpBroker: () => ({ url: URL_OF('notion'), authorization: `Bearer ${cap()}` }) };
  const { inj: codex } = await spawnCodex(home, opts, 'c1');
  assert.equal(codex.args.includes('--mcp-config'), false, 'Codex has no --mcp-config');
  const hive = new HiveManager(() => home);
  const claude = await hive.ensureAgent({ id: 'k1', name: 'k1', provider: 'claude', cwd: home }, opts);
  assert.equal(claude.args.some((x) => x.startsWith('mcp_servers.')), false, 'Claude never gets -c overrides');
  assert.equal(Object.keys(claude.env).some((k) => k.startsWith('MOSBIUS_MCP_')), false, 'Claude carries its capability in its own config file');
});
