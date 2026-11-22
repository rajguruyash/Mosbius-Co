'use strict';

/**
 * The agent-activity state machine (src/shared/agentActivity.ts): every state the Huddle can show is the
 * consequence of a real lifecycle event, never a made-up one. These tests drive it with the same hook
 * payloads Claude Code sends and check the state, the signals, and the text that comes out.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const A = loadTs('src/shared/agentActivity.ts');
const {
  newActivity, reduceActivity, computeState, classifyTool, describeTool, parseTodos, parseAskUserQuestion,
  classifyNotificationHook, keystrokeAnswersPrompt, scrubText, clip, toRosterStatus, needsHuman, attentionRank,
  AGENT_STATES, COMPLETED_LINGER_MS, MIN_COMPLETION_TURN_MS, QUIESCE_MS
} = A;

const T0 = 1_700_000_000_000;
/** Fold a list of events, returning the final activity and every signal in order. */
function run(events, start = newActivity('a1', T0)) {
  let a = start;
  const signals = [];
  for (const ev of events) {
    const r = reduceActivity(a, ev);
    a = r.next;
    signals.push(...r.signals);
  }
  return { a, signals };
}
const hook = (at, event, extra = {}) => ({ type: 'hook', at: T0 + at, event, ...extra });
const state = (a, now = T0 + 1_000_000, extra = {}) => computeState(a, { now, alive: true, ...extra });

test('a fresh agent is idle, and the ten states are all named', () => {
  assert.equal(state(newActivity('a1', T0)), 'idle');
  assert.deepEqual([...AGENT_STATES].sort(), ['completed', 'error', 'idle', 'needs-approval', 'needs-input', 'paused', 'researching', 'stopped', 'waiting', 'working']);
});

test('a prompt opens a turn and the agent is working; a research tool makes it researching', () => {
  const { a } = run([hook(0, 'UserPromptSubmit', { prompt: 'fix the build' })]);
  assert.equal(state(a), 'working');
  assert.equal(a.activity.verb, 'thinking');
  const r1 = run([hook(1, 'PreToolUse', { tool: 'Read', toolInput: { file_path: '/repo/src/app.ts' } })], a).a;
  assert.equal(state(r1), 'researching');
  assert.deepEqual(r1.activity, { verb: 'reading', arg: 'app.ts' });
  const r2 = run([hook(2, 'PreToolUse', { tool: 'Bash', toolInput: { command: 'npm test\nsecond line' } })], r1).a;
  assert.equal(state(r2), 'working');
  assert.deepEqual(r2.activity, { verb: 'running', arg: 'npm test' });
});

test('tool classification: reading and searching are research, changing things is work, unknown engines by name', () => {
  for (const t of ['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch']) assert.equal(classifyTool(t), 'research', t);
  for (const t of ['Bash', 'Edit', 'Write', 'MultiEdit', 'Task', 'TodoWrite']) assert.equal(classifyTool(t), 'work', t);
  assert.equal(classifyTool('read_file'), 'research');
  assert.equal(classifyTool('list_directory'), 'research');
  assert.equal(classifyTool('write_file'), 'work');
  assert.equal(classifyTool('run_command'), 'work');
  assert.equal(classifyTool('mcp__github__search_issues'), 'research');
  assert.equal(classifyTool('mcp__github__create_issue'), 'work');
  assert.equal(classifyTool(undefined), 'work');
});

test('describeTool reads the real input and never leaks a secret', () => {
  assert.deepEqual(describeTool('Edit', { file_path: '/a/b/c.ts' }), { verb: 'editing', arg: 'c.ts' });
  assert.deepEqual(describeTool('Grep', { pattern: 'TODO' }), { verb: 'searching', arg: 'TODO' });
  assert.deepEqual(describeTool('WebFetch', { url: 'https://example.com/x?y=1' }), { verb: 'fetching', arg: 'example.com' });
  assert.deepEqual(describeTool('mcp__github__search_issues', {}), { verb: 'usingTool', arg: 'github · search_issues' });
  const secret = ['sk', 'FAKE0123456789abcdef0123456789'].join('-');
  const l = describeTool('Bash', { command: `curl -H "Authorization: Bearer ${secret}" https://x` });
  assert.ok(!JSON.stringify(l).includes(secret), 'the credential must not survive');
});

