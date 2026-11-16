'use strict';

/**
 * Live MCP verification — runs real Claude Code sessions.
 *
 * test/mcp-config-wiring.test.cjs pins the files we write. It cannot tell you
 * whether Claude Code agrees with them, because it never starts Claude Code.
 * This does: it generates a real agent directory with HiveManager, launches
 * `claude -p` against it, and reads the CLI's own `system`/`init` event to see
 * which MCP servers actually connected, then asks for a real tool call.
 *
 *   node tools/verify-mcp-live.cjs
 *
 * It needs: the `claude` CLI signed in, network access (servers are fetched by
 * npx/uvx on first run), and a few minutes. It is deliberately NOT part of
 * `npm run test:focused` — that suite must stay offline and fast.
 *
 * Nothing here writes to your real ~/.claude: every agent is generated under a
 * throwaway home directory that is removed at the end.
 *
 * RETIRED (Stage B). This checked the earlier design, in which the agent's own config carried each
 * server's command and credential and the CLI launched them, and in which six servers were on by
 * default. Stage B removed all three, so every check below that asserts them would now FAIL for the
 * right reason. It is kept, unchanged apart from this notice, so the history of what was verified
 * before is not lost. Use instead:
 *
 *   node tools/verify-stage-b-live.cjs     a real `claude` CLI through the broker, with leak checks
 *   node tools/verify-packages-live.cjs    every pinned package: install, start, tools, a real call
 */
console.error('tools/verify-mcp-live.cjs is retired: it verified the pre-Stage-B design (see its header).\n'
  + 'Run `node tools/verify-stage-b-live.cjs` and `node tools/verify-packages-live.cjs` instead.');
process.exit(2);

const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../test/load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');
const { MCP_CATALOG } = loadTs('src/shared/mcpCatalog.ts');

// A credential that is obviously not real, so we can also prove it never
// reaches stdout, stderr or the transcript.
const FAKE_TOKEN = 'ntn_MOSBIUS_LIVE_CHECK_0000';

