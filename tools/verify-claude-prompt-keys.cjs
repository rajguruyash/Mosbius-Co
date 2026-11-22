#!/usr/bin/env node
'use strict';

/**
 * Do the keys the app sends to answer a permission prompt work in the REAL `claude` terminal interface?
 *
 *   node tools/verify-claude-prompt-keys.cjs [--out evidence/huddle] [--claude claude] [--only approve,reject]
 *
 * What runs for real: the `claude` CLI on this machine, in a real pseudo-terminal (node-pty), showing its own permission
 * prompt. The keys are the app's own (src/shared/promptKeys.ts), sent one press at a time, a moment apart, as the app sends
 * them. The prompt is read back from a small terminal emulator that follows the CLI's own cursor movements, so what is
 * recorded is what a person would have seen on screen.
 *
 * What does NOT: the model. It is a stand-in on a loopback port that speaks just enough of the Messages API to ask for one
 * tool call (a Bash `touch`, or a file write) and to record what came back. The CLI is started with `--bare` (it never reads
 * the keychain or an OAuth login), a throwaway HOME and a made-up key, so no account is used and nothing leaves this
 * machine. This proves how the real prompt reacts to the keys; it does not prove what a real model will ask for.
 *
 * Cases (each in a fresh folder, so a file that was or was not made is the proof of what the prompt did):
 *   approve         Enter                          the command runs
 *   reject          Escape                         the command does not run
 *   option-2/3/4    Down x n, Enter                the n-th menu entry is taken; its label is read from the screen, and the
 *                                                  outcome has to be the one that label promises (a "Yes..." runs the command,
 *                                                  a "No" does not; "don't ask again" must also leave a saved rule)
 *   alternative     Escape, then a typed line      the command does not run, and the typed instruction reaches the model
 *   write-approve   Enter                          the same for a file-write prompt (a different menu)
 *   write-reject    Escape
 *
 * Exit code: 0 when every case passed, 1 on any failure, 2 when `claude` or node-pty is unavailable.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const OUT = path.resolve(flag('--out', path.join(ROOT, 'evidence', 'huddle')));
const CLAUDE = flag('--claude', 'claude');
const ONLY = flag('--only') ? new Set(flag('--only').split(',')) : null;

let pty;
try { pty = require('node-pty'); } catch (e) { console.error(`BLOCKED: node-pty does not load under this Node (${e.message})`); process.exit(2); }
let version;
try { version = execFileSync(CLAUDE, ['--version'], { encoding: 'utf8' }).trim(); } catch { console.error('BLOCKED: `claude` is not on PATH'); process.exit(2); }

const loadTs = require('../test/load-ts.cjs');
const keys = loadTs('src/shared/promptKeys.ts');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch (e) { if (/exited/.test(String(e && e.message))) throw e; } await sleep(100); }
  throw new Error(`timed out waiting for ${what}`);
}

// ── a small terminal screen: enough of VT100 to follow an Ink-style interface ────────────────────
class MiniScreen {
  constructor(cols, rows) { this.cols = cols; this.rows = rows; this.grid = this.blank(); this.x = 0; this.y = 0; this.buf = null; this.saved = [0, 0]; }
  blank() { return Array.from({ length: this.rows }, () => Array(this.cols).fill(' ')); }
  line() { return Array(this.cols).fill(' '); }
  scrollUp() { this.grid.shift(); this.grid.push(this.line()); }
  lf() { if (this.y === this.rows - 1) this.scrollUp(); else this.y++; }
  put(ch) { if (this.x >= this.cols) { this.x = 0; this.lf(); } this.grid[this.y][this.x++] = ch; }
  clear(r, from, to) { for (let c = from; c < to; c++) this.grid[r][c] = ' '; }
  feed(s) {
    for (const ch of s) {
      if (this.buf !== null) {
        this.buf += ch;
        const b = this.buf;
        if (b[0] === '[') { if (b.length > 1 && /[@-~]/.test(ch)) { this.csi(b.slice(1)); this.buf = null; } }
        else if (b[0] === ']') { if (ch === '\u0007' || b.endsWith('\u001b\\')) this.buf = null; }
        else if ('()*+'.includes(b[0])) { if (b.length === 2) this.buf = null; }
        else { this.esc(b); this.buf = null; }
        continue;
      }
      if (ch === '\u001b') { this.buf = ''; continue; }
      if (ch === '\r') this.x = 0;
      else if (ch === '\n') this.lf();
      else if (ch === '\b') this.x = Math.max(0, this.x - 1);
      else if (ch === '\t') this.x = Math.min(this.cols - 1, (Math.floor(this.x / 8) + 1) * 8);
      else if (ch < ' ' || ch === '\u007f') { /* other controls: no text */ }
      else this.put(ch);
    }
  }
  esc(b) {
    if (b === '7') this.saved = [this.x, this.y];
    else if (b === '8') [this.x, this.y] = this.saved;
    else if (b === 'D') this.lf();
    else if (b === 'E') { this.x = 0; this.lf(); }
    else if (b === 'M') { if (this.y === 0) { this.grid.pop(); this.grid.unshift(this.line()); } else this.y--; }
    else if (b === 'c') { this.grid = this.blank(); this.x = 0; this.y = 0; }
  }
  csi(seq) {
    const final = seq[seq.length - 1];
    const raw = seq.slice(0, -1);
    if (/^[?<=>]/.test(raw)) return; // modes (paste, cursor, alternate screen...): no text
    const nums = raw.split(';').map((n) => (n === '' ? null : Number(n)));
    const n = (d) => (nums[0] == null || Number.isNaN(nums[0]) ? d : nums[0]);
    const R = this.rows; const C = this.cols;
    switch (final) {
      case 'A': this.y = Math.max(0, this.y - n(1)); break;
      case 'B': this.y = Math.min(R - 1, this.y + n(1)); break;
      case 'C': this.x = Math.min(C - 1, this.x + n(1)); break;
      case 'D': this.x = Math.max(0, this.x - n(1)); break;
      case 'E': this.y = Math.min(R - 1, this.y + n(1)); this.x = 0; break;
      case 'F': this.y = Math.max(0, this.y - n(1)); this.x = 0; break;
      case 'G': this.x = Math.min(C - 1, Math.max(0, n(1) - 1)); break;
      case 'd': this.y = Math.min(R - 1, Math.max(0, n(1) - 1)); break;
      case 'H': case 'f': this.y = Math.min(R - 1, Math.max(0, (nums[0] ?? 1) - 1)); this.x = Math.min(C - 1, Math.max(0, (nums[1] ?? 1) - 1)); break;
      case 'J': {
        const m = nums[0] ?? 0;
        if (m === 2 || m === 3) { this.grid = this.blank(); }
        else if (m === 0) { this.clear(this.y, this.x, C); for (let r = this.y + 1; r < R; r++) this.clear(r, 0, C); }
        else if (m === 1) { for (let r = 0; r < this.y; r++) this.clear(r, 0, C); this.clear(this.y, 0, this.x + 1); }
        break;
      }
      case 'K': { const m = nums[0] ?? 0; if (m === 0) this.clear(this.y, this.x, C); else if (m === 1) this.clear(this.y, 0, this.x + 1); else this.clear(this.y, 0, C); break; }
      case 'X': this.clear(this.y, this.x, Math.min(C, this.x + n(1))); break;
      case 'P': { const row = this.grid[this.y]; row.splice(this.x, n(1)); while (row.length < C) row.push(' '); break; }
      case '@': { const row = this.grid[this.y]; row.splice(this.x, 0, ...Array(n(1)).fill(' ')); row.length = C; break; }
      case 'L': for (let i = 0; i < n(1); i++) { this.grid.splice(this.y, 0, this.line()); this.grid.pop(); } break;
      case 'M': for (let i = 0; i < n(1); i++) { this.grid.splice(this.y, 1); this.grid.push(this.line()); } break;
      case 'S': for (let i = 0; i < n(1); i++) this.scrollUp(); break;
      case 'T': for (let i = 0; i < n(1); i++) { this.grid.pop(); this.grid.unshift(this.line()); } break;
      case 's': this.saved = [this.x, this.y]; break;
      case 'u': [this.x, this.y] = this.saved; break;
      default: break; // colours, scroll regions, reports: no effect on the text
    }
  }
  lines() { return this.grid.map((r) => r.join('').replace(/\s+$/, '')); }
  text() { return this.lines().join('\n'); }
}
const norm = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase();

