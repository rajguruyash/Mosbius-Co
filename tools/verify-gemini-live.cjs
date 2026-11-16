#!/usr/bin/env node
'use strict';

/**
 * Gemini CLI, driven for real against the app's broker.
 *
 *   node tools/verify-gemini-live.cjs --gemini <path to the gemini binary> [--evidence evidence/gemini/gemini-live]
 *
 * What runs for real: the `gemini` CLI you point it at (headless, with its own agent loop, its own MCP client, its own
 * shell tool, its own skills and hooks loaders), the app's production code that decides what a Gemini agent is given
 * (HiveManager.ensureAgent: the agent's own Gemini home, the person's settings merged in, the broker entry), the in-app
 * broker and its MCP route, the connection manager (an account connected with a sign-in), the audit log.
 *
 * What does NOT: no real account anywhere.
 *   - the provider behind the broker is a STAND-IN (test/fixtures/stage-a-idp.cjs);
 *   - the MODEL is a stand-in speaking the Gemini API on a loopback address (GOOGLE_GEMINI_BASE_URL), playing a fixed
 *     script, so the real agent loop runs without a Google account or a key. Whether a real Gemini model uses the offered
 *     tools well is NOT tested here;
 *   - a throwaway HOME is the person's home: their real ~/.gemini is never read or copied. The CLI's own login, and
 *     whether the app's links carry a REAL login into the agent's home, are not tested (nothing here is signed in).
 *
 * Checks (printed PASS/FAIL, exit 1 on any FAIL, 2 when the CLI is missing):
 *   startup      the agent's home the app builds is accepted; the broker's server connects, authenticated by `$VAR`
 *   discovery    the model is offered exactly the granted tool, and no other integration's tool
 *   execution    a tool call made by the model reaches the provider with the PROVIDER's token, never the agent's pass
 *   permission   a tool that was not granted is not offered, cannot be called, and nothing of it reaches the provider
 *   isolation    what Gemini's shell can see (MEASURED, not assumed), nothing secret in files, arguments, model traffic
 *   revocation   after the pass is revoked the CLI no longer connects and the provider is not asked
 *   trust        in a folder the person has not trusted in Gemini, the integration is disabled (it fails closed)
 *   hooks        the lifecycle hooks the app writes are loaded and RUN by the real CLI
 *   skills       where the CLI finds skills inside the app's agent home, and that a skill the app installs for Gemini is found
 *   control      the system-settings layer the app used to write is REFUSED by this CLI (the reason for the design)
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const http = require('node:http');
const { spawn, spawnSync, execFileSync } = require('node:child_process');

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const geminiBin = flag('--gemini', 'gemini');
const evidenceBase = flag('--evidence');
const packageDir = flag('--package-dir');           // where `npm install @google/gemini-cli` was run, to record its integrity

// A throwaway "person's home". Short on purpose: a unix socket path is limited to about 100 characters.
const ROOT = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'mgl-'));
const FAKE_HOME = path.join(ROOT, 'h');
const WORK = path.join(ROOT, 'w');                  // a workspace the person HAS trusted in Gemini
const OTHER = path.join(ROOT, 'u');                 // a workspace they have NOT
for (const d of [FAKE_HOME, WORK, OTHER, path.join(FAKE_HOME, '.gemini')]) fs.mkdirSync(d, { recursive: true });
process.env.HOME = FAKE_HOME; process.env.USERPROFILE = FAKE_HOME;

const loadTs = require('../test/load-ts.cjs');
const { startStageAIdp } = require('../test/fixtures/stage-a-idp.cjs');
const { fakeGitHub, URL1 } = require('../test/fixtures/fake-github.cjs');
const { call, json, rpc } = require('../test/fixtures/broker-helpers.cjs');
const { IntegrationBroker } = loadTs('src/main/integrationBroker.ts');
const { HiveManager, codexCapabilityVariable } = loadTs('src/main/hive.ts');
const { AuditLog } = loadTs('src/main/broker/audit.ts');
const { mcpIntegrationFor, eligibleIntegrationIds, sanitizeMcpGrants } = loadTs('src/main/mcpWiring.ts');
const { createMcpCredentialProvider } = loadTs('src/main/mcpCredentials.ts');
const { ConnectionManager } = loadTs('src/main/connect/manager.ts');
const { safeLog } = loadTs('src/main/oauth/types.ts');
const { installSkill } = loadTs('src/main/skills.ts');
const { compatOf } = loadTs('src/shared/agentCompat.ts');

const results = [];
const info = {};
const check = (group, name, ok, detail = '') => {
  results.push({ group, name, ok: !!ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  [${group}] ${name}${detail ? `  — ${detail}` : ''}`);
};
const ID = 'linear';
const AGENT = 'agent-gemini';
const cleanups = [];
let idp;
const upstreamTools = () => idp.mcpCalls.filter((c) => c.method === 'tools/call').map((c) => c.params?.name);

// ── the test "browser" and a vault, as in the other live tools ────────────────────────────────────
const rawGet = (target, headers = {}) => new Promise((resolve) => {
  const u = new URL(target);
  const req = http.request({ host: '127.0.0.1', port: u.port, path: u.pathname + u.search, headers }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
  req.on('error', () => resolve(0)); req.end();
});
const browser = async (url) => {
  const r = await fetch(url, { redirect: 'manual' });
  const loc = r.headers.get('location');
  if (loc) await rawGet(loc, { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' });
};
const makeVault = () => { const v = { map: new Map(), get: (r) => v.map.get(r), set: (r, x) => (v.map.set(r, x), { ok: true }), has: (r) => v.map.has(r), readable: () => true, delete: (r) => v.map.delete(r) }; return v; };

// ── a stand-in MODEL that speaks the Gemini API and plays a script ────────────────────────────────
class StubGemini {
  constructor(script) {
    this.script = script; this.step = 0; this.offered = []; this.outputs = []; this.seen = new Set(); this.bodies = []; this.paths = [];
    this.server = http.createServer((req, res) => this.handle(req, res));
  }
  async start() { await new Promise((r) => this.server.listen(0, '127.0.0.1', r)); this.port = this.server.address().port; return this; }
  stop() { this.server.close(); }
  handle(req, res) {
    let body = ''; req.on('data', (c) => (body += c));
    req.on('end', () => {
      this.bodies.push(body); this.paths.push(`${req.method} ${req.url.split('?')[0]}`);
      let j = {}; try { j = JSON.parse(body); } catch { /* not json */ }
      if (/:streamGenerateContent/.test(req.url)) {
        const names = (j.tools ?? []).flatMap((t) => (t.functionDeclarations ?? []).map((f) => f.name));
        if (this.step === 0) this.offered = names;
        // every request repeats the whole history, so a result is recorded once, in the order it was first seen
        for (const c of j.contents ?? []) for (const p of c.parts ?? []) {
          if (!p.functionResponse) continue;
          const text = JSON.stringify(p.functionResponse.response);
          const key = `${p.functionResponse.name}|${p.functionResponse.id ?? ''}|${text}`;
          if (!this.seen.has(key)) { this.seen.add(key); this.outputs.push({ name: p.functionResponse.name, text, response: p.functionResponse.response }); }
        }
        const next = this.script[this.step++];
        if (next && next.before) next.before();
        const parts = next && next.call ? [{ functionCall: next.call(names) }].filter((p) => p.functionCall) : [{ text: 'done' }];
        const chunk = { candidates: [{ content: { role: 'model', parts: parts.length ? parts : [{ text: 'done' }] }, finishReason: 'STOP', index: 0 }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } };
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        return res.end(`data: ${JSON.stringify(chunk)}\r\n\r\n`);
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      if (/:generateContent/.test(req.url)) return res.end(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: '{"reasoning":"x","next_speaker":"user"}' }] }, finishReason: 'STOP' }], usageMetadata: { totalTokenCount: 2 } }));
      return res.end('{}');
    });
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────────────────────────
const psSnapshot = () => { try { return execFileSync('ps', ['-axo', 'pid=,args='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }); } catch { return ''; } };
function walk(dir, out = []) {
  let names; try { names = fs.readdirSync(dir); } catch { return out; }
  for (const name of names) {
    const p = path.join(dir, name); let st; try { st = fs.lstatSync(p); } catch { continue; }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}
const leaks = (haystack, needles) => needles.filter((n) => n && haystack.includes(n));
const clean = (s) => String(s).replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');

/** The environment the CLI is started with: minimal, plus the app's, plus the person's own variables. */
function cliEnv(extra, stub) {
  return {
    PATH: process.env.PATH, HOME: FAKE_HOME, TMPDIR: process.env.TMPDIR ?? '/tmp', LANG: 'en_US.UTF-8', USER: process.env.USER ?? 'user', SHELL: '/bin/zsh',
    TERM: 'dumb', NO_COLOR: '1', CI: '1',
    GEMINI_API_KEY: 'stub-key-the-person-gave-gemini', ...(stub ? { GOOGLE_GEMINI_BASE_URL: `http://127.0.0.1:${stub.port}` } : {}),
    USER_PLAIN_VARIABLE: 'visible', MY_OWN_API_KEY: 'user-key-canary', SSH_AUTH_SOCK: '/tmp/not-a-real-agent.sock',
    ...extra
  };
}

function run(args, { env, cwd, timeoutMs = 120_000 }) {
  return new Promise((resolve) => {
    const child = spawn(geminiBin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = ''; const snaps = [];
    child.stdout.on('data', (c) => (out += c)); child.stderr.on('data', (c) => (err += c));
    const sampler = setInterval(() => snaps.push(psSnapshot()), 500);
    const killer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (code) => { clearInterval(sampler); clearTimeout(killer); resolve({ code, out: clean(out), err: clean(err), snaps }); });
  });
}
const mcpList = async (env, cwd) => {
  const r = await run(['mcp', 'list'], { env, cwd, timeoutMs: 60_000 });
  const rows = {};
  // (this CLI prints the list on stderr, not stdout: read both)
  for (const m of `${r.out}\n${r.err}`.matchAll(/^\s*\S\s+([^\s:]+):\s+(\S+)\s+\((\w+)\)\s+-\s+(.+?)\s*$/gm)) rows[m[1]] = { url: m[2], type: m[3], state: m[4] };
  return { ...r, rows };
};
const skillsList = async (env, cwd) => {
  const r = await run(['skills', 'list', '--all'], { env, cwd, timeoutMs: 60_000 });
  const names = [...r.out.matchAll(/^(\S+) \[(Enabled|Disabled)\]/gm)].map((m) => m[1]);
  return { ...r, names };
};
const shellNamesOf = (stub) => {
  const out = stub.outputs.find((o) => o.name === 'run_shell_command');
  const text = out ? out.text : '';
  return { names: new Set([...text.matchAll(/(?:\\n|\n)([A-Za-z_][A-Za-z0-9_]*)(?=\\n|\n|")/g)].map((m) => m[1]).concat([...text.matchAll(/(?:^|\\n|\n|:")([A-Za-z_][A-Za-z0-9_]*)(?=\\n)/g)].map((m) => m[1]))), text };
};

