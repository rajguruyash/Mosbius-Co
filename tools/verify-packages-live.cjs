#!/usr/bin/env node
'use strict';

/**
 * Stage B live check: every pinned package installs from its lock, starts, lists its tools and
 * answers a real tool call, through the same code the app uses (PackageStore + StdioHost).
 *
 *   node tools/verify-packages-live.cjs [--only id,id] [--node /path/to/node] [--evidence out.json] [--snapshot] [--keep]
 *
 * With --snapshot it also writes each server's real tool list to resources/mcp-locks/<id>/tools.json,
 * the file test/mcp-tool-classes.test.cjs holds the catalogue's pinned tool classes against.
 *
 * It really installs (npm ci --ignore-scripts / uv pip install --require-hashes) into a fresh
 * temporary folder, so it needs the network and a few minutes. It does NOT use any real credential:
 * Notion and Brave are given an obviously fake one, and their tool call is expected to reach the
 * provider and be refused (that proves the call path, not an account). Playwright is expected to be
 * unable to open a page if no browser has been installed. Those two outcomes are recorded as what
 * they are and never counted as "works end to end".
 *
 * Exit code 0 only if every package installed, started, listed tools and answered its call (or
 * reached the expected, labelled limit).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawnSync, execFileSync } = require('node:child_process');
const loadTs = require('../test/load-ts.cjs');

const { MCP_CATALOG, MCP_REMOTE_PACKAGE_SPEC } = loadTs('src/shared/mcpCatalog.ts');
const { PackageStore } = loadTs('src/main/mcpPackages.ts');
const { StdioHost } = loadTs('src/main/broker/stdio-host.ts');
const { localServerEnv, localServerSecrets, serverBaseEnv } = loadTs('src/main/mcpCredentials.ts');
const { resolveLaunch } = loadTs('src/main/mcpLaunch.ts');

const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const only = (flag('--only') ?? '').split(',').filter(Boolean);
const nodePath = flag('--node') ?? process.execPath;
const evidencePath = flag('--evidence');
const keep = argv.includes('--keep');
const snapshot = argv.includes('--snapshot');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mosbius-live-'));
const storeRoot = path.join(root, 'store');
const workspace = path.join(root, 'workspace');
fs.mkdirSync(workspace, { recursive: true });
const PATHV = [path.dirname(nodePath), ...(process.env.PATH ?? '').split(path.delimiter)].filter(Boolean).join(path.delimiter);

const find = (name) => {
  for (const d of PATHV.split(path.delimiter)) { const p = path.join(d, name); if (fs.existsSync(p)) return p; }
  return undefined;
};
const which = (n) => (n === 'node' ? nodePath : find(n));
const FAKE = { notion: 'ntn_STAGEB_FAKE_NOT_A_REAL_CREDENTIAL', 'brave-search': 'BSA_STAGEB_FAKE_NOT_A_REAL_KEY' };

// ─── stand-ins: a page for `fetch`/`playwright`, and an MCP server for the bridge ─────────────
const page = '<html><head><title>Stage B probe</title></head><body><h1>Hello from the probe</h1><p>Second paragraph.</p></body></html>';
const probe = http.createServer((req, res) => {
  if (req.url === '/page') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(page); }
  if (req.url === '/mcp' && req.method === 'POST') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let m; try { m = JSON.parse(Buffer.concat(chunks).toString()); } catch { res.writeHead(400); return res.end(); }
      const ok = (result) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result })); };
      if (m.method === 'initialize') return ok({ protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'probe', version: '1' } });
      if (m.method === 'tools/list') return ok({ tools: [{ name: 'echo', description: 'echo', inputSchema: { type: 'object' } }] });
      if (m.method === 'tools/call') return ok({ content: [{ type: 'text', text: `echo:${JSON.stringify(m.params?.arguments ?? {})}` }] });
      res.writeHead(202); res.end();
    });
    return;
  }
  res.writeHead(404); res.end();
});

// ─── what to call, per package ───────────────────────────────────────────────────────────────
const calls = (port) => ({
  'sequential-thinking': { name: 'sequentialthinking', args: { thought: 'Stage B probe', nextThoughtNeeded: false, thoughtNumber: 1, totalThoughts: 1 } },
  time: { name: 'get_current_time', args: { timezone: 'UTC' } },
  // the fetch server refuses loopback and private addresses (it is an SSRF guard), so this one goes to a public example page
  fetch: { name: 'fetch', args: { url: 'https://example.com/' }, network: 'example.com (IANA example domain)' },
  context7: { name: 'resolve-library-id', args: { libraryName: 'react', query: 'react hooks' }, network: 'context7 public service' },
  filesystem: { name: 'read_text_file', args: { path: path.join(workspace, 'hello.txt') } },
  git: { name: 'git_status', args: { repo_path: workspace } },
  playwright: { name: 'browser_navigate', args: { url: `http://127.0.0.1:${port}/page` }, expect: 'browser' },
  notion: { name: 'API-get-self', args: {}, expect: 'fake-credential', network: 'api.notion.com, with a fake token' },
  'brave-search': { name: 'brave_web_search', args: { query: 'stage b probe' }, expect: 'fake-credential', network: 'api.search.brave.com, with a fake key' }
});

const textOf = (r) => (r?.result?.content ?? []).map((c) => c.text ?? '').join(' ').replace(/\s+/g, ' ').trim();

async function drive(host, id, agent, call) {
  const post = async (body) => { const r = await host.handle(id, agent, JSON.stringify(body)); return { status: r.status, json: r.body ? JSON.parse(r.body) : undefined }; };
  const t0 = Date.now();
  const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'stage-b-probe', version: '1' } } });
  if (!init.json?.result) return { stage: 'start', error: init.json?.error?.message ?? `status ${init.status}`, ms: Date.now() - t0 };
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const tools = [];
  let cursor;
  for (let page = 0; page < 10; page++) {
    const l = await post({ jsonrpc: '2.0', id: 2 + page, method: 'tools/list', ...(cursor ? { params: { cursor } } : {}) });
    if (!l.json?.result) return { stage: 'list', error: l.json?.error?.message ?? 'no result', ms: Date.now() - t0 };
    tools.push(...l.json.result.tools);
    cursor = l.json.result.nextCursor;
    if (!cursor) break;
  }
  const out = { server: init.json.result.serverInfo, tools: tools.map((t) => ({ name: t.name, annotations: t.annotations })), startMs: Date.now() - t0 };
  if (!call) return { ...out, stage: 'listed' };
  const t1 = Date.now();
  const named = tools.find((t) => t.name === call.name);
  if (!named) return { ...out, stage: 'call', error: `tool ${call.name} is not offered`, ms: Date.now() - t0 };
  const c = await post({ jsonrpc: '2.0', id: 99, method: 'tools/call', params: { name: call.name, arguments: call.args } });
  return { ...out, stage: 'called', callMs: Date.now() - t1, rpcError: c.json?.error?.message, isError: c.json?.result?.isError === true, text: textOf(c.json).slice(0, 240) };
}

(async () => {
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port;
  fs.writeFileSync(path.join(workspace, 'hello.txt'), 'hello from the workspace\n');
  try {
    execFileSync('git', ['init', '-q'], { cwd: workspace });
    execFileSync('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=probe', 'add', '.'], { cwd: workspace });
    execFileSync('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=probe', 'commit', '-q', '-m', 'init'], { cwd: workspace });
  } catch { /* git status will say so */ }

  const store = new PackageStore({ root: storeRoot, locksRoot: path.join(__dirname, '..', 'resources', 'mcp-locks'), which, env: () => serverBaseEnv(process.env, PATHV) });
  const plan = calls(port);
  const results = [];
  const targets = [...MCP_CATALOG.filter((e) => e.spec.transport === undefined || e.spec.transport === 'stdio').map((e) => ({ id: e.id, entry: e, pkg: e.spec.package })), { id: 'mcp-remote', entry: null, pkg: MCP_REMOTE_PACKAGE_SPEC }];
  const version = (cmd, a) => { try { return spawnSync(cmd, a, { encoding: 'utf8', env: { PATH: PATHV } }).stdout.trim().split('\n')[0]; } catch { return 'n/a'; } };
  console.log(`node ${version(nodePath, ['-v'])} (${nodePath}) · npm ${version(which('npm') ?? 'npm', ['-v'])} · ${version(which('uv') ?? 'uv', ['--version'])} · ${process.platform}/${process.arch}\n`);

  for (const t of targets) {
    if (only.length && !only.includes(t.id)) continue;
    const row = { id: t.id, package: `${t.pkg.name}@${t.pkg.version}`, manager: t.pkg.manager };
    const t0 = Date.now();
    const ensured = await store.ensure(t.id, t.pkg);
    row.install = ensured.ok ? 'ok' : `FAILED: ${ensured.error}`;
    row.installMs = Date.now() - t0;
    if (!ensured.ok) { row.verdict = 'FAIL'; results.push(row); console.log(`✗ ${t.id}: install ${row.install}`); continue; }
    const installed = store.readyLaunch(t.id, t.pkg);
    if (!installed) { row.verdict = 'FAIL'; row.install = 'installed but not launchable'; results.push(row); console.log(`✗ ${t.id}: not launchable`); continue; }

    let launch;
    if (t.entry) {
      // the environment has no credential; it goes down a private pipe and is set inside the server
      const env = localServerEnv(t.entry, process.env, PATHV);
      const secrets = localServerSecrets(t.entry, FAKE[t.id]);
      launch = resolveLaunch(t.entry, installed, workspace, env, secrets);
      if (!launch) { row.verdict = 'FAIL'; row.install = 'could not build a launch'; results.push(row); console.log(`✗ ${t.id}: no launch`); continue; }
    } else {
      launch = { command: installed.command, args: [...installed.args, `http://127.0.0.1:${port}/mcp`, '--transport', 'http-only', '--allow-http', '--host', '127.0.0.1'], env: serverBaseEnv(process.env, PATHV), cwd: workspace, roots: [] };
    }
    const host = new StdioHost({ launch: () => launch, limits: { requestMs: 90_000 } });
    const call = t.entry ? plan[t.id] : { name: 'echo', args: { via: 'mcp-remote' } };
    const r = await drive(host, t.id, 'probe-agent', call);
    // the child must be a child of THIS process (the app), not of anything an agent started
    row.childPids = host.running().length;
    host.closeAll();
    Object.assign(row, r);
    if (snapshot && t.entry && r.tools) {
      fs.writeFileSync(path.join(__dirname, '..', 'resources', 'mcp-locks', t.id, 'tools.json'), JSON.stringify({
        package: t.pkg.name, version: t.pkg.version, listedWith: 'tools/list through the app-run host', tools: r.tools
      }, null, 2) + '\n');
    }
    // verdict
    const expect = call?.expect;
    if (r.stage !== 'called') row.verdict = 'FAIL';
    else if (expect === 'fake-credential') {
      // some servers return the provider's refusal as ordinary content rather than as an error
      const refused = r.isError || r.rpcError || /\b(401|403|422)\b|unauthori[sz]ed|invalid|forbidden/i.test(r.text || '');
      row.verdict = refused ? 'LIMITED: reached the provider with a fake credential and was refused; no real account was used' : 'UNEXPECTED: a fake credential was accepted';
    }
    else if (expect === 'browser') row.verdict = (r.isError || r.rpcError) ? `LIMITED: the call reached the server but no page opened (${(r.text || r.rpcError || '').slice(0, 120)})` : 'PASS';
    else row.verdict = (r.isError || r.rpcError) ? `FAIL: ${r.rpcError || r.text}` : 'PASS';
    results.push(row);
    console.log(`${row.verdict.startsWith('PASS') ? '✓' : row.verdict.startsWith('LIMITED') ? '~' : '✗'} ${t.id.padEnd(20)} install ${row.install} (${row.installMs} ms) · ${row.tools?.length ?? 0} tools · ${call?.name} → ${row.verdict}`);
  }
  probe.close();
  const summary = { at: new Date().toISOString(), node: version(nodePath, ['-v']), npm: version(which('npm') ?? 'npm', ['-v']), uv: version(which('uv') ?? 'uv', ['--version']), platform: `${process.platform}/${process.arch}`, results };
  if (evidencePath) { fs.mkdirSync(path.dirname(path.resolve(evidencePath)), { recursive: true }); fs.writeFileSync(evidencePath, JSON.stringify(summary, null, 2)); }
  if (!keep) fs.rmSync(root, { recursive: true, force: true });
  const bad = results.filter((r) => r.verdict === 'FAIL' || r.verdict?.startsWith('FAIL') || r.verdict?.startsWith('UNEXPECTED'));
  console.log(`\n${results.length - bad.length}/${results.length} as expected${bad.length ? `, ${bad.length} FAILED` : ''}`);
  process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.error('verifier crashed:', e); try { probe.close(); } catch { /* */ } process.exit(2); });