// ── the stand-in model ──────────────────────────────────────────────────────────────────────
const ASK = 'Please create the marker file now';
const FAKE_KEY = 'standin-not-a-real-key-loopback-only';

function startStandIn() {
  const st = { tool: 'bash', toolUsed: '', toolNames: [], project: '', asked: false, mainCalls: 0, toolResults: [], userTexts: [], paths: [] };
  const sse = (res, events) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    for (const [name, data] of events) res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
    res.end();
  };
  const head = (model) => ({ type: 'message_start', message: { id: 'msg_standin', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
  const textEvents = (model, text) => [
    ['message_start', head(model)],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }],
    ['message_stop', { type: 'message_stop' }]
  ];
  const toolEvents = (model) => {
    // a file prompt: the Write tool when this CLI offers it, else Edit on a file the case made beforehand
    const write = st.tool === 'write';
    const name = !write ? 'Bash' : st.toolNames.includes('Write') ? 'Write' : 'Edit';
    const input = !write ? { command: 'touch marker.txt', description: 'Create the marker file' }
      : name === 'Write' ? { file_path: path.join(st.project, 'marker.txt'), content: 'marker\n' }
        : { file_path: path.join(st.project, 'edit.txt'), old_string: 'before', new_string: 'after' };
    st.toolUsed = name;
    return [
      ['message_start', head(model)],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_standin01', name, input: {} } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 20 } }],
      ['message_stop', { type: 'message_stop' }]
    ];
  };
  const flat = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => (b && b.text) || '').join(' ') : '');

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { /* not json */ }
      const url = (req.url || '').split('?')[0];
      st.paths.push(`${req.method} ${url}`);
      if (req.method === 'POST' && url === '/v1/messages') {
        const model = typeof body.model === 'string' ? body.model : 'stand-in';
        const msgs = Array.isArray(body.messages) ? body.messages : [];
        const allBlocks = msgs.flatMap((m) => (Array.isArray(m.content) ? m.content : typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : []));
        const isMain = Array.isArray(body.tools) && body.tools.some((t) => t && t.name === 'Bash');
        const hasAsk = allBlocks.some((b) => b && b.type === 'text' && typeof b.text === 'string' && b.text.includes(ASK));
        let reply;
        if (isMain) st.toolNames = body.tools.map((t) => t && t.name).filter(Boolean);
        if (isMain && hasAsk && !st.asked) { st.asked = true; reply = toolEvents(model); }
        else reply = textEvents(model, isMain ? 'Done.' : 'ok');
        if (isMain) {
          st.mainCalls++;
          const last = msgs[msgs.length - 1];
          const lastBlocks = last && Array.isArray(last.content) ? last.content : [];
          for (const b of lastBlocks) {
            if (b && b.type === 'tool_result') st.toolResults.push({ is_error: !!b.is_error, content: flat(b.content).slice(0, 200) });
            else if (b && b.type === 'text' && typeof b.text === 'string') st.userTexts.push(b.text.slice(0, 200));
          }
        }
        if (body.stream === true) return sse(res, reply);
        const text = reply.filter((e) => e[0] === 'content_block_delta').map((e) => e[1].delta.text || '').join('');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'msg_standin', type: 'message', role: 'assistant', model, content: [{ type: 'text', text: text || 'ok' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } }));
        return;
      }
      if (req.method === 'POST' && url === '/v1/messages/count_tokens') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ input_tokens: 100 })); return; }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'stand-in: no such route' } }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, st, port: server.address().port })));
}

