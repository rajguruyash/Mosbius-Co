'use strict';

/**
 * The encrypted secret store (`src/main/integrations.ts`) must never lose a
 * credential silently.
 *
 * Before this work it rewrote its file in place and turned ANY read or parse
 * error into an empty store, so the next save wrote that empty store plus one
 * new entry over every other credential. These tests pin the replacement:
 * atomic writes, a read failure that is never mistaken for "nothing stored",
 * damaged files set aside and restored from a backup, and writers in several
 * processes that cannot cancel each other out.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

// integrations.ts reads Electron's userData and safeStorage. Stand in for both:
// a throwaway directory, and a "cipher" that is trivially recognisable.
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'md-secrets-'));
let encryptionAvailable = true;
let storageBackend = 'gnome_libsecret';
let decryptCalls = 0;
const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron,
  filename: electron,
  loaded: true,
  exports: {
    app: { getPath: () => userData },
    safeStorage: {
      isEncryptionAvailable: () => encryptionAvailable,
      getSelectedStorageBackend: () => storageBackend,
      encryptString: (s) => Buffer.from('enc:' + s, 'utf8'),
      decryptString: (b) => {
        decryptCalls++;
        const text = b.toString('utf8');
        if (!text.startsWith('enc:')) throw new Error('not our ciphertext');
        return text.slice(4);
      }
    }
  }
};

const store = loadTs('src/main/integrations.ts');
const FILE = path.join(userData, 'integration-secrets.json');
const BAK = `${FILE}.bak`;
const WRITER = path.join(__dirname, 'fixtures', 'secret-store-writer.cjs');

test.after(() => fs.rmSync(userData, { recursive: true, force: true }));

function reset() {
  for (const name of fs.readdirSync(userData)) {
    if (name.startsWith('integration-secrets.json')) fs.rmSync(path.join(userData, name), { recursive: true, force: true });
  }
  encryptionAvailable = true;
  storageBackend = 'gnome_libsecret';
  store.acknowledgeSecretStoreProblem();
}
test.beforeEach(reset);

const files = (prefix) => fs.readdirSync(userData).filter((n) => n.startsWith(prefix));
const readBlob = (p = FILE) => JSON.parse(fs.readFileSync(p, 'utf8'));
const corruptCopies = () => files('integration-secrets.json.corrupt-');

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

// ─── ordinary use ───────────────────────────────────────────────────────────

test('set, get, has and delete round-trip, including awkward values', () => {
  const values = { 'int:a': 'plain', 'int:b': 'quote " and \\ backslash', 'int:c': 'line\nbreak', 'int:d': 'ünï-çødé ✓' };
  for (const [ref, v] of Object.entries(values)) assert.deepEqual(store.setSecret(ref, v), { ok: true });
  for (const [ref, v] of Object.entries(values)) {
    assert.equal(store.getSecret(ref), v);
    assert.equal(store.hasSecret(ref), true);
  }
  assert.equal(store.getSecret('int:missing'), undefined);
  assert.equal(store.hasSecret('int:missing'), false);
  assert.deepEqual(store.deleteSecret('int:b'), { ok: true });
  assert.equal(store.hasSecret('int:b'), false);
  assert.equal(store.getSecret('int:a'), 'plain');
  assert.deepEqual(store.deleteSecret('int:never-existed'), { ok: true });
});

test('the file holds ciphertext only, is owner-only, and a backup mirrors it', () => {
  store.setSecret('int:a', 'SUPER-SECRET-VALUE');
  const raw = fs.readFileSync(FILE, 'utf8');
  assert.equal(raw.includes('SUPER-SECRET-VALUE'), false);
  assert.equal(fs.readFileSync(BAK, 'utf8'), raw, 'the backup is the last good state');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(FILE).mode & 0o777, 0o600);
    assert.equal(fs.statSync(BAK).mode & 0o777, 0o600);
  }
});

test('no temp or lock files are left behind by normal use', () => {
  for (let i = 0; i < 10; i++) store.setSecret(`int:${i}`, `v${i}`);
  store.deleteSecret('int:3');
  assert.deepEqual(files('integration-secrets.json').sort(), ['integration-secrets.json', 'integration-secrets.json.bak']);
});

test('hasSecret does not decrypt anything', () => {
  store.setSecret('int:a', 'x');
  decryptCalls = 0;
  store.hasSecret('int:a');
  assert.equal(decryptCalls, 0);
});

test('without real OS encryption nothing is written, including the Linux basic_text fallback', () => {
  encryptionAvailable = false;
  const none = store.setSecret('int:a', 'x');
  assert.equal(none.ok, false);
  assert.match(none.error, /refusing to store a secret in plaintext/);
  assert.deepEqual(files('integration-secrets.json'), []);

  encryptionAvailable = true;
  storageBackend = 'basic_text';
  const weak = store.setSecret('int:a', 'x');
  assert.equal(weak.ok, false);
  assert.deepEqual(files('integration-secrets.json'), []);
});

test('input is validated', () => {
  assert.equal(store.setSecret('', 'x').ok, false);
  assert.equal(store.setSecret('int:a', '').ok, false);
  assert.equal(store.setSecret('int:a', undefined).ok, false);
  assert.deepEqual(files('integration-secrets.json'), []);
});

// ─── interrupted writes ─────────────────────────────────────────────────────

for (const step of ['renameSync', 'fsyncSync', 'writeSync']) {
  test(`a failure in ${step} while saving changes nothing and loses nothing`, (t) => {
    store.setSecret('int:keep-1', 'one');
    store.setSecret('int:keep-2', 'two');
    const before = fs.readFileSync(FILE, 'utf8');
    failOnce(t, step);
    const res = store.setSecret('int:new', 'three');
    assert.equal(res.ok, false);
    assert.equal(fs.readFileSync(FILE, 'utf8'), before, 'the store is byte-for-byte what it was');
    assert.equal(store.getSecret('int:keep-1'), 'one');
    assert.equal(store.getSecret('int:keep-2'), 'two');
    assert.equal(store.hasSecret('int:new'), false);
    assert.deepEqual(files('integration-secrets.json.tmp-'), []);
    assert.equal(fs.existsSync(`${FILE}.lock`), false, 'the lock was released');
    assert.deepEqual(store.setSecret('int:new', 'three'), { ok: true }, 'and the next save works');
    assert.equal(store.getSecret('int:keep-1'), 'one');
  });
}

test('a crashed writer that left a temp file and a lock behind does not wedge the store', () => {
  store.setSecret('int:a', 'one');
  const { spawnSync } = require('node:child_process');
  const deadPid = Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']).stdout.toString());
  fs.writeFileSync(`${FILE}.lock`, JSON.stringify({ pid: deadPid, t: Date.now() }));
  const orphan = `${FILE}.tmp-${deadPid}-abcd1234`;
  fs.writeFileSync(orphan, '{"half":');
  const old = new Date(Date.now() - 5 * 60_000);
  fs.utimesSync(orphan, old, old);
  const started = Date.now();
  assert.deepEqual(store.setSecret('int:b', 'two'), { ok: true });
  assert.ok(Date.now() - started < 2000);
  assert.equal(store.getSecret('int:a'), 'one');
  assert.equal(store.getSecret('int:b'), 'two');
  assert.equal(fs.existsSync(orphan), false);
});

// ─── corruption and recovery ────────────────────────────────────────────────

test('a truncated store is restored from the backup, the damaged file is kept, nothing is lost', () => {
  store.setSecret('int:a', 'alpha');
  store.setSecret('int:b', 'beta');
  const good = fs.readFileSync(FILE, 'utf8');
  const damaged = good.slice(0, Math.floor(good.length / 2));
  fs.writeFileSync(FILE, damaged);

  assert.equal(store.getSecret('int:a'), 'alpha', 'reads see the restored store');
  assert.equal(store.getSecret('int:b'), 'beta');
  const status = store.secretStoreStatus();
  assert.equal(status.state, 'recovered-from-backup');
  assert.match(status.preservedAs, /integration-secrets\.json\.corrupt-\d+$/);
  assert.equal(fs.readFileSync(status.preservedAs, 'utf8'), damaged, 'the damaged bytes are kept for inspection');
  assert.deepEqual(readBlob(), JSON.parse(good), 'the main file is whole again');

  // saving afterwards keeps what was recovered
  assert.deepEqual(store.setSecret('int:c', 'gamma'), { ok: true });
  assert.equal(store.getSecret('int:a'), 'alpha');
  assert.equal(store.getSecret('int:c'), 'gamma');
});

test('a damaged store with no backup is set aside, never overwritten, and the loss is reported', () => {
  store.setSecret('int:a', 'alpha');
  fs.rmSync(BAK);
  const damaged = '{"int:a": "ZW5jOmFscGhh", "int:b": ';
  fs.writeFileSync(FILE, damaged);

  assert.equal(store.hasSecret('int:a'), false);
  const status = store.secretStoreStatus();
  assert.equal(status.state, 'corrupt-unrecovered');
  assert.equal(fs.readFileSync(status.preservedAs, 'utf8'), damaged);

  // the user enters a new credential: the evidence stays, and so does the warning
  assert.deepEqual(store.setSecret('int:new', 'fresh'), { ok: true });
  assert.equal(store.getSecret('int:new'), 'fresh');
  assert.equal(fs.readFileSync(status.preservedAs, 'utf8'), damaged, 'the damaged file is untouched by later saves');
  assert.equal(store.secretStoreStatus().state, 'corrupt-unrecovered', 'the warning stays until acknowledged');
  store.acknowledgeSecretStoreProblem();
  assert.equal(store.secretStoreStatus().state, 'ok');
});

for (const [name, content] of [
  ['an empty file', ''],
  ['whitespace', '   \n\n'],
  ['a JSON array', '["a","b"]'],
  ['a JSON string', '"just a string"'],
  ['null', 'null'],
  ['an entry that is not a string', '{"int:a":123}'],
  ['binary garbage', Buffer.from([0, 255, 254, 1, 2, 3, 128, 129])],
  ['two objects glued together', '{"a":"b"}{"c":"d"}']
]) {
  test(`${name} is treated as damage, not as an empty store`, () => {
    store.setSecret('int:a', 'alpha');
    fs.writeFileSync(FILE, content);
    assert.equal(store.getSecret('int:a'), 'alpha', 'restored from the backup');
    assert.equal(store.secretStoreStatus().state, 'recovered-from-backup');
    assert.equal(corruptCopies().length, 1);
  });
}

test('only the newest few damaged copies are kept', () => {
  for (let i = 0; i < 8; i++) {
    store.setSecret('int:a', `v${i}`);
    fs.writeFileSync(FILE, `{broken ${i}`);
    store.getSecret('int:a');
    // distinct millisecond timestamps in the file names
    const until = Date.now() + 3;
    while (Date.now() < until) { /* spin */ }
  }
  assert.ok(corruptCopies().length <= 5);
  assert.ok(corruptCopies().length >= 1);
});

