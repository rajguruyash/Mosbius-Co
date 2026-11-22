'use strict';

/**
 * The Huddle hub and the notification actions: the merge of roster, activity and terminals into what the
 * windows show, the commands that come back, and the guarantee that a click reaches only the agent it names.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { HuddleHub, DEPART_LINGER_MS, DEALT_WITH_LINGER_MS } = loadTs('src/main/huddleHub.ts');
const { NotificationService } = loadTs('src/main/notifyService.ts');
const { ActivityTracker } = loadTs('src/main/activityTracker.ts');
const { handleSignals } = loadTs('src/main/lifecycleWiring.ts');
const { resolveNotification, validateResolve } = loadTs('src/main/notifyActions.ts');
const H = loadTs('src/shared/huddle.ts');
const K = loadTs('src/shared/promptKeys.ts');

const T0 = 1_700_000_000_000;

function rig() {
  let clock = T0;
  const log = { writes: [], toOwner: [], asked: [], kills: [], paused: [], broadcasts: [], answered: [], opened: [], settings: [], counted: 0 };
  const ptys = new Map();
  const tasks = [];
  const control = new Map();
  const timers = [];
  const notifyPorts = {
    now: () => clock, load: () => undefined, save: () => {},
    showDesktop: () => 'shown', desktopSupported: () => true, playSound: () => true, strings: () => ({}), changed: () => {}, activate: () => {},
    setTimeout: (fn, ms) => { const t = { fn, at: clock + ms }; timers.push(t); return t; }, clearTimeout: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); }
  };
  const notifications = new NotificationService(notifyPorts);
  const names = { a1: 'Marshall', a2: 'Lily', god: 'Ted' };
  const tracker = new ActivityTracker({
    now: () => clock,
    onSignals: (agentId, signals, activity) => handleSignals({ notifications, agentRef: (id) => ({ id, name: names[id] ?? id, isGod: id === 'god' }), now: () => clock }, agentId, signals, activity)
  });
  const hubPorts = {
    now: () => clock,
    livePtys: () => [...ptys.values()],
    tracker, notifications,
    tasks: () => tasks,
    registry: () => ({}),
    controlSnapshot: (id) => control.get(id) ?? { paused: false, halted: false },
    setPaused: (id, on) => { log.paused.push([id, on]); control.set(id, { paused: on, halted: false }); tracker.control(id, { paused: on, halted: false }); },
    ptyWrite: (id, data) => { log.writes.push([id, data]); return { ok: ptys.has(id) }; },
    killAgent: (id) => { log.kills.push(id); return { ok: true }; },
    toOwner: (agentId, channel, payload) => { log.toOwner.push([agentId, channel, payload]); return true; },
    askOwner: async (agentId, cmd) => { log.asked.push([agentId, cmd]); return { ok: true }; },
    validateAttachment: (p) => p.startsWith('/missing') ? { ok: false, error: 'missing' } : { ok: true },
    broadcast: (s) => log.broadcasts.push(s),
    mode: () => ({ active: true, level: 'compact', selectedAgentId: null, dock: null }),
    countMessageSent: () => { log.counted++; },
    setTimeout: (fn, ms) => { const t = { fn, at: clock + ms }; timers.push(t); return t; }, clearTimeout: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); }
  };
  const hub = new HuddleHub(hubPorts);
  const advance = (ms) => { clock += ms; for (const t of [...timers].sort((a, b) => a.at - b.at)) if (t.at <= clock) { timers.splice(timers.indexOf(t), 1); t.fn(); } };
  const spawn = (id, ptyId = `pty-${id}`) => { ptys.set(ptyId, { id: ptyId, lastOutputAt: clock, hasOutput: true }); tracker.spawn(id); };
  const agent = (id, extra = {}) => ({ id, name: names[id] ?? id, character: 'marshall', accent: 'sky', ptyId: `pty-${id}`, ...extra });
  const actionPorts = {
    notifications, ptyIdOf: (id) => hub.ptyIdOf(id), ptyAlive: (p) => ptys.has(p),
    ptyWrite: hubPorts.ptyWrite,
    pause: async () => undefined,
    sendMessage: (agentId, text) => hub.command({ type: 'send', agentId, text, attachments: [] }),
    answerTask: (taskId, text) => { log.answered.push([taskId, text]); return { ok: true }; },
    openAgent: (id) => log.opened.push(id), openSettings: (s) => log.settings.push(s),
    restartAgent: (agentId) => hub.command({ type: 'restart', agentId })
  };
  return { hub, tracker, notifications, log, ptys, tasks, control, advance, spawn, agent, actionPorts, now: () => clock, setNow: (n) => { clock = n; } };
}

const hook = (r, id, event, extra = {}) => r.tracker.hook(id, { event, ...extra });

test('the compact list is every live agent, in the floor\'s order, each in the state its real events put it in', () => {
  const r = rig();
  r.spawn('a1'); r.spawn('a2');
  r.hub.setRoster(1, [r.agent('a1'), r.agent('a2')]);
  hook(r, 'a1', 'UserPromptSubmit', { prompt: 'go' });
  hook(r, 'a1', 'PreToolUse', { tool: 'Read', toolInput: { file_path: '/p/main.ts' } });
  const s = r.hub.state();
  assert.deepEqual(s.agents.map((a) => [a.id, a.state]), [['a1', 'researching'], ['a2', 'idle']]);
  assert.deepEqual(s.agents[0].activity, { verb: 'reading', arg: 'main.ts' });
  assert.equal(s.counts.total, 2);
  assert.equal(s.counts.working, 1);
  assert.equal(s.mainAvailable, true);
});

test('an agent that needs a person goes to the top and stays there; the order of the rest does not shuffle', () => {
  const r = rig();
  for (const id of ['a1', 'a2', 'god']) r.spawn(id);
  r.hub.setRoster(1, [r.agent('a1'), r.agent('a2'), r.agent('god', { isGod: true })]);
  assert.deepEqual(r.hub.state().agents.map((a) => a.id), ['a1', 'a2', 'god']);
  hook(r, 'god', 'PreToolUse', { tool: 'Bash', toolInput: { command: 'ls' } });
  hook(r, 'god', 'Notification', { notificationType: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
  const s = r.hub.state();
  assert.deepEqual(s.agents.map((a) => a.id), ['god', 'a1', 'a2']);
  assert.equal(s.agents[0].state, 'needs-approval');
  assert.ok(s.agents[0].attention, 'its open notification is attached');
  assert.equal(s.agents[0].attention.ids.length, 1);
  assert.equal(s.counts.attention, 1);
});

test('attention clears when the request is resolved, not when anyone looks: the state and the notification agree', () => {
  const r = rig();
  r.spawn('a1');
  r.hub.setRoster(1, [r.agent('a1')]);
  hook(r, 'a1', 'PreToolUse', { tool: 'Bash', toolInput: { command: 'ls' } });
  hook(r, 'a1', 'Notification', { notificationType: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
  const id = r.notifications.openFor('a1')[0].id;
  r.notifications.markRead(id);
  r.hub.setRoster(1, [r.agent('a1')]);
  assert.ok(r.hub.state().agents[0].attention, 'reading it does not resolve it');
  assert.equal(r.hub.state().agents[0].state, 'needs-approval');
  hook(r, 'a1', 'PostToolUse', { tool: 'Bash' });
  assert.equal(r.hub.state().agents[0].attention, null);
  assert.equal(r.hub.state().agents[0].state, 'working');
});

test('progress is the agent\'s own checklist, else its hive tasks, else nothing', () => {
  const r = rig();
  r.spawn('a1');
  r.hub.setRoster(1, [r.agent('a1')]);
  assert.equal(r.hub.state().agents[0].progress, undefined, 'nothing to measure: no bar');
  r.tasks.push({ id: 't1', status: 'done', assignee: 'a1' }, { id: 't2', status: 'doing', assignee: 'a1', title: 'Write the tests' }, { id: 't3', status: 'todo', assignee: 'a1' }, { id: 't4', status: 'todo', assignee: 'a2' });
  assert.deepEqual(r.hub.state().agents[0].progress, { done: 1, total: 3, current: 'Write the tests', source: 'tasks' });
  hook(r, 'a1', 'PreToolUse', { tool: 'TodoWrite', toolInput: { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'pending', activeForm: 'Doing b' }] } });
  assert.deepEqual(r.hub.state().agents[0].progress, { done: 1, total: 2, source: 'todos' });
  r.tasks.length = 0;
  r.tracker.forget('a1');
  assert.equal(r.hub.state().agents[0].progress, undefined);
});

test('one task is not a progress bar', () => {
  const r = rig();
  r.spawn('a1');
  r.hub.setRoster(1, [r.agent('a1')]);
  r.tasks.push({ id: 't1', status: 'doing', assignee: 'a1' });
  assert.equal(r.hub.state().agents[0].progress, undefined);
});

test('paused is read from the control registry, so the two cannot disagree', () => {
  const r = rig();
  r.spawn('a1');
  r.hub.setRoster(1, [r.agent('a1')]);
  r.control.set('a1', { paused: true, halted: false });
  const v = r.hub.state().agents[0];
  assert.equal(v.state, 'paused');
  assert.equal(v.paused, true);
  assert.equal(v.controls.resume, true);
  assert.equal(v.controls.pause, false);
});

test('the floor\'s own status is believed where there is no tracker evidence (waiting, an engine without hooks)', () => {
  const r = rig();
  r.spawn('a1');
  r.hub.setRoster(1, [r.agent('a1', { status: 'waiting' })]);
  assert.equal(r.hub.state().agents[0].state, 'waiting');
  r.hub.setRoster(1, [r.agent('a1', { status: 'working' })]);
  assert.equal(r.hub.state().agents[0].state, 'working');
});

test('an agent that is gone leaves after a short linger, as completed if it had just finished, stopped otherwise', () => {
  const r = rig();
  r.spawn('a1'); r.spawn('a2');
  r.hub.setRoster(1, [r.agent('a1'), r.agent('a2')]);
  assert.equal(r.hub.state().agents.length, 2);
  hook(r, 'a1', 'UserPromptSubmit', { prompt: 'x' });
  r.advance(20_000);
  hook(r, 'a1', 'Stop');
  r.tracker.exit('a1', { exitCode: 0 });
  r.tracker.exit('a2', { exitCode: 0 });
  r.ptys.delete('pty-a1'); r.ptys.delete('pty-a2');
  const gone = r.hub.state();
  assert.deepEqual(gone.agents.map((a) => [a.id, a.state, a.alive]), [['a1', 'completed', false], ['a2', 'stopped', false]]);
  assert.ok(gone.agents.every((a) => a.lingerUntil > r.now()));
  assert.ok(gone.agents.every((a) => !a.controls.send && !a.controls.pause && !a.controls.end), 'nothing can be sent to a process that is gone');
  r.advance(DEPART_LINGER_MS + 1);
  assert.equal(r.hub.state().agents.length, 0, 'and then the cards go');
});

test('a crashed agent stays until its notification is dealt with, then leaves like any other', () => {
  const r = rig();
  r.spawn('a1');
  r.hub.setRoster(1, [r.agent('a1')]);
  r.tracker.exit('a1', { exitCode: 1, tail: 'Error: boom' });
  r.ptys.delete('pty-a1');
  r.advance(DEPART_LINGER_MS * 5);
  const v = r.hub.state().agents[0];
  assert.equal(v.state, 'error');
  assert.equal(v.error, 'Error: boom');
  assert.ok(v.attention);
  assert.equal(v.controls.restart, true);
  r.notifications.dismiss(r.notifications.openFor('a1')[0].id);
  assert.equal(r.hub.state().agents.length, 1, 'it does not vanish under the cursor');
  r.advance(DEALT_WITH_LINGER_MS + 1);
  assert.equal(r.hub.state().agents.length, 0, 'dismissed: it can go');
});

test('a roster entry whose process has died is a departure, not a live card; archived and assistant entries are not listed', () => {
  const r = rig();
  r.spawn('a1');
  r.hub.setRoster(1, [r.agent('a1'), r.agent('a2', { archived: true }), { ...r.agent('asst'), isAssistant: true }, { id: 'nopty', name: 'x', character: 'ted', accent: 'sky' }]);
  r.spawn('a2'); r.spawn('asst');
  assert.deepEqual(r.hub.state().agents.map((a) => a.id), ['a1']);
});

test('with no agents there is an honest empty state; with one agent, one card', () => {
  const r = rig();
  assert.equal(r.hub.state().agents.length, 0);
  assert.equal(r.hub.state().mainAvailable, false);
  r.spawn('a1');
  r.hub.setRoster(1, [r.agent('a1')]);
  assert.equal(r.hub.state().agents.length, 1);
  r.hub.dropSource(1);
  assert.equal(r.hub.state().agents.length, 0, 'closing the window that owns the roster removes its agents from the list');
});

test('the same state is not sent twice, and a burst of changes is one message', () => {
  const r = rig();
  r.spawn('a1');
  r.hub.setRoster(1, [r.agent('a1')]);
  r.hub.setRoster(1, [r.agent('a1')]);
  r.hub.refresh(); r.hub.refresh();
  r.advance(100);
  assert.equal(r.log.broadcasts.length, 1);
  r.hub.refresh();
  r.advance(100);
  assert.equal(r.log.broadcasts.length, 1, 'nothing changed');
  hook(r, 'a1', 'UserPromptSubmit', { prompt: 'x' });
  r.hub.refresh();
  r.advance(100);
  assert.equal(r.log.broadcasts.length, 2);
});

test('a turn that never said it ended is ended by terminal silence, with no completion announced', () => {
  const r = rig();
  r.spawn('a1');
  r.hub.setRoster(1, [r.agent('a1')]);
  hook(r, 'a1', 'UserPromptSubmit', { prompt: 'x' });
  hook(r, 'a1', 'PreToolUse', { tool: 'Bash', toolInput: { command: 'sleep 99' } });
  assert.equal(r.hub.state().agents[0].state, 'working');
  r.advance(5_000); r.hub.tick();
  assert.equal(r.hub.state().agents[0].state, 'working', 'quiet for 5s is still a long command');
  r.advance(10_000); r.hub.tick();
  assert.equal(r.hub.state().agents[0].state, 'idle');
  assert.equal(r.notifications.snapshot().records.length, 0);
});

test('a prompt the terminal parser keeps seeing, that no hook announced, becomes one "stuck" intervention, and goes when it does', () => {
  const r = rig();
  r.spawn('a1');
  r.hub.setRoster(1, [r.agent('a1', { status: 'blocked' })]);
  r.hub.tick();
  assert.equal(r.notifications.openFor('a1').length, 0, 'a flicker is not a stuck agent');
  r.advance(3_000); r.hub.tick();
  const open = r.notifications.openFor('a1');
  assert.equal(open.length, 1);
  assert.equal(open[0].category, 'intervention');
  r.advance(3_000); r.hub.tick();
  assert.equal(r.notifications.openFor('a1').length, 1, 'one episode, one notification');
  r.hub.setRoster(1, [r.agent('a1', { status: 'working' })]);
  r.hub.tick();
  assert.equal(r.notifications.openFor('a1').length, 0);
});

// ─── commands ────────────────────────────────────────────────────────────────

test('send queues the message with the owning window, formatted like the composer, for exactly that agent', async () => {
  const r = rig();
  r.spawn('a1'); r.spawn('a2');
  r.hub.setRoster(7, [r.agent('a1'), r.agent('a2')]);
  const res = await r.hub.command({ type: 'send', agentId: 'a2', text: 'please look at this', attachments: [{ path: '/tmp/shot.png', name: 'shot.png' }] });
  assert.deepEqual(res, { ok: true, queued: true });
  assert.deepEqual(r.log.toOwner, [['a2', 'hive:enqueueToAgent', { targetId: 'a2', text: 'please look at this\n\nAttached files:\n- /tmp/shot.png (shot.png)' }]]);
  assert.equal(r.log.counted, 1, 'counted as a message a person sent');
  assert.deepEqual(r.log.writes, [], 'nothing was typed into any terminal: the queue delivers it when the agent is free');
  const onlyFiles = await r.hub.command({ type: 'send', agentId: 'a1', text: '', attachments: [{ path: '/tmp/a.txt', name: 'a.txt' }] });
  assert.equal(onlyFiles.ok, true);
  assert.equal(r.log.toOwner[1][2].text, 'Attached files:\n- /tmp/a.txt (a.txt)');
});

test('send refuses what it cannot deliver, and says why', async () => {
  const r = rig();
  r.spawn('a1');
  r.hub.setRoster(1, [r.agent('a1'), r.agent('a2')]);
  assert.deepEqual(await r.hub.command({ type: 'send', agentId: 'nobody', text: 'x', attachments: [] }), { ok: false, error: 'unknown-agent' });
  assert.deepEqual(await r.hub.command({ type: 'send', agentId: 'a2', text: 'x', attachments: [] }), { ok: false, error: 'not-running' });
  assert.deepEqual(await r.hub.command({ type: 'send', agentId: 'a1', text: 'x', attachments: [{ path: '/missing/file', name: 'file' }] }), { ok: false, error: 'attachment: missing' });
  assert.equal(r.log.toOwner.length, 0);
});

test('pause, resume, interrupt, end and restart each reach the agent they name and nothing else', async () => {
  const r = rig();
  r.spawn('a1'); r.spawn('a2'); r.spawn('god');
  r.hub.setRoster(1, [r.agent('a1'), r.agent('a2'), r.agent('god', { isGod: true })]);
  hook(r, 'a2', 'UserPromptSubmit', { prompt: 'x' });

  assert.equal((await r.hub.command({ type: 'pause', agentId: 'a1' })).ok, true);
  assert.deepEqual(r.log.paused, [['a1', true]]);
  assert.equal(r.hub.state().agents.find((a) => a.id === 'a1').state, 'paused');
  assert.equal(r.hub.state().agents.find((a) => a.id === 'a2').state, 'working', 'the other agent is untouched');
  assert.equal((await r.hub.command({ type: 'resume', agentId: 'a1' })).ok, true);
  assert.deepEqual(r.log.paused, [['a1', true], ['a1', false]]);

  assert.equal((await r.hub.command({ type: 'interrupt', agentId: 'a2' })).ok, true);
  assert.deepEqual(r.log.writes, [['pty-a2', '\u001b']], 'Escape, in a2\'s terminal only');

  assert.equal((await r.hub.command({ type: 'end', agentId: 'a1' })).ok, true);
  assert.deepEqual(r.log.kills, ['a1']);
  assert.deepEqual(await r.hub.command({ type: 'end', agentId: 'god' }), { ok: false, error: 'not-for-orchestrator' });
  assert.deepEqual(r.log.kills, ['a1']);

  assert.equal((await r.hub.command({ type: 'restart', agentId: 'a2' })).ok, true);
  assert.deepEqual(r.log.asked, [['a2', { type: 'restart', agentId: 'a2' }]]);
});

test('controls offered match what would work: interrupt only while it is busy, resume only while paused', () => {
  const r = rig();
  r.spawn('a1');
  r.hub.setRoster(1, [r.agent('a1')]);
  let c = r.hub.state().agents[0].controls;
  assert.deepEqual(c, { send: true, pause: true, resume: false, interrupt: false, end: true, restart: true });
  hook(r, 'a1', 'UserPromptSubmit', { prompt: 'x' });
  c = r.hub.state().agents[0].controls;
  assert.equal(c.interrupt, true);
  const god = rig();
  god.spawn('god');
  god.hub.setRoster(1, [god.agent('god', { isGod: true })]);
  assert.equal(god.hub.state().agents[0].controls.end, false, 'the orchestrator is not ended from a floating window');
});

test('a command carried out while the main window has gone says so instead of pretending', async () => {
  const r = rig();
  r.spawn('a1');
  r.hub.ports.toOwner = () => false;
  r.hub.setRoster(1, [r.agent('a1')]);
  assert.deepEqual(await r.hub.command({ type: 'send', agentId: 'a1', text: 'x', attachments: [] }), { ok: false, error: 'main-window-unavailable' });
});

test('commands from outside are validated before they are trusted', () => {
  assert.equal(H.validateCommand(null), null);
  assert.equal(H.validateCommand({ type: 'send', agentId: 'a1', text: '', attachments: [] }), null, 'nothing to send');
  assert.equal(H.validateCommand({ type: 'send', agentId: '../etc', text: 'x' }), null, 'a path is not an agent id');
  assert.equal(H.validateCommand({ type: 'send', agentId: 'a1', text: 'x'.repeat(H.MAX_MESSAGE_CHARS + 1) }), null);
  assert.equal(H.validateCommand({ type: 'rm-rf', agentId: 'a1' }), null);
  assert.deepEqual(H.validateCommand({ type: 'pause', agentId: 'a1', extra: 1 }), { type: 'pause', agentId: 'a1' });
  const ok = H.validateCommand({ type: 'send', agentId: 'a1', text: 'hi', attachments: [{ path: '/a/b.png', name: 'b.png' }, { path: 5 }, null, { path: '' }] });
  assert.deepEqual(ok.attachments, [{ path: '/a/b.png', name: 'b.png' }]);
  const many = H.validateCommand({ type: 'send', agentId: 'a1', text: 'hi', attachments: Array.from({ length: 40 }, (_, i) => ({ path: `/f${i}`, name: 'f' })) });
  assert.equal(many.attachments.length, H.MAX_ATTACHMENTS);
  assert.deepEqual(H.validateRoster([{ id: 'a1', name: 'M', character: 'ted', accent: 'sky', evil: { x: 1 } }, { id: 'a1' }, { id: 'bad id!' }, 7]).map((a) => a.id), ['a1']);
});

// ─── notification actions ────────────────────────────────────────────────────

function pendingApproval(r) {
  r.spawn('a1'); r.spawn('a2');
  r.hub.setRoster(1, [r.agent('a1'), r.agent('a2')]);
  hook(r, 'a1', 'PreToolUse', { tool: 'Bash', toolInput: { command: 'npm publish' } });
  hook(r, 'a1', 'Notification', { notificationType: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
  return r.notifications.openFor('a1')[0];
}

test('approve answers the prompt in that agent\'s terminal with Enter, and closes the notification as approved by the person', async () => {
  const r = rig();
  const n = pendingApproval(r);
  assert.deepEqual(await resolveNotification(r.actionPorts, { id: n.id, action: 'approve' }), { ok: true });
  assert.deepEqual(r.log.writes, [['pty-a1', K.KEY_APPROVE]]);
  assert.equal(r.notifications.get(n.id).resolution.action, 'approved');
  assert.equal(r.notifications.get(n.id).resolution.by, 'user');
});

test('reject cancels the prompt with Escape, in the right terminal only', async () => {
  const r = rig();
  const n = pendingApproval(r);
  assert.equal((await resolveNotification(r.actionPorts, { id: n.id, action: 'reject' })).ok, true);
  assert.deepEqual(r.log.writes, [['pty-a1', K.KEY_REJECT]]);
  assert.equal(r.notifications.get(n.id).resolution.action, 'rejected');
});

test('an alternative says no, then queues the person\'s instruction for the same agent', async () => {
  const r = rig();
  const n = pendingApproval(r);
  const res = await resolveNotification(r.actionPorts, { id: n.id, action: 'alternative', text: 'use npm pack instead' });
  assert.equal(res.ok, true);
  assert.deepEqual(r.log.writes, [['pty-a1', K.KEY_REJECT]]);
  assert.deepEqual(r.log.toOwner, [['a1', 'hive:enqueueToAgent', { targetId: 'a1', text: 'use npm pack instead' }]]);
  assert.equal(r.notifications.get(n.id).resolution.action, 'alternative');
});

test('a prompt that has already gone cannot receive a stray keystroke', async () => {
  const r = rig();
  const n = pendingApproval(r);
  hook(r, 'a1', 'PostToolUse', { tool: 'Bash' }); // answered in the terminal a moment ago
  assert.deepEqual(await resolveNotification(r.actionPorts, { id: n.id, action: 'approve' }), { ok: false, error: 'already-resolved' });
  assert.deepEqual(r.log.writes, []);
});

test('if the agent\'s process is gone the answer is not sent and the notification stays open', async () => {
  const r = rig();
  const n = pendingApproval(r);
  r.ptys.delete('pty-a1');
  assert.deepEqual(await resolveNotification(r.actionPorts, { id: n.id, action: 'approve' }), { ok: false, error: 'not-running' });
  assert.equal(r.notifications.get(n.id).resolution, undefined);
});

test('an option on a question the agent asked moves the highlight that far and presses Enter', async () => {
  const r = rig();
  r.spawn('a1');
  r.hub.setRoster(1, [r.agent('a1')]);
  hook(r, 'a1', 'PreToolUse', { tool: 'AskUserQuestion', toolInput: { questions: [{ question: 'Which?', options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }], multiSelect: false }] } });
  const n = r.notifications.openFor('a1')[0];
  assert.deepEqual(await resolveNotification(r.actionPorts, { id: n.id, action: 'option', index: 2 }), { ok: true });
  assert.deepEqual(r.log.writes, [['pty-a1', '\u001b[B'], ['pty-a1', '\u001b[B'], ['pty-a1', '\r']], 'one press at a time, so a menu that redraws between keys is not outrun');
  assert.equal(r.notifications.get(n.id).resolution.note, 'C');
  assert.equal((await resolveNotification(r.actionPorts, { id: n.id, action: 'option', index: 1 })).ok, false);
  const n2 = (hook(r, 'a1', 'PreToolUse', { tool: 'AskUserQuestion', toolInput: { questions: [{ question: 'Again?', options: [{ label: 'A' }], multiSelect: false }] } }), r.notifications.openFor('a1')[0]);
  assert.deepEqual(await resolveNotification(r.actionPorts, { id: n2.id, action: 'option', index: 5 }), { ok: false, error: 'no-such-option' });
});

test('only the buttons a notification offers can be used on it', async () => {
  const r = rig();
  const n = pendingApproval(r);
  r.notifications.ingest({ agentId: 'a1', category: 'completed', title: { key: 'k' }, body: { key: 'k' }, actions: ['open'], requestKey: 'a1|done|1' });
  const done = r.notifications.snapshot().records.find((x) => x.category === 'completed');
  assert.deepEqual(await resolveNotification(r.actionPorts, { id: done.id, action: 'approve' }), { ok: false, error: 'not-offered' });
  assert.deepEqual(await resolveNotification(r.actionPorts, { id: n.id, action: 'answer', text: 'x' }), { ok: false, error: 'not-offered' });
  assert.deepEqual(await resolveNotification(r.actionPorts, { id: 'nope', action: 'approve' }), { ok: false, error: 'unknown-notification' });
  assert.deepEqual(r.log.writes, []);
});

test('an answer to a question the agent put through the hive goes onto its task; open and settings navigate; dismiss closes', async () => {
  const r = rig();
  r.spawn('god');
  r.hub.setRoster(1, [r.agent('god', { isGod: true })]);
  const N = loadTs('src/shared/notifications.ts');
  const ask = r.notifications.ingest(N.intentFromHumanAsk({ id: 'god', name: 'Ted' }, { taskId: 't7', subject: 'Pricing', question: 'Free or paid?', key: 't7:q' }));
  assert.deepEqual(await resolveNotification(r.actionPorts, { id: ask.id, action: 'answer', text: 'Paid' }), { ok: true });
  assert.deepEqual(r.log.answered, [['t7', 'Paid']]);
  assert.equal(r.notifications.get(ask.id).resolution.action, 'answered');

  const access = r.notifications.ingest(N.intentFromAccessDenied({ id: 'god', name: 'Ted' }, { integrationId: 'github' }));
  assert.deepEqual(await resolveNotification(r.actionPorts, { id: access.id, action: 'settings' }), { ok: true });
  assert.deepEqual(r.log.settings, ['Integrations & Skills']);
  assert.equal(r.notifications.get(access.id).resolution, undefined, 'looking at the settings does not grant access, so it stays open');
  assert.equal(r.notifications.get(access.id).read, true);
  assert.deepEqual(await resolveNotification(r.actionPorts, { id: access.id, action: 'open' }), { ok: true });
  assert.deepEqual(r.log.opened, ['god']);
  assert.deepEqual(await resolveNotification(r.actionPorts, { id: access.id, action: 'dismiss' }), { ok: true });
  assert.equal(r.notifications.get(access.id).resolution.action, 'dismissed');
});

test('restart from a crash notification runs Restart & Continue for that agent and closes it', async () => {
  const r = rig();
  r.spawn('a1');
  r.hub.setRoster(1, [r.agent('a1')]);
  r.tracker.exit('a1', { exitCode: 1, tail: 'boom' });
  const n = r.notifications.openFor('a1')[0];
  assert.deepEqual(await resolveNotification(r.actionPorts, { id: n.id, action: 'restart' }), { ok: true });
  assert.deepEqual(r.log.asked, [['a1', { type: 'restart', agentId: 'a1' }]]);
  assert.equal(r.notifications.get(n.id).resolution.note, 'restarted');
});

test('resolve requests from outside are validated', () => {
  assert.equal(validateResolve(null), null);
  assert.equal(validateResolve({ id: 'n1', action: 'format-disk' }), null);
  assert.equal(validateResolve({ id: '', action: 'approve' }), null);
  assert.equal(validateResolve({ id: 'n1', action: 'alternative', text: '   ' }), null);
  assert.equal(validateResolve({ id: 'n1', action: 'option', index: -1 }), null);
  assert.equal(validateResolve({ id: 'n1', action: 'option', index: 1.5 }), null);
  assert.deepEqual(validateResolve({ id: 'n1', action: 'option', index: 1 }), { id: 'n1', action: 'option', index: 1 });
  assert.deepEqual(validateResolve({ id: 'n1', action: 'answer', text: ' yes ' }), { id: 'n1', action: 'answer', text: 'yes' });
});

test('the keys are the ones a person would press', () => {
  assert.equal(K.KEY_APPROVE, '\r');
  assert.equal(K.KEY_REJECT, '\u001b');
  assert.equal(K.keysForOption(0), '\r');
  assert.equal(K.keysForOption(1), '\u001b[B\r');
  assert.equal(K.keysForOption(-3), '\r');
  assert.deepEqual(K.optionKeySteps(2), ['\u001b[B', '\u001b[B', '\r']);
  assert.deepEqual(K.optionKeySteps(0), ['\r']);
});
