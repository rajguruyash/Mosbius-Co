'use strict';

/**
 * INTEGRATIONS.md says what the app's own data says. The support tables in it are generated from
 * src/shared/providers.ts and src/shared/agentCompat.ts; if either changes (a provider becomes verified, a CLI is
 * run), this fails until the page is regenerated, so the documentation can never claim more than the evidence.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

test('INTEGRATIONS.md matches the data the app uses (regenerate with: node tools/gen-support-matrix.cjs)', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'gen-support-matrix.cjs'), '--check'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr || r.stdout);
});

test('the page never marks a provider verified that the data does not, and tells the truth about each CLI\'s shell', () => {
  const text = fs.readFileSync(path.join(ROOT, 'INTEGRATIONS.md'), 'utf8');
  const rowOf = (name) => text.split('\n').find((l) => l.startsWith(`| ${name} |`)) ?? '';
  assert.match(rowOf('Gemini CLI'), /\*\*VERIFIED\*\* \|.*\| visible to the agent's shell \| \*\*VERIFIED\*\* \|.*evidence\/gemini\/gemini-live\.json/);
  assert.match(rowOf('Codex CLI'), /hidden from the agent's shell, only while its OS sandbox is on/, 'Codex\'s label carries its measured condition');
  // the prose repeats what the table says: nothing in the page still calls the Gemini CLI unrun or unmeasured
  assert.equal(/Gemini CLI[^\n]{0,80}(WIRED, NOT RUN|not installed where this was built|\*\*not measured\*\*)/.test(text), false, 'stale Gemini wording');
  assert.match(text, /Gemini's shell can read the pass/, 'the page says plainly that Gemini\'s shell can read it');
  // F9 was attempted and left open: the documents say so, and say why, instead of presenting a switch that does not exist
  const report = fs.readFileSync(path.join(ROOT, 'SECURITY_REPORT.md'), 'utf8');
  const f9 = report.split('\n').find((l) => l.startsWith('| F9 |')) ?? '';
  assert.match(f9, /\*\*OPEN, on purpose/);
  assert.match(f9, /own process environment|its own process environment/);
  assert.match(f9, /no per-variable exclusion/);
  assert.match(f9, /SSH_AUTH_SOCK/);
  assert.match(text, /no Gemini setting can stop that/);
  assert.equal(/F9[^\n]{0,80}\b(FIXED|CLOSED|RESOLVED)\b/.test(`${text}\n${report}`), false, 'no document may call F9 fixed');
  for (const name of ['Notion', 'Linear', 'GitHub', 'Google Calendar', 'Gmail', 'Slack', 'Stripe', 'Sentry']) {
    const row = text.split('\n').find((l) => l.startsWith(`| ${name} |`));
    assert.ok(row, `${name} has a row`);
    assert.ok(/\*\*UNVERIFIED\*\*/.test(row), `${name} must read UNVERIFIED until a real sign-in is recorded`);
  }
  assert.match(text.split('\n').find((l) => l.startsWith('| Salesforce |')) ?? '', /NOT IMPLEMENTED/);
});

test('the page keeps the fan-made disclaimer and names no upstream project', () => {
  const text = fs.readFileSync(path.join(ROOT, 'INTEGRATIONS.md'), 'utf8');
  assert.match(text, /fan-made project inspired by How I Met Your Mother/);
  assert.equal(/Munder\s*Difflin/i.test(text), false);
});

test('the platforms workflow has the three jobs, signs and publishes nothing, and marks every non-macOS leg experimental', () => {
  // read as plain text: the project has no YAML parser of its own, and the file's matrix legs are one-line maps
  const text = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'platforms.yml'), 'utf8');
  const code = text.replace(/^\s*#.*$/gm, '');
  const jobs = [...code.slice(code.indexOf('\njobs:')).matchAll(/^  ([a-z][a-z-]*):\s*$/gm)].map((m) => m[1]);
  assert.deepEqual(jobs, ['test', 'package', 'ui']);
  const legs = [...code.matchAll(/- \{ os: ([a-z0-9.-]+)[^}]*experimental: (true|false)[^}]*\}/g)].map((m) => ({ os: m[1], experimental: m[2] === 'true' }));
  assert.ok(legs.length >= 7, `${legs.length} matrix legs read`);
  for (const os of ['windows-latest', 'ubuntu-latest']) assert.ok(legs.some((l) => l.os === os), `${os} is covered`);
  assert.ok(legs.some((l) => l.os.startsWith('macos')));
  for (const leg of legs.filter((l) => !l.os.startsWith('macos'))) assert.equal(leg.experimental, true, `${leg.os} must be marked experimental until it has run green`);
  for (const leg of legs.filter((l) => l.os.startsWith('macos'))) assert.equal(leg.experimental, false);
  assert.match(code, /--publish never/);
  assert.equal(/CSC_LINK|CSC_KEY_PASSWORD|APPLE_|GH_TOKEN|GITHUB_TOKEN|secrets\./.test(code), false, 'no signing credential, token or secret is used');
  assert.equal(/\bpublish: always\b|gh release|softprops\/action-gh-release/.test(code), false, 'nothing is released');
});
