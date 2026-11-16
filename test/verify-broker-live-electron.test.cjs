'use strict';

/**
 * The Phase 4 gate's account mode, under the REAL Electron binary, up to the point where an account is
 * needed. What this proves without an account:
 *   • the Electron wiring starts (name, throwaway profile, catalogue endpoints, redirect URI and scopes);
 *   • it refuses to run on a profile another process holds (the guard against two processes on one store);
 *   • it refuses to read a client secret without a terminal, and fails cleanly with a fixed message;
 *   • it leaves no throwaway profile behind, on success or on failure.
 * It does NOT sign in, and says nothing about Google or Slack.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
const TOOL = path.join(ROOT, 'tools', 'verify-broker-live.cjs');
const haveElectron = fs.existsSync(ELECTRON);
const skip = haveElectron ? false : 'the Electron binary is not installed';
const leftovers = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('mosbius-gate-'));

const run = (args, opts = {}) => spawnSync(ELECTRON, [TOOL, ...args], { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'], ...opts });

test('no client stored: the gate runs its first step under Electron, fails it by name, writes evidence without a secret, and deletes its profile', { skip }, (t) => {
  const before = new Set(leftovers());
  const evidence = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gate-ev-')), 'ev.json');
  t.after(() => fs.rmSync(path.dirname(evidence), { recursive: true, force: true }));
  const r = run(['google-calendar', '--account', '--evidence', evidence]);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /redirect URI that must be registered with the provider: http:\/\/127\.0\.0\.1:33102\/oauth\/callback/);
  assert.match(r.stdout, /calendar\.events\.readonly/);
  assert.match(r.stdout, /FAIL\s+\[1\.0\] an OAuth client is stored/);
  assert.match(r.stdout, /throwaway profile deleted/);
  const ev = JSON.parse(fs.readFileSync(evidence, 'utf8'));
  assert.equal(ev.mode, 'real account');
  assert.equal(ev.ok, false);
  assert.equal(JSON.stringify(ev).match(/Bearer\s+\S{12,}/), null);
  assert.deepEqual(leftovers().filter((n) => !before.has(n)), [], 'no throwaway profile is left behind');
});

test('--prompt-client without a terminal: a fixed error, nothing read from a pipe, no profile left behind', { skip }, () => {
  const before = new Set(leftovers());
  const r = run(['google-calendar', '--account', '--prompt-client']);
  assert.equal(r.status, 2, 'a setup error (2), not a failed check (1)');
  assert.match(r.stderr + r.stdout, /this needs a terminal: stdin is not a TTY/);
  assert.deepEqual(leftovers().filter((n) => !before.has(n)), []);
});

test('a profile another process holds is REFUSED (exit 2) before anything is read or written', { skip }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-held-'));
  const holder = path.join(dir, 'holder.cjs');
  fs.writeFileSync(holder, `const { app } = require('electron'); app.setPath('userData', ${JSON.stringify(path.join(dir, 'ud'))}); const got = app.requestSingleInstanceLock(); console.log('LOCK:' + got); app.whenReady().then(() => setTimeout(() => app.quit(), 40000));`);
  const child = spawn(ELECTRON, [holder], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { child.kill('SIGKILL'); fs.rmSync(dir, { recursive: true, force: true }); });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  const end = Date.now() + 20_000;
  while (!out.includes('LOCK:true') && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
  assert.ok(out.includes('LOCK:true'), 'the holder took the lock');
  const r = run(['google-calendar', '--account', '--user-data', path.join(dir, 'ud')]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /open on this profile/);
  assert.equal(fs.existsSync(path.join(dir, 'ud', 'integration-secrets.json')), false, 'nothing was written to the held profile');
});

test('--keep-signin is refused on a throwaway profile (it would delete the profile and leave the sign-in alive at the provider)', { skip }, () => {
  const r = run(['google-calendar', '--account', '--keep-signin']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--keep-signin needs/);
});

test('an interrupt (Ctrl-C or a kill) while waiting for input removes the throwaway profile (driven through a real pseudo-terminal)', { skip }, () => {
  const before = new Set(leftovers());
  const py = `
import os, pty, signal, sys, time, select
pid, fd = pty.fork()
if pid == 0:
    os.execv(${JSON.stringify(ELECTRON)}, [${JSON.stringify(ELECTRON)}, ${JSON.stringify(TOOL)}, 'google-calendar', '--account', '--prompt-client'])
out = b''
def pump(t):
    global out
    end = time.time() + t
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.1)
        if r:
            try: out += os.read(fd, 4096)
            except OSError: return
        if b'OAuth client ID:' in out: return
pump(25)
assert b'OAuth client ID:' in out, out[-300:]
os.kill(pid, signal.SIGINT)
_, status = os.waitpid(pid, 0)
print('EXIT', os.waitstatus_to_exitcode(status))
`;
  const r = spawnSync('python3', ['-c', py], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /EXIT (0|130)/);
  assert.deepEqual(leftovers().filter((n) => !before.has(n)), [], 'the interrupted run left its profile behind');
});