// ── one case ────────────────────────────────────────────────────────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mosbius-keys-'));
const results = [];
const record = (group, name, ok, detail = '') => { results.push({ group, name, ok: !!ok, detail }); console.log(`  ${ok ? 'PASS' : 'FAIL'}  [${group}] ${name}${detail ? `  — ${detail}` : ''}`); };
const observed = { version, cases: {} };

const CASES = [
  { name: 'approve', steps: [keys.KEY_APPROVE], runs: true },
  { name: 'reject', steps: [keys.KEY_REJECT], runs: false },
  { name: 'option-2', steps: keys.optionKeySteps(1), index: 1, runs: 'by-label' },
  { name: 'option-3', steps: keys.optionKeySteps(2), index: 2, runs: 'by-label' },
  { name: 'option-4', steps: keys.optionKeySteps(3), index: 3, runs: 'by-label' },
  { name: 'alternative', steps: [keys.KEY_REJECT], runs: false, then: 'use a different file name' },
  { name: 'write-approve', tool: 'write', steps: [keys.KEY_APPROVE], runs: true },
  { name: 'write-reject', tool: 'write', steps: [keys.KEY_REJECT], runs: false }
];

/** The menu entries on screen: "1. Yes", "2. Yes, and don't ask again ...", with or without the highlight arrow. */
function menuFrom(lines) {
  const at = lines.map((l, i) => (/do you want/i.test(l) ? i : -1)).filter((i) => i >= 0).pop();
  if (at === undefined) return { prompt: '', options: {}, highlighted: null };
  const out = []; const options = {}; let highlighted = null;
  for (let i = at; i < Math.min(lines.length, at + 16); i++) {
    out.push(lines[i]);
    const m = /^\s*([❯>›]\s*)?(\d)\.\s+(.+?)\s*$/.exec(lines[i]);
    if (m) { options[m[2]] = m[3]; if (m[1]) highlighted = m[2]; }
    if (/esc to cancel/i.test(lines[i])) break;
  }
  return { prompt: out.join('\n'), options, highlighted };
}

