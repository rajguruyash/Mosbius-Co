'use strict';

/**
 * F4 — the verified package store, with npm and uv replaced by a fake runner.
 *
 * What is pinned: the install command lines (the flags that make it safe are present: scripts
 * off, hashes required, nothing built); the installer's environment is a short allow-list; an
 * install is only ever trusted once its marker exists, and the marker is written last; a version
 * that is not the pinned one, a missing executable, a timeout or a failed command leave NOTHING
 * that reads as installed; a changed lock is a different install; concurrent callers share one
 * install; an executable outside its package is refused; old installs are pruned.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { PackageStore } = loadTs('src/main/mcpPackages.ts');

const NPM = { manager: 'npm', name: '@scope/server', version: '1.2.3', bin: 'server-bin' };
const PY = { manager: 'pypi', name: 'mcp-server-x', version: '2026.1.1', bin: 'mcp-server-x' };

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mosbius-pkg-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const locks = path.join(base, 'locks');
  const root = path.join(base, 'store');
  fs.mkdirSync(path.join(locks, 'npmpkg'), { recursive: true });
  fs.writeFileSync(path.join(locks, 'npmpkg', 'package.json'), '{"name":"x","dependencies":{"@scope/server":"1.2.3"}}');
  fs.writeFileSync(path.join(locks, 'npmpkg', 'package-lock.json'), '{"lockfileVersion":3}');
  fs.mkdirSync(path.join(locks, 'pypkg'), { recursive: true });
  fs.writeFileSync(path.join(locks, 'pypkg', 'requirements.txt'), 'mcp-server-x==2026.1.1 \\\n    --hash=sha256:' + 'a'.repeat(64) + '\n');
  const calls = [];
  const behaviour = { npm: 'ok', version: '1.2.3', bin: 'dist/index.js', skipBin: false };
  const which = (n) => ({ npm: '/fake/npm', uv: '/fake/uv', node: '/fake/node' }[n]);
  const run = async (cmd, args, o) => {
    calls.push({ cmd, args, cwd: o.cwd, env: o.env });
    if (behaviour.npm === 'timeout') return { code: null, timedOut: true };
    if (behaviour.npm === 'fail') return { code: 1, timedOut: false };
    if (path.basename(cmd) === 'npm') {
      const pkgDir = path.join(o.cwd, 'node_modules', '@scope', 'server');
      fs.mkdirSync(path.join(pkgDir, 'dist'), { recursive: true });
      fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: '@scope/server', version: behaviour.version, bin: { 'server-bin': behaviour.bin } }));
      if (!behaviour.skipBin) fs.writeFileSync(path.join(pkgDir, 'dist', 'index.js'), '//');
    } else if (args[0] === 'venv') {
      fs.mkdirSync(path.join(args[args.length - 1], 'bin'), { recursive: true });
    } else if (args[0] === 'pip') {
      const venv = path.dirname(path.dirname(args[args.indexOf('--python') + 1]));
      fs.mkdirSync(path.join(venv, 'bin'), { recursive: true });
      if (!behaviour.skipBin) fs.writeFileSync(path.join(venv, 'bin', 'mcp-server-x'), '#!/bin/sh');
    }
    return { code: 0, timedOut: false };
  };
  const store = new PackageStore({
    root, locksRoot: locks, run, which, platform: 'linux',
    env: () => ({ PATH: '/usr/bin', HOME: '/home/u', LANG: 'C' })
  });
  return { store, calls, behaviour, root, locks, which };
}

test('an npm install uses the lock only, with scripts off, and ends with a marker and a launch command', async (t) => {
  const f = fixture(t);
  assert.equal(f.store.readyLaunch('npmpkg', NPM), undefined, 'nothing is installed yet');
  assert.equal(f.store.state('npmpkg', NPM), 'missing');
  assert.deepEqual(await f.store.ensure('npmpkg', NPM), { ok: true });
  const [c] = f.calls;
  assert.equal(c.cmd, '/fake/npm');
  assert.equal(c.args[0], 'ci', 'npm ci installs exactly what the lock says, and fails on any mismatch');
  for (const flag of ['--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund']) assert.ok(c.args.includes(flag), `missing ${flag}`);
  assert.equal(c.env.npm_config_ignore_scripts, 'true');
  const launch = f.store.readyLaunch('npmpkg', NPM);
  assert.equal(launch.command, '/fake/node');
  assert.ok(launch.args[0].endsWith(path.join('node_modules', '@scope', 'server', 'dist', 'index.js')));
  assert.equal(f.store.state('npmpkg', NPM), 'ready');
});

test('a PyPI install requires hashes, takes no dependencies of its own, and builds nothing', async (t) => {
  const f = fixture(t);
  assert.deepEqual(await f.store.ensure('pypkg', PY), { ok: true });
  const pip = f.calls.find((c) => c.args[0] === 'pip');
  for (const flag of ['--require-hashes', '--no-deps', '--no-build', '--no-config']) assert.ok(pip.args.includes(flag), `missing ${flag}`);
  assert.ok(pip.args.includes(path.join(f.locks, 'pypkg', 'requirements.txt')), 'installs from the shipped lock file');
  assert.ok(f.store.readyLaunch('pypkg', PY).command.endsWith(path.join('venv', 'bin', 'mcp-server-x')));
});

test('the installer\'s environment is the allow-list it was given, not the app\'s environment', async (t) => {
  process.env.MOSBIUS_TEST_SECRET = 'SHOULD-NOT-LEAK';
  t.after(() => { delete process.env.MOSBIUS_TEST_SECRET; });
  const f = fixture(t);
  await f.store.ensure('npmpkg', NPM);
  assert.equal(JSON.stringify(f.calls[0].env).includes('SHOULD-NOT-LEAK'), false);
  assert.equal(f.calls[0].env.PATH, '/usr/bin');
});

test('the marker is written LAST: a failed, timed-out or wrong-version install leaves nothing that reads as installed', async (t) => {
  for (const [mode, error] of [['fail', 'install-failed'], ['timeout', 'timeout']]) {
    const f = fixture(t);
    f.behaviour.npm = mode;
    assert.deepEqual(await f.store.ensure('npmpkg', NPM), { ok: false, error });
    assert.equal(f.store.readyLaunch('npmpkg', NPM), undefined);
    assert.equal(f.store.state('npmpkg', NPM), 'failed');
  }
  const wrong = fixture(t);
  wrong.behaviour.version = '9.9.9';
  assert.deepEqual(await wrong.store.ensure('npmpkg', NPM), { ok: false, error: 'version-mismatch' });
  assert.equal(wrong.store.readyLaunch('npmpkg', NPM), undefined, 'a different release is not the pinned one');
  const nobin = fixture(t);
  nobin.behaviour.skipBin = true;
  assert.deepEqual(await nobin.store.ensure('npmpkg', NPM), { ok: false, error: 'bin-missing' });
  assert.equal(fs.existsSync(nobin.store.dirFor('npmpkg', NPM)), false, 'and the half-install was removed');
});

test('a half-finished install without its marker is not trusted, and the next attempt starts clean', async (t) => {
  const f = fixture(t);
  const dir = f.store.dirFor('npmpkg', NPM);
  fs.mkdirSync(path.join(dir, 'node_modules', '@scope', 'server', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', '@scope', 'server', 'package.json'), JSON.stringify({ version: '1.2.3', bin: { 'server-bin': 'dist/index.js' } }));
  fs.writeFileSync(path.join(dir, 'node_modules', '@scope', 'server', 'dist', 'index.js'), '//');
  assert.equal(f.store.readyLaunch('npmpkg', NPM), undefined, 'files without a marker are not an install');
  fs.writeFileSync(path.join(dir, 'LEFTOVER'), 'x');
  await f.store.ensure('npmpkg', NPM);
  assert.equal(fs.existsSync(path.join(dir, 'LEFTOVER')), false, 'the old attempt was discarded, not built on');
});

test('a changed lock is a different install: the old one stops counting and is removed after the new one lands', async (t) => {
  const f = fixture(t);
  await f.store.ensure('npmpkg', NPM);
  const first = f.store.dirFor('npmpkg', NPM);
  fs.writeFileSync(path.join(f.locks, 'npmpkg', 'package-lock.json'), '{"lockfileVersion":3,"changed":true}');
  assert.equal(f.store.readyLaunch('npmpkg', NPM), undefined, 'the shipped lock changed, so the old install is not enough');
  await f.store.ensure('npmpkg', NPM);
  assert.notEqual(f.store.dirFor('npmpkg', NPM), first);
  assert.equal(fs.existsSync(first), false, 'the previous release is pruned');
  assert.ok(f.store.readyLaunch('npmpkg', NPM));
});

test('callers asking at the same time share one install', async (t) => {
  const f = fixture(t);
  const [a, b, c] = await Promise.all([f.store.ensure('npmpkg', NPM), f.store.ensure('npmpkg', NPM), f.store.ensure('npmpkg', NPM)]);
  assert.deepEqual([a.ok, b.ok, c.ok], [true, true, true]);
  assert.equal(f.calls.length, 1);
});

test('installing is reported while it runs', async (t) => {
  const f = fixture(t);
  const p = f.store.ensure('npmpkg', NPM);
  assert.equal(f.store.state('npmpkg', NPM), 'installing');
  await p;
  assert.equal(f.store.state('npmpkg', NPM), 'ready');
});

test('a missing tool or lock is a clear refusal, not a guess', async (t) => {
  const f = fixture(t);
  const noNpm = new PackageStore({ root: f.root, locksRoot: f.locks, run: async () => ({ code: 0, timedOut: false }), which: (n) => (n === 'npm' ? undefined : '/x'), env: () => ({}) });
  assert.deepEqual(await noNpm.ensure('npmpkg', NPM), { ok: false, error: 'no-npm' });
  const noUv = new PackageStore({ root: f.root, locksRoot: f.locks, run: async () => ({ code: 0, timedOut: false }), which: (n) => (n === 'uv' ? undefined : '/x'), env: () => ({}) });
  assert.deepEqual(await noUv.ensure('pypkg', PY), { ok: false, error: 'no-uv' });
  const noNode = new PackageStore({ root: f.root, locksRoot: f.locks, run: async () => ({ code: 0, timedOut: false }), which: (n) => (n === 'node' ? undefined : '/x'), env: () => ({}) });
  assert.deepEqual(await noNode.ensure('npmpkg', NPM), { ok: false, error: 'no-node' });
  assert.deepEqual(await f.store.ensure('nolock', NPM), { ok: false, error: 'no-lock' });
  assert.deepEqual(await f.store.ensure('../escape', NPM), { ok: false, error: 'no-lock' }, 'an unsafe id is never used to build a path');
});

test('an executable that points outside its package is refused', async (t) => {
  const f = fixture(t);
  f.behaviour.bin = '../../../../evil.js';
  const r = await f.store.ensure('npmpkg', NPM);
  assert.equal(r.ok, false);
  assert.equal(f.store.readyLaunch('npmpkg', NPM), undefined);
});

test('a marker for another release or another package does not make an install ready', async (t) => {
  const f = fixture(t);
  await f.store.ensure('npmpkg', NPM);
  const dir = f.store.dirFor('npmpkg', NPM);
  const marker = path.join(dir, '.verified.json');
  const good = JSON.parse(fs.readFileSync(marker, 'utf8'));
  for (const bad of [{ ...good, version: '0.0.1' }, { ...good, name: 'other' }, { ...good, lockHash: 'f'.repeat(64) }]) {
    fs.writeFileSync(marker, JSON.stringify(bad));
    assert.equal(f.store.readyLaunch('npmpkg', NPM), undefined);
  }
  fs.writeFileSync(marker, '{not json');
  assert.equal(f.store.readyLaunch('npmpkg', NPM), undefined);
});

test('uninstall removes everything for one package and forgets the failure', async (t) => {
  const f = fixture(t);
  f.behaviour.npm = 'fail';
  await f.store.ensure('npmpkg', NPM);
  assert.equal(f.store.state('npmpkg', NPM), 'failed');
  f.store.uninstall('npmpkg');
  assert.equal(f.store.state('npmpkg', NPM), 'missing');
  f.behaviour.npm = 'ok';
  await f.store.ensure('npmpkg', NPM);
  f.store.uninstall('npmpkg');
  assert.equal(fs.existsSync(path.join(f.root, 'npmpkg')), false);
});
