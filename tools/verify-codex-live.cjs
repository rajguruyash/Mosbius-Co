#!/usr/bin/env node
'use strict';

/**
 * Codex, driven for real against the app's broker.
 *
 *   node tools/verify-codex-live.cjs [--evidence evidence/codex/codex-live] [--node /path/to/node]
 *
 * What runs for real: the `codex` CLI on this machine (its agent loop through `codex exec`, and its own
 * `codex app-server` protocol), the app's production code that decides what a Codex agent is given
 * (HiveManager.ensureAgent), the in-app broker and its MCP route, the connection manager (an account
 * connected with a sign-in, not a pasted key), the audit log.
 *
 * What does NOT: no real account is used anywhere.
 *   - the provider behind the broker is a STAND-IN (test/fixtures/stage-a-idp.cjs);
 *   - the MODEL is a stand-in that speaks the Responses API and plays a fixed script, so the real agent
 *     loop runs (tool offers, tool calls, approvals, the shell tool) without a model account. Whether a real
 *     OpenAI model reasons well with the offered tools is NOT tested here: that needs the owner's Codex sign-in.
 *   - a throwaway HOME and CODEX_HOME are used; the user's own ~/.codex is never read or copied.
 *
 * Checks (printed PASS/FAIL, exit code 1 on any FAIL, 2 when codex is missing):
 *   startup      the config the app writes is accepted; the broker's server starts and is reported as bearer-authenticated
 *   discovery    the model is offered exactly the granted tools, and not the others
 *   execution    a model-driven tool call reaches the provider with the PROVIDER's token, never the agent's capability
 *   permission   a tool that is not granted is not offered, cannot be called by the model, and is refused by the
 *                broker when called directly; an unclassified tool is refused too
 *   isolation    the capability is not in the shell Codex runs for the model; the user's own variables are untouched,
 *                the user's own exclusions are kept; neither the capability nor the provider's tokens are in any
 *                file Codex wrote, any process argument, anything sent to the model, or Codex's output
 *   revocation   after the capability is revoked, the same session is refused and a new session cannot start
 *   skills       where Codex discovers a SKILL.md (recorded, to label compatibility honestly)
 *
 * Debugging aids (environment variables): VERIFY_DEBUG=1 prints what the model was offered, the audit log and
 * Codex's stderr; VERIFY_PROXY=1 records the exact HTTP exchange between Codex and the broker;
 * VERIFY_RUST_LOG='rmcp=trace,codex_mcp=debug' turns on Codex's own MCP tracing; VERIFY_FULL_STDERR=<file>
 * keeps all of it.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const evidenceBase = flag('--evidence');

// Everything below runs with a throwaway HOME, so the user's own ~/.codex is never read.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'mosbius-codex-live-'));
const FAKE_HOME = path.join(ROOT, 'home');
fs.mkdirSync(FAKE_HOME, { recursive: true });
process.env.HOME = FAKE_HOME;

const loadTs = require('../test/load-ts.cjs');
const { startStageAIdp } = require('../test/fixtures/stage-a-idp.cjs');
const { call, json, rpc } = require('../test/fixtures/broker-helpers.cjs');
const { IntegrationBroker } = loadTs('src/main/integrationBroker.ts');
const { HiveManager, codexCapabilityVariable } = loadTs('src/main/hive.ts');
const { AuditLog } = loadTs('src/main/broker/audit.ts');
const { mcpIntegrationFor, eligibleIntegrationIds, sanitizeMcpGrants } = loadTs('src/main/mcpWiring.ts');
const { createMcpCredentialProvider } = loadTs('src/main/mcpCredentials.ts');
const { ConnectionManager } = loadTs('src/main/connect/manager.ts');
const { compatOf } = loadTs('src/shared/agentCompat.ts');
const { safeLog } = loadTs('src/main/oauth/types.ts');

const results = [];
const check = (group, name, ok, detail = '') => {
  results.push({ group, name, ok: !!ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  [${group}] ${name}${detail ? `  — ${detail}` : ''}`);
};
const info = {};

const ID = 'linear';             // a real catalogue id; the address behind it is the stand-in's
const AGENT = 'agent-codex';
const cleanups = [];
let idp;                          // the stand-in provider, set once it is running
const upstreamTools = () => idp.mcpCalls.filter((c) => c.method === 'tools/call').map((c) => c.params?.name);

// ── the test "browser": follows the authorization redirect the way a person's browser would ──────
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

// ── a stand-in MODEL: speaks the Responses API and plays a script, so the real agent loop runs ────
class StubModel {
  constructor(script) {
    this.script = script; this.step = 0; this.offered = []; this.outputs = []; this.bodies = [];
    this.server = http.createServer((req, res) => this.handle(req, res));
  }
  async start() { await new Promise((r) => this.server.listen(0, '127.0.0.1', r)); this.port = this.server.address().port; return this; }
  stop() { this.server.close(); }
  handle(req, res) {
    let body = ''; req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.method !== 'POST' || !/responses$/.test(req.url)) { res.writeHead(404); return res.end('{}'); }
      this.bodies.push(body);
      let j = {}; try { j = JSON.parse(body); } catch { /* ignore */ }
      if (this.step === 0) this.offered = j.tools ?? [];
      for (const it of j.input ?? []) if (it.type === 'function_call_output') this.outputs.push({ call_id: it.call_id, text: typeof it.output === 'string' ? it.output : JSON.stringify(it.output) });
      const id = `resp_${++this.step}`;
      const events = [{ type: 'response.created', response: { id } }];
      const next = this.script[this.step - 1];
      const names = (j.tools ?? []).map((t) => t.name);
      if (next && next.call) {
        const spec = next.call(names);
        if (spec) events.push({ type: 'response.output_item.done', item: { type: 'function_call', call_id: `call_${this.step}`, ...spec } });
      } else {
        events.push({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] } });
      }
      events.push({ type: 'response.completed', response: { id, usage: { input_tokens: 1, input_tokens_details: null, output_tokens: 1, output_tokens_details: null, total_tokens: 2 } } });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));
    });
  }
}
const providerArgs = (port) => ['-c', 'model_provider="stub"', '-c', 'model="stub-model"',
  '-c', `model_providers.stub={ name = "stub", base_url = "http://127.0.0.1:${port}/v1", wire_api = "responses", requires_openai_auth = false, supports_websockets = false }`];

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────
const psSnapshot = () => { try { return execFileSync('ps', ['-axo', 'pid=,args='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }); } catch { return ''; } };
const pairsOf = (args) => { const out = []; for (let i = 0; i < args.length; i++) if (args[i] === '-c' && typeof args[i + 1] === 'string') { out.push('-c', args[i + 1]); i++; } return out; };
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

