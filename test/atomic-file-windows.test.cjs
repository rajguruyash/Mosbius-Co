'use strict';

/**
 * The file lock and atomic write under WINDOWS conditions.
 *
 * HONEST SCOPE: these tests run on whatever OS runs the suite. On macOS/Linux
 * they cannot prove how Windows behaves; what they prove is that the code does
 * the right thing when the file system answers the way Windows is known to
 * answer. The faults are injected:
 *
 *   • a rename or delete that fails with EPERM/EACCES/EBUSY because a virus
 *     scanner, the search indexer or a backup tool has the file open for a moment;
 *   • a lock file that another process deleted but still holds open ("delete
 *     pending"), which cannot be re-created yet and answers EPERM, not EEXIST;
 *   • a directory that cannot be opened for fsync.
 *
 * The same file, run on a real Windows machine (`node --test
 * test/atomic-file-windows.test.cjs`), also exercises the genuine article: the
 * kill tests below use real child processes, and every assertion that depends on
 * POSIX file modes is skipped there. See MCP_BROKER_DESIGN.md §12.2 for what has
 * and has not been verified on Windows.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const { writeFileAtomic, withFileLock, LockTimeoutError, readTextRetry, atomicFileEnv } = loadTs('src/main/atomicFile.ts');
const CHILD = path.join(__dirname, 'fixtures', 'atomic-file-child.cjs');

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-win-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const leftovers = (dir) => fs.readdirSync(dir).filter((n) => n.includes('.tmp-'));

function platform(t, value) {
  const before = atomicFileEnv.platform;
  atomicFileEnv.platform = value;
  t.after(() => { atomicFileEnv.platform = before; });
}

/**
 * Make `fs[name]` throw `code` for the first `times` matching calls (Infinity =
 * always), then behave. Returns a counter of how many matching calls were made.
 */
function flaky(t, name, code, times, match = () => true) {
  const original = fs[name];
  const state = { calls: 0, failed: 0 };
  fs[name] = function patched(...args) {
    if (match(args)) {
      state.calls++;
      if (state.failed < times) { state.failed++; throw Object.assign(new Error(`${code}: injected`), { code }); }
    }
    return original.apply(this, args);
  };
  t.after(() => { fs[name] = original; });
  return state;
}

const lockOf = (dir) => path.join(dir, 'store.lock');
const isLockCreate = (lock) => (args) => String(args[0]) === lock && args[1] === 'wx';

// ─── rename ─────────────────────────────────────────────────────────────────

for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
  test(`win32: a rename blocked by a scanner (${code}) is retried and the write lands`, (t) => {
    platform(t, 'win32');
    const dir = tmpDir(t);
    const file = path.join(dir, 'store.json');
    writeFileAtomic(file, 'old');
    const rename = flaky(t, 'renameSync', code, 3, (a) => String(a[1]) === file);
    writeFileAtomic(file, 'new');
    assert.equal(fs.readFileSync(file, 'utf8'), 'new');
    assert.equal(rename.calls, 4, 'three refusals, then success');
    assert.deepEqual(leftovers(dir), []);
  });
}

test('win32: a rename that never succeeds fails within a bounded time and changes nothing', (t) => {
  platform(t, 'win32');
  const dir = tmpDir(t);
  const file = path.join(dir, 'store.json');
  writeFileAtomic(file, 'old');
  flaky(t, 'renameSync', 'EPERM', Infinity, (a) => String(a[1]) === file);
  const started = Date.now();
  assert.throws(() => writeFileAtomic(file, 'new'), (e) => e.code === 'EPERM');
  const took = Date.now() - started;
  assert.ok(took < 4000, `gave up after ${took} ms`);
  assert.ok(took >= 200, 'it did try for a while before giving up');
  assert.equal(fs.readFileSync(file, 'utf8'), 'old', 'the target is untouched');
  assert.deepEqual(leftovers(dir), [], 'the temp file was removed');
});

test('not Windows: EPERM on a rename is a real permission problem and is raised at once', (t) => {
  platform(t, 'linux');
  const dir = tmpDir(t);
  const file = path.join(dir, 'store.json');
  const rename = flaky(t, 'renameSync', 'EPERM', Infinity, (a) => String(a[1]) === file);
  assert.throws(() => writeFileAtomic(file, 'x'), (e) => e.code === 'EPERM');
  assert.equal(rename.calls, 1, 'it was not retried');
});