// ─── a failed read is not an empty store ────────────────────────────────────

test('when the store cannot be read, a save is refused and every credential survives', () => {
  store.setSecret('int:a', 'alpha');
  store.setSecret('int:b', 'beta');
  store.setSecret('int:c', 'gamma');
  const before = fs.readFileSync(FILE, 'utf8');

  // an I/O error that is not "the file does not exist": make the path a directory
  fs.rmSync(FILE);
  fs.mkdirSync(FILE);
  const refused = store.setSecret('int:d', 'delta');
  assert.equal(refused.ok, false);
  assert.match(refused.error, /unreadable/);
  assert.match(refused.error, /nothing was changed/);
  assert.equal(fs.statSync(FILE).isDirectory(), true, 'nothing was written over it');
  assert.equal(store.hasSecret('int:a'), false, 'reads cannot answer');
  assert.equal(store.secretStoreStatus().state, 'unreadable');

  const del = store.deleteSecret('int:a');
  assert.equal(del.ok, false, 'a delete that did not happen must say so');

  // once the store is readable again nothing has been lost
  fs.rmdirSync(FILE);
  fs.writeFileSync(FILE, before);
  assert.equal(store.getSecret('int:a'), 'alpha');
  assert.equal(store.getSecret('int:b'), 'beta');
  assert.equal(store.getSecret('int:c'), 'gamma');
  assert.deepEqual(store.setSecret('int:d', 'delta'), { ok: true });
  assert.equal(store.getSecret('int:a'), 'alpha');
});

