'use strict';

/**
 * writeFileAtomic and withFileLock: the two guarantees the secret store (and,
 * later, the OAuth token store) stand on.
 *
 *   - a reader, or a crash at any instant, sees the whole old file or the whole
 *     new one, never a mixture;
 *   - read-modify-write cycles from several processes cannot lose an update.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const { writeFileAtomic, withFileLock, LockTimeoutError, sleepSync } = loadTs('src/main/atomicFile.ts');
const CHILD = path.join(__dirname, 'fixtures', 'atomic-file-child.cjs');

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-atomic-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const leftovers = (dir) => fs.readdirSync(dir).filter((n) => n.includes('.tmp-'));
const run = (...args) => new Promise((resolve) => {
  const child = spawn(process.execPath, [CHILD, ...args], { stdio: ['ignore', 'ignore', 'inherit'] });
  child.on('exit', (code) => resolve(code));
});

/** Make `fs[name]` fail once, then behave normally. */
function failOnce(t, name, error = new Error('injected failure')) {
  const original = fs[name];
  let armed = true;
  fs[name] = function patched(...args) {
    if (armed) { armed = false; throw error; }
    return original.apply(this, args);
  };
  t.after(() => { fs[name] = original; });
}

// ─── writeFileAtomic ────────────────────────────────────────────────────────

test('writes the exact content with owner-only permissions and leaves nothing behind', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'store.json');
  writeFileAtomic(file, 'first');
  assert.equal(fs.readFileSync(file, 'utf8'), 'first');
  writeFileAtomic(file, Buffer.from('second'));
  assert.equal(fs.readFileSync(file, 'utf8'), 'second');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(leftovers(dir), []);
});

test('creates the directory when it does not exist', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'a', 'b', 'store.json');
  writeFileAtomic(file, 'x');
  assert.equal(fs.readFileSync(file, 'utf8'), 'x');
});

test('a large file round-trips intact', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'big');
  const data = Buffer.alloc(5 * 1024 * 1024, 'ab');
  writeFileAtomic(file, data);
  assert.ok(fs.readFileSync(file).equals(data));
});

for (const step of ['renameSync', 'fsyncSync', 'writeSync', 'openSync']) {
  test(`a failure in ${step} leaves the previous file untouched and no temp file behind`, (t) => {
    const dir = tmpDir(t);
    const file = path.join(dir, 'store.json');
    writeFileAtomic(file, 'OLD CONTENT');
    failOnce(t, step);
    assert.throws(() => writeFileAtomic(file, 'NEW CONTENT'), /injected failure/);
    assert.equal(fs.readFileSync(file, 'utf8'), 'OLD CONTENT');
    assert.deepEqual(leftovers(dir), []);
    // and the next write works
    writeFileAtomic(file, 'NEWER');
    assert.equal(fs.readFileSync(file, 'utf8'), 'NEWER');
  });
}

test('a crash between the temp file and the rename leaves the old file valid; the orphan is swept later', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'store.json');
  writeFileAtomic(file, 'GOOD');
  // what a killed writer leaves: a temp file next to the real one
  const orphan = `${file}.tmp-99999-deadbeef`;
  fs.writeFileSync(orphan, 'half of something');
  const old = new Date(Date.now() - 5 * 60_000);
  fs.utimesSync(orphan, old, old);
  const fresh = `${file}.tmp-88888-cafebabe`;
  fs.writeFileSync(fresh, 'another writer, still going');

  assert.equal(fs.readFileSync(file, 'utf8'), 'GOOD', 'readers never see the orphan');
  writeFileAtomic(file, 'GOOD 2');
  assert.equal(fs.existsSync(orphan), false, 'an old orphan is removed');
  assert.equal(fs.existsSync(fresh), true, 'a recent temp file may belong to a live writer and is left alone');
});

test('several processes rewriting one file: every read is a complete, uniform version', async (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'store.json');
  const letters = ['A', 'B', 'C', 'D'];
  const jobs = letters.map((l) => run('write', file, l, '25'));
  let reads = 0;
  let torn = 0;
  let done = false;
  Promise.all(jobs).then(() => { done = true; });
  while (!done) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') { await new Promise((r) => setImmediate(r)); continue; } throw e; }
    reads++;
    if (text.length !== 200000 || text !== text[0].repeat(200000)) torn++;
    await new Promise((r) => setImmediate(r));
  }
  const codes = await Promise.all(jobs);
  assert.deepEqual(codes, [0, 0, 0, 0]);
  assert.ok(reads > 20, `the reader only managed ${reads} reads`);
  assert.equal(torn, 0, `${torn} of ${reads} reads saw a half-written file`);
  const final = fs.readFileSync(file, 'utf8');
  assert.ok(letters.some((l) => final === l.repeat(200000)));
  assert.deepEqual(leftovers(dir), []);
});

