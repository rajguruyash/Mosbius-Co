'use strict';

/**
 * Mirroring a terminal into a second window (the Huddle's terminal view) with the real PtyManager and a real
 * process: what is already on the screen is replayed, new output follows, the owner's own stream is untouched,
 * and a window that goes away stops being written to.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { PtyManager } = loadTs('src/main/pty.ts');
const POSIX = process.platform !== 'win32';

function fakeWindow() {
  const sent = [];
  let destroyed = false;
  return { sent, send: (channel, payload) => { sent.push([channel, payload]); }, isDestroyed: () => destroyed, destroy: () => { destroyed = true; } };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000) { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await wait(20); } return false; }
const dataOf = (w) => w.sent.filter(([c]) => c === 'huddle:ptyData').map(([, p]) => p.data).join('');

test('a tap gets what is already on the screen, then everything new, and the owner still gets its own stream', { skip: !POSIX }, async (t) => {
  const mgr = new PtyManager();
  const owner = fakeWindow();
  const tap = fakeWindow();
  t.after(() => mgr.killAll());
  assert.equal(mgr.spawn({ id: 'p1', cwd: process.cwd(), command: '/bin/sh', args: ['-c', 'echo before-the-tap; sleep 0.4; echo after-the-tap; sleep 0.5'] }, owner).ok, true);
  assert.ok(await until(() => mgr.list()[0]?.hasOutput));
  await wait(100);
  const res = mgr.addTap('p1', tap);
  assert.equal(res.ok, true);
  assert.match(res.replay, /before-the-tap/, 'the replay is what was already printed');
  assert.ok(res.cols > 0 && res.rows > 0);
  assert.equal(mgr.tapCount('p1'), 1);
  assert.ok(await until(() => /after-the-tap/.test(dataOf(tap))), 'new output reaches the tap');
  assert.ok(!/before-the-tap/.test(dataOf(tap)), 'and the replay is not sent twice');
  assert.ok(owner.sent.some(([c, d]) => c === 'pty:data:p1' && /after-the-tap/.test(d)), 'the owner window is unaffected');
  assert.ok(owner.sent.every(([c]) => !c.startsWith('huddle:')), 'the mirror channels never go to the owner');
});

test('removing a tap stops delivery; a window that is destroyed is dropped without an error', { skip: !POSIX }, async (t) => {
  const mgr = new PtyManager();
  const a = fakeWindow(); const b = fakeWindow();
  t.after(() => mgr.killAll());
  mgr.spawn({ id: 'p2', cwd: process.cwd(), command: '/bin/sh', args: ['-c', 'while true; do echo tick; sleep 0.05; done'] }, null);
  assert.ok(await until(() => mgr.list()[0]?.hasOutput));
  mgr.addTap('p2', a); mgr.addTap('p2', b);
  assert.equal(mgr.tapCount('p2'), 2);
  assert.ok(await until(() => dataOf(a).includes('tick') && dataOf(b).includes('tick')));
  mgr.removeTap('p2', a);
  const aBefore = a.sent.length;
  b.destroy();
  await wait(300);
  assert.equal(a.sent.length, aBefore, 'a removed tap hears nothing more');
  assert.equal(mgr.tapCount('p2'), 0, 'the destroyed window was dropped');
});

test('a window that closes is removed from every terminal it was watching', { skip: !POSIX }, async (t) => {
  const mgr = new PtyManager();
  const w = fakeWindow();
  t.after(() => mgr.killAll());
  for (const id of ['p3', 'p4']) mgr.spawn({ id, cwd: process.cwd(), command: '/bin/sh', args: ['-c', 'sleep 5'] }, null);
  mgr.addTap('p3', w); mgr.addTap('p4', w);
  mgr.removeTapsFor(w);
  assert.equal(mgr.tapCount('p3') + mgr.tapCount('p4'), 0);
});

test('tapping a terminal that does not exist is an error, not a silent success', () => {
  const mgr = new PtyManager();
  const r = mgr.addTap('nope', fakeWindow());
  assert.equal(r.ok, false);
});

test('the replay is bounded, and never begins in the middle of a line', { skip: !POSIX }, async (t) => {
  const mgr = new PtyManager();
  const w = fakeWindow();
  t.after(() => mgr.killAll());
  mgr.spawn({ id: 'p5', cwd: process.cwd(), command: '/bin/sh', args: ['-c', 'i=0; while [ $i -lt 4000 ]; do echo "line-$i-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"; i=$((i+1)); done; sleep 2'] }, null);
  assert.ok(await until(() => mgr.list().length === 1));
  await wait(1200);
  const r = mgr.addTap('p5', w);
  assert.equal(r.ok, true);
  assert.ok(r.replay.length <= 96 * 1024, `replay is ${r.replay.length} bytes`);
  assert.ok(r.replay.length > 40 * 1024, 'and it is the newest part, not nothing');
  assert.match(r.replay, /^line-\d+-x+/, 'the first line is whole');
  assert.match(r.replay, /line-3999-/, 'the newest line is there');
});

test('a tap hears when the process ends, and the terminal size follows a resize', { skip: !POSIX }, async (t) => {
  const mgr = new PtyManager();
  const w = fakeWindow();
  t.after(() => mgr.killAll());
  mgr.setExitHandler(() => undefined);
  mgr.spawn({ id: 'p6', cwd: process.cwd(), command: '/bin/sh', args: ['-c', 'sleep 0.6; exit 3'], cols: 80, rows: 24 }, null);
  mgr.addTap('p6', w);
  assert.deepEqual(mgr.geometry('p6'), { cols: 80, rows: 24 });
  mgr.resize('p6', 100, 30);
  const geo = w.sent.find(([c]) => c === 'huddle:ptyGeometry');
  assert.deepEqual(geo[1], { id: 'p6', cols: 100, rows: 30 });
  assert.ok(await until(() => w.sent.some(([c]) => c === 'huddle:ptyExit')));
  assert.equal(w.sent.find(([c]) => c === 'huddle:ptyExit')[1].exitCode, 3);
  assert.equal(mgr.tapCount('p6'), 0, 'a finished terminal keeps no windows');
});
