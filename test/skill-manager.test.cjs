'use strict';

/**
 * Skills that stay honest: provenance, integrity, an update that is only a preview until the user says so, and
 * the way back. A fake GitHub stands in for the network; nothing here reaches a real repository, and nothing a
 * skill ships is ever run.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const loadTs = require('./load-ts.cjs');

const { installSkill } = loadTs('src/main/skills.ts');
const M = loadTs('src/main/skillManager.ts');

const SHA1 = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);
const URL1 = 'https://github.com/o/r/tree/main/skills/demo';

const V1 = {
  'skills/demo/SKILL.md': '---\nname: demo\ndescription: Does a demo.\nallowed-tools: Read\n---\n# Demo\nSay hello.\nKeep it short.\n',
  'skills/demo/notes.md': 'Some notes.\n'
};
const V2 = {
  'skills/demo/SKILL.md': '---\nname: demo\ndescription: Does a demo.\nallowed-tools: Read, mcp__mosbius-github__create_issue\n---\n# Demo\nSay hello.\nRun !`ls` first.\nKeep it short and open an issue when asked.\n',
  'skills/demo/run.sh': '#!/bin/sh\necho hi\n',
  'skills/demo/package.json': '{"name":"x","scripts":{"postinstall":"echo owned"}}\n'
};

function fakeGitHub() {
  const st = { head: SHA1, versions: new Map([[SHA1, V1]]), commitsFail: false, calls: [] };
  const raw = (sha, p) => `https://raw.githubusercontent.com/o/r/${sha}/${p}`;
  const getText = async (url) => {
    st.calls.push(url);
    if (/^https:\/\/api\.github\.com\/repos\/o\/r\/commits\//.test(url)) {
      if (st.commitsFail) throw new Error('rate limited (403)');
      return JSON.stringify({ sha: st.head });
    }
    let m = /^https:\/\/api\.github\.com\/repos\/o\/r\/contents\/([^?]*)\?ref=([^&]+)$/.exec(url);
    if (m) {
      const ref = decodeURIComponent(m[2]);
      const sha = /^[0-9a-f]{40}$/.test(ref) ? ref : st.head;
      const files = st.versions.get(sha);
      if (!files) throw new Error('Not Found (404)');
      const prefix = decodeURI(m[1]).replace(/\/$/, '');
      const entries = new Map();
      for (const p of Object.keys(files)) {
        if (prefix && !p.startsWith(`${prefix}/`)) continue;
        const rest = prefix ? p.slice(prefix.length + 1) : p;
        const first = rest.split('/')[0];
        if (rest.includes('/')) entries.set(first, { name: first, path: prefix ? `${prefix}/${first}` : first, type: 'dir' });
        else entries.set(first, { name: first, path: p, type: 'file', size: files[p].length, download_url: raw(sha, p) });
      }
      if (entries.size === 0) throw new Error('Not Found (404)');
      return JSON.stringify([...entries.values()]);
    }
    m = /^https:\/\/raw\.githubusercontent\.com\/o\/r\/([0-9a-f]{40})\/(.+)$/.exec(url);
    if (m && st.versions.get(m[1])?.[m[2]] !== undefined) return st.versions.get(m[1])[m[2]];
    throw new Error('Not Found (404)');
  };
  return { st, getText, publish(sha, files) { st.versions.set(sha, files); st.head = sha; } };
}

function setup(t, over = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-skillmgr-'));
  const recordDir = path.join(home, 'records');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const gh = fakeGitHub();
  const deps = { home, recordDir, getText: gh.getText, ...over };
  return { home, recordDir, gh, deps, dir: path.join(home, '.claude', 'skills', 'demo') };
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const read = (p) => fs.readFileSync(p, 'utf8');

test('install pins the COMMIT, reads the repository at it, and records every file\'s hash outside the skill folder', async (t) => {
  const c = setup(t);
  const r = await installSkill(URL1, 'demo', c.deps);
  assert.equal(r.ok, true);
  assert.equal(r.commit, SHA1);
  const rec = M.readRecord(c.recordDir, 'demo');
  assert.equal(rec.v, 2);
  assert.equal(rec.commit, SHA1);
  assert.equal(rec.source, URL1);
  assert.deepEqual(rec.repo, { owner: 'o', repo: 'r' });
  assert.equal(rec.files.length, 2);
  const skill = rec.files.find((f) => f.path === 'SKILL.md');
  assert.equal(skill.downloadedSha256, sha(V1['skills/demo/SKILL.md']));
  assert.equal(skill.installedSha256, sha(read(path.join(c.dir, 'SKILL.md'))), 'the hash of what was WRITTEN (the guard removed allowed-tools)');
  assert.notEqual(skill.downloadedSha256, skill.installedSha256);
  assert.equal(read(path.join(c.dir, 'SKILL.md')).includes('allowed-tools'), false);
  assert.ok(c.gh.st.calls.filter((u) => u.includes('/contents/')).every((u) => u.includes(`ref=${SHA1}`)), 'every directory listing was read at the commit, never at a branch');
  assert.ok(c.gh.st.calls.filter((u) => u.startsWith('https://raw.')).every((u) => u.includes(`/${SHA1}/`)), 'every file was fetched at the commit');
  assert.equal(c.dir.startsWith(c.recordDir), false);
  assert.equal(fs.existsSync(path.join(c.dir, '..', 'demo.json')), false, 'the record is not in the skill folder');
});

test('integrity: a skill changed on disk since install is reported file by file, and an unmanaged one is not claimed', async (t) => {
  const c = setup(t);
  await installSkill(URL1, 'demo', c.deps);
  assert.deepEqual(M.verifySkill(c.deps, 'demo'), { state: 'ok' });
  fs.appendFileSync(path.join(c.dir, 'SKILL.md'), '\nsneaky addition\n');
  fs.rmSync(path.join(c.dir, 'notes.md'));
  fs.writeFileSync(path.join(c.dir, 'extra.txt'), 'x');
  assert.deepEqual(M.verifySkill(c.deps, 'demo'), { state: 'changed', changed: ['SKILL.md'], missing: ['notes.md'], added: ['extra.txt'] });
  assert.deepEqual(M.verifySkill(c.deps, 'never-installed'), { state: 'unmanaged' });
  assert.deepEqual(M.verifySkill(c.deps, '../escape'), { state: 'unmanaged' });
  const listed = M.listManagedSkills(c.deps);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].integrity.state, 'changed');
  assert.equal(listed[0].canRollback, false);
});

test('an update check with nothing new says so and stages nothing', async (t) => {
  const c = setup(t);
  await installSkill(URL1, 'demo', c.deps);
  const r = await M.checkUpdate(c.deps, 'demo');
  assert.deepEqual(r, { ok: true, upToDate: true, commit: SHA1 });
  assert.equal(fs.existsSync(path.join(c.recordDir, 'staging')), false);
});

test('an update is a PREVIEW: every change, the tool it asks for, the new script, what the guard removed; and the installed skill is untouched', async (t) => {
  const c = setup(t);
  await installSkill(URL1, 'demo', c.deps);
  const before = read(path.join(c.dir, 'SKILL.md'));
  c.gh.publish(SHA2, V2);
  const r = await M.checkUpdate(c.deps, 'demo');
  assert.equal(r.ok, true);
  assert.equal(r.upToDate, false);
  const p = r.preview;
  assert.equal(p.from, SHA1);
  assert.equal(p.to, SHA2);
  const by = Object.fromEntries(p.files.map((f) => [f.path, f]));
  assert.equal(by['SKILL.md'].change, 'changed');
  assert.ok(by['SKILL.md'].diff.some((l) => l.startsWith('+Keep it short and open an issue when asked.')));
  assert.ok(by['SKILL.md'].diff.some((l) => l.startsWith('-Keep it short.')));
  assert.equal(by['notes.md'].change, 'removed');
  assert.equal(by['run.sh'].change, 'added');
  assert.equal(by['package.json'].change, 'added');
  assert.deepEqual(p.newTools, ['mcp__mosbius-github__create_issue'], 'the ask is shown, though the installer removes it');
  assert.deepEqual(p.newIntegrations, ['github']);
  assert.ok(p.newScripts.some((n) => n.startsWith('run.sh')) && p.newScripts.some((n) => n.startsWith('package.json')));
  assert.ok(p.stripped.some((s) => s.what === 'allowed-tools'));
  assert.ok(p.stripped.some((s) => s.what === 'dynamic-command'));
  assert.deepEqual(p.locallyModified, []);
  // nothing changed on disk yet
  assert.equal(read(path.join(c.dir, 'SKILL.md')), before);
  assert.equal(fs.existsSync(path.join(c.dir, 'run.sh')), false);
  assert.equal(M.readRecord(c.recordDir, 'demo').commit, SHA1);
  // the staged copy lives outside the skill folder and is already sanitised
  const staged = read(path.join(c.recordDir, 'staging', p.token, 'skill', 'SKILL.md'));
  assert.equal(/allowed-tools|!`/.test(staged), false);
  M.discardUpdate(p.token);
  assert.equal(fs.existsSync(path.join(c.recordDir, 'staging', p.token)), false);
});

test('applying an update installs it, keeps the old folder, writes nothing executable, and records the history', async (t) => {
  const c = setup(t);
  await installSkill(URL1, 'demo', c.deps);
  c.gh.publish(SHA2, V2);
  const { preview } = await M.checkUpdate(c.deps, 'demo');
  const r = M.applyUpdate(c.deps, 'demo', preview.token);
  assert.deepEqual(r, { ok: true, commit: SHA2 });
  assert.equal(fs.existsSync(path.join(c.dir, 'notes.md')), false);
  assert.equal(read(path.join(c.dir, 'run.sh')), V2['skills/demo/run.sh']);
  assert.equal((fs.statSync(path.join(c.dir, 'run.sh')).mode & 0o111), 0, 'a downloaded script is data: not executable');
  assert.equal(/allowed-tools|!`/.test(read(path.join(c.dir, 'SKILL.md'))), false);
  const rec = M.readRecord(c.recordDir, 'demo');
  assert.equal(rec.commit, SHA2);
  assert.equal(rec.previous.length, 1);
  assert.equal(rec.previous[0].commit, SHA1);
  assert.ok(rec.updatedAt >= rec.installedAt);
  assert.deepEqual(rec.deps.integrations, ['github']);
  assert.deepEqual(M.verifySkill(c.deps, 'demo'), { state: 'ok' });
  assert.equal(M.listManagedSkills(c.deps)[0].canRollback, true);
  assert.equal(fs.existsSync(path.join(c.recordDir, 'backups', rec.previous[0].backup, 'skill', 'notes.md')), true);
  // the preview token is spent
  assert.equal(M.applyUpdate(c.deps, 'demo', preview.token).ok, false);
});

test('rollback restores the earlier version and its record, once', async (t) => {
  const c = setup(t);
  await installSkill(URL1, 'demo', c.deps);
  const original = read(path.join(c.dir, 'SKILL.md'));
  c.gh.publish(SHA2, V2);
  M.applyUpdate(c.deps, 'demo', (await M.checkUpdate(c.deps, 'demo')).preview.token);
  const r = M.rollbackSkill(c.deps, 'demo');
  assert.deepEqual(r, { ok: true, commit: SHA1 });
  assert.equal(read(path.join(c.dir, 'SKILL.md')), original);
  assert.equal(fs.existsSync(path.join(c.dir, 'notes.md')), true);
  assert.equal(fs.existsSync(path.join(c.dir, 'run.sh')), false);
  assert.equal(M.readRecord(c.recordDir, 'demo').commit, SHA1);
  assert.deepEqual(M.verifySkill(c.deps, 'demo'), { state: 'ok' });
  assert.equal(M.rollbackSkill(c.deps, 'demo').ok, false, 'there is nothing earlier to go back to now');
});

test('an edit the user made is flagged in the preview, replaced by the update, and still in the backup', async (t) => {
  const c = setup(t);
  await installSkill(URL1, 'demo', c.deps);
  fs.writeFileSync(path.join(c.dir, 'notes.md'), 'MY OWN NOTES\n');
  c.gh.publish(SHA2, V2);
  const { preview } = await M.checkUpdate(c.deps, 'demo');
  assert.deepEqual(preview.locallyModified, ['notes.md']);
  M.applyUpdate(c.deps, 'demo', preview.token);
  M.rollbackSkill(c.deps, 'demo');
  assert.equal(read(path.join(c.dir, 'notes.md')), 'MY OWN NOTES\n', 'the edit survived in the backup and came back with the rollback');
});

test('refusals: a name that is not a folder name, a wrong or spent token, a skill this app did not install', async (t) => {
  const c = setup(t);
  await installSkill(URL1, 'demo', c.deps);
  c.gh.publish(SHA2, V2);
  const { preview } = await M.checkUpdate(c.deps, 'demo');
  assert.equal(M.applyUpdate(c.deps, '../demo', preview.token).ok, false);
  assert.equal(M.applyUpdate(c.deps, 'demo', 'ffffffffffffffff').ok, false);
  assert.equal(M.applyUpdate(c.deps, 'other', preview.token).ok, false);
  assert.equal((await M.checkUpdate(c.deps, 'not-installed')).ok, false);
  assert.equal((await M.checkUpdate(c.deps, '../x')).ok, false);
  assert.equal(M.rollbackSkill(c.deps, 'demo').ok, false);
  // none of that touched the skill
  assert.equal(M.readRecord(c.recordDir, 'demo').commit, SHA1);
  assert.deepEqual(M.verifySkill(c.deps, 'demo'), { state: 'ok' });
});

test('an update that fails half way leaves the skill exactly as it was', async (t) => {
  const c = setup(t);
  await installSkill(URL1, 'demo', c.deps);
  const before = read(path.join(c.dir, 'SKILL.md'));
  c.gh.publish(SHA2, V2);
  const { preview } = await M.checkUpdate(c.deps, 'demo');
  fs.rmSync(path.join(c.recordDir, 'staging', preview.token, 'skill', 'SKILL.md'));       // the staged copy is damaged
  const r = M.applyUpdate(c.deps, 'demo', preview.token);
  assert.equal(r.ok, false);
  assert.equal(read(path.join(c.dir, 'SKILL.md')), before);
  assert.equal(fs.existsSync(path.join(c.dir, 'notes.md')), true);
  assert.equal(M.readRecord(c.recordDir, 'demo').commit, SHA1);
});

test('when GitHub will not name a commit the install is recorded as not pinned, and an update is found by content', async (t) => {
  const c = setup(t);
  c.gh.st.commitsFail = true;
  const r = await installSkill(URL1, 'demo', c.deps);
  assert.equal(r.ok, true);
  assert.equal(r.commit, null);
  assert.equal(M.readRecord(c.recordDir, 'demo').commit, null);
  // identical content: nothing to update
  const same = await M.checkUpdate(c.deps, 'demo');
  assert.equal(same.ok && same.upToDate, true);
  // different content: a preview, with no "from" commit to name
  c.gh.st.versions.set(SHA1, V2);
  const diff = await M.checkUpdate(c.deps, 'demo');
  assert.equal(diff.ok && diff.upToDate === false, true);
  assert.equal(diff.preview.from, null);
});

test('the line diff counts and bounds what it shows', () => {
  const d = M.diffText('a\nb\nc\nd\n', 'a\nB\nc\nd\ne\n');
  assert.equal(d.additions, 2, 'B, and the new line e');
  assert.equal(d.deletions, 1, 'b');
  assert.ok(d.lines.includes('-b') && d.lines.includes('+B'));
  const long = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join('\n');
  assert.deepEqual(M.diffText(long, `${long}\nx`).lines, ['(too long to show line by line)']);
  const big = M.diffText(Array.from({ length: 800 }, (_, i) => `a${i}`).join('\n'), Array.from({ length: 800 }, (_, i) => `b${i}`).join('\n'));
  assert.ok(big.lines.length <= 162);
});

test('a record that is not exactly a record is ignored, not trusted', async (t) => {
  const c = setup(t);
  fs.mkdirSync(c.recordDir, { recursive: true });
  fs.writeFileSync(path.join(c.recordDir, 'demo.json'), '{"source":"x"}');
  assert.equal(M.readRecord(c.recordDir, 'demo'), null);
  fs.writeFileSync(path.join(c.recordDir, 'bad.json'), 'not json');
  assert.deepEqual(M.listManagedSkills(c.deps), []);
});