async function runCase(c, port, st) {
  const work = fs.realpathSync(fs.mkdtempSync(path.join(TMP, `${c.name}-`)));
  const home = path.join(work, 'home');
  fs.mkdirSync(home, { recursive: true });
  const project = path.join(work, 'project');
  fs.mkdirSync(project, { recursive: true });
  // Skip first-run dialogs: onboarding done, this folder trusted, the made-up key approved.
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
    numStartups: 20, hasCompletedOnboarding: true, theme: 'dark', hasSeenTasksHint: true,
    customApiKeyResponses: { approved: [FAKE_KEY.slice(-20)], rejected: [] },
    projects: { [project]: { allowedTools: [], history: [], mcpServers: {}, hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } }
  }));
  const env = {
    PATH: process.env.PATH, HOME: home, TERM: 'xterm-256color', LANG: 'en_US.UTF-8', TMPDIR: process.env.TMPDIR || '/tmp',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_API_KEY: FAKE_KEY,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', NO_UPDATE_NOTIFIER: '1'
  };
  fs.writeFileSync(path.join(project, 'edit.txt'), 'before\n');
  st.tool = c.tool || 'bash'; st.project = project; st.toolUsed = ''; st.toolNames = [];
  st.asked = false; st.mainCalls = 0; st.toolResults.length = 0; st.userTexts.length = 0; st.paths.length = 0;

  const screen = new MiniScreen(120, 40);
  const term = pty.spawn(CLAUDE, ['--bare', '--permission-mode', 'default'], { name: 'xterm-256color', cols: 120, rows: 40, cwd: project, env });
  term.onData((d) => { screen.feed(d); });
  let exited = false;
  term.onExit(() => { exited = true; });
  const seen = (needle) => norm(screen.text()).includes(norm(needle));
  const o = { tool: st.tool, keys: c.steps.map((s) => JSON.stringify(s)) };
  observed.cases[c.name] = o;
  const marker = path.join(project, 'marker.txt');
  try {
    // startup: answer the dialogs that may still appear, until the input box is there
    await waitFor(async () => {
      if (exited) throw new Error('the CLI exited during startup');
      if (seen('do you trust') || seen('trust this folder')) { term.write('\r'); await sleep(400); }
      return seen('for shortcuts') || seen('? for');
    }, 40000, 'the input box');
    await sleep(500);
    term.write(ASK);
    await sleep(500);
    term.write('\r');
    await waitFor(() => { if (exited) throw new Error('the CLI exited before the prompt'); return seen('do you want'); }, 40000, 'the permission prompt');
    await sleep(900); // let the menu finish drawing
    const menu = menuFrom(screen.lines());
    o.promptOnScreen = menu.prompt;
    o.options = menu.options;
    o.toolUsed = st.toolUsed;
    const asks = st.tool === 'write' ? /marker\.txt|edit\.txt/i.test(screen.text()) : /touch marker\.txt/i.test(screen.text());
    record(c.name, `the real permission prompt appeared for ${st.tool === 'write' ? `a file change (the ${st.toolUsed} tool)` : 'the command'}`, asks && Object.keys(menu.options).length >= 2, `${Object.keys(menu.options).length} entries: ${Object.entries(menu.options).map(([k, v]) => `${k}. ${v}`).join(' | ')}`);

    // A menu choice is Down presses and then Enter: stop before the Enter and read which entry the highlight is on.
    const moves = c.runs === 'by-label' ? c.steps.slice(0, -1) : [];
    for (let i = 0; i < moves.length; i++) { if (i > 0) await sleep(keys.KEY_GAP_MS); term.write(moves[i]); }
    if (moves.length) {
      await sleep(400);
      o.highlightedBeforeEnter = menuFrom(screen.lines()).highlighted;
      record(c.name, `after ${moves.length} Down press${moves.length > 1 ? 'es' : ''} the highlight is on entry ${c.index + 1}`, o.highlightedBeforeEnter === String(c.index + 1), `highlight on ${o.highlightedBeforeEnter}`);
      await sleep(keys.KEY_GAP_MS);
    }
    const rest = c.steps.slice(moves.length);
    for (let i = 0; i < rest.length; i++) { if (i > 0) await sleep(keys.KEY_GAP_MS); term.write(rest[i]); }
    if (c.then) { await sleep(1500); term.write(c.then); await sleep(400); term.write('\r'); }
    await sleep(c.runs === false ? 3500 : 2500);
    const edited = (() => { try { return fs.readFileSync(path.join(project, 'edit.txt'), 'utf8').startsWith('after'); } catch { return false; } })();
    const made = st.tool === 'write' ? (fs.existsSync(marker) || edited) : fs.existsSync(marker);
    o.markerCreated = made;
    o.toolResults = st.toolResults.slice();
    o.userTextsToModel = st.userTexts.slice();
    const rule = path.join(project, '.claude', 'settings.local.json');
    o.savedRule = fs.existsSync(rule) ? fs.readFileSync(rule, 'utf8').slice(0, 400) : null;
    o.screenAfter = screen.lines().filter((l) => l.trim()).slice(-14).join('\n');

    let expectRuns = c.runs;
    let label = null;
    if (c.runs === 'by-label') { label = menu.options[String(c.index + 1)] || null; expectRuns = label ? /^yes/i.test(label) : null; o.chosenLabel = label; }
    if (expectRuns === null) {
      record(c.name, `entry ${c.index + 1} could be read from the prompt`, false, 'not on screen; outcome recorded only');
    } else if (expectRuns === true) {
      record(c.name, `the ${st.tool === 'write' ? 'file was written' : 'command ran'} (the file exists)${label ? ` after choosing "${label}"` : ''}`, made);
      await waitFor(() => st.toolResults.length > 0, 8000, 'the tool result reaching the model')
        .then(() => record(c.name, 'the model was told it succeeded', st.toolResults.some((r) => !r.is_error), JSON.stringify(st.toolResults[0])))
        .catch(() => record(c.name, 'the model was told it succeeded', false, 'no tool result arrived'));
    } else {
      record(c.name, `the ${st.tool === 'write' ? 'write' : 'command'} did NOT happen (no file)${label ? ` after choosing "${label}"` : ''}`, !made);
      if (c.then) record(c.name, 'the instruction typed afterwards reached the model', st.userTexts.some((t) => t.includes(c.then)), JSON.stringify(st.userTexts.slice(-2)));
      else record(c.name, 'no tool result was sent for a command that never ran, or it says it was refused', st.toolResults.length === 0 || st.toolResults.every((r) => r.is_error), JSON.stringify(st.toolResults));
    }
  } catch (e) {
    record(c.name, 'the case ran to its end', false, e.message);
    o.toolsOffered = st.toolNames.slice(); o.toolUsed = st.toolUsed; o.userTextsToModel = st.userTexts.slice(); o.toolResults = st.toolResults.slice();
    o.screenAtFailure = screen.lines().filter((l) => l.trim()).slice(-30).join('\n');
  } finally {
    try { term.kill(); } catch { /* gone */ }
    await sleep(300);
  }
}

