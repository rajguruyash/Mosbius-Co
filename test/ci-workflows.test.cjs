'use strict';

/**
 * The GitHub Actions workflows (.github/workflows/) keep doing what they are for.
 *
 *   - Every action runs on a supported runtime. GitHub deprecated actions that run on Node 20 ("Node.js 20 actions are
 *     deprecated"); checkout and setup-node v4, upload-artifact v4/v5 and github-script v7 are such actions, and the first
 *     majors that run on Node 24 are below. That is the runtime of the ACTIONS: the project's own tooling runtime is the
 *     `node-version` each job asks setup-node for, and nothing here pins it to a number, only to one value per file.
 *   - The jobs are the project's real ones: install with `npm ci` (so a lock out of step fails loudly, as it did), typecheck
 *     both processes, build, run the suite, and check that README.md, INTEGRATIONS.md and the website match the app.
 *   - Nothing here publishes, signs, deploys or releases; the one workflow that builds installers only runs when asked.
 *   - The pull_request_target gate never checks out or runs a pull request's code (its own file says why).
 *
 * The files are read as text: the project has no YAML parser of its own (see support-matrix-doc.test.cjs).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, '.github', 'workflows');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const files = fs.readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f)).sort();
const text = Object.fromEntries(files.map((f) => [f, fs.readFileSync(path.join(DIR, f), 'utf8')]));
/** The file without whole-line comments, which say why and are not instructions. */
const code = (f) => text[f].replace(/^\s*#.*$/gm, '');

/** The first major of each first-party action that runs on Node 24 (read from each action's action.yml on 2026-11-16). */
const FIRST_NODE24 = { checkout: 5, 'setup-node': 5, 'upload-artifact': 6, 'download-artifact': 6, 'github-script': 8, cache: 5 };

const usesOf = (f) => [...code(f).matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gm)].map((m) => m[1]);
/** The text of each job, by name, in file order. */
const jobBlocks = (f) => {
  const c = code(f);
  const at = c.indexOf('\njobs:');
  const out = {};
  if (at < 0) return out;
  const parts = c.slice(at).split(/^  ([a-z][\w-]*):[ \t]*$/m);     // ['\njobs:\n', 'typecheck', '<its text>', 'build', ...]
  for (let i = 1; i < parts.length; i += 2) out[parts[i]] = parts[i + 1];
  return out;
};
const jobsOf = (f) => Object.keys(jobBlocks(f));
const stepsRun = (f) => [...code(f).matchAll(/^\s*-?\s*run:\s*(.+)$/gm)].map((m) => m[1].trim());

test('there are workflow files, they are plain YAML with the expected top-level keys, and none uses a tab', () => {
  assert.deepEqual(files, ['ci.yml', 'platforms.yml', 'pr-evidence.yml']);
  for (const f of files) {
    assert.equal(/\t/.test(text[f]), false, `${f} has a tab, which YAML forbids for indentation`);
    for (const key of ['name', 'on', 'jobs', 'permissions']) assert.match(code(f), new RegExp(`^${key}:`, 'm'), `${f} has a top-level ${key}:`);
    assert.ok(jobsOf(f).length >= 1, `${f} has jobs`);
  }
});

test('every action is first-party, pinned to a major, and a major that runs on Node 24 (the deprecation warning)', () => {
  let seen = 0;
  for (const f of files) {
    for (const u of usesOf(f)) {
      seen++;
      const m = /^actions\/([a-z-]+)@v(\d+)$/.exec(u);
      assert.ok(m, `${f} uses ${u}: only actions/* at a major tag is expected here (review anything else on purpose, then allow it)`);
      const first = FIRST_NODE24[m[1]];
      assert.ok(first, `${f} uses actions/${m[1]}, which this test does not know the Node 24 major of`);
      assert.ok(Number(m[2]) >= first, `${f}: actions/${m[1]}@v${m[2]} runs on Node 20, which GitHub has deprecated; v${first} or later runs on Node 24`);
    }
  }
  assert.ok(seen >= 10, `${seen} action uses were read`);
});