test('a permissions error is also an unreadable store, not an empty one', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, () => {
  store.setSecret('int:a', 'alpha');
  fs.chmodSync(FILE, 0o000);
  try {
    assert.equal(store.setSecret('int:b', 'beta').ok, false);
    assert.equal(store.secretStoreStatus().state, 'unreadable');
  } finally {
    fs.chmodSync(FILE, 0o600);
  }
  assert.equal(store.getSecret('int:a'), 'alpha');
  assert.equal(store.hasSecret('int:b'), false);
});

test('a missing store is genuinely empty and is not a problem', () => {
  assert.equal(store.hasSecret('int:a'), false);
  assert.equal(store.secretStoreStatus().state, 'ok');
  assert.deepEqual(store.deleteSecret('int:a'), { ok: true });
  assert.deepEqual(files('integration-secrets.json'), []);
});

// ─── deletion really deletes ────────────────────────────────────────────────

test('a deleted secret leaves neither the file nor the backup, and deleting the last one removes both', () => {
  store.setSecret('int:keep', 'k');
  store.setSecret('int:drop', 'SECRET-TO-DROP');
  const dropCipher = readBlob()['int:drop'];
  store.deleteSecret('int:drop');
  assert.equal(fs.readFileSync(FILE, 'utf8').includes(dropCipher), false);
  assert.equal(fs.readFileSync(BAK, 'utf8').includes(dropCipher), false, 'the backup must not keep a deleted secret');
  assert.equal(store.getSecret('int:keep'), 'k');
  store.deleteSecret('int:keep');
  assert.equal(fs.existsSync(FILE), false);
  assert.equal(fs.existsSync(BAK), false);
});