test('a permission prompt is needs-approval, names the tool that asked, and is resolved when the tool runs', () => {
  const { a, signals } = run([
    hook(0, 'UserPromptSubmit', { prompt: 'deploy' }),
    hook(1, 'PreToolUse', { tool: 'Bash', toolInput: { command: 'rm -rf build' } }),
    hook(2, 'Notification', { notificationType: 'permission_prompt', message: 'Claude needs your permission to use Bash' })
  ]);
  assert.equal(state(a), 'needs-approval');
  assert.equal(a.pending.kind, 'approval');
  assert.equal(a.pending.tool, 'Bash');
  assert.match(a.pending.preview, /^Bash: rm -rf build/, 'it says what is being asked: the command itself');
  assert.equal(a.pending.automatable, true);
  assert.equal(signals.filter((s) => s.kind === 'approval-requested').length, 1);

  // the same prompt reported twice is one request
  const again = run([hook(3, 'Notification', { notificationType: 'permission_prompt', message: 'Claude needs your permission to use Bash' })], a);
  assert.equal(again.signals.filter((s) => s.kind === 'approval-requested').length, 0, 'a repeat is not a new request');

  // approved in the terminal: the tool runs
  const done = run([hook(4, 'PostToolUse', { tool: 'Bash' })], a);
  assert.equal(done.a.pending, undefined);
  assert.equal(state(done.a), 'working');
  assert.deepEqual(done.signals.map((s) => s.kind), ['request-resolved']);
});

test('the permission preview is the literal command, path or address, with the agent\'s own description after it', () => {
  const ask = (tool, toolInput) => run([hook(0, 'PreToolUse', { tool, toolInput }), hook(1, 'Notification', { notificationType: 'permission_prompt', message: 'Claude needs your permission' })]).a.pending.preview;
  assert.equal(ask('Bash', { command: 'git push --force origin main', description: 'Push the branch' }), 'Bash: git push --force origin main — Push the branch');
  assert.equal(ask('Write', { file_path: '/repo/src/new.ts', content: 'x' }), 'Write: /repo/src/new.ts');
  assert.equal(ask('WebFetch', { url: 'https://example.com/a' }), 'WebFetch: https://example.com/a');
  // without a tool call to point at, the CLI's own words are what there is
  assert.equal(run([hook(0, 'Notification', { notificationType: 'permission_prompt', message: 'Claude needs your permission to use Edit' })]).a.pending.preview, 'Claude needs your permission to use Edit');
  assert.equal(A.toolDetail('Bash', { command: 'echo $TOKEN_FAKE' }), 'echo $TOKEN_FAKE');
  const fake = ['ghp', 'FAKE1234567890abcdefghijkl'].join('_');
  assert.ok(!A.toolDetail('Bash', { command: `curl -u x:${fake} https://h` }).includes(fake), 'a credential in a command is not shown');
});

test('older Claude versions send only a message: permission and idle are still told apart', () => {
  assert.equal(classifyNotificationHook(undefined, 'Claude needs your permission to use Edit'), 'approval');
  assert.equal(classifyNotificationHook(undefined, 'Claude is waiting for your input'), 'idle');
  assert.equal(classifyNotificationHook('idle_prompt', 'anything'), 'idle');
  assert.equal(classifyNotificationHook('permission', 'Claude wants to run a command'), 'approval');
  assert.equal(classifyNotificationHook('elicitation_dialog', 'Pick one'), 'input');
  assert.equal(classifyNotificationHook(undefined, undefined), 'idle');
  assert.equal(classifyNotificationHook('auth_success', 'Signed in'), 'other');
});