const results = [];
const record = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '\n      ' + detail : ''}`);
};

function claudeVersion() {
  try {
    return execFileSync('claude', ['--version'], { encoding: 'utf8' }).trim();
  } catch {
    console.error('`claude` is not on PATH. Install Claude Code and sign in, then re-run.');
    process.exit(2);
  }
}

/** Generate a real agent directory and return what the app would spawn. */
async function makeAgent(home, id, opts) {
  const hive = new HiveManager(() => home);
  const inj = await hive.ensureAgent(
    { id, name: id, provider: 'claude', cwd: path.join(home, 'work') },
    opts
  );
  return { inj, dir: path.join(home, 'hive/agents', id) };
}

/**
 * Run one short prompt through Claude Code with the generated config and
 * return every stream-json event, plus the raw text we saw.
 */
function runClaude(configPath, prompt, extraArgs) {
  const args = [
    '-p', prompt,
    '--mcp-config', configPath,
    '--strict-mcp-config',          // ignore the developer's own servers
    '--output-format', 'stream-json',
    '--verbose',
    ...(extraArgs || []),
  ];
  const out = spawnSync('claude', args, {
    encoding: 'utf8',
    timeout: 240000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const raw = (out.stdout || '') + (out.stderr || '');
  const events = [];
  for (const line of (out.stdout || '').split('\n')) {
    const s = line.trim();
    if (!s.startsWith('{')) continue;
    try { events.push(JSON.parse(s)); } catch { /* partial line */ }
  }
  return { events, raw, status: out.status, error: out.error };
}

const initEvent = (events) => events.find((e) => e.type === 'system' && e.subtype === 'init');
const serverNames = (events) => {
  const init = initEvent(events);
  if (!init || !Array.isArray(init.mcp_servers)) return null;
  return init.mcp_servers.map((s) => s.name).sort();
};
const connected = (events) => {
  const init = initEvent(events);
  if (!init || !Array.isArray(init.mcp_servers)) return [];
  return init.mcp_servers.filter((s) => s.status === 'connected').map((s) => s.name).sort();
};

async function main() {
  const version = claudeVersion();
  console.log(`claude ${version}`);
  console.log(`node ${process.version}\n`);

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mosbius-live-'));
  fs.mkdirSync(path.join(home, 'work'), { recursive: true });
  // Give the workspace a git repo so the git server has something to look at.
  spawnSync('git', ['init', '-q'], { cwd: path.join(home, 'work') });
  fs.writeFileSync(path.join(home, 'work', 'README.md'), '# live check\n');

  try {
    // ── agent A: the defaults, plus a secret-tier server WITH a credential,
    //    plus a secret-tier server WITHOUT one.
    const a = await makeAgent(home, 'agent-a', {
      mcpDefaults: { notion: { enabled: true }, github: { enabled: true } },
      mcpSecret: (id) => (id === 'notion' ? FAKE_TOKEN : undefined),
    });

    const settings = JSON.parse(fs.readFileSync(path.join(a.dir, 'settings.json'), 'utf8'));
    record(
      'the settings file carries no mcpServers key',
      !('mcpServers' in settings),
      'Claude Code ignores that key; this is the bug the fix was for.'
    );

    const cfgPath = path.join(a.dir, 'mcp-config.json');
    const flagIdx = a.inj.args.indexOf('--mcp-config');
    record(
      'the spawn command passes --mcp-config',
      flagIdx !== -1 && a.inj.args[flagIdx + 1] === cfgPath,
      a.inj.args.slice(Math.max(0, flagIdx - 1), flagIdx + 2).join(' ')
    );

    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const declared = Object.keys(cfg.mcpServers).sort();
    console.log(`\n  declared: ${declared.join(', ')}\n`);

    record(
      'a consented secret-tier server with no credential is not declared',
      !declared.includes('mosbius-github'),
      'github was switched on but no token is stored, so it is left out entirely.'
    );
    record(
      'a consented secret-tier server WITH a credential is declared',
      declared.includes('mosbius-notion'),
      'notion carries the stored credential.'
    );

    // ── live run 1: which servers does Claude Code actually load?
    console.log('  starting a real session (first run downloads the servers)...');
    const r1 = runClaude(cfgPath, 'Reply with the single word: ready', []);
    const names = serverNames(r1.events);
    if (!names) {
      record('Claude Code reports its MCP servers', false,
        'no system/init event. exit=' + r1.status + '\n' + r1.raw.slice(0, 600));
    } else {
      record('Claude Code reports its MCP servers', true, names.join(', '));
      record(
        'every declared server is the one we wrote, namespaced',
        names.every((n) => n.startsWith('mosbius-')) && names.length === declared.length,
        `expected ${declared.length} (${declared.join(', ')}), got ${names.length}`
      );
      const ok = connected(r1.events);
      record(
        'the default servers connect',
        ok.length >= 4,
        `connected: ${ok.join(', ') || 'none'}`
      );
    }

    // ── live run 2: a real tool call through one of them.
    console.log('\n  asking for a real tool call...');
    const r2 = runClaude(
      cfgPath,
      'Use the time tool to get the current time in UTC. Then reply with just that timestamp.',
      ['--allowedTools', 'mcp__mosbius-time__get_current_time']
    );
    const toolUses = [];
    for (const ev of r2.events) {
      const content = ev.message && ev.message.content;
      if (!Array.isArray(content)) continue;
      for (const c of content) if (c.type === 'tool_use') toolUses.push(c.name);
    }
    record(
      'a real MCP tool call succeeds',
      toolUses.some((n) => n.startsWith('mcp__mosbius-')),
      toolUses.length ? 'tools used: ' + [...new Set(toolUses)].join(', ') : 'no tool_use in the transcript'
    );

    // ── credentials must not appear anywhere we can see.
    const leaked = r1.raw.includes(FAKE_TOKEN) || r2.raw.includes(FAKE_TOKEN);
    record(
      'the stored credential never appears in terminal output',
      !leaked,
      leaked ? 'the token was printed — fix before shipping' : 'searched stdout and stderr of both runs'
    );

    const mode = fs.statSync(cfgPath).mode & 0o777;
    record('the config file holding it is owner-only', mode === 0o600, '0' + mode.toString(8));

    // ── agent B: a different worker, a different set of capabilities.
    const off = Object.fromEntries(
      MCP_CATALOG.filter((e) => e.defaultEnabled && e.id !== 'sequential-thinking')
        .map((e) => [e.id, { enabled: false }])
    );
    const b = await makeAgent(home, 'agent-b', { mcpDefaults: off });
    const bCfg = JSON.parse(fs.readFileSync(path.join(b.dir, 'mcp-config.json'), 'utf8'));
    const bDeclared = Object.keys(bCfg.mcpServers);

    console.log('\n  starting a second worker with almost everything switched off...');
    const r3 = runClaude(path.join(b.dir, 'mcp-config.json'), 'Reply with the single word: ready', []);
    const bNames = serverNames(r3.events) || [];
    record(
      'a second worker gets only its own capabilities',
      bDeclared.length === 1 && bNames.length === bDeclared.length && bNames[0] === bDeclared[0],
      `worker A: ${declared.length} servers · worker B: ${bNames.join(', ') || 'none'}`
    );
    record(
      'servers switched off are not loaded',
      !bNames.includes('mosbius-filesystem') && !bNames.includes('mosbius-git'),
      'filesystem and git were disabled for worker B and did not appear'
    );
    record(
      'worker B never sees worker A\'s credential',
      !JSON.stringify(bCfg).includes(FAKE_TOKEN) && !r3.raw.includes(FAKE_TOKEN),
      'checked worker B\'s config and its session output'
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
