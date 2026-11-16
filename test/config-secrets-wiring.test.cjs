'use strict';

/**
 * F2 wiring — config.json really is kept clean, and no channel to the renderer carries a secret.
 *
 * Part one runs the real config module against a throwaway data folder: an install that still
 * has plaintext secrets is migrated, the file ends up free of them and STAYS free of them across
 * later writes, and an install whose secure storage fails keeps its plaintext rather than lose
 * the only copy. Part two reads the main process's source (it cannot be loaded under plain node)
 * and pins that every handler which hands the config, a trigger list or a secret to a window goes
 * through the redaction, that no secret-bearing key is written through `writeConfig`, and that the
 * renderer no longer has the fields at all.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'mosbius-cfgsec-'));
const electron = require.resolve('electron');
require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: { app: { getPath: () => userData } } };

const cfg = loadTs('src/main/config.ts');
const S = loadTs('src/main/configSecrets.ts');
const configFile = path.join(userData, 'config.json');
test.after(() => fs.rmSync(userData, { recursive: true, force: true }));

const CAN = ['SIGN-CANARY-0123456789abcdef', 'BOT-CANARY-xoxb-9999', 'GROQ-CANARY-gsk-abcdef012345', 'ORG-CANARY-key-77', 'HOOK-CANARY-aaaa1111bbbb2222', 'LEGACYHOOK-CANARY-cccc3333'];
const legacyFile = () => ({
  onboardingComplete: true, mcpOptInV1: true, triggersMigratedV1: true,
  slackEnabled: true, slackSigningSecret: CAN[0], slackBotToken: CAN[1], groqApiKey: CAN[2],
  webhookSecret: CAN[5],
  webhookTriggers: [{ id: 'hook1', name: 'H', secret: CAN[4], enabled: true, mode: 'strict', schema: '{}', createdAt: 1 }],
  orgTrigger: { enabled: true, apiKey: CAN[3], mode: 'strict' }
});
const fileText = () => fs.readFileSync(configFile, 'utf8');
const vaultOf = (opts = {}) => {
  const map = new Map();
  return {
    map,
    get: (r) => map.get(r), has: (r) => map.has(r), delete: (r) => { map.delete(r); return { ok: true }; },
    set: (r, v) => { if (opts.broken) return { ok: false, error: 'locked' }; map.set(r, v); return { ok: true }; },
    available: () => !opts.broken
  };
};

test.beforeEach(() => { cfg.setScrubSecretsOnWrite(false); });

test('migrating an old install leaves config.json free of every secret, and it stays that way', () => {
  fs.writeFileSync(configFile, JSON.stringify(legacyFile()));
  const vault = vaultOf();
  const r = S.migrateSecretsToVault(cfg.readConfig(), vault);
  assert.deepEqual(r.failed, []);
  cfg.writeConfig(r.patch);
  cfg.setScrubSecretsOnWrite(true);
  for (const c of CAN) assert.equal(fileText().includes(c), false, `${c} is still in config.json`);
  assert.equal(vault.map.size, 6);
  // later, unrelated writes must not bring anything back, and settings survive
  cfg.writeConfig({ slackEnabled: false, notifications: true });
  cfg.writeConfig({ webhookTriggers: cfg.readConfig().webhookTriggers });
  for (const c of CAN) assert.equal(fileText().includes(c), false, `${c} came back`);
  assert.equal(cfg.readConfig().notifications, true);
  assert.equal(cfg.readConfig().webhookTriggers[0].id, 'hook1');
});

test('even a write that tries to put a secret in the file cannot, once the vault holds them', () => {
  fs.writeFileSync(configFile, JSON.stringify({ onboardingComplete: true, mcpOptInV1: true, triggersMigratedV1: true }));
  cfg.setScrubSecretsOnWrite(true);
  cfg.writeConfig({ slackBotToken: CAN[1], groqApiKey: CAN[2], orgTrigger: { enabled: true, apiKey: CAN[3], mode: 'strict' },
    webhookTriggers: [{ id: 'x', name: 'x', secret: CAN[4], enabled: false, mode: 'strict', schema: '{}', createdAt: 1 }] });
  for (const c of CAN) assert.equal(fileText().includes(c), false, `${c} reached the file`);
});

test('when secure storage fails, nothing is scrubbed and no later write loses the only copy', () => {
  fs.writeFileSync(configFile, JSON.stringify(legacyFile()));
  const r = S.migrateSecretsToVault(cfg.readConfig(), vaultOf({ broken: true }));
  assert.equal(r.failed.length, 6);
  assert.deepEqual(r.patch, {});
  cfg.setScrubSecretsOnWrite(r.failed.length === 0); // what the main process does: stays off
  cfg.writeConfig({ notifications: true });
  for (const c of CAN) assert.equal(fileText().includes(c), true, `${c} was lost`);
});

test('the renderer\'s view of that same config has no secret in it, whichever state the file is in', () => {
  fs.writeFileSync(configFile, JSON.stringify(legacyFile()));
  const view = S.publicConfig(cfg.readConfig(), vaultOf());
  for (const c of CAN) assert.equal(JSON.stringify(view).includes(c), false, `${c} would reach the renderer`);
  assert.equal(view.secretsSet.plaintextRemaining, 6, 'but the renderer is told some are still in the file');
});

// ─── the main process's wiring, from its source ─────────────────────────────

const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf8');
const body = (re) => { const m = re.exec(main); assert.ok(m, `${re} not found`); return m[0]; };

test('every handler that hands the config to a window redacts it', () => {
  assert.match(body(/ipcMain\.handle\('config:get'[^\n]*/), /forRenderer\(\)/);
  assert.match(body(/ipcMain\.handle\('config:setAgentTokenCap'[\s\S]*?\n\);/), /forRenderer\(/);
  assert.match(body(/ipcMain\.handle\('app:setNotifications'[^\n]*/), /forRenderer\(/);
  assert.match(body(/ipcMain\.handle\('config:update'[\s\S]*?\n\}\);/), /return forRenderer\(next\)/);
  const broadcast = body(/onConfigWritten\(\(config\) => \{[\s\S]*?\n\}\);/);
  assert.match(broadcast, /forRenderer\(config\)/);
  assert.match(broadcast, /send\('config:changed', view\)/, 'the broadcast must send the redacted view, not the raw config');
});