test('a directory that cannot be opened for fsync (Windows) does not fail the write', (t) => {
  for (const [os_, code] of [['win32', 'EISDIR'], ['win32', 'EPERM'], ['linux', 'EINVAL']]) {
    platform(t, os_);
    const dir = tmpDir(t);
    const file = path.join(dir, 'store.json');
    flaky(t, 'openSync', code, Infinity, (a) => String(a[0]) === dir);
    writeFileAtomic(file, `ok-${os_}-${code}`);
    assert.equal(fs.readFileSync(file, 'utf8'), `ok-${os_}-${code}`);
  }
});

// ─── lock ───────────────────────────────────────────────────────────────────

test('win32: a lock file another process deleted but still holds open (EPERM on create) is waited out', (t) => {
  platform(t, 'win32');
  const dir = tmpDir(t);
  const lock = lockOf(dir);
  const create = flaky(t, 'openSync', 'EPERM', 3, isLockCreate(lock));
  let ran = 0;
  withFileLock(lock, () => { ran++; }, { timeoutMs: 3000 });
  assert.equal(ran, 1);
  assert.equal(create.calls, 4);
  assert.equal(fs.existsSync(lock), false);
});

test('win32: a real permission failure on the lock is raised as itself, not disguised as "busy"', (t) => {
  platform(t, 'win32');
  const dir = tmpDir(t);
  const lock = lockOf(dir);
  flaky(t, 'openSync', 'EACCES', Infinity, isLockCreate(lock));
  let ran = false;
  assert.throws(() => withFileLock(lock, () => { ran = true; }, { timeoutMs: 150 }),
    (e) => e.code === 'EACCES' && !(e instanceof LockTimeoutError));
  assert.equal(ran, false);
});

test('not Windows: EACCES on the lock is raised at once, never retried', (t) => {
  platform(t, 'linux');
  const dir = tmpDir(t);
  const lock = lockOf(dir);
  const create = flaky(t, 'openSync', 'EACCES', Infinity, isLockCreate(lock));
  const started = Date.now();
  assert.throws(() => withFileLock(lock, () => {}, { timeoutMs: 3000 }), (e) => e.code === 'EACCES');
  assert.equal(create.calls, 1);
  assert.ok(Date.now() - started < 500);
});

test('a lock that is really held still ends in LockTimeoutError on Windows too', (t) => {
  platform(t, 'win32');
  const dir = tmpDir(t);
  const lock = lockOf(dir);
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, t: Date.now() }));   // a live holder: this process
  assert.throws(() => withFileLock(lock, () => {}, { timeoutMs: 120 }), (e) => e instanceof LockTimeoutError);
  assert.equal(fs.existsSync(lock), true, 'someone else\'s lock was left alone');
});

test('win32: releasing a lock that a scanner has open is retried until it goes', (t) => {
  platform(t, 'win32');
  const dir = tmpDir(t);
  const lock = lockOf(dir);
  const del = flaky(t, 'unlinkSync', 'EBUSY', 2, (a) => String(a[0]) === lock);
  withFileLock(lock, () => {});
  assert.equal(del.calls, 3);
  assert.equal(fs.existsSync(lock), false);
});

test('taking over a dead holder\'s lock never spins when the old file cannot be deleted', (t) => {
  for (const os_ of ['win32', 'linux']) {
    platform(t, os_);
    const dir = tmpDir(t);
    const lock = lockOf(dir);
    fs.writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 - 1, t: Date.now() }));   // a pid that is not running
    flaky(t, 'unlinkSync', 'EPERM', Infinity, (a) => String(a[0]) === lock);
    const started = Date.now();
    assert.throws(() => withFileLock(lock, () => {}, { timeoutMs: 250 }), (e) => e instanceof LockTimeoutError);
    assert.ok(Date.now() - started < 3000, `${os_}: it timed out instead of looping for ever`);
  }
});

