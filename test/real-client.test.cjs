'use strict';

/**
 * REAL CLIENT CHECK. The installed `claude` CLI, given the MCP config the app writes for an
 * agent, talks to the broker in front of a STAND-IN OAuth provider and a STAND-IN MCP server.
 * Nothing here touches Google or Slack.
 *
 * It is OFF unless `MD_REAL_CLAUDE=1`, because the second half asks a model to use two tools
 * (a few cents of the user's own Claude usage). Run it with:
 *
 *   MD_REAL_CLAUDE=1 npm run test:real-client
 *
 * What it shows, through a real MCP client rather than a test one:
 *   1. the broker's Streamable HTTP behaviour is accepted: the server connects, with the
 *      capability in an Authorization header and no OAuth of its own started by the CLI;
 *   2. the tool list the CLI sees is the FILTERED one;
 *   3. a granted call works, an ungranted one comes back as the broker's refusal;
 *   4. the upstream only ever saw the engine's token, and no output of the CLI holds a secret.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { assemble, until, startOauthMcpServer } = require('./fixtures/phase3-env.cjs');

const ENABLED = process.env.MD_REAL_CLAUDE === '1';
const CLAUDE = process.env.MD_CLAUDE_BIN || 'claude';
const skip = ENABLED ? false : 'set MD_REAL_CLAUDE=1 to run the installed claude CLI against the broker';

const TOOLS = [
  { name: 'search', description: 'Search the mailbox.', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'send', description: 'Send a message.', inputSchema: { type: 'object', properties: { to: { type: 'string' } }, required: ['to'] } }
];
const SERVER = 'mosbius-gmail';

/** Run the CLI, handing each stream-json line to `onLine`. Resolves with everything it printed. */
function runClaude(args, { cwd, onLine, timeoutMs = 150_000 }) {
  return new Promise((resolve) => {
    const child = spawn(CLAUDE, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } });
    let out = ''; let err = ''; let buf = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => {
      out += d; buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let json; try { json = JSON.parse(line); } catch { continue; }
        try { onLine(json, child); } catch (e) { err += `\n[handler] ${e.message}`; }
      }
    });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