// ─── concurrent access ──────────────────────────────────────────────────────

test('many saves issued at once in one process all land', async () => {
  const jobs = [];
  for (let i = 0; i < 100; i++) jobs.push(Promise.resolve().then(() => store.setSecret(`int:${i}`, `v${i}`)));
  const results = await Promise.all(jobs);
  assert.ok(results.every((r) => r.ok));
  for (let i = 0; i < 100; i++) assert.equal(store.getSecret(`int:${i}`), `v${i}`);
  assert.equal(Object.keys(readBlob()).length, 100);
});

test('saves and deletes interleaved in one process leave a consistent store', async () => {
  for (let i = 0; i < 20; i++) store.setSecret(`int:${i}`, `v${i}`);
  await Promise.all([
    ...Array.from({ length: 20 }, (_, i) => Promise.resolve().then(() => store.deleteSecret(`int:${i}`))),
    ...Array.from({ length: 20 }, (_, i) => Promise.resolve().then(() => store.setSecret(`int:n${i}`, `n${i}`)))
  ]);
  const blob = readBlob();
  assert.deepEqual(Object.keys(blob).sort(), Array.from({ length: 20 }, (_, i) => `int:n${i}`).sort());
  assert.deepEqual(readBlob(BAK), blob);
});

test('three processes saving at the same moment lose nothing', async () => {
  store.setSecret('int:pre-existing', 'stays');
  const codes = await Promise.all(['p1', 'p2', 'p3'].map((p) => new Promise((resolve) => {
    spawn(process.execPath, [WRITER, userData, p, '30'], { stdio: ['ignore', 'ignore', 'inherit'] }).on('exit', resolve);
  })));
  assert.deepEqual(codes, [0, 0, 0]);
  const blob = readBlob();
  assert.equal(Object.keys(blob).length, 91, `expected 91 entries, found ${Object.keys(blob).length}`);
  assert.equal(store.getSecret('int:pre-existing'), 'stays');
  for (const p of ['p1', 'p2', 'p3']) {
    for (let i = 0; i < 30; i++) assert.equal(store.getSecret(`${p}:${i}`), `value-${p}-${i}`);
  }
  assert.deepEqual(readBlob(BAK), blob, 'the backup is the final state');
  assert.deepEqual(files('integration-secrets.json').sort(), ['integration-secrets.json', 'integration-secrets.json.bak']);
});

test('a reader running while other processes save never sees damage', async () => {
  store.setSecret('int:anchor', 'steady');
  const writers = ['w1', 'w2'].map((p) => new Promise((resolve) => {
    spawn(process.execPath, [WRITER, userData, p, '40'], { stdio: ['ignore', 'ignore', 'inherit'] }).on('exit', resolve);
  }));
  let done = false;
  Promise.all(writers).then(() => { done = true; });
  let reads = 0;
  while (!done) {
    assert.equal(store.getSecret('int:anchor'), 'steady');
    reads++;
    await new Promise((r) => setImmediate(r));
  }
  assert.ok(reads > 5);
  assert.equal(store.secretStoreStatus().state, 'ok', 'no reader ever mistook a write for damage');
  assert.deepEqual(corruptCopies(), []);
});