test('ci.yml: the jobs, what they run, and that the project\'s own Node version is one value used everywhere', () => {
  assert.deepEqual(jobsOf('ci.yml'), ['typecheck', 'build', 'website', 'test']);
  const c = code('ci.yml');
  assert.match(c, /^on:\n\s+push:\n\s+branches: \[main, 'release\/\*\*'\]\n\s+pull_request:\n\s+branches: \[main, 'release\/\*\*'\]/m);
  assert.match(c, /^permissions:\n\s+contents: read\s*$/m, 'the workflow token is read-only');
  assert.equal(/pull_request_target/.test(c), false, 'ci.yml builds pull request code, so it must not run with the base repository\'s token');

  const runs = stepsRun('ci.yml');
  const has = (cmd) => assert.ok(runs.some((r) => r === cmd), `ci.yml runs \`${cmd}\``);
  for (const cmd of ['npm run typecheck', 'npm run check:links', 'npm run build', 'npm run docs:check', 'npm run website:check', 'node --test test/*.test.cjs']) has(cmd);
  // dependencies install with `npm ci`, never `npm install`: a lock out of step with package.json has to fail, not be quietly rewritten
  assert.equal(runs.filter((r) => /^npm install\b/.test(r)).length, 0);
  assert.ok(runs.filter((r) => /^npm ci\b/.test(r)).length >= 4, 'every job installs with npm ci');
  // the job that only reads the sources does not run the native rebuild, and nothing in CI writes into the repository
  assert.ok(runs.includes('npm ci --ignore-scripts'));
  assert.equal(runs.some((r) => /website:build|docs:gen/.test(r)), false, 'CI checks the generated files; it does not rewrite them');

  // one Node version for the project's own tooling, the same in every job
  const versions = [...c.matchAll(/node-version:\s*([^\s#]+)/g)].map((m) => m[1]);
  assert.equal(versions.length, 4, 'every job sets its Node version');
  assert.equal(new Set(versions).size, 1, `the jobs disagree about the Node version: ${versions.join(', ')}`);
  assert.ok(/^\d+$/.test(versions[0]), 'a major version, as it has always been');
  assert.equal((c.match(/cache: npm/g) ?? []).length, 4, 'npm\'s download cache is kept');
  assert.equal((c.match(/timeout-minutes:/g) ?? []).length, 4, 'no job can hang for six hours');
  // the two jobs that were allowed to fail while unproven still say so, and the gate jobs do not
  const blocks = jobBlocks('ci.yml');
  for (const j of ['build', 'test']) assert.match(blocks[j], /continue-on-error: true/, `${j} is non-blocking until it has run green on a GitHub runner`);
  for (const j of ['typecheck', 'website']) {
    assert.ok(blocks[j].length > 100, `the ${j} job was read`);
    assert.equal(/continue-on-error/.test(blocks[j]), false, `${j} blocks`);
  }
  assert.match(blocks.website, /runs-on: ubuntu-latest/, 'the documents job needs no macOS runner');
});

test('every npm script a workflow runs exists in package.json', () => {
  let named = 0;
  for (const f of files) {
    for (const r of stepsRun(f)) {
      for (const m of r.matchAll(/npm run ([a-z][\w:-]*)/g)) {
        named++;
        assert.ok(pkg.scripts[m[1]], `${f} runs \`npm run ${m[1]}\`, which package.json does not define`);
      }
    }
  }
  assert.ok(named >= 6);
  // and each script CI relies on is the one the docs promise
  assert.equal(pkg.scripts['website:check'], 'node tools/build-website.cjs --check');
  assert.equal(pkg.scripts['docs:check'], 'node tools/gen-docs.cjs --check && node tools/gen-support-matrix.cjs --check');
});

test('nothing publishes, signs, deploys or releases; the installer workflow only runs when someone asks', () => {
  for (const f of files) {
    const c = code(f);
    assert.equal(/CSC_LINK|CSC_KEY_PASSWORD|APPLE_ID|APPLE_APP_SPECIFIC|GH_TOKEN|secrets\.[A-Z_]+/.test(c), false, `${f} uses a secret`);
    assert.equal(/gh release|action-gh-release|npm publish|\bpublish: always\b|gh-pages|pages: write|deploy-pages|id-token: write/.test(c), false, `${f} publishes or deploys`);
    assert.equal(/contents: write|packages: write|deployments: write/.test(c), false, `${f} can write to the repository`);
  }
  const p = code('platforms.yml');
  assert.match(p, /^on:\n\s+workflow_dispatch:/m);
  assert.equal(/^\s+(push|pull_request|pull_request_target|schedule|release|workflow_run):/m.test(p), false, 'platforms.yml builds unsigned installers and keeps them for a week, so it only runs by hand');
  assert.match(p, /--publish never/);
});

test('pr-evidence.yml never checks out or runs a pull request\'s code, because it runs with write permission', () => {
  const c = code('pr-evidence.yml');
  assert.match(c, /^on:\n\s+pull_request_target:/m);
  assert.equal(/actions\/checkout|^\s*-?\s*run:|npm |node |\bsh\b|bash/m.test(c.replace(/script: \|[\s\S]*$/, '')), false, 'a step outside the inline script runs something');
  assert.match(c, /^permissions:\n\s+pull-requests: write\s*$/m, 'it can comment on a pull request and do nothing else');
  assert.deepEqual(usesOf('pr-evidence.yml').map((u) => u.split('@')[0]), ['actions/github-script'], 'the gate uses one action and nothing else');
  // the inline script uses only what github-script v8 still injects
  const script = text['pr-evidence.yml'].slice(text['pr-evidence.yml'].indexOf('script: |'));
  assert.equal(/require\(\s*['"]@actions\/github['"]\s*\)/.test(script), false, 'require("@actions/github") stopped working in github-script v9');
  assert.match(script, /github\.rest\.issues\./);
  assert.match(script, /context\.payload\.pull_request/);
});