test('REAL CLIENT: the CLI connects, sees only the filtered tools, is refused what is not granted, and nothing secret is printed', { skip, timeout: 240_000 }, async (t) => {
  const v = spawnSync(CLAUDE, ['--version'], { encoding: 'utf8' });
  assert.equal(v.status, 0, `the claude CLI is not usable here: ${v.stderr || v.error}`);
  t.diagnostic(`claude ${v.stdout.trim()}`);

  // the stand-in provider and the app's whole assembly; the stand-in MCP server checks the bearer
  // against that same provider, and is what the broker's route forwards to
  let mcp;
  const c = await assemble(t, {
    grants: { defaults: { gmail: { preset: 'custom', allow: ['search', 'send'] } } },
    upstreamUrl: () => mcp.url
  });
  mcp = await startOauthMcpServer(t, c.idp, { tools: TOOLS });
  await c.signIn();
  const { file, token } = await c.spawn('agent-A');

  // the app's own file, trimmed to the one server under test (the rest are npx servers)
  const full = JSON.parse(fs.readFileSync(file, 'utf8'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mosbius-real-client-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const trimmed = path.join(cwd, 'mcp.json');
  fs.writeFileSync(trimmed, JSON.stringify({ mcpServers: { [SERVER]: full.mcpServers[SERVER] } }), { mode: 0o600 });

  const prompt = [
    `Use the tool mcp__${SERVER}__send with to="a@example.com" and tell me, word for word, the error or the result it gives back.`,
    `Then use mcp__${SERVER}__search with query="hello" and tell me, word for word, the result.`,
    'Do not use any other tool. Keep your answer under 60 words.'
  ].join(' ');
  const args = [
    '-p', prompt, '--mcp-config', trimmed, '--strict-mcp-config', '--output-format', 'stream-json', '--verbose',
    '--max-turns', '5', '--model', process.env.MD_CLAUDE_MODEL || 'haiku', '--tools', '',
    '--allowedTools', `mcp__${SERVER}__search`, `mcp__${SERVER}__send`, '--no-session-persistence'
  ];

  const events = [];
  let init;
  const run = await runClaude(args, {
    cwd,
    onLine: (e) => {
      events.push(e);
      if (e.type === 'system' && e.subtype === 'init' && !init) {
        init = e;
        // The CLI has listed the tools it was offered. NARROW the grant now, while the client still
        // believes `send` exists: the next `send` it attempts must be refused by the broker.
        c.cfg.mcpGrants = { defaults: { gmail: { preset: 'custom', allow: ['search'] } } };
      }
    }
  });
  const printed = run.out + run.err;
  t.diagnostic(`exit ${run.code}; ${events.length} events; init=${!!init}`);

  if (!init) {
    const why = (run.err || run.out).split('\n').slice(0, 3).join(' | ').slice(0, 300);
    assert.fail(`the CLI never reported its init event: ${why}`);
  }

  // 1. the server connected, with no OAuth of the CLI's own
  const server = (init.mcp_servers ?? []).find((s) => s.name === SERVER);
  assert.ok(server, `the init event lists no ${SERVER}: ${JSON.stringify(init.mcp_servers)}`);
  assert.equal(server.status, 'connected', `the server is ${server.status}`);
  assert.equal(JSON.stringify(init.mcp_servers).includes('needs-auth'), false);

  // 2. the tool list the CLI saw is what the broker let through at that moment
  const mcpTools = (init.tools ?? []).filter((x) => x.startsWith(`mcp__${SERVER}__`)).sort();
  assert.deepEqual(mcpTools, [`mcp__${SERVER}__search`, `mcp__${SERVER}__send`]);

  // 3. what happened to the calls: `send` was refused by the BROKER, `search` went through
  const uses = events.filter((e) => e.type === 'assistant').flatMap((e) => e.message.content).filter((b) => b.type === 'tool_use');
  const results = events.filter((e) => e.type === 'user').flatMap((e) => (Array.isArray(e.message.content) ? e.message.content : [])).filter((b) => b.type === 'tool_result');
  const textOf = (r) => (Array.isArray(r.content) ? r.content.map((x) => x.text ?? '').join('') : String(r.content ?? ''));
  const sendUse = uses.find((u) => u.name === `mcp__${SERVER}__send`);
  const searchUse = uses.find((u) => u.name === `mcp__${SERVER}__search`);
  assert.ok(sendUse, `the model never attempted send. tool uses: ${uses.map((u) => u.name)}`);
  assert.ok(searchUse, `the model never attempted search. tool uses: ${uses.map((u) => u.name)}`);
  const sendResult = results.find((r) => r.tool_use_id === sendUse.id);
  const searchResult = results.find((r) => r.tool_use_id === searchUse.id);
  assert.ok(sendResult && textOf(sendResult).includes('Not permitted'), `send was not refused by the broker: ${sendResult && textOf(sendResult)}`);
  assert.ok(searchResult && textOf(searchResult).includes('called search'), `search did not go through: ${searchResult && textOf(searchResult)}`);

  // 4. what the upstream saw, and what the CLI printed
  const calls = mcp.seen.filter((r) => r.rpc?.method === 'tools/call').map((r) => r.rpc.params.name);
  assert.deepEqual(calls, ['search'], 'the refused call never went upstream');
  const auths = new Set(mcp.seen.map((r) => r.headers.authorization));
  assert.equal(auths.has(`Bearer ${token}`), false, 'the capability never went upstream');
  const rec = c.record();
  for (const secret of [token, rec.accessToken, rec.refreshToken, c.env.secrets.map.get('mcp:gmail:client_secret')]) {
    assert.equal(printed.includes(secret), false, 'the CLI printed a secret');
  }
  t.diagnostic(`the CLI saw: ${JSON.stringify(mcpTools)}; upstream calls: ${JSON.stringify(calls)}; tool uses: ${uses.map((u) => u.name)}`);
});

test('REAL CLIENT: a tool list the server STREAMS is filtered and handed on as a stream the CLI accepts (no model call is made)', { skip, timeout: 120_000 }, async (t) => {
  let mcp;
  const c = await assemble(t, {
    grants: { defaults: { gmail: { preset: 'custom', allow: ['search'] } } },
    upstreamUrl: () => mcp.url
  });
  mcp = await startOauthMcpServer(t, c.idp, { tools: TOOLS, listAsStream: true });
  await c.signIn();
  const { file } = await c.spawn('agent-A');
  const full = JSON.parse(fs.readFileSync(file, 'utf8'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mosbius-real-client-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const trimmed = path.join(cwd, 'mcp.json');
  fs.writeFileSync(trimmed, JSON.stringify({ mcpServers: { [SERVER]: full.mcpServers[SERVER] } }), { mode: 0o600 });

  let init;
  await runClaude([
    '-p', 'hello', '--mcp-config', trimmed, '--strict-mcp-config', '--output-format', 'stream-json', '--verbose',
    '--max-turns', '1', '--model', process.env.MD_CLAUDE_MODEL || 'haiku', '--tools', '', '--no-session-persistence'
  ], {
    cwd, timeoutMs: 60_000,
    // the init event is printed before any request to a model: stop the CLI there
    onLine: (e, child) => { if (e.type === 'system' && e.subtype === 'init' && !init) { init = e; child.kill('SIGTERM'); } }
  });
  assert.ok(init, 'the CLI never reported its init event');
  const server = (init.mcp_servers ?? []).find((s) => s.name === SERVER);
  assert.equal(server?.status, 'connected');
  assert.deepEqual((init.tools ?? []).filter((x) => x.startsWith(`mcp__${SERVER}__`)), [`mcp__${SERVER}__search`], 'the streamed list was filtered: `send` is not there');
  assert.ok(mcp.seen.some((r) => r.rpc?.method === 'tools/list'));
});