test('the status report is a copy', () => {
  const status = store.secretStoreStatus();
  status.state = 'corrupt-unrecovered';
  assert.equal(store.secretStoreStatus().state, 'ok');
});

// ─── a delete that did not fully happen must say so ─────────────────────────

/** Make every call of `fs[name]` whose first argument ends with `suffix` throw. */
function failForPath(t, name, suffix, code = 'EPERM') {
  const original = fs[name];
  fs[name] = function patched(...args) {
    if (String(args[args.length > 1 && name === 'renameSync' ? 1 : 0]).endsWith(suffix)) {
      throw Object.assign(new Error(`${code}: injected`), { code });
    }
    return original.apply(this, args);
  };
  t.after(() => { fs[name] = original; });
}

test('deleting one of several secrets leaves no copy of it in the backup mirror', () => {
  store.setSecret('int:keep', 'KEEP');
  store.setSecret('int:drop', 'DROP');
  assert.deepEqual(store.deleteSecret('int:drop'), { ok: true });
  assert.equal(Object.keys(readBlob(FILE)).includes('int:drop'), false);
  assert.equal(Object.keys(readBlob(BAK)).includes('int:drop'), false, 'recovery would put it back');
});

test('a delete is NOT ok when the backup still holds the secret and cannot be fixed', (t) => {
  store.setSecret('int:keep', 'KEEP');
  store.setSecret('int:drop', 'DROP');
  // the backup cannot be refreshed (its rename fails) AND cannot be removed either
  failForPath(t, 'renameSync', '.bak');
  failForPath(t, 'rmSync', '.bak');
  const res = store.deleteSecret('int:drop');
  assert.equal(res.ok, false);
  assert.match(res.error, /backup/);
  assert.equal(readBlob(FILE)['int:drop'], undefined, 'the main file did lose it');
  assert.ok(readBlob(BAK)['int:drop'], 'and the report is true: a copy survives in the backup');
});

test('a backup that cannot be refreshed but can be removed is removed, and the delete is ok', (t) => {
  store.setSecret('int:keep', 'KEEP');
  store.setSecret('int:drop', 'DROP');
  failForPath(t, 'renameSync', '.bak');
  assert.deepEqual(store.deleteSecret('int:drop'), { ok: true });
  assert.equal(fs.existsSync(BAK), false, 'a stale backup holding the deleted secret was taken away');
  assert.equal(store.getSecret('int:keep'), 'KEEP');
});

test('deleting the LAST secret removes the file and the backup, or reports that it could not', (t) => {
  store.setSecret('int:only', 'ONLY');
  assert.deepEqual(store.deleteSecret('int:only'), { ok: true });
  assert.equal(fs.existsSync(FILE), false);
  assert.equal(fs.existsSync(BAK), false);

  store.setSecret('int:only', 'ONLY');
  failForPath(t, 'rmSync', '.bak');
  const res = store.deleteSecret('int:only');
  assert.equal(res.ok, false, 'a backup that survived the delete must not be reported as deleted');
});

test('removing an integration keeps its record when its credential cannot be deleted', () => {
  const rec = store.upsertRecord({ id: 'keepme', label: 'Keep me', kind: 'custom-rest', baseUrl: 'https://api.example.com', authType: 'bearer', enabled: true });
  assert.equal(rec.ok, true, rec.error);
  store.setSecret('int:keepme', 'SECRET');
  const ref = rec.record.secretRef;

  fs.rmSync(FILE); fs.rmSync(BAK);
  fs.mkdirSync(FILE);                                   // the store becomes unreadable
  const refused = store.removeRecord('keepme');
  assert.equal(refused.ok, false);
  assert.match(refused.error, /unreadable/);
  assert.ok(store.getRecord('keepme'), 'the record is still there, so the user can see it and retry');

  fs.rmdirSync(FILE);                                   // fixed: the store is readable again
  store.setSecret(ref, 'SECRET');
  assert.deepEqual(store.removeRecord('keepme'), { ok: true });
  assert.equal(store.getRecord('keepme'), undefined);
  assert.equal(store.hasSecret(ref), false);
});
