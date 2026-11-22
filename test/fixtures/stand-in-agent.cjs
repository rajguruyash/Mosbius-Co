#!/usr/bin/env node
'use strict';
/**
 * A stand-in for an agent CLI, for tests that need a real process in a real terminal that reports its life the way
 * Claude Code does: it connects to the hive's hook socket (HIVE_SOCK) and sends the same newline-delimited JSON
 * payloads the app's own hook shim forwards (SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Notification,
 * Stop), with AGENT_ID from the environment. It draws a prompt and reacts to what is typed into it, and a
 * permission prompt or a question really waits for a key.
 *
 * It is NOT Claude: it makes no model calls and says so. A #tag in a message picks the scenario (the app's own
 * orientation prompts contain ordinary words, so plain words never trigger one):
 *   #work     a plan (TodoWrite), reads, a search, an edit, a command; then done
 *   #approve  asks permission to run a command, and waits: Enter or 1 approves, Esc or 3 rejects
 *   #ask      asks a multiple-choice question and waits: arrows move, Enter chooses
 *   #crash    prints an error and exits with code 1
 *   #long     keeps working for about a minute
 *   anything else is answered in a moment
 *
 * Demo mode (MOSBIUS_STANDIN_DEMO=<a folder>) is for recording the README's and the website's videos, and for nothing else. The
 * program then keeps a transcript of its own turns in that folder, shaped like the one Claude Code keeps, and tells the app where it
 * is the way the real CLI does, so the Huddle's conversation view has a conversation to show. It also leaves out of what it prints
 * and writes the #tags and its two lines that say what it is, and it reads files with a real project's names. It is still not a
 * model: every word is a scenario's own, and tests never set the variable.
 */
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');