/** `codex exec` with the app's own wiring and a scripted model. Resolves with the parsed JSONL events. */
function runExec({ wiring, env, model, work, extra = [], sandbox = 'workspace-write', timeoutMs = 90_000 }) {
  return new Promise((resolve) => {
    const args = [...wiring, ...extra, ...providerArgs(model.port), 'exec', '--skip-git-repo-check', '--json', '-s', sandbox, '-C', work, 'run the check'];
    const child = spawn('codex', args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = ''; const snaps = [];
    child.stdout.on('data', (c) => (out += c)); child.stderr.on('data', (c) => (err += c));
    const sampler = setInterval(() => snaps.push(psSnapshot()), 400);
    const killer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (code) => {
      clearInterval(sampler); clearTimeout(killer);
      const events = out.split('\n').filter((l) => l.startsWith('{')).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      resolve({ code, events, out, err, snaps, args });
    });
  });
}

/** A `codex app-server` session: JSON-RPC lines over stdio. */
function appServer({ wiring, env, model }) {
  const child = spawn('codex', [...wiring, ...providerArgs(model.port), 'app-server'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = ''; const pending = new Map(); let id = 0; let err = '';
  child.stdout.on('data', (c) => {
    buf += c; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    }
  });
  child.stderr.on('data', (c) => { err += c; });
  const send = (method, params, ms = 30_000) => new Promise((resolve) => {
    const i = ++id; pending.set(i, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: i, method, params })}\n`);
    setTimeout(() => { if (pending.has(i)) { pending.delete(i); resolve({ timeout: true }); } }, ms);
  });
  return {
    child, send, stderr: () => err,
    async init() { const r = await send('initialize', { clientInfo: { name: 'mosbius-verify', version: '1' } }); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized' })}\n`); return r; },
    close() { try { child.kill('SIGKILL'); } catch { /* gone */ } }
  };
}