test('a lock taken over by someone else between "it is stale" and "delete it" is not deleted from under them', (t) => {
  platform(t, 'linux');
  const dir = tmpDir(t);
  const lock = lockOf(dir);
  const dead = JSON.stringify({ pid: 2 ** 22 - 1, t: Date.now() });
  const live = JSON.stringify({ pid: process.pid, t: Date.now() });
  fs.writeFileSync(lock, dead);
  // The waiter reads the dead stamp; then, before it can act, another process takes the lock over.
  const original = fs.readFileSync;
  let swapped = false;
  fs.readFileSync = function patched(p, ...rest) {
    const text = original.call(this, p, ...rest);
    if (String(p) === lock && !swapped) { swapped = true; fs.writeFileSync(lock, live); }
    return text;
  };
  t.after(() => { fs.readFileSync = original; });
  assert.throws(() => withFileLock(lock, () => {}, { timeoutMs: 150 }), (e) => e instanceof LockTimeoutError);
  assert.equal(original.call(fs, lock, 'utf8'), live, 'the new holder\'s lock survived');
});

// ─── reads ──────────────────────────────────────────────────────────────────

test('readTextRetry: rides out Windows-transient errors only on Windows, and never hides ENOENT', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'a.json');
  fs.writeFileSync(file, 'hello');

  platform(t, 'win32');
  const read = flaky(t, 'readFileSync', 'EBUSY', 2, (a) => String(a[0]) === file);
  assert.equal(readTextRetry(file), 'hello');
  assert.equal(read.calls, 3);
  assert.throws(() => readTextRetry(path.join(dir, 'missing.json')), (e) => e.code === 'ENOENT');

  platform(t, 'linux');
  const again = flaky(t, 'readFileSync', 'EBUSY', Infinity, (a) => String(a[0]) === file);
  assert.throws(() => readTextRetry(file), (e) => e.code === 'EBUSY');
  assert.equal(again.calls, 1);
});

// ─── process termination (real processes) ───────────────────────────────────

function startHolder(lock) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHILD, 'hold', lock], { stdio: ['ignore', 'pipe', 'inherit'] });
    child.once('error', reject);
    child.stdout.once('data', () => resolve(child));
    child.once('exit', (code) => reject(new Error(`holder exited early (${code})`)));
  });
}
const exited = (child) => new Promise((resolve) => (child.exitCode !== null || child.signalCode ? resolve() : child.once('exit', resolve)));

test('a holder killed while it holds the lock leaves a lock the next caller takes over at once', async (t) => {
  const dir = tmpDir(t);
  const lock = lockOf(dir);
  const holder = await startHolder(lock);
  assert.equal(fs.existsSync(lock), true, 'the holder really holds it');

  // a waiter cannot barge in while the holder lives
  assert.throws(() => withFileLock(lock, () => {}, { timeoutMs: 120 }), (e) => e instanceof LockTimeoutError);

  holder.kill('SIGKILL');                       // TerminateProcess on Windows
  await exited(holder);
  assert.equal(fs.existsSync(lock), true, 'a killed process cannot clean up after itself');

  const started = Date.now();
  let ran = false;
  withFileLock(lock, () => { ran = true; }, { timeoutMs: 5000 });
  assert.equal(ran, true);
  assert.ok(Date.now() - started < 2000, 'a dead holder\'s lock is detected by its pid, not by waiting out the age limit');
  assert.equal(fs.existsSync(lock), false);
});

test('a writer killed at a random moment never leaves a torn file; the next write sweeps its temp file', async (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'store.json');
  writeFileAtomic(file, 'A'.repeat(200000));
  const isWhole = (text) => text.length === 200000 && /^(.)\1*$/s.test(text);
  for (let round = 0; round < 12; round++) {
    const child = spawn(process.execPath, [CHILD, 'write', file, String.fromCharCode(66 + (round % 20)), '100000'], { stdio: ['ignore', 'ignore', 'inherit'] });
    await new Promise((r) => setTimeout(r, 15 + Math.floor(Math.random() * 60)));
    child.kill('SIGKILL');
    await exited(child);
    assert.equal(isWhole(fs.readFileSync(file, 'utf8')), true, `round ${round}: the file is a whole, uniform version`);
  }
  // orphaned temp files are ignored by readers and swept once old enough
  for (const name of leftovers(dir)) fs.utimesSync(path.join(dir, name), new Date(0), new Date(0));
  writeFileAtomic(file, 'Z'.repeat(200000));
  assert.deepEqual(leftovers(dir), []);
  assert.equal(isWhole(fs.readFileSync(file, 'utf8')), true);
});
