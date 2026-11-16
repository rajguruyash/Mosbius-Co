#!/usr/bin/env node
'use strict';

/**
 * Stage B, the real thing: a real `claude` CLI uses real, hash-pinned MCP packages THROUGH the
 * app's broker, and we look for the credential everywhere an agent could ever see it.
 *
 *   node tools/verify-stage-b-live.cjs [--node /path/to/node] [--model haiku] [--evidence out.json]
 *
 * What runs for real: the pinned packages (installed from their locks, started by the app's host),
 * the broker and its route, the production code that writes the agent's mcp-config.json, the audit
 * store, and Claude Code itself (a few short turns on a small model, a few cents of your usage).
 * What does NOT: no real account of any provider is used. Notion gets an obviously fake token (a
 * "canary") and is expected to answer 401; that proves the call reached the provider and the canary
 * went nowhere it should not, not that an account works.
 *
 * Checks (each printed as PASS/FAIL, exit code 1 on any FAIL):
 *   - the CLI connects to every granted server through the broker, as HTTP servers, and to nothing else
 *   - real tool calls succeed through the broker: time, filesystem (read), git (read)
 *   - a call that reaches Notion with the canary is refused by Notion (401), and the canary is in no
 *     answer, no config file, no process argument, no agent environment, no transcript, no audit record
 *   - the tools the agent is shown are exactly the granted ones; a denied call is refused by the broker
 *   - every server process is a child of THIS process (the app) and none is a descendant of the CLI
 *   - after the capability is revoked, the same config no longer connects and the servers are gone
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const loadTs = require('../test/load-ts.cjs');

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const nodePath = flag('--node', process.execPath);
const model = flag('--model', 'haiku');
const evidencePath = flag('--evidence');

const { IntegrationBroker } = loadTs('src/main/integrationBroker.ts');
const { StdioHost } = loadTs('src/main/broker/stdio-host.ts');
const { DISCOVERY_AGENT } = loadTs('src/main/broker/mcp-route.ts');
const { AuditStore } = loadTs('src/main/broker/audit-store.ts');
const { PackageStore } = loadTs('src/main/mcpPackages.ts');
const { HiveManager } = loadTs('src/main/hive.ts');
const { mcpCatalogEntry, mcpPackageOf } = loadTs('src/shared/mcpCatalog.ts');
const { mcpIntegrationFor, sanitizeMcpGrants } = loadTs('src/main/mcpWiring.ts');
const { createMcpCredentialProvider, localServerEnv, localServerSecrets, serverBaseEnv } = loadTs('src/main/mcpCredentials.ts');
const { resolveLaunch } = loadTs('src/main/mcpLaunch.ts');

const CANARY = 'ntn_STAGEB_LIVE_CANARY_5f3a9c1e7b2d4a60_NOT_A_REAL_TOKEN';
const IDS = ['time', 'filesystem', 'git', 'notion'];
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const find = (name, PATHV) => { for (const d of PATHV.split(path.delimiter)) { const p = path.join(d, name); if (fs.existsSync(p)) return p; } return undefined; };
const sh = (cmd, a) => { try { return execFileSync(cmd, a, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }); } catch (e) { return String(e.stdout ?? ''); } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 100)); } return null; };

function ancestors(pid, table) {
  const out = []; let cur = pid;
  for (let i = 0; i < 20 && cur > 1; i++) { const row = table.get(cur); if (!row) break; out.push(row.ppid); cur = row.ppid; }
  return out;
}
const psTable = () => {
  const m = new Map();
  for (const line of sh('ps', ['-axo', 'pid=,ppid=,args=']).split('\n')) {
    const x = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (x) m.set(Number(x[1]), { ppid: Number(x[2]), args: x[3] });
  }
  return m;
};

function runClaude(configPath, prompt, allowed, cwd, samples) {
  return new Promise((resolve) => {
    const args = ['-p', prompt, '--mcp-config', configPath, '--strict-mcp-config', '--output-format', 'stream-json', '--verbose',
      '--model', model, '--max-turns', '8', '--allowedTools', allowed];
    const child = spawn('claude', args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    const timer = setInterval(() => { if (samples) samples.push({ at: Date.now(), claudePid: child.pid, table: psTable() }); }, 700);
    const killer = setTimeout(() => child.kill('SIGKILL'), 300_000);
    child.on('close', (code) => {
      clearInterval(timer); clearTimeout(killer);
      const events = out.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{')).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      resolve({ code, events, raw: out + err, claudePid: child.pid });
    });
  });
}

const toolUses = (events) => events.flatMap((e) => (e.message?.content ?? []).filter((c) => c.type === 'tool_use').map((c) => ({ id: c.id, name: c.name, input: c.input })));
const toolResults = (events) => events.flatMap((e) => (Array.isArray(e.message?.content) ? e.message.content : []).filter((c) => c.type === 'tool_result').map((c) => ({
  id: c.tool_use_id, isError: c.is_error === true,
  text: (typeof c.content === 'string' ? c.content : (c.content ?? []).map((x) => x.text ?? '').join(' ')).replace(/\s+/g, ' ').slice(0, 300)
})));
const initOf = (events) => events.find((e) => e.type === 'system' && e.subtype === 'init');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mosbius-stageb-live-'));
  const home = path.join(root, 'app');          // the app's data folder
  const work = path.join(root, 'workspace');    // the agent's working directory
  fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(path.join(work, 'hello.txt'), 'hello from the workspace\n');
  execFileSync('git', ['init', '-q'], { cwd: work });
  execFileSync('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=probe', 'add', '.'], { cwd: work });
  execFileSync('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=probe', 'commit', '-q', '-m', 'init'], { cwd: work });
  const PATHV = [path.dirname(nodePath), ...(process.env.PATH ?? '').split(path.delimiter)].join(path.delimiter);

  let claudeVersion = '';
  try { claudeVersion = execFileSync('claude', ['--version'], { encoding: 'utf8' }).trim(); } catch { console.error('`claude` is not on PATH'); process.exit(2); }
  console.log(`claude ${claudeVersion} · model ${model} · node ${sh(nodePath, ['-v']).trim()} · ${process.platform}/${process.arch}\n`);

  // ── the app, assembled the way src/main/index.ts assembles it ───────────────────────────────
  const store = new PackageStore({
    root: path.join(home, 'mcp-packages'), locksRoot: path.join(__dirname, '..', 'resources', 'mcp-locks'),
    which: (n) => (n === 'node' ? nodePath : find(n, PATHV)), env: () => serverBaseEnv(process.env, PATHV)
  });
  console.log('installing the pinned packages from their locks...');
  for (const id of IDS) {
    const r = await store.ensure(id, mcpPackageOf(mcpCatalogEntry(id)));
    check(`${id}: installed from its lock`, r.ok, r.ok ? '' : r.error);
    if (!r.ok) process.exit(1);
  }
  const vault = { notion: CANARY };
  const cfg = {
    mcpDefaults: Object.fromEntries(IDS.map((id) => [id, { enabled: true }])),
    // the agent may READ with time, filesystem and git; Notion only its one harmless call; nobody may write or reset
    mcpGrants: { defaults: {
      time: { preset: 'read' }, filesystem: { preset: 'read' }, git: { preset: 'read' },
      notion: { preset: 'custom', allow: ['API-get-self'] }
    } }
  };
  const audit = new AuditStore({ dir: path.join(home, 'audit'), key: Buffer.from('k'.repeat(32)) });
  const cwds = new Map([['agent-1', work]]);
  const host = new StdioHost({
    launch: (id, agentId) => {
      const entry = mcpCatalogEntry(id);
      if (!entry || cfg.mcpDefaults[id]?.enabled !== true) return undefined;
      const installed = store.readyLaunch(id, mcpPackageOf(entry));
      const cwd = agentId === DISCOVERY_AGENT ? home : cwds.get(agentId);
      const env = localServerEnv(entry, process.env, PATHV);
      const secrets = localServerSecrets(entry, vault[id]);
      return installed && cwd && env && secrets ? resolveLaunch(entry, installed, cwd, env, secrets) : undefined;
    },
    limits: { requestMs: 90_000 }
  });
  const broker = new IntegrationBroker({ getRecord: () => undefined, getSecret: () => undefined }, {
    mcp: {
      resolve: (id) => mcpIntegrationFor(id, cfg),
      credentials: createMcpCredentialProvider({ entry: mcpCatalogEntry, token: (id) => vault[id], oauth: { accessHeaders: () => ({ ok: false, code: 'sign_in_required' }) } }),
      hosted: { handle: (i, a, b, s) => host.handle(i, a, b, s), close: (a, i) => host.close(a, i) },
      grants: () => sanitizeMcpGrants(cfg.mcpGrants),
      audit: (e) => audit.append({ kind: 'mcp', actor: `agent:${e.agentId}`, agentId: e.agentId, integrationId: e.integrationId, action: e.tool ?? e.method, decision: e.decision, reason: e.reason })
    }
  });
  const { port } = await broker.start();

  // ── what the app does at spawn: mint a capability, write the config with production code ───
  const token = broker.grantMcp('agent-1', IDS);
  const hive = new HiveManager(() => home);
  const inj = await hive.ensureAgent({ id: 'agent-1', name: 'agent-1', provider: 'claude', cwd: work }, {
    mcpDefaults: cfg.mcpDefaults,
    mcpBroker: (id) => (IDS.includes(id) ? { url: `http://127.0.0.1:${port}/m/${id}`, authorization: `Bearer ${token}` } : undefined)
  });
  const configPath = path.join(home, 'hive', 'agents', 'agent-1', 'mcp-config.json');
  const configText = fs.readFileSync(configPath, 'utf8');
  const cfgJson = JSON.parse(configText);
  check('the config the agent reads holds only broker addresses and a capability (no command, argument, environment or credential)',
    Object.values(cfgJson.mcpServers).every((s) => Object.keys(s).sort().join() === 'headers,type,url' && s.type === 'http' && s.url.startsWith(`http://127.0.0.1:${port}/m/`))
    && !configText.includes(CANARY), `${Object.keys(cfgJson.mcpServers).length} servers`);

  // ── run 1: real tool calls ───────────────────────────────────────────────────────────────────
  const allowed = IDS.map((id) => `mcp__mosbius-${id}`).join(',');
  const prompt = `Use ONLY tools from the MCP servers whose names start with mosbius-. Do these four things, then reply with exactly four short lines, one per item, quoting any error text exactly:
1) Get the current time in UTC with the time server.
2) Read the file ${path.join(work, 'hello.txt')} with the filesystem server.
3) Run git status for the repository at ${work} with the git server.
4) Call the Notion tool API-get-self.`;
  console.log('\nrunning claude (a few short turns)...');
  const samples = [];
  const run1 = await runClaude(configPath, prompt, allowed, work, samples);
  const init = initOf(run1.events);
  const servers = (init?.mcp_servers ?? []).map((s) => `${s.name}:${s.status}`).sort();
  check('the CLI connects to every granted server through the broker, and to nothing else',
    servers.length === IDS.length && servers.every((s) => /^mosbius-(time|filesystem|git|notion):connected$/.test(s)), servers.join(' '));
  const uses = toolUses(run1.events);
  const results1 = toolResults(run1.events);
  const usedNames = [...new Set(uses.map((u) => u.name))];
  const text = results1.map((r) => r.text).join(' || ');
  check('a real time call succeeds through the broker', uses.some((u) => u.name === 'mcp__mosbius-time__get_current_time') && /20\d\d-\d\d-\d\dT/.test(text), usedNames.join(', '));
  check('a real filesystem read succeeds through the broker', /hello from the workspace/.test(text));
  check('a real git call succeeds through the broker', /nothing to commit|working tree clean|On branch/i.test(text));
  const notionRes = results1.find((r) => /token is invalid|unauthori[sz]ed|401/i.test(r.text));
  check('the Notion call reached Notion with the canary and was refused (401): the call path works, no real account was used', !!notionRes, notionRes?.text?.slice(0, 120));
  const toolNames = init?.tools ?? [];
  const mosb = toolNames.filter((n) => n.startsWith('mcp__mosbius-'));
  const forbidden = mosb.filter((n) => /write_file|edit_file|move_file|create_directory|append_file|copy_file|git_commit|git_add|git_reset|git_checkout|git_merge|API-(post|patch|update|delete|create|move)/i.test(n));
  check('the agent is shown only the tools it was granted: no write, no commit, no reset, no Notion write', forbidden.length === 0, `${mosb.length} tools offered; offered write tools: ${forbidden.join(', ') || 'none'}`);

  // ── a denied call, made straight at the broker with this agent's capability ───────────────────
  const http = require('node:http');
  // node:http, not fetch: fetch adds the Sec-Fetch-* headers a browser sends, which the broker (rightly) refuses
  const post = (id, body) => new Promise((resolve) => {
    const data = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: `/m/${id}`, agent: false,
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}`, 'content-length': Buffer.byteLength(data) } }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', (e) => resolve({ status: 0, text: String(e.message) }));
    req.end(data);
  });
  await post('filesystem', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '1' } } });
  await post('filesystem', { jsonrpc: '2.0', method: 'notifications/initialized' });
  await post('filesystem', { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const victim = path.join(work, 'must-not-exist.txt');
  const denied = await post('filesystem', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'write_file', arguments: { path: victim, content: 'x' } } });
  check('a write the agent was not granted is refused by the broker, and the file is not created', /Not permitted/i.test(denied.text) && !fs.existsSync(victim), denied.text.slice(0, 100));
  const reset = await post('git', { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'git_reset', arguments: { repo_path: work } } });
  check('git_reset (destructive) is refused by the broker', /Not permitted/i.test(reset.text), reset.text.slice(0, 100));

  // ── 3. every server is a child of the app and none descends from the CLI ──────────────────────
  const table = psTable();
  const serverPids = [];
  for (const [pid, row] of table) {
    if (row.ppid === process.pid && /mcp-locks|mcp-packages/.test(row.args) === false && /mcp-packages/.test(row.args + ' ')) serverPids.push(pid);
  }
  const mine = [...table].filter(([, row]) => row.ppid === process.pid && row.args.includes(path.join(home, 'mcp-packages')));
  check('every server process is a direct child of the app (this process)', mine.length >= IDS.length, `${mine.length} server processes, all with ppid ${process.pid}`);
  const claudePids = new Set(samples.map((s) => s.claudePid));
  const descended = [];
  for (const s of samples) for (const [pid, row] of s.table) {
    if (!row.args.includes(path.join(home, 'mcp-packages'))) continue;
    if (ancestors(pid, s.table).some((a) => claudePids.has(a))) descended.push(pid);
  }
  check('no server process was ever a descendant of the CLI, in any of the samples taken while it ran', descended.length === 0, `${samples.length} process-table samples`);

  // ── 2. the credential, everywhere the agent could look ─────────────────────────────────────────
  const surfaces = {
    'the CLI output': run1.raw,
    'the agent config': configText,
    'the spawn arguments the app builds': JSON.stringify(inj.args),
    'the environment the app adds': JSON.stringify(inj.env ?? {}),
    'every process-table sample taken while the CLI ran (arguments)': samples.map((s) => [...s.table.values()].map((r) => r.args).join('\n')).join('\n'),
    'the audit trail': (() => { audit.close(); return fs.readdirSync(path.join(home, 'audit')).map((f) => fs.readFileSync(path.join(home, 'audit', f), 'utf8')).join('\n'); })()
  };
  // the CLI's own session transcript for this run
  const projects = path.join(os.homedir(), '.claude', 'projects');
  let transcripts = '';
  try {
    const enc = work.replace(/[/.]/g, '-');
    const d = fs.readdirSync(projects).filter((n) => n.includes(path.basename(root)) || n === enc);
    for (const n of d) for (const f of fs.readdirSync(path.join(projects, n))) transcripts += fs.readFileSync(path.join(projects, n, f), 'utf8');
  } catch { /* none found */ }
  surfaces[`the CLI's session transcript (${transcripts.length} bytes)`] = transcripts;
  // the environment of the running CLI process, as the OS reports it
  const envOfCli = samples.length ? sh('ps', ['eww', '-p', String(samples[0].claudePid)]) : '';
  surfaces['the environment of the running CLI process (ps eww)'] = envOfCli;
  const unobservable = [];
  for (const [where, blob] of Object.entries(surfaces)) {
    // `ps eww` on a hardened (signed) binary such as the CLI returns only the command line; that is not evidence
    if (where.startsWith('the environment of the running CLI') && blob.length < 200) { unobservable.push(where); continue; }
    check(`the credential is not in ${where}`, !blob.includes(CANARY), blob.length ? `${blob.length} bytes searched` : 'nothing captured');
  }
  for (const w of unobservable) console.log(`  N/A   ${w}  — the OS shows no environment for this process, so nothing was checked here (the environment the app builds for it is checked above)`);
  // what any other process of this user can read about a server: its arguments AND its environment
  const notionRow = mine.find(([, r]) => /notion/.test(r.args));
  const serverEnv = notionRow ? sh('ps', ['eww', '-p', String(notionRow[0])]) : '';
  check('the credential is not readable from the Notion server process by `ps eww` (argument list or initial environment)', !!notionRow && serverEnv.length > 100 && !serverEnv.includes(CANARY), notionRow ? `${serverEnv.length} bytes of its argument list and environment searched` : 'no Notion server process found');
  const exposedToSameUser = serverEnv.includes(CANARY);

  // ── revocation ──────────────────────────────────────────────────────────────────────────────────
  const pidsBefore = mine.map(([pid]) => pid);
  broker.revokeMcp('agent-1');
  check('after revocation every server process the app ran for that agent is stopped', !!(await until(() => pidsBefore.every((p) => !alive(p)))), `${pidsBefore.length} processes`);
  const run2 = await runClaude(configPath, 'Reply with the single word OK.', allowed, work, null);
  const init2 = initOf(run2.events);
  const st2 = (init2?.mcp_servers ?? []).map((s) => `${s.name}:${s.status}`);
  check('with the revoked capability the same config no longer connects to any server', st2.length > 0 && st2.every((s) => !/:connected$/.test(s)), st2.join(' '));
  check('no server was started for the revoked agent', mine.length > 0 && !(psTable().size && [...psTable()].some(([pid, row]) => !pidsBefore.includes(pid) && row.args.includes(path.join(home, 'mcp-packages')))));

  // ── tidy up and report ──────────────────────────────────────────────────────────────────────────
  broker.stop(); host.closeAll();
  const cost = run1.events.find((e) => e.type === 'result');
  const summary = {
    at: new Date().toISOString(), claude: claudeVersion, model, node: sh(nodePath, ['-v']).trim(), platform: `${process.platform}/${process.arch}`, notObservable: unobservable,
    turns: cost?.num_turns, costUsd: cost?.total_cost_usd, toolCalls: uses.map((u) => u.name), mcpServers: servers, toolsOffered: mosb.length,
    serverEnvironmentReadableBySameUser: exposedToSameUser, results
  };
  if (evidencePath) { fs.mkdirSync(path.dirname(path.resolve(evidencePath)), { recursive: true }); fs.writeFileSync(evidencePath, JSON.stringify(summary, null, 2)); }
  fs.rmSync(root, { recursive: true, force: true });
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed · ${cost?.num_turns ?? '?'} turns · $${cost?.total_cost_usd ?? '?'}`);
  console.log(`credential visible to a same-user process through \`ps eww\` on the server: ${exposedToSameUser ? 'YES' : 'no'} (it lives only in the server's memory; a same-user process with debugger rights could still read that)`);
  process.exit(results.every((r) => r.ok) ? 0 : 1);
})().catch((e) => { console.error('verifier crashed:', e); process.exit(2); });