test('AskUserQuestion is a request for input, with the options the agent offered', () => {
  const input = { questions: [{ question: 'Which database should I use?', header: 'DB', options: [{ label: 'Postgres', description: 'x' }, { label: 'SQLite', description: 'y' }], multiSelect: false }] };
  const { a, signals } = run([hook(0, 'PreToolUse', { tool: 'AskUserQuestion', toolInput: input })]);
  assert.equal(state(a), 'needs-input');
  assert.equal(a.pending.preview, 'Which database should I use?');
  assert.deepEqual(a.pending.options, ['Postgres', 'SQLite']);
  assert.equal(a.pending.automatable, true, 'one single-choice question can be answered with the menu keys');
  assert.deepEqual(signals.map((s) => s.kind), ['input-requested']);
  assert.deepEqual(parseAskUserQuestion({ questions: [{ question: 'a', options: [{ label: 'x' }], multiSelect: true }] }).multiSelect, true);
  const multi = run([hook(0, 'PreToolUse', { tool: 'AskUserQuestion', toolInput: { questions: [input.questions[0], input.questions[0]] } })]).a;
  assert.equal(multi.pending.automatable, false, 'several questions are answered in the terminal');
  const answered = run([hook(1, 'PostToolUse', { tool: 'AskUserQuestion' })], a).a;
  assert.equal(answered.pending, undefined);
});

test('a substantial finish is "completed" and lingers, then settles to idle; a short one is routine', () => {
  const long = run([
    hook(0, 'UserPromptSubmit', { prompt: 'refactor' }),
    hook(MIN_COMPLETION_TURN_MS + 1000, 'Stop')
  ]);
  const doneAt = T0 + MIN_COMPLETION_TURN_MS + 1000;
  assert.equal(long.signals.find((s) => s.kind === 'turn-completed').substantial, true);
  assert.equal(state(long.a, doneAt + 1000), 'completed');
  assert.equal(state(long.a, doneAt + COMPLETED_LINGER_MS + 1), 'idle');

  const tools = run([
    hook(0, 'UserPromptSubmit', { prompt: 'x' }),
    hook(1, 'PreToolUse', { tool: 'Read', toolInput: {} }), hook(2, 'PreToolUse', { tool: 'Read', toolInput: {} }), hook(3, 'PreToolUse', { tool: 'Read', toolInput: {} }),
    hook(4, 'Stop')
  ]);
  assert.equal(tools.signals.find((s) => s.kind === 'turn-completed').substantial, true, 'three tools is substantial however short');

  const quick = run([hook(0, 'UserPromptSubmit', { prompt: 'hi' }), hook(2_000, 'Stop')]);
  assert.equal(quick.signals.find((s) => s.kind === 'turn-completed').substantial, false);
  assert.equal(state(quick.a, T0 + 3_000), 'idle', 'a one-line answer does not claim to have completed anything');
});

test('an inbox nudge is not a user-initiated turn; a typed prompt is', () => {
  const { inboxNudgeText } = loadTs('src/shared/hiveNudge.ts');
  const nudged = run([hook(0, 'UserPromptSubmit', { prompt: inboxNudgeText(['m1']) })]).a;
  assert.equal(nudged.turn.userInitiated, false);
  const typed = run([hook(0, 'UserPromptSubmit', { prompt: 'please add tests' })]).a;
  assert.equal(typed.turn.userInitiated, true);
});

test('Stop with stop_hook_active, or a blocked Stop, does not end the turn', () => {
  const { a } = run([hook(0, 'UserPromptSubmit', { prompt: 'x' }), hook(20_000, 'Stop', { blocked: true }), hook(20_001, 'Stop', { stopHookActive: true })]);
  assert.equal(a.turn.active, true);
  assert.equal(state(a), 'working');
});

test('a Stop that never comes (an interrupt) is covered by terminal silence, and silence never clears a waiting prompt', () => {
  const working = run([hook(0, 'UserPromptSubmit', { prompt: 'x' }), hook(1, 'PreToolUse', { tool: 'Bash', toolInput: { command: 'sleep 100' } })]).a;
  assert.equal(run([{ type: 'quiet', at: T0 + 5000, quietMs: QUIESCE_MS - 1 }], working).a.turn.active, true, 'not yet');
  const quiet = run([{ type: 'quiet', at: T0 + 20_000, quietMs: QUIESCE_MS + 1 }], working);
  assert.equal(quiet.a.turn.active, false);
  assert.equal(state(quiet.a), 'idle');
  assert.deepEqual(quiet.signals, [], 'nobody finished anything, so nothing is announced');

  const waiting = run([hook(2, 'Notification', { notificationType: 'permission_prompt', message: 'Claude needs your permission to use Bash' })], working).a;
  const stillWaiting = run([{ type: 'quiet', at: T0 + 60_000, quietMs: 60_000 }], waiting).a;
  assert.equal(state(stillWaiting), 'needs-approval', 'a prompt waiting for a person looks exactly like silence');
});