test('the trigger lists leave through the redaction too', () => {
  assert.match(body(/ipcMain\.handle\('webhooks:list'[^\n]*/), /webhooksForRenderer\(/);
  assert.match(body(/ipcMain\.handle\('webhooks:save'[\s\S]*?\n\}\);/), /return webhooksForRenderer\(list\)/);
  assert.match(body(/ipcMain\.handle\('webhooks:delete'[\s\S]*?\n\}\);/), /return webhooksForRenderer\(list\)/);
  assert.match(body(/ipcMain\.handle\('org:getTrigger'[^\n]*/), /orgForRenderer\(/);
  assert.match(body(/ipcMain\.handle\('org:setTrigger'[\s\S]*?\n\}\);/), /orgForRenderer\(next\)/);
});

test('the general config update drops the secret keys, and the secret-returning handlers are gone', () => {
  assert.match(body(/ipcMain\.handle\('config:update'[\s\S]*?\n\}\);/), /withoutSecretKeys\(withoutProtectedKeys\(patch\)\)/);
  assert.equal(/ipcMain\.handle\('webhooks?:generateSecret'/.test(main), false, 'no handler may hand a freshly made secret to a page');
});

test('the secret handlers that act for a page check that it is the app\'s own page', () => {
  for (const ch of ['webhooks:rotateSecret', 'webhooks:copySecret']) {
    const h = body(new RegExp(`ipcMain\\.handle\\('${ch}'[\\s\\S]*?\\n\\}\\);`));
    assert.match(h, /fromAppPage\(evt\)/, `${ch} must check the sender`);
  }
  assert.match(body(/ipcMain\.handle\('webhooks:copySecret'[\s\S]*?\n\}\);/), /clipboard\.writeText\(secret\)/, 'the main process does the copying');
  assert.match(body(/ipcMain\.handle\('webhooks:copySecret'[\s\S]*?\n\}\);/), /return \{ ok: true \}/, 'and the reply carries no value');
});

test('no writeConfig call in the main process writes a secret-bearing key', () => {
  const calls = [...main.matchAll(/writeConfig\(([^;]*?)\);/g)].map((m) => m[1]);
  for (const arg of calls) {
    for (const k of ['slackSigningSecret', 'slackBotToken', 'groqApiKey', 'webhookSecret']) {
      assert.equal(new RegExp(`\\b${k}\\b`).test(arg), false, `writeConfig(${arg.slice(0, 60)}…) writes ${k}`);
    }
  }
});

test('every secret reaches main code through the vault readers, never the raw config', () => {
  for (const re of [/readConfig\(\)\.slackBotToken/, /readConfig\(\)\.slackSigningSecret/, /readConfig\(\)\.groqApiKey/, /cfg\.slackBotToken/, /cfg\.slackSigningSecret/, /cfg\.groqApiKey/, /\.webhookSecret/]) {
    assert.equal(re.test(main), false, `${re} reads a secret from the raw config`);
  }
});

test('the renderer and the preload no longer have the secret fields, or a way to be handed one', () => {
  const sources = [];
  const walk = (d) => { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); if (fs.statSync(p).isDirectory()) walk(p); else if (/\.(ts|tsx)$/.test(n)) sources.push(p); } };
  walk(path.join(root, 'src/renderer/src'));
  sources.push(path.join(root, 'src/preload/index.ts'));
  for (const f of sources) {
    const text = fs.readFileSync(f, 'utf8').split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
    // `secretsSet.<name>` is the boolean "is one stored", and is the only way these names may appear
    for (const re of [/(?<!secretsSet\??)\.slackSigningSecret\b/, /(?<!secretsSet\??)\.slackBotToken\b/, /(?<!secretsSet\??)\.groqApiKey\b/, /\.webhookSecret\b/, /generateWebhookSecret\b/, /webhookGenerateSecret\b/]) {
      assert.equal(re.test(text), false, `${path.relative(root, f)} still uses ${re}`);
    }
  }
});
