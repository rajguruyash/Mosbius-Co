'use strict';

/**
 * The compatibility matrix is honest: a `verified` label needs an evidence file in this repository, and that file
 * must show a run in which every check passed. A `wired` label needs none but must not be backed by a pretend one.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { AGENT_COMPAT, compatOf, agentKeyOf, skillTargetFor, agentsForTarget } = loadTs('src/shared/agentCompat.ts');
const ROOT = path.resolve(__dirname, '..');

function evidenceOk(rel) {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) return `missing: ${rel}`;
  let o;
  try { o = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return `not JSON: ${rel}`; }
  const results = Array.isArray(o.results) ? o.results : Array.isArray(o.checks) ? o.checks : null;
  if (!results || results.length === 0) return `no results recorded in ${rel}`;
  const failed = results.filter((r) => r.ok === false);
  return failed.length ? `${failed.length} failed checks recorded in ${rel}` : null;
}

test('the three CLIs are covered, each with its own entry', () => {
  assert.deepEqual(AGENT_COMPAT.map((a) => a.agent), ['claude', 'codex', 'gemini']);
  assert.equal(new Set(AGENT_COMPAT.map((a) => a.label)).size, 3);
  assert.deepEqual(AGENT_COMPAT.map((a) => a.delivery), ['config-file', 'command-line-and-env', 'settings-file-and-env'], 'no CLI is assumed to take another\'s configuration');
});

test('every verified label has an evidence file in the repository showing a run that passed', () => {
  for (const a of AGENT_COMPAT) {
    if (a.integrations === 'verified') {
      assert.ok(a.integrationsEvidence.length > 0, `${a.agent}: integrations are verified but name no evidence`);
      for (const rel of a.integrationsEvidence) assert.equal(evidenceOk(rel), null, `${a.agent}: ${evidenceOk(rel)}`);
    }
    if (a.skills === 'verified') {
      assert.ok(a.skillsEvidence.length > 0, `${a.agent}: skills are verified but name no evidence`);
      for (const rel of a.skillsEvidence) assert.equal(evidenceOk(rel), null, `${a.agent}: ${evidenceOk(rel)}`);
    }
  }
});

test('a label that is not verified names no evidence, and an agent that has not been run cannot claim a measured shell', () => {
  for (const a of AGENT_COMPAT) {
    if (a.integrations !== 'verified') assert.deepEqual(a.integrationsEvidence, [], a.agent);
    if (a.skills !== 'verified') assert.deepEqual(a.skillsEvidence, [], a.agent);
    // "hidden" or "visible" is a measurement: it needs the run that measured it
    if (a.integrations !== 'verified') assert.equal(a.capabilityHiddenFromShell, 'unknown', `${a.agent}: nothing was run, so nothing was measured`);
    if (a.capabilityHiddenFromShell !== 'unknown') assert.ok(a.integrationsEvidence.length > 0, `${a.agent}: a measured shell needs its evidence`);
  }
});

test('the shell label of every CLI is the one its own run measured, and the measurement had a control', () => {
  const measured = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
  // Codex: hidden by two overrides; the run shows the pass IS visible without them
  const codex = measured('evidence/codex/codex-live.json');
  assert.equal(compatOf('codex').capabilityHiddenFromShell, 'yes');
  assert.ok(codex.results.some((r) => r.group === 'isolation' && /control/.test(r.name) && r.ok), 'Codex: a control shows the check can fail');
  // Gemini: NOT hidden; the run shows the pass visible, and that the CLI's own redaction (the control) would hide it, at a price
  const gem = measured('evidence/gemini/gemini-live.json');
  assert.equal(compatOf('gemini').capabilityHiddenFromShell, 'no');
  assert.equal(gem.capabilityVisibleToShell, true, 'the label says visible only because the run measured it visible');
  assert.deepEqual(gem.withTheCLIsOwnRedactionOn, { passHidden: true, sshAuthSockHidden: true, secretLookingVariablesHidden: true }, 'the control: the lever works, and is broader than the pass');
});

test('"hidden from the shell" is claimed only as far as it was measured: Codex needs its OS sandbox, and says so', () => {
  const codex = JSON.parse(fs.readFileSync(path.join(ROOT, 'evidence/codex/codex-live.json'), 'utf8'));
  const c = compatOf('codex');
  assert.equal(c.capabilityHiddenFromShell, 'yes');
  assert.equal(c.shellProtectionNeedsSandbox, true, 'the label must carry its condition');
  // sandbox ON (the app's auto mode): not readable, because process inspection is refused there
  assert.equal(codex.passReadableFromTheProcessesAboveTheShell, false);
  assert.equal(codex.processInspectionRefusedInsideTheSandbox, true, 'a negative scan only means something if it says why nothing was found');
  // sandbox OFF (the control): the same scan walks the process tree and reads the real pass from the Codex process
  assert.equal(codex.passReadableFromTheProcessesAboveTheShellWithTheSandboxOff, true, 'the control: without the sandbox the pass IS readable, so the condition is real');
  assert.ok(codex.processesWalkedWithTheSandboxOff >= 2);
  // the flag is claimed only where a run measured it, and no other CLI claims it
  for (const a of AGENT_COMPAT) if (a.shellProtectionNeedsSandbox) assert.ok(a.integrationsEvidence.some((rel) => /codex/.test(rel)), `${a.agent}: no sandbox measurement behind the flag`);
  assert.equal(compatOf('gemini').shellProtectionNeedsSandbox, false);
  assert.equal(compatOf('claude').shellProtectionNeedsSandbox, false);
});

test('F9 stays open for a recorded reason: no Gemini setting makes the pass inaccessible to its shell', () => {
  const gem = JSON.parse(fs.readFileSync(path.join(ROOT, 'evidence/gemini/gemini-live.json'), 'utf8'));
  const f9 = gem.f9;
  assert.ok(f9 && Array.isArray(f9.why) && f9.why.length === 3, 'the evidence lists the limits that prevent closure');
  assert.equal(f9.closable, false);
  // the control: the original exposure, in the shell's environment and from the processes above it, with the real pass
  assert.equal(f9.control.passInShellEnvironment, true);
  assert.equal(f9.control.passReadableFromTheProcessesAboveTheShell, true);
  assert.ok(f9.control.processesHoldingIt >= 1);
  assert.ok(['SSH_AUTH_SOCK', 'MY_OWN_API_KEY', 'F9_PROBE_PLAIN'].every((n) => f9.control.variablesReachingTheShell.includes(n)), 'the control shows the person\'s variables reaching the shell');
  // LIMIT 2: no per-variable lever
  assert.equal(f9.blockedListWithRedactionOff.passInShellEnvironment, true);
  // the best lever: removes the pass from `env`, but the processes above still hold it, and it hides what is not the pass
  assert.equal(f9.globalRedactionWithAllNamesAllowed.passInShellEnvironment, false);
  assert.equal(f9.globalRedactionWithAllNamesAllowed.passReadableFromTheProcessesAboveTheShell, true, 'LIMIT 1: no setting makes it inaccessible');
  assert.ok(f9.globalRedactionWithAllNamesAllowed.hiddenAlthoughAllowedByName.includes('SSH_AUTH_SOCK'), 'LIMIT 3: SSH_AUTH_SOCK is hidden whatever the allow list says');
  assert.ok(f9.globalRedactionWithAllNamesAllowed.keptByTheAllowList.includes('F9_PROBE_PLAIN'));
  // the workaround that is NOT shipped
  assert.equal(f9.bashEnvStartUpFileWorkaround.envNoLongerShowsThePass, true);
  assert.equal(f9.bashEnvStartUpFileWorkaround.stillReadableFromTheProcessesAboveTheShell, true, 'a start-up-file trick hides it from `env` only');
  // every f9 check of the run passed (each passes when its limit is observed), so the evidence and the claim agree
  const group = gem.results.filter((r) => r.group === 'f9');
  assert.ok(group.length >= 9 && group.every((r) => r.ok), `${group.filter((r) => !r.ok).length} f9 checks failed`);
  // the label and the code agree with the evidence: Gemini is labelled "visible", and no switch, setting or workaround was shipped
  assert.equal(compatOf('gemini').capabilityHiddenFromShell, 'no');
  const hive = fs.readFileSync(path.join(ROOT, 'src/main/hive.ts'), 'utf8').replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '');
  assert.equal(/environmentVariableRedaction|BASH_ENV/.test(hive), false, 'the app must not switch on Gemini\'s redaction or lean on BASH_ENV');
  for (const rel of ['src/main/config.ts', 'src/preload/index.ts', 'src/renderer/src/store/config.ts']) {
    assert.equal(/geminiHidePass|hidePassFromShell|passFromShell|geminiShell/i.test(fs.readFileSync(path.join(ROOT, rel), 'utf8')), false, `${rel}: no half-working setting was added for it`);
  }
});

test('"loads integrations only in trusted folders" is claimed only for a CLI whose run measured it, and the app does not work around it', () => {
  for (const a of AGENT_COMPAT) {
    if (!a.folderTrustRequired) continue;
    const ok = a.integrationsEvidence.some((rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8')).results.some((r) => r.group === 'trust' && r.ok));
    assert.ok(ok, `${a.agent}: no passing trust check in its evidence`);
  }
  assert.equal(compatOf('gemini').folderTrustRequired, true);
  assert.equal(compatOf('claude').folderTrustRequired, false);
  assert.equal(compatOf('codex').folderTrustRequired, false);
  // the trust decision stays the person's: the app never passes the flag that skips it and never writes the file that holds it
  const hive = fs.readFileSync(path.join(ROOT, 'src/main/hive.ts'), 'utf8');
  assert.equal(/--skip-trust/.test(hive.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '')), false, 'the app must not pass --skip-trust');
  assert.equal(/writeFileSync\([^)]*trustedFolders/.test(hive), false, 'the app must not write the person\'s trust file');
});

test('evidence from a stand-in is labelled as such: the run says what was not real', () => {
  for (const rel of ['evidence/codex/codex-live.json', 'evidence/gemini/gemini-live.json']) {
    const o = JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    assert.ok(o.stands_in_for && o.stands_in_for.provider && o.stands_in_for.model, `${rel} names its stand-ins`);
    assert.ok(Array.isArray(o.not_tested) && o.not_tested.length > 0, `${rel} says what it did not test`);
    assert.ok(o.results.some((r) => (r.group === 'control' || /control/.test(r.name)) && r.ok), `${rel} carries a control showing a check can fail`);
  }
  const gem = JSON.parse(fs.readFileSync(path.join(ROOT, 'evidence/gemini/gemini-live.json'), 'utf8'));
  assert.ok(/gemini-cli 0\.68\./.test(gem.gemini) && gem.package && /^sha512-/.test(gem.package.integrity), 'the Gemini run records the exact version and the package integrity it ran');
  assert.ok(gem.not_tested.some((s) => /login/i.test(s)), 'and says that no Gemini login was used');
});

test('skill targets: Claude Code has its own folder; Codex and Gemini share .agents', () => {
  assert.equal(skillTargetFor('claude'), 'claude');
  assert.equal(skillTargetFor('codex'), 'agents');
  assert.equal(skillTargetFor('gemini'), 'agents');
  assert.deepEqual(agentsForTarget('claude'), ['claude']);
  assert.deepEqual(agentsForTarget('agents'), ['codex', 'gemini']);
  for (const a of AGENT_COMPAT) assert.ok(a.skillFolders.length >= 2, `${a.agent} lists where its skills live`);
});

test('agentKeyOf maps hive provider ids and nothing else', () => {
  assert.equal(agentKeyOf('claude'), 'claude');
  assert.equal(agentKeyOf('codex'), 'codex');
  assert.equal(agentKeyOf('gemini'), 'gemini');
  for (const other of ['grok', 'agy', 'qwen', 'custom', '', undefined]) assert.equal(agentKeyOf(other), undefined, String(other));
});
