'use strict';

/**
 * D7 — EVERY integration is opt-in, the local MCP servers included.
 *
 * Before 2026-11-15 six local servers (sequential-thinking, time, fetch, context7,
 * filesystem, git) shipped ON for every agent. Two of them reach the internet, two
 * reach the filesystem. Nothing may become available to an agent silently, so:
 *
 *   - no catalogue entry ships switched on, and the seeded consent map says so;
 *   - an install that predates this has those six reset to OFF exactly once, while a
 *     switch the user flipped on purpose (a server that was never on by default) is
 *     left alone, and a switch turned on AFTER the migration is never undone by it;
 *   - a new install is born migrated, and so is a reset one;
 *   - a hire manifest can ask for servers but can never switch one on.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'mosbius-optin-'));
const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron, filename: electron, loaded: true,
  exports: { app: { getPath: () => userData } }
};

const { readConfig, writeConfig, resetConfig } = loadTs('src/main/config.ts');
const { MCP_CATALOG, defaultMcpDefaults } = loadTs('src/shared/mcpCatalog.ts');
const { validateHireManifest } = loadTs('src/shared/hire.ts');

const configFile = path.join(userData, 'config.json');
const SIX = ['sequential-thinking', 'time', 'fetch', 'context7', 'filesystem', 'git'];
const onDisk = () => JSON.parse(fs.readFileSync(configFile, 'utf8'));

test.after(() => fs.rmSync(userData, { recursive: true, force: true }));

test('no catalogue entry ships switched on, and the seeded consent map is all off', () => {
  for (const e of MCP_CATALOG) assert.equal(e.defaultEnabled, false, `${e.id} ships switched on`);
  const seeded = defaultMcpDefaults();
  assert.deepEqual(Object.keys(seeded).sort(), MCP_CATALOG.map((e) => e.id).sort());
  for (const [id, v] of Object.entries(seeded)) assert.deepEqual(v, { enabled: false }, id);
});

test('a first-run config enables nothing', () => {
  assert.equal(fs.existsSync(configFile), false);
  const cfg = readConfig();
  for (const e of MCP_CATALOG) assert.equal(cfg.mcpDefaults[e.id].enabled, false, e.id);
});

test('an install from before this change has the six old defaults reset, once; other choices survive', () => {
  // exactly what an upgrading user has on disk: the six ON because they were the default,
  // plus the browser and GitHub, which could only have been switched on by hand
  const legacy = {
    onboardingComplete: true,
    mcpDefaults: Object.fromEntries([
      ...SIX.map((id) => [id, { enabled: true }]),
      ['playwright', { enabled: true }], ['github', { enabled: true }], ['notion', { enabled: false }]
    ])
  };
  fs.writeFileSync(configFile, JSON.stringify(legacy));

  const first = readConfig();
  for (const id of SIX) assert.equal(first.mcpDefaults[id].enabled, false, `${id} must be reset`);
  assert.equal(first.mcpDefaults.playwright.enabled, true, 'a deliberate choice is left alone');
  assert.equal(first.mcpDefaults.github.enabled, true);
  assert.equal(first.mcpDefaults.notion.enabled, false);
  assert.equal(first.mcpOptInV1, true);
  assert.equal(onDisk().mcpOptInV1, true, 'the marker is persisted');
  for (const id of SIX) assert.equal(onDisk().mcpDefaults[id].enabled, false, `${id} is off on disk too`);
  assert.equal(first.onboardingComplete, true, 'nothing else was disturbed');
});

test('the migration is one-shot: a switch turned on afterwards survives every later read', () => {
  writeConfig({ mcpDefaults: { ...readConfig().mcpDefaults, time: { enabled: true } } });
  for (let i = 0; i < 3; i++) assert.equal(readConfig().mcpDefaults.time.enabled, true, `read ${i}`);
  assert.equal(onDisk().mcpDefaults.time.enabled, true);
});

test('a reset install is born migrated, so the first switch it turns on is not undone', () => {
  resetConfig();
  assert.equal(onDisk().mcpOptInV1, true);
  writeConfig({ mcpDefaults: { ...readConfig().mcpDefaults, fetch: { enabled: true } } });
  assert.equal(readConfig().mcpDefaults.fetch.enabled, true);
  assert.equal(readConfig().mcpDefaults.fetch.enabled, true, 'and again');
});

test('a brand-new install (no config.json yet) is born migrated too', () => {
  fs.rmSync(configFile, { force: true });
  assert.equal(fs.existsSync(configFile), false);
  writeConfig({ mcpDefaults: { ...readConfig().mcpDefaults, git: { enabled: true } } });
  assert.equal(onDisk().mcpOptInV1, true, 'the very first file already carries the marker');
  assert.equal(readConfig().mcpDefaults.git.enabled, true, 'so the migration never touches it');
});

test('a hire manifest can request servers but every id is surfaced for consent, none enabled', () => {
  const v = validateHireManifest({
    spec: 'munder-difflin/hire@1', name: 'Reader', description: 'reads', provider: 'claude',
    mcpServers: ['time', 'fetch', 'github', 'playwright']
  });
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  assert.deepEqual(v.consentRequired.slice().sort(), ['fetch', 'github', 'playwright', 'time'],
    'even the read-only local servers need consent now');
});
