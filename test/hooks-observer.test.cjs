'use strict';

/**
 * The lifecycle observer on HookServer: what the activity tracker and the notification service are fed from. Every
 * real hook is seen (with its tool input), telemetry is not, a throwing observer cannot break an agent's hook, and
 * once an observer is installed the old per-hook toasts stand down so a person is never told twice.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const electron = require.resolve('electron');
const banners = [];
require.cache[electron] = {
  id: electron, filename: electron, loaded: true,
  exports: { Notification: class { constructor(o) { this.o = o; } show() { banners.push(this.o); } static isSupported() { return true; } } }
};

const { HiveManager } = loadTs('src/main/hive.ts');
const { HookServer } = loadTs('src/main/hooks.ts');
const { ActivityTracker } = loadTs('src/main/activityTracker.ts');

async function rig(t, config = { notifications: true }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-hooks-obs-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'a1', name: 'Marshall', provider: 'claude', cwd: home });
  const server = new HookServer(hive, () => null, () => config, undefined, undefined);
  const seen = [];
  server.setObserver((agentId, h) => seen.push([agentId, h]));
  banners.length = 0;
  return { server, seen, fire: (p) => server.handle({ agent_id: 'a1', session_id: 's1', ...p }) };
}

test('every real hook is observed with what the agent sent, including the tool input', async (t) => {
  const { seen, fire } = await rig(t);
  await fire({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } });
  await fire({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
  await fire({ hook_event_name: 'UserPromptSubmit', prompt: 'hello' });
  await fire({ hook_event_name: 'Stop' });
  assert.deepEqual(seen.map(([id, h]) => [id, h.event]), [['a1', 'PreToolUse'], ['a1', 'Notification'], ['a1', 'UserPromptSubmit'], ['a1', 'Stop']]);
  assert.deepEqual(seen[0][1].toolInput, { command: 'ls' });
  assert.equal(seen[0][1].tool, 'Bash');
  assert.equal(seen[1][1].notificationType, 'permission_prompt');
  assert.equal(seen[2][1].prompt, 'hello');
});

test('the status line and cost samples are telemetry, not lifecycle: they are not observed', async (t) => {
  const { seen, fire } = await rig(t);
  await fire({ hook_event_name: 'Status', context_window: { total_input_tokens: 10, context_window_size: 100 } });
  await fire({ hook_event_name: 'CostSample', input: 1, output: 1, model: 'm' });
  assert.deepEqual(seen, []);
});

test('an agent that is halted or paused is still observed: it is still an agent the person wants to know about', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-hooks-obs-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'a1', name: 'M', provider: 'claude', cwd: home });
  const { ControlRegistry } = loadTs('src/main/control.ts');
  const control = new ControlRegistry();
  control.halt('a1');
  const server = new HookServer(hive, () => null, () => ({}), control, undefined);
  const seen = [];
  server.setObserver((id, h) => seen.push(h.event));
  const res = await server.handle({ agent_id: 'a1', hook_event_name: 'PreToolUse', tool_name: 'Bash' });
  assert.deepEqual(seen, ['PreToolUse']);
  assert.equal(res.continue, false, 'and the halt still applies');
});

test('an observer that throws cannot break the hook: the agent gets its normal answer', async (t) => {
  const { server, fire } = await rig(t);
  const quiet = console.error; console.error = () => undefined;
  t.after(() => { console.error = quiet; });
  server.setObserver(() => { throw new Error('boom'); });
  const res = await fire({ hook_event_name: 'Stop' });
  assert.deepEqual(res, {});
});

test('an event with no agent id is not handed to the observer', async (t) => {
  const { server, seen } = await rig(t);
  await server.handle({ hook_event_name: 'Stop' });
  assert.deepEqual(seen, []);
});

test('with an observer installed the old "finished" and "waiting" toasts stand down; without one they still fire', async (t) => {
  const withObs = await rig(t);
  await withObs.fire({ hook_event_name: 'Stop' });
  await withObs.fire({ hook_event_name: 'Notification', notification_type: 'idle', message: 'Claude is waiting for your input' });
  assert.equal(banners.length, 0, 'the notification service owns these now');
  const without = await rig(t);
  without.server.setObserver(null);
  await without.fire({ hook_event_name: 'Stop' });
  assert.equal(banners.length, 1, 'the old path is intact when nothing has taken over');
});

test('the observer drives the tracker the way the app wires it: a permission prompt is seen with its tool', async (t) => {
  const { server, fire } = await rig(t);
  const tracker = new ActivityTracker();
  server.setObserver((agentId, h) => tracker.hook(agentId, h));
  await fire({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm -rf build' } });
  await fire({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
  assert.equal(tracker.get('a1').pending.kind, 'approval');
  assert.match(tracker.get('a1').pending.preview, /rm -rf build/);
});

test('the CLI\'s own id for a tool call travels with the hook, and is dropped when it is not a plain string', async (t) => {
  const { seen, fire } = await rig(t);
  await fire({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'toolu_abc123', tool_input: { command: 'ls' } });
  await fire({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: { not: 'a string' } });
  await fire({ hook_event_name: 'PostToolUse', tool_name: 'Bash' });
  assert.equal(seen[0][1].toolUseId, 'toolu_abc123');
  assert.equal(seen[1][1].toolUseId, undefined);
  assert.equal(seen[2][1].toolUseId, undefined);
});