(async () => {
  let codexVersion = '';
  try { codexVersion = execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim(); } catch { console.error('BLOCKED: `codex` is not on PATH'); process.exit(2); }
  info.codex = codexVersion; info.platform = `${process.platform}/${process.arch}`; info.node = process.version;
  console.log(`${codexVersion} · node ${process.version} · ${process.platform}/${process.arch}\n  (throwaway HOME ${FAKE_HOME}; the user's ~/.codex is not touched)\n`);

  // the user's own Codex config, as a user might have it: one exclusion of their own
  fs.mkdirSync(path.join(FAKE_HOME, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(FAKE_HOME, '.codex', 'config.toml'), '[shell_environment_policy]\ninherit = "all"\nexclude = ["MY_OWN_HIDDEN_*"]\n');

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
  const started = await broker.start();
  if (!started.ok) { console.error('broker did not start'); process.exit(1); }
  cleanups.push(() => broker.stop());

  const connected = await mgr.connect(ID);
  check('startup', 'an account is connected through the stand-in provider (sign-in, no pasted key)', connected && connected.ok === true);
  const ids = eligibleIntegrationIds(cfg, AGENT, (id) => (id === ID ? mgr.status(id) : 'unconfigured'), Date.now());
  const capability = ids.length ? broker.grantMcp(AGENT, ids) : undefined;
  check('startup', 'the app mints a capability for this agent and this integration only', typeof capability === 'string' && ids.join() === ID);

  // (debugging aid) VERIFY_PROXY=1 puts a recording pass-through in front of the broker, to see Codex's exact requests
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
            wire.push({ m: req.method, u: req.url, sid: req.headers['mcp-session-id'] ? 'yes' : 'no', rq: body.toString('utf8').slice(0, 160), status: r.statusCode, ct: r.headers['content-type'], rs: rb.toString('utf8').slice(0, 220) });
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

  // the production code decides what a Codex agent is given
  const work = path.join(ROOT, 'workspace'); fs.mkdirSync(work, { recursive: true });
  const hive = new HiveManager(() => path.join(ROOT, 'app'));
  const inj = await hive.ensureAgent({ id: AGENT, name: AGENT, provider: 'codex', cwd: work }, {
    mcpDefaults: cfg.mcpDefaults,
    mcpBroker: (cid) => (capability !== undefined && ids.includes(cid) ? { url: `${brokerBase}/m/${cid}`, authorization: `Bearer ${capability}` } : undefined)
  });
  const wiring = pairsOf(inj.args);
  const variable = codexCapabilityVariable(ID);
  check('startup', 'the app gives the agent the broker route as -c overrides and the capability as one variable', wiring.some((a) => a.startsWith(`mcp_servers.mosbius-${ID}.url=`)) && inj.env[variable] === capability);
  info.wiring = wiring.filter((a) => a !== '-c');
  info.capabilityVariable = variable;

  // the environment Codex is started with: minimal, plus the app's, plus the user's own variables
  const baseEnv = { PATH: process.env.PATH, HOME: FAKE_HOME, TMPDIR: process.env.TMPDIR ?? '/tmp', LANG: 'en_US.UTF-8', USER: process.env.USER ?? 'user', SHELL: '/bin/zsh', TERM: 'dumb' };
  const userVars = { USER_PLAIN_VARIABLE: 'visible', MY_OWN_API_KEY: 'user-key-canary', MY_OWN_HIDDEN_VALUE: 'hidden-by-the-users-own-rule' };
  const codexEnv = { ...baseEnv, ...userVars, ...inj.env, ...(process.env.VERIFY_RUST_LOG ? { RUST_LOG: process.env.VERIFY_RUST_LOG } : {}) };    // inj.env: CODEX_HOME (isolated, written by the app) and the capability variable
  const codexHome = codexEnv.CODEX_HOME;
  check('startup', 'Codex runs in the isolated per-agent home the app wrote', typeof codexHome === 'string' && codexHome.startsWith(path.join(ROOT, 'app')) && fs.existsSync(path.join(codexHome, 'config.toml')));
  check('isolation', 'no login of the user is linked into that home (there is none on this throwaway HOME)', !fs.existsSync(path.join(codexHome, 'auth.json')));

  const upstreamAuthHeaders = () => [...new Set(idp.requests('/mcp').map((r) => r.headers.authorization).filter(Boolean))];

  // ─────────────── A. the real agent loop, with a stand-in model ──────────────────────────────────
  const SHELL = (names) => (names.includes('exec_command') ? { name: 'exec_command', arguments: JSON.stringify({ cmd: 'env' }) } : names.includes('shell_command') ? { name: 'shell_command', arguments: JSON.stringify({ command: 'env' }) } : null);
  const model = await new StubModel([
    { call: SHELL },
    { call: () => ({ name: 'search', namespace: 'mcp__mosbius_linear', arguments: JSON.stringify({ query: 'quarterly plan' }) }) },
    { call: () => ({ name: 'delete_page', namespace: 'mcp__mosbius_linear', arguments: JSON.stringify({ id: 'p1' }) }) },
    { call: () => ({ name: 'create_page', namespace: 'mcp__mosbius_linear', arguments: JSON.stringify({ title: 'x' }) }) }
  ]).start();
  cleanups.push(() => model.stop());
  // the TEST answers Codex's tool-approval question (the app does not set this: the user's own policy decides)
  const approve = ['-c', `mcp_servers.mosbius-${ID}.default_tools_approval_mode="approve"`];
  const run = await runExec({ wiring, env: codexEnv, model, work, extra: approve });
  info.execExit = run.code;
  if (process.env.VERIFY_DEBUG) {
    console.log('DEBUG offered:', model.offered.map((t) => t.name ?? t.type).join(', '));
    console.log('DEBUG audit:', JSON.stringify(audit.recent(ID, 20)));
    console.log('DEBUG codex stderr tail:', run.err.split('\n').slice(-12).join('\n'));
    if (process.env.VERIFY_FULL_STDERR) fs.writeFileSync(process.env.VERIFY_FULL_STDERR, run.err);
    console.log('DEBUG events:', run.events.map((e) => `${e.type}:${e.item?.type ?? ''}`).join(' | '));
    console.log('DEBUG upstream mcp methods:', idp.mcpCalls.map((c) => c.method).join(','));
    for (const w of wire) console.log('WIRE', JSON.stringify(w));
  }
  check('startup', 'codex exec starts with the app\'s config and finishes the scripted run', run.code === 0 && run.events.some((e) => e.type === 'turn.completed'), `exit ${run.code}`);

  const nsTool = model.offered.find((t) => t.type === 'namespace' && t.name === `mcp__mosbius_${ID}`);
  const offeredNames = (nsTool?.tools ?? []).map((t) => t.name).sort();
  info.offeredToTheModel = offeredNames;
  check('discovery', 'the model is offered the broker\'s server, and only the granted tool', !!nsTool && offeredNames.join() === 'search', `offered: ${offeredNames.join(', ') || 'none'}`);
  const mcpNamespaces = model.offered.filter((t) => t.type === 'namespace' && /^mcp__/.test(t.name ?? '')).map((t) => t.name);
  check('discovery', 'the broker\'s server is the only MCP server the model was offered', mcpNamespaces.join() === `mcp__mosbius_${ID}`, mcpNamespaces.join(', '));

  const mcpItems = run.events.filter((e) => e.type === 'item.completed' && e.item?.type === 'mcp_tool_call');
  const searchItem = mcpItems.find((e) => e.item.tool === 'search')?.item;
  check('execution', 'a tool call made by the model runs through the broker and returns the provider\'s answer', searchItem?.status === 'completed' && JSON.stringify(searchItem.result ?? {}).length > 2, searchItem ? `status ${searchItem.status}` : 'no mcp_tool_call item');
  const toolCalls = upstreamTools();
  info.upstreamToolCalls = toolCalls;
  check('execution', 'the provider received exactly one tool call: search', toolCalls.join() === 'search', `upstream saw: ${toolCalls.join(', ') || 'none'}`);
  const liveTokens = idp.liveAccess();
  const upstream = upstreamAuthHeaders();
  check('execution', 'the provider saw ITS OWN access token, never the agent\'s capability', upstream.length >= 1 && upstream.every((a) => liveTokens.includes(a.replace('Bearer ', ''))) && !upstream.some((a) => a.includes(capability)));

  const denied = model.outputs.filter((o) => /unsupported call/.test(o.text));
  check('permission', 'a tool the model was not offered cannot be called: Codex refuses it before the broker is reached', denied.length >= 2 && !toolCalls.includes('delete_page') && !toolCalls.includes('create_page'), `${denied.length} refused locally`);

  // the shell the agent was given
  const shellOut = model.outputs.find((o) => /Output:/.test(o.text) && /PATH=/.test(o.text));
  const shellText = shellOut ? shellOut.text : '';
  const shellNames = new Set(shellText.split(/\\n|\n/).map((l) => (/^([A-Za-z_][A-Za-z0-9_]*)=/.exec(l.trim()) ?? [])[1]).filter(Boolean));
  info.shellVariableCount = shellNames.size;
  check('isolation', 'the agent\'s own shell ran and printed its environment', shellNames.has('PATH') && shellNames.size > 3, `${shellNames.size} variables`);
  check('isolation', 'the capability variable is NOT in the shell Codex runs for the model', !shellNames.has(variable) && !shellText.includes(capability));
  check('isolation', 'the user\'s own variables are untouched, secret-looking ones included (nothing was broadened)', shellNames.has('USER_PLAIN_VARIABLE') && shellNames.has('MY_OWN_API_KEY'));
  check('isolation', 'the user\'s own exclusion (from their config.toml) is still honoured', !shellNames.has('MY_OWN_HIDDEN_VALUE'));

  // nothing secret anywhere an agent, a log or a model could see it
  const providerTokens = [...new Set([...liveTokens, ...[...idp.clients.values()].map((c) => c.secret).filter(Boolean), ...idp.regTokens.values()])];
  const everyFile = walk(ROOT).filter((f) => { try { return fs.statSync(f).size < 4_000_000; } catch { return false; } });
  const fileLeaks = []; const capLeaks = [];
  for (const f of everyFile) {
    let body; try { body = fs.readFileSync(f, 'utf8'); } catch { continue; }
    if (leaks(body, providerTokens).length) fileLeaks.push(path.relative(ROOT, f));
    if (body.includes(capability)) capLeaks.push(path.relative(ROOT, f));
  }
  check('isolation', 'the provider\'s tokens are in no file Codex or the app wrote under the throwaway folders', fileLeaks.length === 0, fileLeaks.join(', '));
  check('isolation', 'the capability is in no file Codex or the app wrote', capLeaks.length === 0, capLeaks.join(', '));
  const allArgs = run.snaps.join('\n');
  check('isolation', 'neither the capability nor a provider token appears in any process argument while Codex ran', leaks(allArgs, [capability, ...providerTokens]).length === 0, `${run.snaps.length} process listings`);
  check('isolation', 'nothing sent to the model, nor Codex\'s own output, carries the capability or a provider token', leaks(`${model.bodies.join('\n')}\n${run.out}\n${run.err}`, [capability, ...providerTokens]).length === 0);

  // A control, so the check above can fail: the same Codex, the same environment, but WITHOUT the app's two shell
  // overrides. If the variable is visible here, the app's overrides are what hide it, not luck.
  const stripped = [];
  for (let i = 0; i < wiring.length; i += 2) {
    if (/^features\.shell_snapshot=/.test(wiring[i + 1]) || /^shell_environment_policy\.exclude=/.test(wiring[i + 1])) continue;
    stripped.push(wiring[i], wiring[i + 1]);
  }
  const controlModel = await new StubModel([{ call: SHELL }]).start();
  cleanups.push(() => controlModel.stop());
  await runExec({ wiring: stripped, env: codexEnv, model: controlModel, work, extra: approve });
  const controlOut = controlModel.outputs.find((o) => /Output:/.test(o.text) && /PATH=/.test(o.text))?.text ?? '';
  const controlNames = new Set(controlOut.split(/\\n|\n/).map((l) => (/^([A-Za-z_][A-Za-z0-9_]*)=/.exec(l.trim()) ?? [])[1]).filter(Boolean));
  // (run AFTER the file scan above: with the variable visible, Codex writes what the shell printed into its own transcript)
  check('isolation', 'control: without the app\'s two overrides, the same Codex DOES show the variable to the model\'s shell (so the check above can fail)', controlNames.has(variable));

  // The shell's own environment is one place a pass can be read; the processes above the shell are another. Codex needs the pass in
  // ITS environment (bearer_token_env_var), so a command in its shell may be able to read it there with ps. Measured with the app's
  // real wiring, and printed as a hash so that the pass itself is never shown.
  const SCAN_SCRIPT = [
    'echo SCAN_SHELL_PID=$$',
    `ps -axo pid=,ppid= | awk -v me=$$ '{ pp[$1]=$2 } END { p=me; while (p>1) { print p; p=pp[p] } }' | while read -r q; do`,
    // for a NEGATIVE result to mean anything, say how many processes were walked and how much of each one's environment ps returned
    `  printf "SCAN_ANCESTOR pid=%s comm=" "$q"; ps -o comm= -p "$q" 2>/dev/null | head -1 | tr -d "\\n"; printf " envtokens="; ps eww -p "$q" 2>/dev/null | tr " " "\\n" | grep -ac "^[A-Za-z_][A-Za-z0-9_]*="`,
    `  ps eww -p "$q" 2>/dev/null | tr " " "\\n" | grep -a "^${variable}=" | head -1 | cut -d= -f2- | { read -r v; if [ -n "$v" ]; then printf "SCAN_HAS_PASS pid=%s sha256=" "$q"; printf %s "$v" | LC_ALL=C LANG=C shasum -a 256 2>/dev/null | cut -d" " -f1; fi; }`,
    'done',
    'echo SCAN_DONE',
    'echo ---NAMES---',
    'env | cut -d= -f1'
  ].join('\n');
  const SCAN = (names) => (names.includes('exec_command') ? { name: 'exec_command', arguments: JSON.stringify({ cmd: SCAN_SCRIPT }) } : names.includes('shell_command') ? { name: 'shell_command', arguments: JSON.stringify({ command: SCAN_SCRIPT }) } : null);
  const scanModel = await new StubModel([{ call: SCAN }]).start();
  cleanups.push(() => scanModel.stop());
  await runExec({ wiring, env: codexEnv, model: scanModel, work, extra: approve });
  const scanText = scanModel.outputs.map((o) => o.text).join('\n');
  // The same scan with Codex's OS sandbox switched OFF (-s danger-full-access, which the app never uses): the control that
  // shows whether the sandbox is what stops the shell from inspecting the processes above it.
  const openModel = await new StubModel([{ call: SCAN }]).start();
  cleanups.push(() => openModel.stop());
  await runExec({ wiring, env: codexEnv, model: openModel, work, extra: approve, sandbox: 'danger-full-access' });
  const openText = openModel.outputs.map((o) => o.text).join('\n');
  const openHolders = [...openText.matchAll(/SCAN_HAS_PASS pid=(\d+) sha256=([0-9a-f]{64})/g)].map((m) => ({ pid: Number(m[1]), sha256: m[2] }));
  const openWalkedList = [...openText.matchAll(/SCAN_ANCESTOR pid=(\d+) comm=(\S*) envtokens=(\d+)/g)].map((m) => `${path.basename(m[2])}(${m[3]})`);
  const openWalked = openWalkedList.length;
  const scanRan = /SCAN_DONE/.test(scanText);
  const holders = [...scanText.matchAll(/SCAN_HAS_PASS pid=(\d+) sha256=([0-9a-f]{64})/g)].map((m) => ({ pid: Number(m[1]), sha256: m[2] }));
  const scanNames = new Set((scanText.split('---NAMES---')[1] ?? '').split(/\\n|\n/).map((l) => l.trim()).filter((l) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(l)));
  const ancestors = [...scanText.matchAll(/SCAN_ANCESTOR pid=(\d+) comm=(\S*) envtokens=(\d+)/g)].map((m) => ({ pid: Number(m[1]), comm: path.basename(m[2]), envTokens: Number(m[3]) }));
  info.scanWalkedThisManyProcesses = ancestors.length;
  info.processesWalkedAndTheEnvironmentPsShowedForEach = ancestors.map((a) => `${a.comm}: ${a.envTokens} variables`);
  const passHash = crypto.createHash('sha256').update(capability).digest('hex');
  const readableFromAbove = scanRan && holders.length > 0 && holders.every((h) => h.sha256 === passHash);
  info.passReadableFromTheProcessesAboveTheShell = readableFromAbove;
  info.processesAboveTheShellHoldingThePass = holders.length;
  check('isolation', 'the scan ran in Codex\'s shell, and the pass is still not in that shell\'s own environment', scanRan && scanNames.size > 3 && !scanNames.has(variable), `${scanNames.size} variables`);
  const readableWithoutSandbox = /SCAN_DONE/.test(openText) && openHolders.length > 0 && openHolders.every((h) => h.sha256 === passHash);
  info.passReadableFromTheProcessesAboveTheShellWithTheSandboxOff = readableWithoutSandbox;
  info.processesWalkedWithTheSandboxOff = openWalked;
  check('isolation', 'control: with Codex\'s OS sandbox switched off (-s danger-full-access, which the app never uses) the same scan walks the process tree and DOES read the real pass from the Codex process, so it is the sandbox that stops the shell inspecting processes',
    readableWithoutSandbox, `walked ${openWalkedList.join(' < ')}; ${openHolders.length} hold the pass`);
  const claimedShell = compatOf('codex').capabilityHiddenFromShell;
  const needsSandbox = compatOf('codex').shellProtectionNeedsSandbox;
  const inspectionRefused = scanRan && ancestors.every((a) => a.envTokens === 0);
  info.processInspectionRefusedInsideTheSandbox = inspectionRefused;
  check('isolation', `MEASURED: with the sandbox on (the app's mode) the pass ${readableFromAbove ? 'CAN' : 'cannot'} be read from the processes above Codex's shell (ps${inspectionRefused ? ' returns nothing there: process inspection is refused inside the sandbox' : ''}); the support matrix says "${claimedShell}" and ${needsSandbox ? 'says the protection needs the sandbox' : 'does not mention the sandbox'}`,
    !readableFromAbove && claimedShell === 'yes' && needsSandbox === readableWithoutSandbox && (!needsSandbox || inspectionRefused),
    readableFromAbove ? `${holders.length} process(es) hold it, hash equal` : `${inspectionRefused ? 'ps returned no process information' : `walked ${ancestors.map((a) => `${a.comm}(${a.envTokens})`).join(' < ')}; none shows the pass`}`);

  // ─────────────── B. Codex's own protocol: status, direct calls, revocation ──────────────────────
  const model2 = await new StubModel([]).start();
  cleanups.push(() => model2.stop());
  const srv = appServer({ wiring, env: codexEnv, model: model2 });
  cleanups.push(() => srv.close());
  const init = await srv.init();
  const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
  check('startup', 'codex app-server answers initialize from the isolated home', !!init.result?.codexHome && real(init.result.codexHome) === real(codexHome));
  const status = await srv.send('mcpServerStatus/list', {});
  const row = (status.result?.data ?? []).find((s) => s.name === `mosbius-${ID}`);
  check('startup', 'Codex reports the broker\'s server, authenticated with a bearer token', !!row && row.authStatus === 'bearerToken', row ? row.authStatus : 'server not listed');
  const listed = Object.keys(row?.tools ?? {}).sort();
  check('discovery', 'the tools Codex lists for it are exactly the granted ones', listed.join() === 'search', listed.join(', ') || 'none');
  const th = await srv.send('thread/start', { cwd: work });
  const threadId = th.result?.thread?.id;
  check('startup', 'a thread starts with no Codex sign-in at all', typeof threadId === 'string');
  const okCall = await srv.send('mcpServer/tool/call', { server: `mosbius-${ID}`, threadId, tool: 'search', arguments: { query: 'direct' } });
  check('execution', 'a direct call to a granted tool succeeds', Array.isArray(okCall.result?.content) && okCall.result.isError !== true);
  for (const [tool, why] of [['delete_page', 'a destructive tool that was not granted'], ['create_page', 'a write tool that was not granted'], ['mystery', 'a tool nobody classified']]) {
    const r = await srv.send('mcpServer/tool/call', { server: `mosbius-${ID}`, threadId, tool, arguments: { id: 'p1' } });
    const refused = !!r.error || r.result?.isError === true;
    check('permission', `the broker refuses ${why}: ${tool}`, refused, JSON.stringify(r.error ?? r.result).slice(0, 120));
  }
  const upstreamAfterDenied = upstreamTools();
  check('permission', 'none of the refused calls reached the provider', !upstreamAfterDenied.some((n) => ['delete_page', 'create_page', 'mystery'].includes(n)), `provider saw: ${upstreamAfterDenied.join(', ')}`);
  const denials = audit.recent(ID).filter((e) => e.decision === 'deny');
  info.auditDenials = denials.map((d) => `${d.tool ?? d.method ?? ''}:${d.reason ?? ''}`);
  check('permission', 'each refusal is in the audit log with the tool and a reason, and no argument', ['delete_page', 'create_page', 'mystery'].every((t) => denials.some((d) => d.tool === t && d.reason)) && !JSON.stringify(denials).includes('p1'));

  // revoke, and try the same session and a new one
  const before = upstreamAfterDenied.length;
  broker.revokeMcp(AGENT);
  const afterRevoke = await srv.send('mcpServer/tool/call', { server: `mosbius-${ID}`, threadId, tool: 'search', arguments: { query: 'after revoke' } });
  check('revocation', 'after revocation the open session\'s next call is refused', !!afterRevoke.error || afterRevoke.result?.isError === true, JSON.stringify(afterRevoke.error ?? afterRevoke.result).slice(0, 120));
  check('revocation', 'and the provider was not asked', upstreamTools().length === before);
  const srv2 = appServer({ wiring, env: codexEnv, model: model2 });
  cleanups.push(() => srv2.close());
  await srv2.init();
  const status2 = await srv2.send('mcpServerStatus/list', {});
  const row2 = (status2.result?.data ?? []).find((s) => s.name === `mosbius-${ID}`);
  check('revocation', 'a new Codex session with the same configuration cannot list or use the tools', !row2 || Object.keys(row2.tools ?? {}).length === 0, row2 ? `${Object.keys(row2.tools ?? {}).length} tools` : 'server not listed');
  const direct = await call(Number(new URL(broker.url()).port), { method: 'POST', path: `/m/${ID}`, headers: { authorization: `Bearer ${capability}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: rpc('tools/list', undefined, 9) });
  check('revocation', 'the revoked capability is refused by the broker itself', direct.status === 401 || direct.status === 403, `HTTP ${direct.status}`);

  // ─────────────── C. where Codex finds a skill ─────────────────────────────────────────────────────
  const skillMd = '---\nname: mosbius-probe-skill\ndescription: A probe used to see where Codex discovers skills.\n---\n\nSay hello.\n';
  const spots = {
    'CODEX_HOME/skills': path.join(codexHome, 'skills', 'probe-a'),
    'workspace/.agents/skills': path.join(work, '.agents', 'skills', 'probe-b'),
    'workspace/.codex/skills': path.join(work, '.codex', 'skills', 'probe-c'),
    'workspace/.claude/skills': path.join(work, '.claude', 'skills', 'probe-d'),
    'HOME/.agents/skills': path.join(FAKE_HOME, '.agents', 'skills', 'probe-e'),
    'HOME/.claude/skills': path.join(FAKE_HOME, '.claude', 'skills', 'probe-f')
  };
  for (const dir of Object.values(spots)) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'SKILL.md'), skillMd.replace('mosbius-probe-skill', `mosbius-probe-${path.basename(dir)}`)); }
  const skills = await srv2.send('skills/list', { cwds: [work], forceReload: true });
  const found = JSON.stringify(skills.result ?? {});
  const where = {};
  for (const [label, dir] of Object.entries(spots)) where[label] = found.includes(`mosbius-probe-${path.basename(dir)}`);
  info.skillsDiscoveredAt = where;
  check('skills', 'Codex answers skills/list and finds at least one of the locations the app could install into', skills.result && Object.values(where).some(Boolean), Object.entries(where).map(([k, v]) => `${k}:${v ? 'yes' : 'no'}`).join('  '));

  // ─────────────── finish ───────────────────────────────────────────────────────────────────────────
  srv2.close(); srv.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? `; FAILED: ${failed.map((f) => f.name).join(' | ')}` : ''}`);
  if (evidenceBase) {
    const outJson = path.resolve(`${evidenceBase}.json`);
    fs.mkdirSync(path.dirname(outJson), { recursive: true });
    fs.writeFileSync(outJson, JSON.stringify({
      tool: 'tools/verify-codex-live.cjs', date: new Date().toISOString(), ...info,
      stands_in_for: { provider: 'test/fixtures/stage-a-idp.cjs (stand-in, not a real provider)', model: 'scripted Responses-API stand-in (no OpenAI model, no account)' },
      not_tested: ['a real OpenAI model choosing tools well', 'a real Codex sign-in', 'Windows and Linux behaviour of Codex (including whether its sandbox there refuses process inspection)', 'any sandbox mode other than workspace-write (the app\'s auto mode) and danger-full-access (the control)'],
      results
    }, null, 2));
    const lines = [`${codexVersion} · ${info.platform} · node ${info.node} · ${new Date().toISOString()}`, '', ...results.map((r) => `${r.ok ? 'PASS' : 'FAIL'}  [${r.group}] ${r.name}${r.detail ? `  — ${r.detail}` : ''}`), '', `${results.length - failed.length}/${results.length} checks passed`];
    fs.writeFileSync(path.resolve(`${evidenceBase}.txt`), `${lines.join('\n')}\n`);
    console.log(`evidence written: ${outJson}`);
  }
  for (const fn of cleanups.reverse()) { try { await fn(); } catch { /* best effort */ } }
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* best effort */ }
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('verify-codex-live crashed:', e instanceof Error ? e.stack : e); try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* best effort */ } process.exit(1); });
