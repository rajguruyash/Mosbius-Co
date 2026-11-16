'use strict';

/**
 * package.json and package-lock.json agree, so `npm ci` (which CI runs first, in every job) can install.
 *
 * The failure this guards: CI stopped at `npm ci` with
 *
 *     npm error `npm ci` can only install packages when your package.json and package-lock.json are in sync.
 *     npm error Missing: ws@8.23.0 from lock file
 *
 * `openai@6.44.0`, which @openai/agents-core pulls in, declares `ws ^8.18.0` as an OPTIONAL peer dependency. The lock held
 * `ws@7.5.11` (hoisted, for tunnelmole), which does not satisfy it. An optional peer is not installed on its own, but once
 * another package in the tree resolves it, the version has to satisfy the range, so `npm ci` wanted a second copy
 * (`ws@8.23.0`) the lock did not list. `npm install --package-lock-only` records it; nothing in package.json changed.
 *
 * Both checks below run offline and in under a second, and both fail on the old lock: `npm ls --package-lock-only --all`
 * reports `ws@7.5.11 deduped invalid: "^8.18.0" from .../openai`, and `npm ci --dry-run` prints the line above.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));

/** Runs npm without a shell where it can; says so (returns null) when npm is not installed, which is no fault of the project. */
function npm(args) {
  const win = process.platform === 'win32';
  const r = spawnSync(win ? 'npm.cmd' : 'npm', args, { cwd: ROOT, encoding: 'utf8', shell: win, timeout: 120000 });
  if (r.error && r.error.code === 'ENOENT') return null;
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

test('the lock is for this package, at the version package.json has, and its root entry lists the same dependencies', () => {
  assert.equal(lock.lockfileVersion, 3);
  assert.equal(lock.name, pkg.name, 'package-lock.json names another package (a rename left it behind)');
  assert.equal(lock.version, pkg.version);
  const root = lock.packages[''];
  assert.equal(root.name, pkg.name);
  assert.equal(root.version, pkg.version);
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    assert.deepEqual(root[field] ?? {}, pkg[field] ?? {}, `${field} differ between package.json and the lock's root entry: run \`npm install --package-lock-only\``);
  }
  // every dependency package.json names is in the lock, at a version that satisfies the range's major
  for (const field of ['dependencies', 'devDependencies']) {
    for (const name of Object.keys(pkg[field] ?? {})) assert.ok(lock.packages[`node_modules/${name}`], `${name} is in package.json but not in the lock`);
  }
});

test('npm ls --package-lock-only: no dependency in the lock fails the range that asks for it (the check that caught ws)', (t) => {
  const r = npm(['ls', '--package-lock-only', '--all']);
  if (!r) return t.skip('npm is not installed here');
  // npm marks a problem edge with a word after the package ("ws@7.5.11 deduped invalid: ..."); a package that merely has the
  // word in its name (character-reference-invalid) is not a problem, so the word has to stand on its own after a space.
  // "UNMET OPTIONAL DEPENDENCY" is how npm says an optional package was not installed: that is what optional means.
  const bad = r.out.split('\n').filter((l) => /\s(invalid|extraneous)(:|\s|$)|UNMET DEPENDENCY|\smissing:/i.test(l) && !/^npm warn/i.test(l));
  assert.equal(r.status, 0, `the lock is out of step with package.json (regenerate it with \`npm install --package-lock-only\`, no hand edits):\n${bad.join('\n') || r.out.slice(-600)}`);
  assert.deepEqual(bad, []);
});

test('npm ci --dry-run, the command CI runs first: it accepts the lock without installing or fetching anything', (t) => {
  const r = npm(['ci', '--dry-run', '--ignore-scripts', '--offline', '--no-audit', '--no-fund']);
  if (!r) return t.skip('npm is not installed here');
  assert.equal(/Missing: [^\n]+ from lock file|are in sync|EUSAGE/.test(r.out), false, `npm ci refuses the lock:\n${r.out.split('\n').filter((l) => /npm error/.test(l)).join('\n')}`);
  assert.equal(r.status, 0, r.out.slice(-800));
});

test('the lock only points at the npm registry, plus the one pinned build tool that comes from git', () => {
  const GIT_ALLOWED = new Map([
    // electron-rebuild's node-gyp fork, pinned to a full commit by its own manifest; reviewed here once, on purpose
    ['node_modules/@electron/node-gyp', /^git\+ssh:\/\/git@github\.com\/electron\/node-gyp\.git#[0-9a-f]{40}$/]
  ]);
  const seen = [];
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (!key) continue;
    assert.equal(Boolean(entry.link), false, `${key} is a local link: a lock that points at this machine cannot be installed elsewhere`);
    assert.ok(entry.resolved, `${key} has no resolved address`);
    if (GIT_ALLOWED.has(key)) {
      seen.push(key);
      assert.match(entry.resolved, GIT_ALLOWED.get(key), `${key} must stay pinned to one commit`);
      continue;
    }
    assert.match(entry.resolved, /^https:\/\/registry\.npmjs\.org\//, `${key} comes from somewhere other than the npm registry: ${entry.resolved}`);
    assert.match(entry.integrity ?? '', /^sha(512|384|256)-/, `${key} has no integrity hash`);
  }
  assert.deepEqual(seen, [...GIT_ALLOWED.keys()], 'an expected git dependency is gone: remove it from the allow-list');
});

test('a package that only installs on some systems is optional, so `npm ci` works on every system CI and the installers use', () => {
  let platformBound = 0;
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (!entry.os && !entry.cpu) continue;
    platformBound++;
    assert.ok(entry.optional || entry.devOptional, `${key} is limited to ${JSON.stringify(entry.os ?? entry.cpu)} but is not optional: \`npm ci\` would fail on any other system`);
  }
  assert.ok(platformBound > 10, 'the platform-specific packages were found and checked');
});
