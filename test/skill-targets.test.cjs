'use strict';

/**
 * Skills for more than one agent CLI. Claude Code reads ~/.claude/skills; Codex reads the shared ~/.agents/skills
 * (shown by the real CLI: evidence/codex/codex-live.json); Gemini CLI reads it too, per its documentation. The app
 * installs into either folder, keeps one record folder per target, and the two never mix: the same skill name can
 * be installed for both, updated for one, and removed from one, and the other stays exactly as it was.
 * A fake GitHub stands in for the network; nothing a skill ships is ever run.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fakeGitHub, SHA1, SHA2, URL1, V1, V2 } = require('./fixtures/fake-github.cjs');
const loadTs = require('./load-ts.cjs');

const S = loadTs('src/main/skills.ts');
const M = loadTs('src/main/skillManager.ts');

function setup(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-skilltargets-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const gh = fakeGitHub();
  const base = path.join(home, 'records');
  const claude = { home, recordDir: base, getText: gh.getText };
  const agents = { home, recordDir: path.join(base, 'agents'), root: path.join(home, '.agents', 'skills'), agents: ['codex', 'gemini'], getText: gh.getText };
  return {
    home, gh, claude, agents,
    claudeDir: path.join(home, '.claude', 'skills', 'demo'),
    agentsDir: path.join(home, '.agents', 'skills', 'demo')
  };
}
const read = (p) => fs.readFileSync(p, 'utf8');
const withHome = async (home, fn) => {
  const before = process.env.HOME;
  process.env.HOME = home;
  try { return await fn(); } finally { if (before === undefined) delete process.env.HOME; else process.env.HOME = before; }
};

test('an install for the shared folder lands there, names the agents it serves, and touches nothing of Claude Code\'s', async (t) => {
  const c = setup(t);
  const r = await S.installSkill(URL1, 'demo', c.agents);
  assert.equal(r.ok, true);
  assert.equal(r.path, c.agentsDir);
  assert.equal(fs.existsSync(path.join(c.agentsDir, 'SKILL.md')), true);
  assert.equal(fs.existsSync(c.claudeDir), false, 'the Claude folder is not written');
  const rec = M.readRecord(c.agents.recordDir, 'demo');
  assert.deepEqual(rec.agents, ['codex', 'gemini']);
  assert.equal(rec.commit, SHA1);
  assert.equal(M.readRecord(c.claude.recordDir, 'demo'), null, 'and has no record in the Claude folder\'s record folder');
  // the guard ran exactly as for Claude: the grant is gone from the copy on disk
  assert.equal(read(path.join(c.agentsDir, 'SKILL.md')).includes('allowed-tools'), false);
});

test('the same skill for both targets: two folders, two records, and changing one leaves the other alone', async (t) => {
  const c = setup(t);
  assert.equal((await S.installSkill(URL1, 'demo', c.claude)).ok, true);
  assert.equal((await S.installSkill(URL1, 'demo', c.agents)).ok, true);
  assert.deepEqual(M.readRecord(c.claude.recordDir, 'demo').agents, ['claude']);
  assert.deepEqual(M.readRecord(c.agents.recordDir, 'demo').agents, ['codex', 'gemini']);
  fs.appendFileSync(path.join(c.agentsDir, 'SKILL.md'), '\nlocal edit\n');
  assert.deepEqual(M.verifySkill(c.claude, 'demo'), { state: 'ok' }, 'Claude\'s copy is still what was installed');
  assert.equal(M.verifySkill(c.agents, 'demo').state, 'changed');
  assert.equal(M.listManagedSkills(c.claude).length, 1);
  assert.equal(M.listManagedSkills(c.agents).length, 1);
  assert.equal(M.listManagedSkills(c.agents)[0].path, c.agentsDir);
  assert.deepEqual(M.listManagedSkills(c.agents)[0].agents, ['codex', 'gemini']);
});

test('update and rollback work in the shared folder, and never reach the other target', async (t) => {
  const c = setup(t);
  await S.installSkill(URL1, 'demo', c.claude);
  await S.installSkill(URL1, 'demo', c.agents);
  c.gh.publish(SHA2, V2);
  const check = await M.checkUpdate(c.agents, 'demo');
  assert.equal(check.ok && check.upToDate === false, true);
  assert.deepEqual(check.preview.newIntegrations, ['github']);
  assert.deepEqual(check.preview.newTools, ['mcp__mosbius-github__create_issue']);
  assert.ok(check.preview.newScripts.length >= 1, 'a script the update ships is shown, not run');
  const applied = M.applyUpdate(c.agents, 'demo', check.preview.token);
  assert.deepEqual(applied, { ok: true, commit: SHA2 });
  assert.equal(read(path.join(c.agentsDir, 'SKILL.md')).includes('open an issue'), true);
  assert.equal(read(path.join(c.claudeDir, 'SKILL.md')).includes('open an issue'), false, 'the Claude copy is the version it was');
  assert.equal(M.readRecord(c.claude.recordDir, 'demo').commit, SHA1);
  const back = M.rollbackSkill(c.agents, 'demo');
  assert.deepEqual(back, { ok: true, commit: SHA1 });
  assert.equal(read(path.join(c.agentsDir, 'SKILL.md')).includes('open an issue'), false);
});

test('a name that is not a plain folder name never becomes a path under either folder', async (t) => {
  const c = setup(t);
  await S.installSkill(URL1, 'demo', c.agents);
  for (const bad of ['../demo', '..', '.', 'a/b', '/etc', 'demo/..']) {
    assert.deepEqual(M.verifySkill(c.agents, bad), { state: 'unmanaged' }, bad);
    assert.equal((await M.checkUpdate(c.agents, bad)).ok, false, bad);
    assert.equal(M.applyUpdate(c.agents, bad, 'x').ok, false, bad);
    assert.equal(M.rollbackSkill(c.agents, bad).ok, false, bad);
  }
});

test('forgetting a record removes that target\'s record and backups only', async (t) => {
  const c = setup(t);
  await S.installSkill(URL1, 'demo', c.claude);
  await S.installSkill(URL1, 'demo', c.agents);
  M.forgetSkillRecord(c.agents, 'demo');
  assert.equal(M.readRecord(c.agents.recordDir, 'demo'), null);
  assert.notEqual(M.readRecord(c.claude.recordDir, 'demo'), null, 'the other target\'s record stays');
  M.forgetSkillRecord(c.agents, '../records/demo');           // a name that is not a folder name does nothing
  assert.notEqual(M.readRecord(c.claude.recordDir, 'demo'), null);
});

test('the local listing shows the shared folder as the CLI that reads it, with ids that cannot collide with Claude\'s', async (t) => {
  const c = setup(t);
  await S.installSkill(URL1, 'demo', c.claude);
  await S.installSkill(URL1, 'demo', c.agents);
  const listed = await withHome(c.home, () => S.listLocalSkills({ cwds: [], bundledDir: null }));
  const demos = listed.filter((s) => s.name === 'demo');
  assert.deepEqual(demos.map((s) => s.provider).sort(), ['claude', 'codex']);
  assert.equal(new Set(demos.map((s) => s.id)).size, 2, 'two rows, two ids');
  assert.ok(demos.find((s) => s.provider === 'claude').id === 'user:demo', 'Claude\'s ids are what they always were');
  assert.ok(demos.find((s) => s.provider === 'codex').path === c.agentsDir);
});

test('uninstall accepts a skill in the shared folder and nothing outside the skills folders', async (t) => {
  const c = setup(t);
  await S.installSkill(URL1, 'demo', c.agents);
  const outside = path.join(c.home, 'Documents', 'important');
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'SKILL.md'), '---\nname: x\n---\n');
  await withHome(c.home, async () => {
    assert.equal(S.uninstallSkill(outside, { cwds: [] }).ok, false, 'a SKILL.md elsewhere is not a skill this app will delete');
    assert.equal(S.uninstallSkill(path.join(c.home, '.agents', 'skills'), { cwds: [] }).ok, false, 'never the skills folder itself');
    assert.deepEqual(S.uninstallSkill(c.agentsDir, { cwds: [] }), { ok: true });
  });
  assert.equal(fs.existsSync(c.agentsDir), false);
  assert.equal(fs.existsSync(outside), true);
});