const sock = process.env.HIVE_SOCK;
const agentId = process.env.AGENT_ID;
const log = (s) => process.stdout.write(s + '\r\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const demoDir = process.env.MOSBIUS_STANDIN_DEMO || '';
const demo = demoDir !== '';
const transcript = demo ? path.join(demoDir, `${agentId || 'agent'}.jsonl`) : '';
let seq = 0;
/** One record of the transcript, shaped like the ones Claude Code writes (only what the Huddle reads from them). */
function record(role, content) {
  if (!transcript) return;
  try {
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.appendFileSync(transcript, JSON.stringify({ type: role, uuid: `${agentId}-${++seq}`, sessionId: `stand-in-${agentId}`, timestamp: new Date().toISOString(), message: { role, content } }) + '\n');
  } catch { /* the transcript is for show: failing to write it changes nothing else */ }
}
const said = (text) => record('assistant', [{ type: 'text', text }]);
const used = (name, input) => record('assistant', [{ type: 'tool_use', id: `toolu_${agentId}_${seq + 1}`, name, input }]);
/** A message without the #tags that pick a scenario: the tags are for the program, not for a reader. */
const plain = (text) => (demo ? text.replace(/#(?:work|approve|ask|crash|long)\b\s*/gi, '').trim() : text);
const DEMO_FILES = ['lexer', 'parser', 'tokens', 'ast', 'visitor', 'printer', 'errors', 'scope', 'resolver', 'emit', 'format', 'options', 'source', 'span', 'diagnostics', 'symbols', 'types', 'check', 'lower', 'cli'];

function post(payload) {
  return new Promise((resolve) => {
    if (!sock) return resolve({});
    let out = '';
    const c = net.createConnection(sock, () => c.write(JSON.stringify({ agent_id: agentId, session_id: `stand-in-${agentId}`, ...(transcript ? { transcript_path: transcript } : {}), ...payload }) + '\n'));
    c.setEncoding('utf8');
    c.on('data', (d) => { out += d; });
    c.on('end', () => { try { resolve(JSON.parse(out || '{}')); } catch { resolve({}); } });
    c.on('error', () => resolve({}));
    setTimeout(() => resolve({}), 4000).unref();
  });
}

let keyWaiter = null;
let running = false;
let interrupted = false;
function waitKey() { return new Promise((resolve) => { keyWaiter = resolve; }); }

async function tool(name, input, shown, ms = 900) {
  if (interrupted) return false;
  if (demo && name !== 'TodoWrite') used(name, input);          // the plan is the progress bar's business: it is not a line of the conversation
  const res = await post({ hook_event_name: 'PreToolUse', tool_name: name, tool_input: input });
  const denied = res && res.hookSpecificOutput && res.hookSpecificOutput.permissionDecision === 'deny';
  log(`\x1b[36m● ${name}\x1b[0m ${shown}`);
  if (denied) { log(`  \x1b[31mdenied: ${res.hookSpecificOutput.permissionDecisionReason || ''}\x1b[0m`); await post({ hook_event_name: 'PostToolUseFailure', tool_name: name }); return false; }
  await sleep(ms);
  await post({ hook_event_name: 'PostToolUse', tool_name: name, tool_input: input });
  return true;
}

async function turn(prompt) {
  const p = prompt.toLowerCase();
  running = true; interrupted = false;
  record('user', plain(prompt));
  await post({ hook_event_name: 'UserPromptSubmit', prompt: plain(prompt) });
  if (!demo) log(`\x1b[2m(stand-in agent: not a model; scenario chosen by keyword)\x1b[0m`);
  if (/#crash/.test(p)) { log('Error: stand-in agent crashed on request'); await sleep(300); process.exit(1); }
  if (/#approve/.test(p)) {
    if (demo) { said('The build folder has to go before the next step, so I am asking first.'); used('Bash', { command: 'rm -rf ./build', description: 'Remove the build folder' }); }
    await post({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm -rf ./build', description: 'Remove the build folder' } });
    log('\x1b[36m● Bash\x1b[0m rm -rf ./build');
    await post({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
    log(' Do you want to proceed?');
    log(' \x1b[35m❯ 1. Yes\x1b[0m');
    log('   2. Yes, and don\'t ask again for rm commands');
    log('   3. No, and tell Claude what to do differently (esc)');
    const k = await waitKey();
    if (k === 'yes') { log('  approved: running it'); await sleep(500); await post({ hook_event_name: 'PostToolUse', tool_name: 'Bash' }); log('  removed ./build'); if (demo) said('Done: the build folder is gone.'); }
    else { log('  rejected'); await post({ hook_event_name: 'PostToolUseFailure', tool_name: 'Bash' }); if (demo) said('Understood: I left the build folder alone.'); }
  } else if (/#ask/.test(p)) {
    const options = ['Postgres', 'SQLite', 'MySQL'];
    const asked = { questions: [{ question: 'Which database should I use?', header: 'Database', options: options.map((label) => ({ label, description: `use ${label}` })), multiSelect: false }] };
    if (demo) { said('Before I start I need to know which database to use.'); used('AskUserQuestion', asked); }
    await post({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: asked });
    let sel = 0;
    const draw = () => { log(' Which database should I use?'); options.forEach((o, i) => log(`  ${i === sel ? '\x1b[35m❯\x1b[0m' : ' '} ${i + 1}. ${o}`)); };
    draw();
    for (;;) {
      const k = await waitKey();
      if (k === 'down') { sel = Math.min(options.length - 1, sel + 1); log(`  (highlight: ${options[sel]})`); }
      else if (k === 'up') { sel = Math.max(0, sel - 1); log(`  (highlight: ${options[sel]})`); }
      else if (k === 'yes') break;
    }
    log(`  you chose ${options[sel]}`);
    if (demo) said(`Going with ${options[sel]}.`);
    await post({ hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion' });
  } else if (/#work|#long/.test(p)) {
    const steps = [{ content: 'Read the code', activeForm: 'Reading the code' }, { content: 'Edit the file', activeForm: 'Editing the file' }, { content: 'Run the tests', activeForm: 'Running the tests' }];
    const todos = (done) => steps.map((s, i) => ({ ...s, status: i < done ? 'completed' : i === done ? 'in_progress' : 'pending' }));
    if (demo) said('I will read the code first, then make the change.');
    await tool('TodoWrite', { todos: todos(0) }, 'plan', 200);
    await tool('Read', { file_path: '/work/src/app.ts' }, 'src/app.ts', 1200);
    await tool('Grep', { pattern: 'TODO' }, '"TODO"', 900);
    await tool('TodoWrite', { todos: todos(1) }, 'plan', 200);
    await tool('Edit', { file_path: '/work/src/app.ts' }, 'src/app.ts', 1500);
    await tool('TodoWrite', { todos: todos(2) }, 'plan', 200);
    await tool('Bash', { command: 'npm test', description: demo ? 'the tests' : 'Run the tests' }, 'npm test', 2200);
    await tool('TodoWrite', { todos: todos(3) }, 'plan', 200);
    if (/#long/.test(p)) for (let i = 0; i < 20; i++) { const file = demo ? `${DEMO_FILES[i % DEMO_FILES.length]}.ts` : `part-${i}.ts`; await tool('Read', { file_path: `/work/src/${demo ? 'parser/' : ''}${file}` }, file, demo ? 5200 : 2200); }
    log('All done.');
    if (demo) said('All done.');
  } else {
    await sleep(900);
    const okay = demo ? 'Okay, noted.' : 'Okay.';
    log(okay);
    if (demo) said(okay);
  }
  running = false;
  // Escape stops a turn without a Stop hook, as in Claude Code: the app must notice the quiet
  if (interrupted) { log('\x1b[33m(interrupted)\x1b[0m'); interrupted = false; prompt_(); return; }
  await post({ hook_event_name: 'Stop' });
  prompt_();
}

function prompt_() { process.stdout.write('\r\n\x1b[1m>\x1b[0m '); }

(async () => {
  if (demo) log('\x1b[2msession started\x1b[0m');
  else log('\x1b[1mstand-in agent\x1b[0m for ' + (process.env.AGENT_NAME || agentId) + ' (no model: a test double)');
  await post({ hook_event_name: 'SessionStart', source: 'startup' });
  prompt_();
  let buf = '';
  let paste = false;
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => {
    for (let i = 0; i < d.length; i++) {
      const rest = d.slice(i);
      if (rest.startsWith('\u001b[200~')) { paste = true; i += 5; continue; }
      if (rest.startsWith('\u001b[201~')) { paste = false; i += 5; continue; }
      if (rest.startsWith('\u001b[B')) { i += 2; if (keyWaiter) { const w = keyWaiter; keyWaiter = null; w('down'); } continue; }
      if (rest.startsWith('\u001b[A')) { i += 2; if (keyWaiter) { const w = keyWaiter; keyWaiter = null; w('up'); } continue; }
      const ch = d[i];
      if (ch === '\u001b') { if (keyWaiter) { const w = keyWaiter; keyWaiter = null; w('no'); } else if (running) interrupted = true; continue; }
      if (keyWaiter) {
        if (ch === '\r' || ch === '1') { const w = keyWaiter; keyWaiter = null; w('yes'); }
        else if (ch === '3') { const w = keyWaiter; keyWaiter = null; w('no'); }
        continue;
      }
      if (ch === '\r' && !paste) {
        const text = buf.trim(); buf = '';
        // demo mode does not echo each key (a #tag would show): the line is written once, without its tags
        process.stdout.write(demo ? `${plain(text)}\r\n` : '\r\n');
        if (text) void turn(text); else prompt_();
      } else if (ch === '\u007f') { buf = buf.slice(0, -1); if (!demo) process.stdout.write('\b \b'); }
      else if (ch >= ' ' || ch === '\n') { buf += ch; if (!demo) process.stdout.write(ch === '\n' ? '\r\n' : ch); }
    }
  });
  process.on('SIGTERM', () => process.exit(0));
})();
