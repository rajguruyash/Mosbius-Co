'use strict';

/**
 * The task-complete piano hook plays on exactly one thing: an agent finishing the whole of what it was asked to do. These tests
 * drive the real chain with the payloads Claude Code's hooks send (the activity state machine, the notification service and its
 * sound gate, the sound port) and ask, for every event the brief names, whether the hook plays.
 *
 * The authoritative event is the agent's own `Stop` hook ending a substantial turn: nothing is inferred from terminal output or a
 * generic success status. A helper finishing (`SubagentStop`), a checklist item, a tool result, a command exiting, a pause, a
 * question, a permission prompt, an error, a stop or a cancellation are all other events, and none of them rings it.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const loadTs = require('./load-ts.cjs');

const { NotificationService } = loadTs('src/main/notifyService.ts');
const { handleSignals } = loadTs('src/main/lifecycleWiring.ts');
const { ActivityTracker } = loadTs('src/main/activityTracker.ts');
const { createSoundPortCore } = loadTs('src/main/soundPort.ts');
const A = loadTs('src/shared/agentActivity.ts');
const S = loadTs('src/main/soundSynth.ts');
const N = loadTs('src/shared/notifications.ts');
const P = loadTs('src/shared/soundPolicy.ts');

/** The real chain from a hook to a sound, with a stand-in only for the player (and, optionally, the real port in front of it). */
function rig(opts = {}) {
  let clock = 1_700_000_000_000;
  const asked = [];
  const svc = new NotificationService({
    now: () => clock, load: () => undefined, save: () => undefined, showDesktop: () => 'shown', desktopSupported: () => true,
    playSound: (kind, o) => { asked.push({ kind, interrupt: !!(o && o.interrupt) }); return opts.port ? opts.port.play(kind, o) : true; },
    // the length the gate holds the speakers for is read from the file that will really play, as the app does
    soundMs: opts.realLengths && opts.port ? (k) => opts.port.lengthMs(k) : undefined,
    strings: () => ({}), changed: () => undefined, activate: () => undefined, agentName: (id) => id
  });
  if (opts.prefs) svc.setPrefs({ ...svc.getPrefs(), ...opts.prefs });
  const tracker = new ActivityTracker({
    now: () => clock,
    onSignals: (id, signals, activity) => handleSignals({ notifications: svc, agentRef: (a) => ({ id: a, name: a, isGod: false }), now: () => clock }, id, signals, activity)
  });
  return { svc, tracker, asked, advance: (ms) => { clock += ms; }, now: () => clock };
}

/** A task as it really goes: the agent starts (which rings the soft start cue), then takes its time; a clock that does not advance would leave that cue still sounding. */
const hooks = (r) => ({
  start: (id) => { r.tracker.spawn(id); r.tracker.hook(id, { event: 'UserPromptSubmit', prompt: 'refactor the parser and add tests' }); r.advance(3000); },
  work: (id, tools = 3) => { for (let i = 0; i < tools; i++) { r.tracker.hook(id, { event: 'PreToolUse', tool: 'Edit', toolInput: { file_path: `/repo/src/f${i}.ts` } }); r.tracker.hook(id, { event: 'PostToolUse', tool: 'Edit' }); r.advance(6000); } },
  stop: (id) => r.tracker.hook(id, { event: 'Stop' })
});
const hookRings = (r) => r.asked.filter((s) => s.kind === 'completed');
const completions = (r) => r.svc.snapshot().records.filter((x) => x.category === 'completed');

// ─── what triggers it ────────────────────────────────────────────────────────

test('1. an agent finishing the whole of its task plays the piano hook, once, and records the completion', () => {
  const r = rig();
  const h = hooks(r);
  h.start('a1'); h.work('a1'); h.stop('a1');
  assert.deepEqual(hookRings(r), [{ kind: 'completed', interrupt: false }]);
  assert.equal(completions(r).length, 1);
  assert.equal(completions(r)[0].delivery.sound, 'played');
  // and what rings is the piano hook: the progression, played by a piano, several voices at once
  assert.ok(S.SCORES.completed.notes.every((n) => n.voice === 'grand') && S.SCORES.completed.notes.length >= 30);
  assert.equal(N.soundFor('completed', 'normal'), 'completed');
});