test('typing the answer into the terminal resolves the prompt; moving the highlight does not', () => {
  const pending = run([
    hook(0, 'PreToolUse', { tool: 'Bash', toolInput: { command: 'ls' } }),
    hook(1, 'Notification', { notificationType: 'permission_prompt', message: 'Claude needs your permission to use Bash' })
  ]).a;
  assert.equal(run([{ type: 'user-input', at: T0 + 5, data: '\u001b[B' }], pending).a.pending !== undefined, true, 'an arrow key only moves the highlight');
  assert.equal(run([{ type: 'user-input', at: T0 + 5, data: 'a' }], pending).a.pending !== undefined, true, 'a letter is not an answer');
  for (const answer of ['\r', '1', '\u001b']) {
    const r = run([{ type: 'user-input', at: T0 + 5, data: answer }], pending);
    assert.equal(r.a.pending, undefined, JSON.stringify(answer));
    assert.deepEqual(r.signals.map((s) => s.how), ['answered-in-terminal']);
  }
  assert.equal(keystrokeAnswersPrompt('\u001b[A'), false);
  assert.equal(keystrokeAnswersPrompt('\u001b'), true);
});

test('pause and halt make the agent paused; resume clears it; the signals say so once each', () => {
  const working = run([hook(0, 'UserPromptSubmit', { prompt: 'x' })]).a;
  const paused = run([{ type: 'control', at: T0 + 1, paused: true, halted: false }], working);
  assert.equal(state(paused.a), 'paused');
  assert.deepEqual(paused.signals.map((s) => s.kind), ['paused']);
  assert.equal(run([{ type: 'control', at: T0 + 2, paused: true, halted: false }], paused.a).signals.length, 0, 'pausing twice is one pause');
  const resumed = run([{ type: 'control', at: T0 + 3, paused: false, halted: false }], paused.a);
  assert.equal(state(resumed.a), 'working');
  assert.deepEqual(resumed.signals.map((s) => s.kind), ['resumed']);
  assert.equal(state(run([{ type: 'control', at: T0 + 1, paused: false, halted: true }], working).a), 'paused', 'a pending halt holds the agent too');
});

test('a crash is an error with what the process said; a clean exit is stopped; a respawn clears both', () => {
  const working = run([hook(0, 'UserPromptSubmit', { prompt: 'x' })]).a;
  const crashed = run([{ type: 'exit', at: T0 + 10, exitCode: 1, tail: 'old\n\u001b[31mError: model overloaded\u001b[0m\n' }], working);
  assert.equal(computeState(crashed.a, { now: T0 + 20, alive: false }), 'error');
  assert.equal(crashed.a.error.message, 'Error: model overloaded');
  assert.deepEqual(crashed.signals.map((s) => s.kind), ['crashed']);
  const killed = run([{ type: 'exit', at: T0 + 10, exitCode: 0 }], working);
  assert.equal(computeState(killed.a, { now: T0 + 20, alive: false }), 'stopped');
  assert.deepEqual(killed.signals.map((s) => s.kind), ['stopped']);
  const sig = run([{ type: 'exit', at: T0 + 10, exitCode: 0, signal: 9 }], working);
  assert.equal(sig.signals[0].kind, 'crashed', 'a process killed by a signal did not finish cleanly');
  const back = run([{ type: 'spawn', at: T0 + 30 }], crashed.a);
  assert.equal(back.a.error, undefined);
  assert.equal(state(back.a, T0 + 40), 'idle');
});

test('a prompt open at the moment the process dies is resolved, not left hanging', () => {
  const pending = run([hook(0, 'PreToolUse', { tool: 'Bash', toolInput: { command: 'ls' } }), hook(1, 'Notification', { notificationType: 'permission_prompt', message: 'Claude needs your permission to use Bash' })]).a;
  const r = run([{ type: 'exit', at: T0 + 9, exitCode: 0 }], pending);
  assert.equal(r.a.pending, undefined);
  assert.deepEqual(r.signals.map((s) => s.kind), ['request-resolved', 'stopped']);
  assert.equal(r.signals[0].how, 'agent-exited');
});