(async () => {
  console.log(`claude: ${version}`);
  const { server, st, port } = await startStandIn();
  try {
    for (const c of CASES) {
      if (ONLY && !ONLY.has(c.name)) continue;
      console.log(`\n== ${c.name}`);
      await runCase(c, port, st);
    }
  } finally { server.close(); }
  fs.mkdirSync(OUT, { recursive: true });
  const failed = results.filter((r) => !r.ok);
  const doc = { when: new Date().toISOString(), claude: version, realCli: true, standInModel: true, note: 'The CLI and its permission prompt are real; the model behind it is a loopback stand-in. This shows how the real prompt reacts to the keys, not what a real model will ask for.', results, observed };
  fs.writeFileSync(path.join(OUT, 'claude-prompt-keys.json'), JSON.stringify(doc, null, 2));
  fs.writeFileSync(path.join(OUT, 'claude-prompt-keys.txt'), `claude ${version}: the real CLI and its real permission prompt; the model is a loopback stand-in (no account, no network); keys: the app's own\n\n${results.map((r) => `${r.ok ? 'PASS' : 'FAIL'}  [${r.group}] ${r.name}${r.detail ? `  — ${r.detail}` : ''}`).join('\n')}\n\n${results.length - failed.length}/${results.length} passed\n`);
  console.log(`\n${results.length - failed.length}/${results.length} passed; evidence in ${path.relative(ROOT, OUT)}/claude-prompt-keys.{json,txt}`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* temp */ }
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
