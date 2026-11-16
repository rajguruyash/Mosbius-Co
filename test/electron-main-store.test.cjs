'use strict';

/**
 * The atomic write, the file lock and the secret store, run inside the REAL
 * Electron main process (test/electron/main-store.cjs) with other Electron
 * processes contending for the same files.
 *
 * Everything else in this suite runs under plain Node. That proves the logic;
 * it cannot prove the same logic behaves the same in the process that ships
 * (Electron's own Node and V8, its `Atomics.wait` rules, its `app` object).
 * This test starts the Electron binary from node_modules and asserts on what it
 * reports.
 *
 * It is skipped, with the reason printed, where Electron cannot start: no binary
 * installed, a Linux box with no display, or MD_SKIP_ELECTRON=1.
 *
 * Opt-in: MD_ELECTRON_REAL_SAFE_STORAGE=1 uses the real OS credential store
 * instead of the stand-in cipher. That can raise a Keychain / DPAPI / libsecret
 * prompt, so it is never on by default.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SCRIPT = path.join(__dirname, 'electron', 'main-store.cjs');

function electronBinary() {
  try {
    const bin = require('electron');                 // the npm package exports the binary's path
    return typeof bin === 'string' && fs.existsSync(bin) ? bin : null;
  } catch { return null; }
}

function skipReason() {
  if (process.env.MD_SKIP_ELECTRON === '1') return 'MD_SKIP_ELECTRON=1';
  if (!electronBinary()) return 'the Electron binary is not installed (npm ci)';
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return 'no display on this Linux machine (run under xvfb-run)';
  return null;
}

function runElectron(scratch, extra = []) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;                 // we want the real main process, not Node mode
    const child = spawn(electronBinary(), [SCRIPT, scratch, ...extra], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const killer = setTimeout(() => child.kill('SIGKILL'), 150000);
    child.on('exit', (code, signal) => { clearTimeout(killer); resolve({ code, signal, out, err }); });
  });
}

test('the lock, the atomic write and the secret store hold up inside the real Electron main process', { skip: skipReason() || false, timeout: 170000 }, async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'md-electron-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

  const extra = process.env.MD_ELECTRON_REAL_SAFE_STORAGE === '1' ? ['--real-safe-storage'] : [];
  const { code, signal, out, err } = await runElectron(scratch, extra);
  const line = out.split('\n').find((l) => l.startsWith('RESULT:'));
  assert.ok(line, `Electron printed no result (exit ${code}, signal ${signal}).\nstderr tail: ${err.slice(-800)}`);
  const result = JSON.parse(line.slice('RESULT:'.length));

  for (const c of result.checks) console.log(`#   ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
  assert.equal(result.crashed, '', `the Electron-side script crashed:\n${result.crashed}`);
  const failed = result.checks.filter((c) => !c.ok);
  assert.deepEqual(failed.map((c) => `${c.name}: ${c.detail}`), [], 'checks that failed inside Electron');
  assert.equal(code, 0);

  const names = result.checks.map((c) => c.name);
  assert.ok(names.includes('runs in the Electron main process'), 'it must prove it really was the main process');
  assert.ok(names.some((n) => n.startsWith('main process + 3 Electron processes lose no update')));
  assert.ok(names.some((n) => n.startsWith('a lock held by a killed Electron process')));
  assert.ok(names.some((n) => n.startsWith('OAuth sign-in under Electron')));
  assert.ok(names.some((n) => n.startsWith('a redirect from the token endpoint is not followed')));
  assert.ok(names.some((n) => n.startsWith('provider-side revocation under Electron')));
  assert.ok(result.checks.length >= 17, `only ${result.checks.length} checks ran`);
});

// ─── the live-verification tool starts, and ends, under Electron ────────────

test('tools/verify-oauth-live.cjs runs under the real Electron, reports honestly with no OAuth client, and exits by itself', { skip: skipReason() || false, timeout: 100000 }, async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'md-electron-tool-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = await new Promise((resolve) => {
    const child = spawn(electronBinary(), [path.join(__dirname, '..', 'tools', 'verify-oauth-live.cjs'), 'gmail', '--user-data', scratch], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const killer = setTimeout(() => { child.kill('SIGKILL'); }, 60000);
    child.on('exit', (code, signal) => { clearTimeout(killer); resolve({ code, signal, out }); });
  });
  // Under Electron `require.main !== module`; a tool that trusted that check would
  // start, do nothing, and sit there for ever. It must run, and it must stop.
  assert.equal(result.signal, null, 'it was killed by the watchdog: it hung instead of ending');
  assert.equal(result.code, 1, 'no OAuth client is stored, so the check fails — and says so');
  assert.match(result.out, /redirect URI to register with the provider: http:\/\/127\.0\.0\.1:33101\/oauth\/callback/);
  assert.match(result.out, /FAIL {2}gmail: OAuth client present in the app's store/);
  assert.match(result.out, /Nothing is verified until they pass/);
});