test('the circuit breaker turns the agent to error until it clears', () => {
  const working = run([hook(0, 'UserPromptSubmit', { prompt: 'x' })]).a;
  const tripped = run([{ type: 'breaker', at: T0 + 5, level: 'constrained', reason: 'same tool call 12 times' }], working);
  assert.equal(state(tripped.a), 'error');
  assert.deepEqual(tripped.signals.map((s) => s.kind), ['breaker']);
  const cleared = run([{ type: 'breaker', at: T0 + 9, level: 'healthy' }], tripped.a);
  assert.equal(state(cleared.a), 'working');
  assert.deepEqual(cleared.signals.map((s) => s.kind), ['breaker-cleared']);
  assert.equal(run([{ type: 'breaker', at: T0 + 5, level: 'steering' }], working).a.error, undefined, 'steering is a warning, not a failure');
});

test('TodoWrite is the real progress: done of total, and what it is on now', () => {
  const todos = [{ content: 'a', status: 'completed' }, { content: 'b', activeForm: 'Writing b', status: 'in_progress' }, { content: 'c', status: 'pending' }];
  assert.deepEqual(parseTodos({ todos }), { done: 1, total: 3, current: 'Writing b' });
  assert.equal(parseTodos({ todos: [] }), undefined);
  assert.equal(parseTodos({}), undefined);
  const { a } = run([hook(0, 'PreToolUse', { tool: 'TodoWrite', toolInput: { todos } })]);
  assert.deepEqual(a.todos, { done: 1, total: 3, current: 'Writing b' });
  assert.equal(state(a), 'working', 'planning does not turn research into work or the reverse');
});

test('ExitPlanMode is a plan to approve, and is not offered as a one-click answer', () => {
  const { a } = run([hook(0, 'PreToolUse', { tool: 'ExitPlanMode', toolInput: { plan: '1. do x\n2. do y' } })]);
  assert.equal(state(a), 'needs-approval');
  assert.equal(a.pending.source, 'plan');
  assert.equal(a.pending.automatable, false);
});

test('the idle notification is announced once per idle period, and a new turn re-arms it', () => {
  const idle = hook(0, 'Notification', { notificationType: 'idle_prompt', message: 'Claude is waiting for your input' });
  const first = run([idle]);
  assert.deepEqual(first.signals.map((s) => s.kind), ['idle-waiting']);
  assert.equal(run([idle], first.a).signals.length, 0, 'the second one is the same idle period');
  const after = run([hook(10, 'UserPromptSubmit', { prompt: 'x' }), hook(20, 'Stop'), hook(30, 'Notification', { notificationType: 'idle_prompt', message: 'Claude is waiting for your input' })], first.a);
  assert.ok(after.signals.some((s) => s.kind === 'idle-waiting'));
});

test('without tracker evidence the floor status is believed; with it the tracker wins', () => {
  const none = newActivity('a1', T0);
  assert.equal(state(none, T0, { rosterStatus: 'blocked' }), 'needs-approval');
  assert.equal(state(none, T0, { rosterStatus: 'waiting' }), 'waiting');
  assert.equal(state(none, T0, { rosterStatus: 'working' }), 'working');
  assert.equal(state(none, T0, { rosterStatus: 'looping' }), 'error');
  assert.equal(state(none, T0, { rosterStatus: 'ghost' }), 'stopped');
  assert.equal(state(undefined, T0, {}), 'idle');
  assert.equal(computeState(undefined, { now: T0, alive: false }), 'stopped');
  const turn = run([hook(0, 'UserPromptSubmit', { prompt: 'x' })]).a;
  assert.equal(state(turn, T0, { rosterStatus: 'idle' }), 'working', 'a turn in progress is not undone by a stale idle');
});

test('the order of precedence: error beats a request beats paused beats working', () => {
  let a = run([hook(0, 'UserPromptSubmit', { prompt: 'x' })]).a;
  a = run([{ type: 'control', at: T0 + 1, paused: true, halted: false }], a).a;
  assert.equal(state(a), 'paused');
  a = run([hook(2, 'Notification', { notificationType: 'permission_prompt', message: 'Claude needs your permission to use Bash' })], a).a;
  assert.equal(state(a), 'needs-approval');
  a = run([{ type: 'breaker', at: T0 + 3, level: 'stopped', reason: 'runaway' }], a).a;
  assert.equal(state(a), 'error');
});

