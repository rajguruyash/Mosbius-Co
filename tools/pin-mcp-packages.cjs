#!/usr/bin/env node
'use strict';

/**
 * Pin the third-party packages the app runs (Stage B, F4).
 *
 *   node tools/pin-mcp-packages.cjs            re-lock every package in the catalogue (+ mcp-remote)
 *   node tools/pin-mcp-packages.cjs time git   only these ids
 *   node tools/pin-mcp-packages.cjs --check    verify the committed locks match the catalogue; offline
 *
 * For each package it writes `resources/mcp-locks/<id>/`:
 *   npm   package.json + package-lock.json     every tarball with its sha512 `integrity`
 *   pypi  requirements.in + requirements.txt   every wheel with its sha256 hashes
 * The app installs from these files and from nothing else (src/main/mcpPackages.ts): `npm ci
 * --ignore-scripts` and `uv pip install --require-hashes --no-deps --no-build`. Re-running this
 * is a deliberate act that changes what the app will run: review the diff of the lock files.
 * Needs network (and `uv` for PyPI packages) to lock; `--check` needs neither.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const loadTs = require('../test/load-ts.cjs');

const root = path.join(__dirname, '..');
const locksRoot = path.join(root, 'resources', 'mcp-locks');
const { mcpPinnedPackages } = loadTs('src/shared/mcpCatalog.ts');

const args = process.argv.slice(2);
const check = args.includes('--check');
const only = args.filter((a) => !a.startsWith('--'));

function sh(cmd, argv, cwd) {
  const r = spawnSync(cmd, argv, { cwd, encoding: 'utf8', env: { ...process.env, npm_config_update_notifier: 'false' } });
  if (r.status !== 0) throw new Error(`${cmd} ${argv.join(' ')} failed:\n${(r.stderr || r.stdout || '').slice(-1500)}`);
  return r.stdout;
}

/** Problems with a committed npm lock (empty = fine). Pure file inspection. */
function checkNpmLock(dir, pkg) {
  const problems = [];
  let lock;
  try { lock = JSON.parse(fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8')); } catch { return ['package-lock.json missing or unreadable']; }
  if (lock.lockfileVersion !== 3) problems.push(`lockfileVersion ${lock.lockfileVersion} (want 3)`);
  const top = lock.packages?.[`node_modules/${pkg.name}`];
  if (!top) problems.push(`no entry for ${pkg.name}`);
  else {
    if (top.version !== pkg.version) problems.push(`locked ${top.version}, catalogue says ${pkg.version}`);
    if (!/^sha512-/.test(top.integrity ?? '')) problems.push(`${pkg.name} has no sha512 integrity`);
  }
  for (const [k, v] of Object.entries(lock.packages ?? {})) {
    if (k === '') continue;
    if (!/^sha512-[A-Za-z0-9+/=]+$/.test(v.integrity ?? '')) problems.push(`${k} has no sha512 integrity`);
    if (typeof v.resolved !== 'string' || !/^https:\/\/registry\.npmjs\.org\//.test(v.resolved)) problems.push(`${k} does not resolve to the npm registry (${v.resolved})`);
    if (v.link) problems.push(`${k} is a link`);
  }
  return problems;
}

/** Problems with a committed PyPI lock. */
function checkPyLock(dir, pkg) {
  const problems = [];
  let text;
  try { text = fs.readFileSync(path.join(dir, 'requirements.txt'), 'utf8'); } catch { return ['requirements.txt missing']; }
  const re = new RegExp(`^${pkg.name.replace(/[-_.]+/g, '[-_.]+')}==${pkg.version.replace(/\./g, '\\.')}\\b`, 'im');
  if (!re.test(text)) problems.push(`requirements.txt does not pin ${pkg.name}==${pkg.version}`);
  const entries = text.split(/\n(?=\S)/).filter((b) => /^[A-Za-z0-9_.-]+==/.test(b));
  if (entries.length === 0) problems.push('no pinned requirements');
  for (const b of entries) {
    if (!/--hash=sha256:[0-9a-f]{64}/.test(b)) problems.push(`${b.split('==')[0]} has no sha256 hash`);
    if (/^\s*(-e|git\+|https?:|file:)/m.test(b)) problems.push(`${b.split('==')[0]} is not a plain registry release`);
  }
  return problems;
}

let bad = 0;
for (const { lockId, pkg } of mcpPinnedPackages()) {
  if (only.length && !only.includes(lockId)) continue;
  const dir = path.join(locksRoot, lockId);
  if (!/^[A-Za-z0-9._-]+$/.test(lockId)) throw new Error(`unsafe lock id ${lockId}`);
  if (!/^\d+(\.\d+)*([-+][0-9A-Za-z.-]+)?$/.test(pkg.version)) throw new Error(`${pkg.name}: version ${pkg.version} is not an exact release`);
  if (!check) {
    fs.mkdirSync(dir, { recursive: true });
    if (pkg.manager === 'npm') {
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
        name: `mosbius-mcp-${lockId}`, version: '0.0.0', private: true, dependencies: { [pkg.name]: pkg.version }
      }, null, 2) + '\n');
      fs.rmSync(path.join(dir, 'package-lock.json'), { force: true });
      sh('npm', ['install', '--package-lock-only', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org/'], dir);
    } else {
      fs.writeFileSync(path.join(dir, 'requirements.in'), `${pkg.name}==${pkg.version}\n`);
      sh('uv', ['pip', 'compile', 'requirements.in', '--universal', '--generate-hashes', '--no-header', '--python-version', '3.10', '-o', 'requirements.txt'], dir);
    }
  }
  const problems = pkg.manager === 'npm' ? checkNpmLock(dir, pkg) : checkPyLock(dir, pkg);
  if (problems.length) { bad++; console.error(`✗ ${lockId} (${pkg.name}@${pkg.version}):\n   ${problems.join('\n   ')}`); }
  else console.log(`✓ ${lockId.padEnd(20)} ${pkg.manager.padEnd(5)} ${pkg.name}@${pkg.version}`);
}
process.exit(bad ? 1 : 0);