test('the authoritative event is a Stop that ends a substantial turn: the state machine says "completed" there and nowhere else', () => {
  const T0 = 1_700_000_000_000;
  const fold = (events) => { let a = A.newActivity('a1', T0); const signals = []; for (const e of events) { const x = A.reduceActivity(a, e); a = x.next; signals.push(...x.signals); } return signals; };
  const ev = (at, event, extra = {}) => ({ type: 'hook', at: T0 + at, event, ...extra });
  const substantial = (signals) => signals.filter((s) => s.kind === 'turn-completed' && s.substantial);
  const full = [ev(0, 'UserPromptSubmit', { prompt: 'x' }), ev(1, 'PreToolUse', { tool: 'Edit', toolInput: {} }), ev(2, 'PreToolUse', { tool: 'Edit', toolInput: {} }), ev(3, 'PreToolUse', { tool: 'Edit', toolInput: {} })];
  assert.equal(substantial(fold([...full, ev(4, 'Stop')])).length, 1, 'the Stop of a substantial turn');
  assert.equal(substantial(fold([...full, ev(4, 'SubagentStop')])).length, 0, 'a helper stopping is not the task stopping');
  assert.equal(substantial(fold(full)).length, 0, 'nor is any amount of work without a Stop');
  assert.equal(substantial(fold([...full, ev(4, 'Stop', { blocked: true })])).length, 0, 'a Stop that is turned back to keep working');
  assert.equal(substantial(fold([...full, ev(4, 'Stop'), ev(5, 'Stop'), ev(6, 'Stop')])).length, 1, 'repeated Stops are one completion');
  assert.equal(substantial(fold([...full, ev(4, 'StopFailure')])).length, 0, 'a turn that ended in an error is not a completion');
});

// ─── what does not ───────────────────────────────────────────────────────────

test('2. a helper (sub-task) finishing inside the agent\'s turn does not play it; the real end of the task does', () => {
  const r = rig();
  const h = hooks(r);
  h.start('a1');
  r.tracker.hook('a1', { event: 'PreToolUse', tool: 'Task', toolInput: { description: 'write the tests' } });
  h.work('a1', 4);
  r.tracker.hook('a1', { event: 'SubagentStop' });
  r.tracker.hook('a1', { event: 'PostToolUse', tool: 'Task' });
  r.tracker.hook('a1', { event: 'SubagentStop' });
  assert.deepEqual(hookRings(r), [], 'two helpers finished, the task did not');
  assert.equal(completions(r).length, 0);
  h.stop('a1');
  assert.equal(hookRings(r).length, 1);
});

test('3. intermediate progress does not play it: checklist items, tool results, commands finishing, each ticked off in turn, even the last item', () => {
  const r = rig();
  const h = hooks(r);
  h.start('a1');
  const todos = (done) => ({ todos: ['plan', 'edit', 'test'].map((content, i) => ({ content, activeForm: `doing ${content}`, status: i < done ? 'completed' : i === done ? 'in_progress' : 'pending' })) });
  for (const done of [0, 1, 2, 3]) {
    r.tracker.hook('a1', { event: 'PreToolUse', tool: 'TodoWrite', toolInput: todos(done) });
    r.tracker.hook('a1', { event: 'PostToolUse', tool: 'TodoWrite', toolInput: todos(done) });
    r.tracker.hook('a1', { event: 'PreToolUse', tool: 'Bash', toolInput: { command: 'npm test' } });
    r.tracker.hook('a1', { event: 'PostToolUse', tool: 'Bash' });                  // a command exited successfully
  }
  assert.deepEqual(hookRings(r), [], 'every checklist item is done and the agent has not said it is finished');
  assert.deepEqual(r.asked.filter((s) => s.kind !== 'started'), []);
  h.stop('a1');
  assert.equal(hookRings(r).length, 1);
});