(async () => {
  let version = '';
  try { version = execFileSync(geminiBin, ['--version'], { encoding: 'utf8' }).trim(); } catch { console.error('BLOCKED: no Gemini CLI at', geminiBin); try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* gone */ } process.exit(2); }
  info.gemini = `gemini-cli ${version}`; info.platform = `${process.platform}/${process.arch}`; info.node = process.version;
  if (packageDir) {
    try {
      const lock = JSON.parse(fs.readFileSync(path.join(packageDir, 'package-lock.json'), 'utf8')).packages['node_modules/@google/gemini-cli'];
      info.package = { name: '@google/gemini-cli', version: lock.version, integrity: lock.integrity, installedWith: 'npm install --ignore-scripts --save-exact, into a throwaway folder' };
    } catch { /* not recorded */ }
  }
  console.log(`gemini-cli ${version} · node ${process.version} · ${process.platform}/${process.arch}\n  (throwaway home ${FAKE_HOME}; the person's real ~/.gemini is not read)\n`);

  // the person's own Gemini setup, as a person might have it: a login choice, a server of their own, a login file, skills
  const gem = path.join(FAKE_HOME, '.gemini');
  fs.writeFileSync(path.join(gem, 'settings.json'), JSON.stringify({
    security: { auth: { selectedType: 'gemini-api-key' } }, telemetry: { enabled: false }, general: { enableAutoUpdate: false },
    privacy: { usageStatisticsEnabled: false }, mcpServers: { mine: { httpUrl: 'http://127.0.0.1:9/mine' } }
  }));
  fs.writeFileSync(path.join(gem, 'oauth_creds.json'), '{"note":"stand-in login file; not a real credential"}');
  fs.writeFileSync(path.join(gem, 'trustedFolders.json'), JSON.stringify({ [WORK]: 'TRUST_FOLDER' }));
  const skillMd = (n) => `---\nname: ${n}\ndescription: probe ${n}\n---\nSay hello.\n`;
  const plant = (dir, n) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'SKILL.md'), skillMd(n)); };
  const spots = {
    '~/.agents/skills': plant.bind(null, path.join(FAKE_HOME, '.agents', 'skills', 'probe-home-agents'), 'probe-home-agents'),
    '~/.gemini/skills': plant.bind(null, path.join(gem, 'skills', 'probe-home-gemini'), 'probe-home-gemini'),
    '<project>/.agents/skills': plant.bind(null, path.join(WORK, '.agents', 'skills', 'probe-proj-agents'), 'probe-proj-agents'),
    '<project>/.gemini/skills': plant.bind(null, path.join(WORK, '.gemini', 'skills', 'probe-proj-gemini'), 'probe-proj-gemini'),
    '<project>/.claude/skills': plant.bind(null, path.join(WORK, '.claude', 'skills', 'probe-proj-claude'), 'probe-proj-claude')
  };
  for (const f of Object.values(spots)) f();

  // ── the app, assembled the way src/main/index.ts assembles it ───────────────────────────────────
  idp = await startStageAIdp({ after: (fn) => cleanups.push(fn) });
  const vault = makeVault();
  const entry = {
    id: ID, label: 'Linear', description: '', tier: 'write', defaultEnabled: false, publisher: 'test', source: 'test', verified: '2026-11-15',
    spec: { transport: 'http', url: `${idp.base}/mcp`, connect: { hosts: [idp.host], methods: [{ kind: 'dcr' }] } }
  };
  const mgr = new ConnectionManager({
    entry: (id) => (id === ID ? entry : undefined), secrets: vault, fetch: (u, i) => fetch(u, i), openUrl: browser,
    now: () => Date.now(), log: safeLog(() => {}), policy: { allowInsecureLoopback: true }, sleep: async () => {},
    timeouts: { signInMs: 8000, requestMs: 8000, refreshMs: 8000, retryDelaysMs: [0, 0], cooldownMs: 50, revokeMs: 4000 }
  });
  cleanups.push(() => mgr.dispose());
  const cfg = { mcpDefaults: { [ID]: { enabled: true } }, mcpGrants: { defaults: { [ID]: { preset: 'custom', allow: ['search'] } } } };
  const audit = new AuditLog();
  const broker = new IntegrationBroker({ getRecord: () => undefined, getSecret: () => undefined }, {
    mcp: {
      resolve: (id) => { const i = mcpIntegrationFor(id, cfg); return i ? { ...i, url: `${idp.base}/mcp` } : undefined; },
      credentials: createMcpCredentialProvider({
        entry: (id) => (id === ID ? entry : undefined), token: () => undefined,
        oauth: { accessHeaders: () => ({ ok: false, code: 'unavailable' }) },
        connections: { status: (id) => mgr.status(id), accessHeaders: (s) => mgr.accessHeaders(s), rejected: (s, u) => mgr.rejected(s, u) }
      }),
      grants: () => sanitizeMcpGrants(cfg.mcpGrants),
      audit: (e) => audit.push(e)
    }
  });
  if (!(await broker.start()).ok) { console.error('broker did not start'); process.exit(1); }
  cleanups.push(() => broker.stop());

  const connected = await mgr.connect(ID);
  check('startup', 'an account is connected through the stand-in provider (sign-in, no pasted key)', connected && connected.ok === true);
  const ids = eligibleIntegrationIds(cfg, AGENT, (id) => (id === ID ? mgr.status(id) : 'unconfigured'), Date.now());
  const capability = ids.length ? broker.grantMcp(AGENT, ids) : undefined;
  check('startup', 'the app mints a pass for this agent and this integration only', typeof capability === 'string' && ids.join() === ID);

  // (debugging aid) VERIFY_PROXY=1 puts a recording pass-through in front of the broker, to see Gemini's exact requests
  let brokerBase = broker.url();
  const wire = [];
  if (process.env.VERIFY_PROXY) {
    const upPort = Number(new URL(broker.url()).port);
    const proxy = http.createServer((req, res) => {
      const chunks = []; req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const up = http.request({ host: '127.0.0.1', port: upPort, method: req.method, path: req.url, headers: { ...req.headers, host: `127.0.0.1:${upPort}` } }, (r) => {
          const out = []; r.on('data', (c) => out.push(c));
          r.on('end', () => {
            const rb = Buffer.concat(out);
            wire.push({ m: req.method, u: req.url, auth: req.headers.authorization ? req.headers.authorization.replace(capability ?? '@@', '<pass>') : 'none', accept: req.headers.accept, rq: body.toString('utf8').slice(0, 140), status: r.statusCode, ct: r.headers['content-type'], rs: rb.toString('utf8').slice(0, 200) });
            res.writeHead(r.statusCode, r.headers); res.end(rb);
          });
        });
        up.on('error', () => { res.writeHead(502); res.end(); });
        up.end(body);
      });
    });
    await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
    cleanups.push(() => proxy.close());
    brokerBase = `http://127.0.0.1:${proxy.address().port}`;
  }

  const hive = new HiveManager(() => path.join(ROOT, 'app'));
  hive.ensureHive();
  const sockPath = hive.sockPath();
  const events = [];
  // the hive's own socket, answered the way the app's HookServer answers a hook it has nothing to say about
  const hookServer = net.createServer((conn) => {
    let buf = '';
    conn.setEncoding('utf8'); conn.on('error', () => {});
    conn.on('data', (d) => {
      buf += d;
      const i = buf.indexOf('\n');
      if (i < 0) return;
      let name = 'unparsed';
      try { const p = JSON.parse(buf.slice(0, i)); name = `${p.hook_event_name ?? 'unknown'}${p.agent_id === AGENT ? '' : '(other agent)'}`; } catch { /* not json */ }
      events.push(name);
      conn.end('{}\n');
    });
  });
  await new Promise((r) => hookServer.listen(sockPath, r));
  cleanups.push(() => hookServer.close());
  const personalSettingsBefore = fs.readFileSync(path.join(gem, 'settings.json'), 'utf8');
  const personalTrustBefore = fs.readFileSync(path.join(gem, 'trustedFolders.json'), 'utf8');
  const inj = await hive.ensureAgent({ id: AGENT, name: AGENT, provider: 'gemini', cwd: WORK }, {
    mcpDefaults: cfg.mcpDefaults,
    mcpBroker: (cid) => (capability !== undefined && ids.includes(cid) ? { url: `${brokerBase}/m/${cid}`, authorization: `Bearer ${capability}` } : undefined)
  });
  const variable = codexCapabilityVariable(ID);
  const agentHome = inj.env.GEMINI_CLI_HOME;
  const settingsFile = agentHome ? path.join(agentHome, '.gemini', 'settings.json') : '';
  const appSettings = (() => { try { return JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch { return {}; } })();
  check('startup', 'the app gives the agent a Gemini home of its own, the route in its settings and the pass in one variable',
    !!agentHome && agentHome.startsWith(path.join(ROOT, 'app')) && appSettings.mcpServers?.[`mosbius-${ID}`]?.httpUrl === `${brokerBase}/m/${ID}` && inj.env[variable] === capability && !('GEMINI_CLI_SYSTEM_SETTINGS_PATH' in inj.env));
  check('startup', 'the person\'s own settings and server are carried into it, beside the app\'s', appSettings.security?.auth?.selectedType === 'gemini-api-key' && !!appSettings.mcpServers?.mine);
  info.settingsKeysTheAppAdded = { mcpServers: Object.keys(appSettings.mcpServers ?? {}), hookEvents: Object.keys(appSettings.hooks ?? {}) };
  check('startup', 'the person\'s own ~/.gemini/settings.json and trust file are not modified by the app', fs.readFileSync(path.join(gem, 'settings.json'), 'utf8') === personalSettingsBefore && fs.readFileSync(path.join(gem, 'trustedFolders.json'), 'utf8') === personalTrustBefore);
  const loginLink = path.join(agentHome ?? '', '.gemini', 'oauth_creds.json');
  const linked = (() => { try { return fs.lstatSync(loginLink).isSymbolicLink() && fs.realpathSync(loginLink) === fs.realpathSync(path.join(gem, 'oauth_creds.json')); } catch { return false; } })();
  check('startup', 'the person\'s login file is LINKED into the agent\'s home, not copied (structure only: whether Gemini accepts a real login this way is not tested)', linked);
  check('startup', 'the hive socket the hooks use is the one the app told the agent about', inj.env.HIVE_SOCK === sockPath && inj.env.AGENT_ID === AGENT);

  const agentEnv = (stub, extra = {}) => cliEnv({ ...inj.env, ...extra }, stub);
  const providerTokens = () => [...new Set([...idp.liveAccess(), ...[...idp.clients.values()].map((c) => c.secret).filter(Boolean), ...idp.regTokens.values()])];

  // ─────────────── A. what `gemini mcp list` says, in the trusted workspace ───────────────────────
  const listed = await mcpList(agentEnv(null), WORK);
  if (process.env.VERIFY_DEBUG) console.log('DEBUG mcp list stdout:\n' + listed.out + '\nDEBUG mcp list stderr:\n' + listed.err.slice(0, 1500) + '\nDEBUG audit:', JSON.stringify(audit.recent(ID, 20)));
  if (process.env.VERIFY_PROXY) for (const w of wire) console.log('WIRE', JSON.stringify(w));
  const row = listed.rows[`mosbius-${ID}`];
  check('startup', 'the real CLI reads the agent\'s home and the broker\'s server CONNECTS, authenticated by `$VAR` (the broker saw the pass)',
    !!row && /connected/i.test(row.state) && !/dis/i.test(row.state), row ? `${row.type}: ${row.state}` : listed.out.slice(0, 120));
  check('startup', 'the person\'s own server is listed beside it, untouched', !!listed.rows.mine);
  check('startup', 'no "Security Warning: Skipping ..." from the CLI: nothing the app wrote is refused', !/Security Warning/.test(listed.out + listed.err), (listed.out + listed.err).match(/Security Warning[^\n]*/)?.[0]?.slice(0, 100) ?? '');
  const sawOnConnect = new Set(audit.recent(ID, 50).filter((e) => e.decision === 'allow' && e.agentId === AGENT).map((e) => e.method));
  check('startup', 'the broker\'s own record shows the CLI\'s handshake (initialize) allowed for this agent, by its pass', sawOnConnect.has('initialize'), [...sawOnConnect].join(', '));

  // ─────────────── B. the real agent loop, with a stand-in model ──────────────────────────────────
  const SHELL = () => ({ name: 'run_shell_command', args: { command: 'env | cut -d= -f1' } });
  const stub = await new StubGemini([
    { call: SHELL },
    { call: (names) => ({ name: names.find((n) => /^mcp_mosbius-linear_search$/.test(n)) ?? 'mcp_mosbius-linear_search', args: { query: 'quarterly plan' } }) },
    { call: () => ({ name: 'mcp_mosbius-linear_delete_page', args: { id: 'p1' } }) },
    { call: () => ({ name: 'mcp_mosbius-linear_create_page', args: { title: 'x' } }) }
  ]).start();
  cleanups.push(() => stub.stop());
  const main = await run(['-p', 'run the check', '-o', 'stream-json', '-y'], { env: agentEnv(stub), cwd: WORK });
  info.runExit = main.code;
  check('startup', 'gemini runs headless against the stand-in model and finishes the scripted run', main.code === 0 && stub.step >= 4, `exit ${main.code}, ${stub.step} model turns`);

  if (process.env.VERIFY_DEBUG) console.log('DEBUG model was offered:', stub.offered.join(', '), '\nDEBUG tool outputs:', JSON.stringify(stub.outputs).slice(0, 1500), '\nDEBUG stderr tail:', main.err.split('\n').slice(-12).join('\n'), '\nDEBUG upstream methods:', idp.mcpCalls.map((c) => c.method).join(','));
  const offered = stub.offered.filter((n) => n.startsWith('mcp_')).sort();
  info.mcpToolsOffered = offered;
  check('discovery', 'the model is offered the broker\'s tool, and only the granted one', offered.join() === `mcp_mosbius-${ID}_search`, offered.join(', ') || 'none');
  check('discovery', 'none of the tools the app did not grant is offered', !offered.some((n) => /fetch|create_page|delete_page|mystery/.test(n)));

  const searched = stub.outputs.find((o) => /^mcp_mosbius-linear_search$/.test(o.name));
  check('execution', 'a tool call made by the model runs through the broker and returns the provider\'s answer', !!searched && searched.text.includes('SENTINEL-USER-DATA'), searched ? 'answer received' : 'no answer');
  const upstream = [...new Set(idp.requests('/mcp').map((r) => r.headers.authorization).filter(Boolean))];
  const live = idp.liveAccess();
  check('execution', 'the provider saw exactly one tool call: search', upstreamTools().join() === 'search', `upstream saw: ${upstreamTools().join(', ') || 'none'}`);
  check('execution', 'the provider saw ITS OWN access token, never the agent\'s pass', upstream.length >= 1 && upstream.every((a) => live.includes(a.replace('Bearer ', ''))) && !upstream.some((a) => a.includes(capability)));
  const refused = stub.outputs.filter((o) => /not found/i.test(o.text) && /delete_page|create_page/.test(o.text));
  check('permission', 'a tool the model was not offered cannot be called: Gemini refuses it before the broker is reached', refused.length >= 2 && !upstreamTools().some((n) => /delete_page|create_page/.test(n)), `${refused.length} refused by the CLI`);
  const entries = audit.recent(ID, 300).filter((e) => e.agentId === AGENT);
  const allowedSeen = new Set(entries.filter((e) => e.decision === 'allow').map((e) => (e.method === 'tools/call' ? `tools/call:${e.tool}` : e.method)));
  check('execution', 'the broker\'s own record shows this agent\'s initialize, tools/list and its one tool call, each allowed', ['initialize', 'tools/list', 'tools/call:search'].every((m) => allowedSeen.has(m)), [...allowedSeen].join(', '));

  // The pass can be read from Gemini's shell (measured below), so an agent could build the request itself. Do exactly that
  // here, with the pass the app really gave this agent: the broker, not the client, is what limits it.
  const brokerPort = Number(new URL(broker.url()).port);
  const asAgent = async (method, params, id, extra = {}) => call(brokerPort, { method: 'POST', path: `/m/${ID}`, headers: { authorization: `Bearer ${capability}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...extra }, body: rpc(method, params, id) });
  const handshake = await asAgent('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'agent-crafted', version: '1' } }, 100);
  const sid = handshake.headers['mcp-session-id'];
  const sidHeader = sid ? { 'mcp-session-id': sid } : {};
  const beforeCrafted = upstreamTools().length;
  const craftedRefusals = [];
  for (const tool of ['delete_page', 'create_page', 'mystery']) {
    const r = await asAgent('tools/call', { name: tool, arguments: { id: 'p1' } }, 101, sidHeader);
    let refusedIt = r.status >= 400; try { const j = json(r); refusedIt = refusedIt || !!j.error || j.result?.isError === true; } catch { /* not json */ }
    craftedRefusals.push(`${tool}:${refusedIt ? 'refused' : 'ALLOWED'}`);
  }
  check('permission', 'with the very pass the agent holds, the broker still refuses a tool that was not granted, a write tool and an unclassified one', craftedRefusals.every((s) => s.endsWith(':refused')) && upstreamTools().length === beforeCrafted, craftedRefusals.join('  '));

  // what Gemini's shell can see (a measurement, compared with what the support matrix says)
  const shell = shellNamesOf(stub);
  info.shellVariableCount = shell.names.size;
  check('isolation', 'the agent\'s own shell ran and printed the NAMES of its environment', shell.names.has('PATH') && shell.names.size > 3, `${shell.names.size} variables`);
  const visible = shell.names.has(variable);
  info.capabilityVisibleToShell = visible;
  const claimed = compatOf('gemini').capabilityHiddenFromShell;
  check('isolation', `MEASURED: the pass ${visible ? 'IS' : 'is NOT'} visible to Gemini's shell, and the support matrix says "${claimed}"`, (visible && claimed === 'no') || (!visible && claimed === 'yes'));
  check('isolation', 'the person\'s own variables are untouched: the app changed nothing about Gemini\'s shell', shell.names.has('USER_PLAIN_VARIABLE') && shell.names.has('MY_OWN_API_KEY') && shell.names.has('SSH_AUTH_SOCK'));

  // nothing secret in any file, argument, or message the model received
  const files = walk(ROOT).filter((f) => { try { return fs.statSync(f).size < 4_000_000; } catch { return false; } });
  const tokens = providerTokens(); const fileLeaks = []; const capLeaks = [];
  for (const f of files) {
    let body; try { body = fs.readFileSync(f, 'utf8'); } catch { continue; }
    if (leaks(body, tokens).length) fileLeaks.push(path.relative(ROOT, f));
    if (body.includes(capability)) capLeaks.push(path.relative(ROOT, f));
  }
  check('isolation', 'the provider\'s tokens are in no file Gemini or the app wrote', fileLeaks.length === 0, fileLeaks.join(', '));
  check('isolation', 'the pass is in no file Gemini or the app wrote (it is in the environment only)', capLeaks.length === 0, capLeaks.join(', '));
  check('isolation', 'neither the pass nor a provider token appears in any process argument while Gemini ran', leaks(main.snaps.join('\n'), [capability, ...tokens]).length === 0, `${main.snaps.length} process listings`);
  check('isolation', 'nothing sent to the model, nor Gemini\'s own output, carries the pass or a provider token', leaks(`${stub.bodies.join('\n')}\n${main.out}\n${main.err}`, [capability, ...tokens]).length === 0);

  // the lever the CLI itself offers: its environment redaction, switched on in a COPY of the agent's settings
  const lever = JSON.parse(JSON.stringify(appSettings));
  lever.security = { ...(lever.security ?? {}), environmentVariableRedaction: { enabled: true } };
  const leverHome = path.join(ROOT, 'lever'); fs.mkdirSync(path.join(leverHome, '.gemini'), { recursive: true });
  fs.writeFileSync(path.join(leverHome, '.gemini', 'settings.json'), JSON.stringify(lever));
  const stub2 = await new StubGemini([{ call: SHELL }]).start();
  cleanups.push(() => stub2.stop());
  await run(['-p', 'run the check', '-o', 'stream-json', '-y'], { env: agentEnv(stub2, { GEMINI_CLI_HOME: leverHome }), cwd: WORK });
  const redacted = shellNamesOf(stub2).names;
  info.withTheCLIsOwnRedactionOn = { passHidden: !redacted.has(variable), sshAuthSockHidden: !redacted.has('SSH_AUTH_SOCK'), secretLookingVariablesHidden: !redacted.has('MY_OWN_API_KEY') };
  check('isolation', 'the CLI\'s own redaction, switched on, hides the pass, and also SSH_AUTH_SOCK and every secret-looking variable (why the app does not switch it on for you)',
    !redacted.has(variable) && !redacted.has('SSH_AUTH_SOCK') && !redacted.has('MY_OWN_API_KEY') && redacted.has('USER_PLAIN_VARIABLE'));

  // ─────────────── F9. can the pass be made INACCESSIBLE to Gemini's shell? ────────────────────────
  // The question, measured on the real CLI. A "yes" needs all three: the pass is out of the shell's reach, the person's own
  // variables stay exactly as they were, and the broker keeps working. These runs record what stands in the way; each check
  // below PASSES when the limitation is observed as documented, so a Gemini version that removes a limit shows up here as a
  // failed check (and then the support matrix, the docs and F9 have to be revisited).
  // (Gemini's own shell guard refuses any command containing $( ), backticks or process substitution, even with --yolo,
  // so the scan is written as plain pipelines.)
  const SCAN_SCRIPT = [
    'echo SCAN_SHELL_PID=$$',
    `ps -axo pid=,ppid= | awk -v me=$$ '{ pp[$1]=$2 } END { p=me; while (p>1) { print p; p=pp[p] } }' | while read -r q; do`,
    `  printf "SCAN_ANCESTOR pid=%s comm=" "$q"; ps -o comm= -p "$q" 2>/dev/null | head -1 | tr -d "\\n"; printf " envtokens="; ps eww -p "$q" 2>/dev/null | tr " " "\\n" | grep -ac "^[A-Za-z_][A-Za-z0-9_]*="`,
    `  ps eww -p "$q" 2>/dev/null | tr " " "\\n" | grep -a "^MOSBIUS_MCP_SECRET_TOKEN_LINEAR=" | head -1 | cut -d= -f2- | { read -r v; if [ -n "$v" ]; then printf "SCAN_HAS_PASS pid=%s sha256=" "$q"; printf %s "$v" | LC_ALL=C LANG=C shasum -a 256 2>/dev/null | cut -d" " -f1; fi; }`,
    'done',
    'echo SCAN_DONE',
    'echo ---NAMES---',
    'env | cut -d= -f1'
  ].join('\n');   // the pass is never printed: only a hash of what was found, to compare with the real one
  const SCAN_CALL = () => ({ name: 'run_shell_command', args: { command: SCAN_SCRIPT } });
  const parseScan = (m) => {
    const o = m.outputs.find((x) => x.name === 'run_shell_command');
    const out = String(o?.response?.output ?? '');
    const hits = [...out.matchAll(/(?:^|\s)SCAN_HAS_PASS pid=(\d+) sha256=([0-9a-f]{64})/gm)].map((x) => ({ pid: Number(x[1]), sha256: x[2] }));
    const names = new Set((out.split('---NAMES---')[1] ?? '').split('\n').map((l) => l.trim()).filter((l) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(l)));
    const walked = [...out.matchAll(/SCAN_ANCESTOR pid=(\d+) comm=(\S*) envtokens=(\d+)/g)].map((x) => ({ pid: Number(x[1]), comm: path.basename(x[2]), envTokens: Number(x[3]) }));
    return { ran: out.includes('SCAN_DONE'), shellPid: Number(/SCAN_SHELL_PID=(\d+)/.exec(out)?.[1] ?? 0), hits, names, walked };
  };
  const passHash = crypto.createHash('sha256').update(capability).digest('hex');
  // made-up stand-ins for what a person really has in their environment: none is a real credential
  const CANARY = {
    F9_PROBE_PLAIN: 'plain-value',
    F9_PROBE_GH_SHAPED: `ghp_${'a1B2c3D4e5'.repeat(4)}`.slice(0, 40),                       // shaped like a GitHub token, under a harmless name
    ARTIFACT_MIRROR: 'https://deploy:hunter2@mirror.example.invalid/repo',                  // credentials inside a URL (a proxy URL has the same shape; not used here because Gemini would route its own calls through it)
    BASH_ENV: '/nonexistent/mosbius-probe-bash-env'                                         // the shell start-up-file route
  };
  const f9Variant = async (label, patch, extraEnv = {}, extraArgs = []) => {
    const m = await new StubGemini([{ call: SCAN_CALL }]).start();
    cleanups.push(() => m.stop());
    const env = agentEnv(m, { ...CANARY, ...extraEnv });
    const home = path.join(ROOT, `f9-${label}`);
    fs.mkdirSync(path.join(home, '.gemini'), { recursive: true });
    const settings = JSON.parse(JSON.stringify(appSettings));
    if (patch) settings.security = { ...(settings.security ?? {}), environmentVariableRedaction: patch(Object.keys(env)) };
    fs.writeFileSync(path.join(home, '.gemini', 'settings.json'), JSON.stringify(settings));
    const r = await run([...extraArgs, '-p', 'scan', '-o', 'stream-json', '-y'], { env: { ...env, GEMINI_CLI_HOME: home }, cwd: WORK });
    if (process.env.VERIFY_DEBUG) console.log(`DEBUG f9 ${label}: exit ${r.code}; model turns ${m.step}; output ${JSON.stringify(m.outputs.map((o) => o.text.slice(0, 400)))}`);
    const scrub = (t) => String(t).split(ROOT).join('<throwaway>').split(fs.realpathSync(os.tmpdir())).join('<tmp>');
    return { ...parseScan(m), exitCode: r.code, stderrHead: scrub(r.err.split('\n').filter(Boolean)[0] ?? '').slice(0, 240) };
  };
  const bashEnvFile = path.join(ROOT, 'bash-env-unset.sh');
  fs.writeFileSync(bashEnvFile, 'unset MOSBIUS_MCP_SECRET_TOKEN_LINEAR\n');          // what a "start-up file" workaround would do
  const v0 = await f9Variant('control', null);                                                                  // the app's default
  const v2 = await f9Variant('blocked-only', () => ({ enabled: false, blocked: [variable] }));                 // a per-variable lever?
  const v1 = await f9Variant('best-lever', (names) => ({ enabled: true, allowed: names.filter((n) => n !== variable), blocked: [variable] }));
  const v3 = await f9Variant('bash-env', null, { BASH_ENV: bashEnvFile });                                      // the shell start-up-file workaround
  // Gemini's own macOS sandbox (Seatbelt, built-in profile): does it stop the process route? (explored, not shipped)
  const v4 = await f9Variant('sandbox', null, { GEMINI_SANDBOX: 'sandbox-exec', SEATBELT_PROFILE: 'permissive-open' }, ['-s']);
  const readsRealPass = (v) => v.ran && v.hits.length > 0 && v.hits.every((h) => h.sha256 === passHash);
  const everyName = ['F9_PROBE_PLAIN', 'F9_PROBE_GH_SHAPED', 'ARTIFACT_MIRROR', 'SSH_AUTH_SOCK', 'MY_OWN_API_KEY', 'GEMINI_API_KEY', 'USER_PLAIN_VARIABLE'];
  const hiddenByLever = everyName.filter((n) => v0.names.has(n) && v1.ran && !v1.names.has(n));
  check('f9', 'all four scans ran inside the real Gemini shell', v0.ran && v1.ran && v2.ran && v3.ran);
  check('f9', 'control (the original exposure): with the app\'s default settings the pass is in the environment of Gemini\'s shell', v0.ran && v0.names.has(variable));
  check('f9', 'control: every variable a person really has reaches the shell, including SSH_AUTH_SOCK and the secret-looking ones, and BASH_ENV reaches it too (Gemini does not strip it from the shell)',
    v0.ran && [...everyName, 'BASH_ENV'].every((n) => v0.names.has(n)));
  check('f9', 'LIMIT 1: the pass can be read from OUTSIDE the shell\'s own environment: a command in Gemini\'s shell reads the environment of the processes above it (ps), and it is the real pass (hash equal)',
    readsRealPass(v0), `${v0.hits.length} process(es) in the shell's ancestry hold it; hashes ${readsRealPass(v0) ? 'equal' : 'DIFFER'}`);
  check('f9', 'LIMIT 2: the CLI has no per-variable lever: with its redaction off, naming the pass as blocked hides nothing', v2.ran && v2.names.has(variable));
  check('f9', 'the global lever (redaction on, every other name allowed) does remove the pass from the shell\'s own environment, and keeps a plain variable', v1.ran && !v1.names.has(variable) && v1.names.has('F9_PROBE_PLAIN'));
  check('f9', 'LIMIT 3: but it also hides variables that are not the pass, whatever the allow list says: SSH_AUTH_SOCK and other secret-named variables (this version drops such names from the allow list), and values shaped like credentials',
    ['SSH_AUTH_SOCK', 'MY_OWN_API_KEY', 'GEMINI_API_KEY', 'ARTIFACT_MIRROR', 'F9_PROBE_GH_SHAPED'].every((n) => hiddenByLever.includes(n)), `hidden although allowed by name: ${hiddenByLever.join(', ') || 'none'}`);
  check('f9', 'LIMIT 1 again, with the lever on: the pass is gone from the shell\'s environment and is STILL readable from the processes above it (so no Gemini setting makes it inaccessible)',
    v1.ran && !v1.names.has(variable) && readsRealPass(v1), `${v1.hits.length} process(es) in the ancestry hold it`);
  check('f9', 'the shell start-up-file workaround (BASH_ENV unsets the pass) hides it from `env` and from nothing else: the processes above the shell still hold the real pass, so it would be a misleading fix and is not shipped',
    v3.ran && !v3.names.has(variable) && readsRealPass(v3), `holders: ${v3.hits.map((h) => h.pid).join(', ') || 'none'}`);
  info.f9 = {
    closable: false,
    why: [
      'LIMIT 1: Gemini expands $VAR in its settings from its own process environment at start-up, so the pass must be in that environment, and a command in its shell can read it from there (ps eww on macOS; /proc/<pid>/environ on Linux, reasoned and not run). Every environment-level lever, the start-up-file workaround included, leaves it there.',
      'LIMIT 2: the CLI has no per-variable exclusion: sanitizeEnvironment returns the whole environment unless the global redaction is enabled.',
      'LIMIT 3: with the global redaction enabled the allow list cannot protect the person\'s own variables: secret-named ones (SSH_AUTH_SOCK, *_KEY, *_TOKEN) are dropped from it, and values shaped like credentials are removed before it is consulted.'
    ],
    control: {
      passInShellEnvironment: v0.names.has(variable), passReadableFromTheProcessesAboveTheShell: readsRealPass(v0), processesHoldingIt: v0.hits.length,
      bashEnvReachesTheShell: v0.names.has('BASH_ENV'), variablesReachingTheShell: [...everyName, 'BASH_ENV'].filter((n) => v0.names.has(n))
    },
    blockedListWithRedactionOff: { passInShellEnvironment: v2.names.has(variable) },
    globalRedactionWithAllNamesAllowed: {
      passInShellEnvironment: v1.names.has(variable), passReadableFromTheProcessesAboveTheShell: readsRealPass(v1),
      keptByTheAllowList: everyName.filter((n) => v1.names.has(n)), hiddenAlthoughAllowedByName: hiddenByLever
    },
    geminiOwnMacOsSandboxAttempt: {
      tried: 'gemini -s with GEMINI_SANDBOX=sandbox-exec and the built-in permissive-open profile, on the app\'s isolated-home layout',
      started: v4.ran, exitCode: v4.exitCode, firstStderrLine: v4.stderrHead,
      conclusion: v4.ran ? 'it started: re-evaluate (it could stop the process route)' : 'it did not start with this layout (the profile does not let the CLI read the trust file kept outside its allowed folders); not pursued: it would also change what the agent may do'
    },
    bashEnvStartUpFileWorkaround: {
      envNoLongerShowsThePass: !v3.names.has(variable),
      stillReadableFromTheProcessesAboveTheShell: readsRealPass(v3)
    }
  };

  // ─────────────── C. hooks ───────────────────────────────────────────────────────────────────────
  await new Promise((r) => setTimeout(r, 400));
  info.hookEventsReceived = [...new Set(events)];
  check('hooks', 'the lifecycle hooks the app wrote are loaded AND RUN by the real CLI: their payloads reached the hive socket', events.length >= 2, `${events.length} payloads: ${[...new Set(events)].join(', ') || 'none'}`);

  // ─────────────── D. skills ──────────────────────────────────────────────────────────────────────
  const gh = fakeGitHub();
  const installed = await installSkill(URL1, 'demo', { home: FAKE_HOME, root: path.join(FAKE_HOME, '.agents', 'skills'), agents: ['codex', 'gemini'], recordDir: path.join(ROOT, 'rec'), getText: gh.getText });
  check('skills', 'a skill is installed for Gemini by the app\'s own installer (into the shared folder)', installed.ok === true);
  const sk = await skillsList(agentEnv(null), WORK);
  const where = {};
  for (const [label, dir] of [['~/.agents/skills', 'probe-home-agents'], ['~/.gemini/skills', 'probe-home-gemini'], ['<project>/.agents/skills', 'probe-proj-agents'], ['<project>/.gemini/skills', 'probe-proj-gemini'], ['<project>/.claude/skills', 'probe-proj-claude']]) where[label] = sk.names.includes(dir);
  info.skillsDiscoveredAt = where;
  check('skills', 'inside the app\'s agent home the real CLI finds the skill the app installed for Gemini', sk.names.includes('demo'), `${sk.names.filter((n) => !/^(antigravity-support|skill-creator)$/.test(n)).join(', ')}`);
  check('skills', 'and the person\'s own shared and Gemini skill folders, through the links the app made', where['~/.agents/skills'] && where['~/.gemini/skills']);
  const plain = await skillsList(cliEnv({}, null), WORK);
  check('skills', 'the person\'s OWN Gemini (no app home, nothing of the app) finds the same skill in ~/.agents/skills', plain.names.includes('demo'), plain.names.includes('demo') ? 'found' : `saw: ${plain.names.join(', ')}`);
  check('skills', 'where the CLI looks is recorded: the project folders, and NOT .claude/skills', where['<project>/.agents/skills'] && where['<project>/.gemini/skills'] && !where['<project>/.claude/skills'], Object.entries(where).map(([k, v]) => `${k}:${v ? 'yes' : 'no'}`).join('  '));

  // ─────────────── E. trust: an untrusted folder fails closed ─────────────────────────────────────
  const callsBefore = audit.recent(ID, 500).length;
  const untrusted = await mcpList(agentEnv(null), OTHER);
  const urow = untrusted.rows[`mosbius-${ID}`];
  check('trust', 'in a folder the person has not trusted in Gemini, the integration is DISABLED, and the broker is not contacted', !!urow && /disabled/i.test(urow.state) && audit.recent(ID, 500).length === callsBefore, urow ? urow.state : untrusted.out.slice(0, 100));

  // ─────────────── F. revocation ──────────────────────────────────────────────────────────────────
  // (1) while a session is OPEN: a second agent, its own pass, revoked between two tool calls of one run
  const AGENT2 = 'agent-gemini-2';
  const cap2 = broker.grantMcp(AGENT2, ids);
  const inj2 = await hive.ensureAgent({ id: AGENT2, name: AGENT2, provider: 'gemini', cwd: WORK }, {
    mcpDefaults: cfg.mcpDefaults,
    mcpBroker: (cid) => (ids.includes(cid) ? { url: `${brokerBase}/m/${cid}`, authorization: `Bearer ${cap2}` } : undefined)
  });
  const SEARCH = (q) => (names) => ({ name: names.find((n) => /^mcp_mosbius-linear_search$/.test(n)) ?? 'mcp_mosbius-linear_search', args: { query: q } });
  const midRun = await new StubGemini([
    { call: SEARCH('before revocation') },
    { before: () => broker.revokeMcp(AGENT2), call: SEARCH('after revocation') }
  ]).start();
  cleanups.push(() => midRun.stop());
  const upstreamBeforeMid = upstreamTools().length;
  await run(['-p', 'search twice', '-o', 'stream-json', '-y'], { env: cliEnv({ ...inj2.env }, midRun), cwd: WORK });
  const midSearches = midRun.outputs.filter((o) => /^mcp_mosbius-linear_search$/.test(o.name));
  check('revocation', 'a pass revoked in the MIDDLE of a run: the call made before it worked, the call made after it did not', midSearches.length >= 2 && midSearches[0].text.includes('SENTINEL-USER-DATA') && !midSearches[1].text.includes('SENTINEL-USER-DATA'), `${midSearches.length} results; second: ${(midSearches[1]?.text ?? 'none').slice(0, 90)}`);
  check('revocation', 'and the provider saw only the one call made before the revocation', upstreamTools().length === upstreamBeforeMid + 1, `${upstreamTools().length - upstreamBeforeMid} provider call(s)`);

  // (2) before a run starts, and at the broker itself
  const toolCallsBefore = upstreamTools().length;
  broker.revokeMcp(AGENT);
  const after = await mcpList(agentEnv(null), WORK);
  const arow = after.rows[`mosbius-${ID}`];
  check('revocation', 'after the pass is revoked the real CLI no longer connects to the integration', !!arow && !/^connected$/i.test(arow.state.trim()), arow ? arow.state : after.out.slice(0, 100));
  const stub3 = await new StubGemini([{ call: (names) => ({ name: names.find((n) => /search$/.test(n) && n.startsWith('mcp_')) ?? 'mcp_mosbius-linear_search', args: { query: 'after revoke' } }) }]).start();
  cleanups.push(() => stub3.stop());
  await run(['-p', 'try again', '-o', 'stream-json', '-y'], { env: agentEnv(stub3), cwd: WORK });
  check('revocation', 'a new run is no longer offered the tool, and the provider was not asked', !stub3.offered.some((n) => n.startsWith('mcp_mosbius')) && upstreamTools().length === toolCallsBefore, `offered: ${stub3.offered.filter((n) => n.startsWith('mcp_')).join(', ') || 'no integration tool'}`);
  const direct = await call(Number(new URL(broker.url()).port), { method: 'POST', path: `/m/${ID}`, headers: { authorization: `Bearer ${capability}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: rpc('tools/list', undefined, 9) });
  check('revocation', 'the revoked pass is refused by the broker itself', direct.status === 401 || direct.status === 403, `HTTP ${direct.status}`);

  // ─────────────── G. the control: the layer the app used to write is refused ─────────────────────
  const oldStyle = path.join(ROOT, 'old-system-settings.json');
  fs.writeFileSync(oldStyle, JSON.stringify({ mcpServers: { 'mosbius-old': { httpUrl: `${broker.url()}/m/${ID}`, headers: { Authorization: 'Bearer $X' } } } }));
  const ctl = await run(['mcp', 'list'], { env: cliEnv({ GEMINI_CLI_SYSTEM_SETTINGS_PATH: oldStyle }), cwd: WORK, timeoutMs: 60_000 });
  const refusedText = (ctl.out + ctl.err).match(/Security Warning: Skipping system settings file[^\n]*not owned by root/)?.[0] ?? '';
  info.systemSettingsControl = refusedText.split(ROOT).join('<throwaway>').split(fs.realpathSync(os.tmpdir())).join('<tmp>').slice(0, 200);
  check('control', 'a SYSTEM settings file written by the app (the old design) is REFUSED by this CLI: it must be owned by root', !!refusedText && !/mosbius-old/.test(ctl.out), refusedText ? 'refused, as measured' : ctl.out.slice(0, 100));

  // ─────────────── finish ─────────────────────────────────────────────────────────────────────────
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? `; FAILED: ${failed.map((f) => f.name).join(' | ')}` : ''}`);
  if (evidenceBase) {
    const outJson = path.resolve(`${evidenceBase}.json`);
    fs.mkdirSync(path.dirname(outJson), { recursive: true });
    fs.writeFileSync(outJson, JSON.stringify({
      tool: 'tools/verify-gemini-live.cjs', date: new Date().toISOString(), ...info,
      stands_in_for: { provider: 'test/fixtures/stage-a-idp.cjs (stand-in, not a real provider)', model: 'scripted Gemini-API stand-in on loopback (no Google account, no key, no Gemini model)' },
      not_tested: ['a real Gemini model choosing tools well', 'a real Gemini login, and whether the app\'s links carry it into an agent\'s home', 'Gemini CLI on Windows and Linux (the /proc/<pid>/environ route that LIMIT 1 predicts there is reasoned from the same design, not run)', 'other Gemini CLI versions', 'a Gemini sandbox profile that refuses process inspection (the built-in one did not start on the app\'s isolated-home layout)'],
      results
    }, null, 2));
    const lines = [`${info.gemini} · ${info.platform} · node ${info.node} · ${new Date().toISOString()}`, '', ...results.map((r) => `${r.ok ? 'PASS' : 'FAIL'}  [${r.group}] ${r.name}${r.detail ? `  — ${r.detail}` : ''}`), '', `${results.length - failed.length}/${results.length} checks passed`];
    fs.writeFileSync(path.resolve(`${evidenceBase}.txt`), `${lines.join('\n')}\n`);
    console.log(`evidence written: ${outJson}`);
  }
  for (const fn of cleanups.reverse()) { try { await fn(); } catch { /* best effort */ } }
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* best effort */ }
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('verify-gemini-live crashed:', e instanceof Error ? e.stack : e); try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* best effort */ } process.exit(1); });