// ─── withFileLock ───────────────────────────────────────────────────────────

test('runs the function, returns its value and removes the lock', (t) => {
  const dir = tmpDir(t);
  const lock = path.join(dir, 'x.lock');
  assert.equal(withFileLock(lock, () => { assert.equal(fs.existsSync(lock), true); return 42; }), 42);
  assert.equal(fs.existsSync(lock), false);
});

test('a failure while stamping the lock file does not leave the lock behind', (t) => {
  const dir = tmpDir(t);
  const lock = path.join(dir, 'x.lock');
  failOnce(t, 'writeSync');
  assert.throws(() => withFileLock(lock, () => 'never'), /injected failure/);
  assert.equal(fs.existsSync(lock), false, 'a leaked lock would wedge every other writer');
  assert.equal(withFileLock(lock, () => 'fine'), 'fine');
});

test('releases the lock when the function throws', (t) => {
  const dir = tmpDir(t);
  const lock = path.join(dir, 'x.lock');
  assert.throws(() => withFileLock(lock, () => { throw new Error('boom'); }), /boom/);
  assert.equal(fs.existsSync(lock), false);
  assert.equal(withFileLock(lock, () => 'again'), 'again');
});

test('is re-entrant inside one process: a nested call does not wait on itself', (t) => {
  const dir = tmpDir(t);
  const lock = path.join(dir, 'x.lock');
  const started = Date.now();
  const out = withFileLock(lock, () => withFileLock(lock, () => withFileLock(lock, () => 'inner'), { timeoutMs: 200 }), { timeoutMs: 200 });
  assert.equal(out, 'inner');
  assert.ok(Date.now() - started < 150);
  assert.equal(fs.existsSync(lock), false, 'only the outermost call releases');
});

test('three processes incrementing one counter lose no update', async (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'counter');
  const lock = path.join(dir, 'counter.lock');
  const codes = await Promise.all([1, 2, 3].map(() => run('count', file, lock, '40')));
  assert.deepEqual(codes, [0, 0, 0]);
  assert.equal(fs.readFileSync(file, 'utf8'), '120');
  assert.equal(fs.existsSync(lock), false);
});

test('a lock left by a process that died is taken over at once', (t) => {
  const dir = tmpDir(t);
  const lock = path.join(dir, 'x.lock');
  const { spawnSync } = require('node:child_process');
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']);
  const deadPid = Number(dead.stdout.toString());
  fs.writeFileSync(lock, JSON.stringify({ pid: deadPid, t: Date.now() }));
  const started = Date.now();
  assert.equal(withFileLock(lock, () => 'ok', { timeoutMs: 2000 }), 'ok');
  assert.ok(Date.now() - started < 1000, 'must not wait out the timeout for a dead holder');
});

test('a lock older than the stale limit is taken over even if its pid looks alive', (t) => {
  const dir = tmpDir(t);
  const lock = path.join(dir, 'x.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: process.ppid, t: 0 }));
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lock, old, old);
  assert.equal(withFileLock(lock, () => 'ok', { timeoutMs: 1000, staleMs: 5000 }), 'ok');
});

test('a lock held by a live process makes a waiter time out instead of barging in', (t) => {
  const dir = tmpDir(t);
  const lock = path.join(dir, 'x.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: process.ppid, t: Date.now() }));
  const started = Date.now();
  assert.throws(() => withFileLock(lock, () => 'never', { timeoutMs: 250, staleMs: 60_000 }), LockTimeoutError);
  assert.ok(Date.now() - started >= 240, 'it should have waited for the timeout');
  assert.equal(fs.existsSync(lock), true, "the other holder's lock must survive");
});

test('sleepSync blocks for about the requested time', () => {
  const started = Date.now();
  sleepSync(60);
  const took = Date.now() - started;
  assert.ok(took >= 55 && took < 400, `slept ${took} ms`);
});