test('4. a permission request does not play it (it rings the approval sound), and neither does a question (the input sound)', () => {
  const r = rig();
  const h = hooks(r);
  h.start('a1'); h.work('a1');
  r.tracker.hook('a1', { event: 'PreToolUse', tool: 'Bash', toolInput: { command: 'git push origin main' } });
  r.tracker.hook('a1', { event: 'Notification', notificationType: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
  assert.deepEqual(r.asked.filter((s) => s.kind !== 'started').map((s) => s.kind), ['approval']);
  r.advance(4000);
  h.start('b1');
  r.tracker.hook('b1', { event: 'PreToolUse', tool: 'AskUserQuestion', toolInput: { questions: [{ question: 'Which database?', options: [{ label: 'Postgres' }, { label: 'SQLite' }] }] } });
  assert.deepEqual(r.asked.filter((s) => s.kind !== 'started').map((s) => s.kind), ['approval', 'input']);
  assert.equal(hookRings(r).length, 0);
});

test('5. a failed task does not play it: a crash, tool failures with no finish, a turn that ended in an error, a short answer', () => {
  // the process dies in the middle of the work: that is a critical error, not a completion
  const crash = rig();
  const c = hooks(crash);
  c.start('a1'); c.work('a1');
  crash.tracker.hook('a1', { event: 'PostToolUseFailure', tool: 'Bash' });
  crash.tracker.exit('a1', { exitCode: 1, tail: 'Error: out of memory' });
  assert.deepEqual(crash.asked.filter((s) => s.kind !== 'started').map((s) => s.kind), ['critical']);
  assert.equal(completions(crash).length, 0);

  // the tools keep failing and the turn ends in an error (the CLI's StopFailure), or the agent just goes quiet
  const fail = rig();
  const f = hooks(fail);
  f.start('a1'); f.work('a1');
  for (let i = 0; i < 3; i++) fail.tracker.hook('a1', { event: 'PostToolUseFailure', tool: 'Bash' });
  fail.tracker.hook('a1', { event: 'StopFailure' });
  fail.tracker.quiet('a1', A.QUIESCE_MS + 1);
  assert.deepEqual(hookRings(fail), []);
  assert.equal(completions(fail).length, 0);

  // a one-line answer is not a task finished
  const quick = rig();
  quick.tracker.hook('a1', { event: 'UserPromptSubmit', prompt: 'hi' });
  quick.advance(2000);
  quick.tracker.hook('a1', { event: 'Stop' });
  assert.deepEqual(hookRings(quick), []);
});

test('6. a cancelled or stopped task does not play it: an interrupt, a killed process, a pause, a Stop that was turned back', () => {
  const interrupted = rig();
  const i = hooks(interrupted);
  i.start('a1'); i.work('a1');
  interrupted.advance(A.QUIESCE_MS + 1000);
  interrupted.tracker.quiet('a1', A.QUIESCE_MS + 1);                      // the person pressed Escape: there is no Stop, only silence
  assert.deepEqual(hookRings(interrupted), []);

  const killed = rig();
  const k = hooks(killed);
  k.start('a1'); k.work('a1');
  killed.tracker.exit('a1', { signal: 15 });                              // the agent was stopped from the app
  assert.deepEqual(hookRings(killed), []);
  assert.equal(completions(killed).length, 0);

  const paused = rig();
  const p = hooks(paused);
  p.start('a1'); p.work('a1');
  paused.tracker.control('a1', { paused: true, halted: false });
  assert.deepEqual(hookRings(paused), []);

  const turnedBack = rig();
  const t = hooks(turnedBack);
  t.start('a1'); t.work('a1');
  turnedBack.tracker.hook('a1', { event: 'Stop', stopHookActive: true });
  turnedBack.tracker.hook('a1', { event: 'Stop', blocked: true });
  assert.deepEqual(hookRings(turnedBack), []);
});

test('7. a duplicate completion does not play it twice, and a genuinely new task later does', () => {
  const r = rig();
  const h = hooks(r);
  h.start('a1'); h.work('a1');
  h.stop('a1'); h.stop('a1'); h.stop('a1');
  assert.equal(hookRings(r).length, 1, 'three Stops for one task');
  assert.equal(completions(r).length, 1, 'and one record of it');
  r.advance(P.SOUND_META.completed.cooldownMs + 500);
  h.start('a1'); h.work('a1'); h.stop('a1');
  assert.equal(hookRings(r).length, 2, 'the next task, well after the first');
  assert.equal(completions(r).length, 2);
});

test('8. agents finishing together ring one hook, not a pile of them: later finishes inside the window are coalesced, urgent news still gets through', () => {
  const r = rig();
  const h = hooks(r);
  for (const id of ['a1', 'a2', 'a3', 'a4', 'a5', 'a7']) { h.start(id); h.work(id); }     // six agents, each well into a task
  for (const id of ['a1', 'a2', 'a3', 'a4']) { r.advance(60); h.stop(id); }
  assert.equal(hookRings(r).length, 1, 'four agents, one hook');
  assert.equal(completions(r).length, 4, 'every completion is still recorded');
  assert.deepEqual(completions(r).map((x) => x.delivery.sound), ['played', 'muted', 'muted', 'muted']);
  r.advance(2500);                                                        // the hook is still sounding
  h.stop('a5');
  assert.equal(hookRings(r).length, 1, 'a fifth finish while it plays does not start another');
  // a permission prompt is more urgent than the hook: it takes over at once
  r.tracker.hook('a6', { event: 'UserPromptSubmit', prompt: 'x' });
  r.tracker.hook('a6', { event: 'PreToolUse', tool: 'Bash', toolInput: { command: 'rm -rf build' } });
  r.tracker.hook('a6', { event: 'Notification', notificationType: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
  assert.deepEqual(r.asked.at(-1), { kind: 'approval', interrupt: true });
  // and once the window has passed, a finish rings again
  r.advance(P.SOUND_META.completed.cooldownMs + 100);
  h.stop('a7');
  assert.equal(hookRings(r).length, 2);
});

// ─── preferences, preview, and keeping out of the agent's way ────────────────

test('9. the preferences are respected: sounds off, the completed kind off, and the master volume', async () => {
  const off = rig({ prefs: { sound: false } });
  const o = hooks(off);
  o.start('a1'); o.work('a1'); o.stop('a1');
  assert.deepEqual(hookRings(off), []);
  assert.equal(completions(off)[0].delivery.sound, 'off');
  assert.equal(completions(off).length, 1, 'the completion is still recorded');

  const kindOff = rig({ prefs: { categories: { ...N.defaultPrefs().categories, completed: false } } });
  const k = hooks(kindOff);
  k.start('a1'); k.work('a1'); k.stop('a1');
  assert.deepEqual(hookRings(kindOff), []);

  // the master volume reaches the player: a gain for the slider, and no player at all at zero
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-done-'));
  const spawned = [];
  let volume = 0.5;
  const port = createSoundPortCore({ dataDir: dir, volume: () => volume, platform: 'darwin', spawn: (cmd, args) => { const c = { cmd, args, on: () => c, unref: () => undefined, kill: () => true }; spawned.push(c); return c; }, beep: () => undefined });
  await port.warm();
  const hookPlayers = () => spawned.filter((c) => /completed-v\d+\.wav$/.test(c.args[2]));
  const loud = rig({ port });
  const l = hooks(loud);
  l.start('a1'); l.work('a1'); l.stop('a1');
  assert.equal(hookPlayers().length, 1);
  assert.equal(hookPlayers()[0].args[1], '0.25', 'a slider at 50% is a gain of 0.25');
  volume = 0;
  const mute = rig({ port });
  const m = hooks(mute);
  m.start('a1'); m.work('a1'); m.stop('a1');
  assert.equal(hookPlayers().length, 1, 'at zero volume no player is started');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('10. the preview plays the hook with no task running, creates nothing, and changes no agent', () => {
  const r = rig();
  const h = hooks(r);
  h.start('a1'); h.work('a1');                                            // an agent in the middle of a task
  const before = JSON.stringify({ records: r.svc.snapshot().records, state: r.tracker.get('a1').turn, activity: r.tracker.get('a1').activity });
  assert.equal(r.svc.previewSound('completed'), 'played');
  assert.deepEqual(hookRings(r), [{ kind: 'completed', interrupt: false }]);
  assert.equal(JSON.stringify({ records: r.svc.snapshot().records, state: r.tracker.get('a1').turn, activity: r.tracker.get('a1').activity }), before, 'no record, no change to the agent');
  const idle = rig({ prefs: { sound: false } });
  assert.equal(idle.svc.previewSound('completed'), 'played', 'with no agent at all, and with notification sounds off');
  assert.equal(idle.svc.snapshot().records.length, 0);
});

test('11. playing the hook never holds up the agent: finishing a task returns at once even when the sound has never been made, and the sound follows', async () => {
  S.forgetRenderedCues();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-done-'));
  const spawned = [];
  const port = createSoundPortCore({ dataDir: dir, volume: () => 0.8, platform: 'darwin', spawn: (cmd, args) => { const c = { cmd, args, on: () => c, unref: () => undefined, kill: () => true }; spawned.push(c); return c; }, beep: () => undefined });
  const r = rig({ port });
  const h = hooks(r);
  h.start('a1'); h.work('a1');
  // the yardstick: what rendering the hook in one go costs on this machine right now (a fixed number of milliseconds fails on a busy one)
  const b0 = performance.now();
  S.renderCueFresh('completed');
  const blockingMs = performance.now() - b0;
  const t0 = performance.now();
  h.stop('a1');                                                            // the completion, with an empty sounds folder
  const took = performance.now() - t0;
  assert.ok(took < blockingMs / 5, `handling the finish took ${took.toFixed(1)} ms with nothing rendered yet (rendering the hook in one go takes ${blockingMs.toFixed(0)} ms here)`);
  assert.equal(r.tracker.get('a1').activity.verb, 'finished', 'the agent\'s own state moved on at once');
  assert.equal(completions(r).length, 1, 'and the notification was recorded');
  assert.equal(spawned.length, 0, 'the sounds are not there yet');
  await port.idle();
  const hookPlayers = spawned.filter((c) => /completed-v\d+\.wav$/.test(c.args[2]));
  assert.equal(hookPlayers.length, 1, 'and then the hook plays, once');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ─── a sound longer than the app's own, standing in for it from the bundled folder ───────────────────────────────────────────
// The repository ships no recorded audio (test/bundled-sound.test.cjs). The port can still play a longer WAV from the bundled folder or
// a person's own, and what that does to the gate (its real length holds the speakers, and widens the pause after it) is held here with a
// WAV made for the test.

/** A mono 16-bit WAV of the given length: a tone, made here, standing in for any sound longer than the app's own. */
function pcmWav(seconds, level = 4000, rate = 44100) {
  const n = Math.round(seconds * rate);
  const out = Buffer.alloc(44 + n * 2);
  out.write('RIFF', 0); out.writeUInt32LE(36 + n * 2, 4); out.write('WAVE', 8); out.write('fmt ', 12);
  out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22); out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * 2, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34); out.write('data', 36); out.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) out.writeInt16LE(Math.round(level * Math.sin((2 * Math.PI * 440 * i) / rate)), 44 + i * 2);
  return out;
}

/** The real chain with the real port and a seven-second WAV made for the test in the bundled folder, and a stand-in only for the player. */
function longSoundRig(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-done-'));
  const bundled = path.join(dir, 'bundled');
  fs.mkdirSync(bundled);
  fs.writeFileSync(path.join(bundled, 'completed.wav'), pcmWav(7));
  const spawned = [];
  const kills = [];
  const port = createSoundPortCore({
    dataDir: dir, bundledDir: bundled, volume: () => 0.8, platform: 'darwin',
    spawn: (cmd, args) => { const c = { cmd, args, on: () => c, unref: () => undefined, kill: () => { kills.push(args.at(-1)); return true; } }; spawned.push(c); return c; },
    beep: () => undefined
  });
  const r = rig({ port, realLengths: true, prefs: opts.prefs });
  return {
    r, port, spawned, kills, dir,
    longs: () => spawned.filter((c) => /[\\/]completed\.wav$/.test(c.args.at(-1))),
    own: () => fs.existsSync(path.join(dir, 'sounds', S.soundFileName('completed'))),
    done: async () => { await port.idle(); fs.rmSync(dir, { recursive: true, force: true }); }
  };
}

test('12. a longer sound in the bundled folder plays for the finish: its real seven seconds hold the speakers, finishes inside about ten seconds are the same news, an urgent sound takes over, and nothing is rendered for it', async () => {
  const s = longSoundRig();
  const h = hooks(s.r);
  await s.port.warm();                                                    // every other sound is made, so each one plays at once, as in a running app (the stand-in needs nothing made)
  assert.equal(s.port.lengthMs('completed'), 7000, 'the length the gate holds the speakers for is read from the file that will play');
  for (const id of ['a1', 'a2', 'a3', 'a4', 'a5']) { h.start(id); h.work(id); }      // five agents, each well into a task
  h.stop('a1');                                                           // T0: the finish rings the stand-in
  assert.equal(s.longs().length, 1, 'the finish plays the longer sound');
  assert.equal(hookRings(s.r).length, 1);
  assert.equal(s.own(), false, 'and the app\'s own hook was not even made for it');
  s.r.advance(4000); h.stop('a2');                                        // still sounding: it lasts seven seconds
  s.r.advance(4000); h.stop('a3');                                        // T0 + 8 s: it has ended, but the pause after it has not
  assert.equal(s.longs().length, 1, 'finishes inside the sound and the pause after it are the same news');
  assert.deepEqual(completions(s.r).map((x) => x.delivery.sound), ['played', 'muted', 'muted'], 'and every one of them is still recorded');
  s.r.advance(2000); h.stop('a4');                                        // T0 + 10 s: past the six seconds plus the 3.65 s by which it outlasts the app\'s own hook
  assert.equal(s.longs().length, 2, 'later still, a finish rings it again');
  s.r.advance(2000);
  s.r.tracker.hook('a5', { event: 'PreToolUse', tool: 'Bash', toolInput: { command: 'rm -rf build' } });
  s.r.tracker.hook('a5', { event: 'Notification', notificationType: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
  assert.deepEqual(s.r.asked.at(-1), { kind: 'approval', interrupt: true }, 'a permission prompt is more urgent than it and takes over at once');
  assert.equal(s.kills.length, 1);
  assert.match(s.kills[0], /[\\/]completed\.wav$/, 'it is the longer sound\'s player that was stopped to let it');
  await s.done();
});

test('13. a longer sound standing in for the app\'s own obeys the switches like any other: with its own switch off the finish is recorded and silent, and its preview still plays it', async () => {
  const s = longSoundRig({ prefs: { cues: { ...N.defaultPrefs().cues, completed: false } } });
  const h = hooks(s.r);
  h.start('a1'); h.work('a1'); h.stop('a1');
  assert.deepEqual(hookRings(s.r), [], 'the sound\'s own switch is off: the player is not asked');
  assert.equal(s.longs().length, 0);
  assert.equal(completions(s.r).length, 1, 'the completion is still recorded');
  assert.equal(completions(s.r)[0].delivery.sound, 'off');
  assert.equal(s.r.svc.previewSound('completed'), 'played');
  assert.equal(s.longs().length, 1, 'but its play button plays it');
  assert.equal(completions(s.r).length, 1, 'and creates nothing');
  await s.done();
});
