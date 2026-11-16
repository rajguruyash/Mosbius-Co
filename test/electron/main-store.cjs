'use strict';

/**
 * Runs INSIDE the real Electron main process (not Node pretending to be it):
 *
 *   electron test/electron/main-store.cjs <scratch-dir> [--real-safe-storage]
 *
 * It exercises the two things the secret store and the OAuth token store stand
 * on — `writeFileAtomic` and `withFileLock` — in the process that will actually
 * run them in the shipped app, with other Electron processes contending for the
 * same files, and prints one `RESULT:{json}` line for test/electron-main-store.test.cjs
 * to assert on.
 *
 * What is real here: Electron's main process (its Node, its V8, its fs, its
 * `Atomics.wait` rules) and its `app` object. What is not, by default: the OS
 * credential store. `safeStorage` is given a stand-in cipher so no Keychain /
 * DPAPI / libsecret prompt can appear on a developer's machine; pass
 * `--real-safe-storage` to use the real one.
 */

const { app, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const scratch = process.argv[2];
const realSafeStorage = process.argv.includes('--real-safe-storage');
const CHILD = path.join(__dirname, '..', 'fixtures', 'atomic-file-child.cjs');
const WRITER = path.join(__dirname, '..', 'fixtures', 'secret-store-writer.cjs');

if (process.platform === 'darwin' && app.dock) app.dock.hide();   // no dock icon for a test run
app.disableHardwareAcceleration();

const checks = [];
const record = (name, ok, detail = '') => { checks.push({ name, ok: !!ok, detail: String(detail) }); };

/** A child running on Electron's own Node (ELECTRON_RUN_AS_NODE), same runtime as this process. */
function child(script, args, stdio = ['ignore', 'ignore', 'inherit']) {
  return spawn(process.execPath, [script, ...args], { stdio, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
}
const exitCode = (c) => new Promise((resolve) => (c.exitCode !== null ? resolve(c.exitCode) : c.once('exit', (code) => resolve(code))));
const wholeUniform = (text) => text.length === 200000 && /^(.)\1*$/s.test(text);

async function run() {
  const loadTs = require('../load-ts.cjs');
  const atomic = loadTs('src/main/atomicFile.ts');
  const { writeFileAtomic, withFileLock, LockTimeoutError, sleepSync } = atomic;

  // ── 1. where are we?
  record('runs in the Electron main process',
    process.type === 'browser' && typeof process.versions.electron === 'string' && app.isReady(),
    `type=${process.type} electron=${process.versions.electron} node=${process.versions.node} v8=${process.versions.v8} ${process.platform}/${process.arch}`);

  // ── 2. Atomics.wait is what sleepSync stands on; it is allowed on the main
  //       thread of the main process (it is NOT allowed on a renderer's).
  {
    const t0 = Date.now();
    let err = '';
    try { sleepSync(40); } catch (e) { err = e.message; }
    const took = Date.now() - t0;
    record('sleepSync (Atomics.wait) works in the main process', !err && took >= 30 && took < 400, err || `${took} ms for a 40 ms sleep`);
  }

  // ── 3. plain atomic write + lock, in this process
  const file = path.join(scratch, 'plain.json');
  writeFileAtomic(file, 'one');
  writeFileAtomic(file, Buffer.from('two'));
  record('writeFileAtomic round-trips', fs.readFileSync(file, 'utf8') === 'two' && fs.readdirSync(scratch).every((n) => !n.includes('.tmp-')));
  {
    const lock = path.join(scratch, 'plain.lock');
    let ran = 0;
    withFileLock(lock, () => { withFileLock(lock, () => { ran++; }); });
    record('withFileLock is re-entrant and releases', ran === 1 && !fs.existsSync(lock));
  }

  // ── 4. the main process and three other Electron processes all increment ONE
  //       counter under the lock: no update may be lost.
  {
    const counter = path.join(scratch, 'counter.txt');
    const lock = path.join(scratch, 'counter.lock');
    const kids = [1, 2, 3].map(() => child(CHILD, ['count', counter, lock, '40']));
    for (let i = 0; i < 40; i++) {
      withFileLock(lock, () => {
        const n = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0;
        writeFileAtomic(counter, String(n + 1));
      }, { timeoutMs: 20000 });
    }
    const codes = await Promise.all(kids.map(exitCode));
    const final = Number(fs.readFileSync(counter, 'utf8'));
    record('main process + 3 Electron processes lose no update under the lock',
      codes.every((c) => c === 0) && final === 160, `exit codes ${codes.join(',')}; counter ended at ${final} of 160`);
  }

  // ── 5. a holder killed outright: its lock is taken over at once, not after the age limit
  {
    const lock = path.join(scratch, 'held.lock');
    const holder = child(CHILD, ['hold', lock], ['ignore', 'pipe', 'inherit']);
    await new Promise((resolve, reject) => { holder.stdout.once('data', resolve); holder.once('exit', () => reject(new Error('holder exited early'))); });
    let blocked = false;
    try { withFileLock(lock, () => {}, { timeoutMs: 150 }); } catch (e) { blocked = e instanceof LockTimeoutError; }
    holder.kill('SIGKILL');
    await exitCode(holder);
    const stillThere = fs.existsSync(lock);
    const t0 = Date.now();
    let took = -1;
    try { withFileLock(lock, () => { took = Date.now() - t0; }, { timeoutMs: 5000 }); } catch (e) { took = -2; }
    record('a lock held by a killed Electron process is taken over promptly',
      blocked && stillThere && took >= 0 && took < 2000, `waiter blocked while held=${blocked}; lock left behind=${stillThere}; took ${took} ms after the kill`);
  }

  // ── 6. readers never see a torn file while another Electron process rewrites it
  {
    const target = path.join(scratch, 'big.json');
    writeFileAtomic(target, 'A'.repeat(200000));
    const writer = child(CHILD, ['write', target, 'B', '60']);
    let reads = 0, torn = 0, done = false;
    exitCode(writer).then(() => { done = true; });
    while (!done) {
      const text = fs.readFileSync(target, 'utf8');
      reads++;
      if (!wholeUniform(text)) torn++;
      await new Promise((r) => setImmediate(r));
    }
    record('no read is torn while another Electron process rewrites the file', torn === 0 && reads > 5, `${reads} reads, ${torn} torn`);
  }

  // ── 7. a writer killed at random moments never leaves a torn file
  {
    const target = path.join(scratch, 'killed.json');
    writeFileAtomic(target, 'A'.repeat(200000));
    let bad = 0;
    for (let round = 0; round < 6; round++) {
      const w = child(CHILD, ['write', target, String.fromCharCode(66 + round), '100000']);
      await new Promise((r) => setTimeout(r, 15 + Math.floor(Math.random() * 60)));
      w.kill('SIGKILL');
      await exitCode(w);
      if (!wholeUniform(fs.readFileSync(target, 'utf8'))) bad++;
    }
    record('a writer killed mid-write never leaves a torn file', bad === 0, `${bad} of 6 rounds left a damaged file`);
  }

  // ── 8. the real secret store, in the real main process
  app.setPath('userData', path.join(scratch, 'userData'));
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  let cipher = 'real safeStorage';
  if (!realSafeStorage) {
    try {
      safeStorage.isEncryptionAvailable = () => true;
      safeStorage.encryptString = (s) => Buffer.from('enc:' + s, 'utf8');
      safeStorage.decryptString = (b) => b.toString('utf8').replace(/^enc:/, '');
      cipher = 'stand-in cipher (no OS credential prompt)';
    } catch (e) { cipher = 'UNAVAILABLE: ' + e.message; }
  }
  const integrations = loadTs('src/main/integrations.ts');
  const ud = app.getPath('userData');
  {
    const set = integrations.setSecret('int:main', 'MAIN-SECRET-VALUE');
    const got = integrations.getSecret('int:main');
    const onDisk = fs.readFileSync(path.join(ud, 'integration-secrets.json'), 'utf8');
    record(`secret store round-trips in the main process (${cipher})`,
      set.ok && got === 'MAIN-SECRET-VALUE' && !onDisk.includes('MAIN-SECRET-VALUE'), `ciphertext only on disk: ${!onDisk.includes('MAIN-SECRET-VALUE')}`);
    const del = integrations.deleteSecret('int:main');
    record('a deleted secret is gone from the store and from the backup',
      del.ok && !integrations.hasSecret('int:main')
      && !(fs.existsSync(path.join(ud, 'integration-secrets.json.bak')) && fs.readFileSync(path.join(ud, 'integration-secrets.json.bak'), 'utf8').includes('int:main')));
  }
  if (!realSafeStorage && cipher.startsWith('stand-in')) {
    // three other Electron processes write their own secrets while this one does too
    const kids = ['a', 'b', 'c'].map((p) => child(WRITER, [ud, p, '25']));
    let mine = 0;
    for (let i = 0; i < 25; i++) if (integrations.setSecret(`m:${i}`, `v-m-${i}`).ok) mine++;
    const codes = await Promise.all(kids.map(exitCode));
    const blob = JSON.parse(fs.readFileSync(path.join(ud, 'integration-secrets.json'), 'utf8'));
    const missing = [];
    for (const prefix of ['a', 'b', 'c', 'm']) for (let i = 0; i < 25; i++) if (!blob[`${prefix}:${i}`]) missing.push(`${prefix}:${i}`);
    record('four Electron processes saving secrets at once lose none of them',
      codes.every((c) => c === 0) && mine === 25 && missing.length === 0 && integrations.secretStoreStatus().state === 'ok',
      `exit codes ${codes.join(',')}; missing ${missing.length} of 100; state=${integrations.secretStoreStatus().state}`);
  }
}

/**
 * The OAuth engine, in the real main process, against the stand-in provider: the
 * parts that depend on the RUNTIME — Electron's own fetch (undici) with `redirect:
 * 'error'`, AbortController, the streamed body reader, node:http — not just on the logic.
 */
async function oauthEngine() {
  const cleanups = [];
  const t = { after: (fn) => cleanups.push(fn) };
  const { startIdp } = require('../fixtures/oauth-idp.cjs');
  const { makeEnv, browse, rawGet, until } = require('../fixtures/oauth-env.cjs');
  try {
    const idp = await startIdp(t, { rotate: true });
    const env = await makeEnv(t, idp, { browser: null, timeouts: { timeoutMs: 4000, exchangeTimeoutMs: 1200, refreshMs: 1200, retryDelaysMs: [], cooldownMs: 20 } });
    const provider = env.controller.provider;
    const who = { id: 'gmail' };

    // a forged redirect while waiting, then the real one
    const waiting = env.controller.signIn('gmail');
    await until(() => env.opened.length === 1);
    const forged = await rawGet(env.ports.gmail, '/oauth/callback?state=forged&code=x');
    const real = await browse(env.opened[0], env);
    const signedIn = await waiting;
    record('OAuth sign-in under Electron: a forged redirect is ignored, then the real one completes',
      forged.status === 400 && real.callback.status === 200 && signedIn.ok === true && idp.tokenRequests().length === 1 && idp.stats.pkceFailures === 0,
      `forged ${forged.status}, real ${real.callback.status}, result ${JSON.stringify(signedIn)}, token requests ${idp.tokenRequests().length}, PKCE failures ${idp.stats.pkceFailures}`);

    // refresh with rotation, through the real runtime
    env.clock.advance(3600_000);
    const first = await provider.accessHeaders(who);
    record('OAuth refresh with rotation under Electron', first.ok === true && idp.tokenRequests('refresh_token').length === 1, JSON.stringify({ ok: first.ok, refreshes: idp.tokenRequests('refresh_token').length }));

    // 40 simultaneous callers, one refresh
    env.clock.advance(3600_000);
    idp.inject('token', { delayMs: 100, status: 0 });
    const many = await Promise.all(Array.from({ length: 40 }, () => provider.accessHeaders(who)));
    record('OAuth: 40 simultaneous callers cause one refresh under Electron', many.every((r) => r.ok) && idp.tokenRequests('refresh_token').length === 2, `refreshes ${idp.tokenRequests('refresh_token').length}`);

    // the runtime's fetch must refuse a redirect from the token endpoint, and never follow it
    env.clock.advance(3600_000);
    idp.inject('token', { redirect: `${idp.issuer}/leak` });
    const redirected = await provider.accessHeaders(who);
    record('a redirect from the token endpoint is not followed (Electron fetch, redirect:error)', redirected.ok === false && idp.requests('/leak').length === 0, `result ${JSON.stringify(redirected)}, requests to the redirect target ${idp.requests('/leak').length}`);

    // a hung token endpoint ends by timeout (AbortController), an oversized answer is cut (stream reader)
    env.clock.advance(200);
    idp.inject('token', { hang: true });
    const t0 = Date.now();
    const hung = await provider.accessHeaders(who);
    record('a hung token endpoint is abandoned at the timeout under Electron', hung.ok === false && Date.now() - t0 < 4000, `result ${JSON.stringify(hung)} after ${Date.now() - t0} ms`);
    env.clock.advance(200);
    idp.inject('token', { status: 200, raw: 'x'.repeat(300 * 1024) });
    const huge = await provider.accessHeaders(who);
    record('an oversized token answer is refused under Electron', huge.ok === false, JSON.stringify(huge));

    // provider-side revocation
    env.clock.advance(200);
    const revoked = await env.controller.revoke('gmail');
    record('provider-side revocation under Electron', revoked.attempted === 1 && revoked.confirmed === 1 && idp.liveAccessTokens().length === 0, JSON.stringify(revoked));
  } finally {
    for (const fn of cleanups.reverse()) { try { await fn(); } catch { /* noop */ } }
  }
}

app.whenReady().then(async () => {
  let crashed = '';
  try { await run(); await oauthEngine(); } catch (e) { crashed = (e && e.stack) || String(e); }
  const ok = !crashed && checks.length > 0 && checks.every((c) => c.ok);
  process.stdout.write(`RESULT:${JSON.stringify({ ok, crashed, checks })}\n`);
  app.exit(ok ? 0 : 1);
});

setTimeout(() => {   // a hung run must not hold the test suite
  process.stdout.write(`RESULT:${JSON.stringify({ ok: false, crashed: 'timed out inside the Electron main process', checks })}\n`);
  app.exit(3);
}, 120000).unref();