test('every state maps to the floor status the office already understands, and needs-you is the loud ones', () => {
  const expected = { idle: 'idle', working: 'working', researching: 'working', waiting: 'waiting', completed: 'success', 'needs-input': 'blocked', 'needs-approval': 'blocked', error: 'looping', paused: 'waiting', stopped: 'ghost' };
  for (const s of AGENT_STATES) assert.equal(toRosterStatus(s), expected[s], s);
  assert.deepEqual(AGENT_STATES.filter(needsHuman).sort(), ['error', 'needs-approval', 'needs-input']);
  assert.ok(attentionRank('needs-approval') > attentionRank('error'));
  assert.ok(attentionRank('error') > attentionRank('working'));
  assert.ok(attentionRank('working') > attentionRank('idle'));
});

test('text from an agent is scrubbed of control characters, clipped, and cleaned of credentials', () => {
  assert.equal(clip('a\u0000b\n\n c'), 'ab c');
  assert.equal(clip('x'.repeat(500), 20).length, 20);
  const fake = ['ghp', 'FAKE1234567890abcdefghijkl'].join('_');
  assert.ok(!scrubText(`token ${fake}`).includes(fake));
  assert.ok(!scrubText('https://x.test/?api_key=SECRETVALUE123&y=1').includes('SECRETVALUE123'));
  assert.ok(scrubText('https://x.test/?y=1').includes('y=1'));
});

test('a prompt for one tool call is not closed by another call that starts or finishes beside it (calls the CLI names by id)', () => {
  const ask = [
    hook(0, 'UserPromptSubmit', { prompt: 'clean up' }),
    hook(1, 'PreToolUse', { tool: 'Bash', toolUseId: 'toolu_A', toolInput: { command: 'rm -rf ./build' } }),
    hook(2, 'Notification', { notificationType: 'permission_prompt', message: 'Claude needs your permission to use Bash' })
  ];
  const { a, signals } = run(ask);
  assert.equal(a.pending.toolUseId, 'toolu_A', 'the prompt remembers which call it is about');
  assert.equal(state(a), 'needs-approval');
  // a sub-agent or a parallel read starts and finishes while the prompt is open
  const beside = run([
    hook(3, 'PreToolUse', { tool: 'Read', toolUseId: 'toolu_B', toolInput: { file_path: '/repo/a.ts' } }),
    hook(4, 'PostToolUse', { tool: 'Read', toolUseId: 'toolu_B' }),
    hook(5, 'PostToolUse', { tool: 'Bash', toolUseId: 'toolu_C' })
  ], a);
  assert.ok(beside.a.pending, 'still open: none of those was the call it is about');
  assert.equal(beside.signals.filter((s) => s.kind === 'request-resolved').length, 0);
  assert.equal(state(beside.a), 'needs-approval');
  // the call itself finishing is the answer
  const done = run([hook(6, 'PostToolUse', { tool: 'Bash', toolUseId: 'toolu_A' })], beside.a);
  assert.equal(done.a.pending, undefined);
  assert.deepEqual(done.signals.filter((s) => s.kind === 'request-resolved').map((s) => s.how), ['agent-moved-on']);
  assert.equal(signals.filter((s) => s.kind === 'approval-requested').length, 1);
});

test('without call ids a prompt is told apart by tool name: a different tool finishing does not close it, the same tool does', () => {
  const { a } = run([
    hook(0, 'UserPromptSubmit', { prompt: 'go' }),
    hook(1, 'PreToolUse', { tool: 'Bash', toolInput: { command: 'ls' } }),
    hook(2, 'Notification', { notificationType: 'permission_prompt', message: 'Claude needs your permission to use Bash' })
  ]);
  const read = run([hook(3, 'PostToolUse', { tool: 'Read' })], a);
  assert.ok(read.a.pending, 'a Read finishing is not the answer to a prompt about Bash');
  const bash = run([hook(4, 'PostToolUse', { tool: 'Bash' })], read.a);
  assert.equal(bash.a.pending, undefined);
  // and a brand-new tool call, when nothing names the calls, still means the person answered (as before)
  const moved = run([hook(5, 'PreToolUse', { tool: 'Edit', toolInput: { file_path: '/repo/a.ts' } })], a);
  assert.equal(moved.a.pending, undefined);
});
