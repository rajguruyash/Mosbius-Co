'use strict';

/**
 * F2 — no secret in config.json, none in anything the renderer is sent.
 *
 * The rules, each pinned below: the six secrets are recognised wherever they hide; the
 * renderer's view of a config contains no secret VALUE (searched with planted canaries,
 * in every position); a migration moves plaintext into the vault only after the vault
 * copy reads back, and keeps the plaintext of anything it could not store; the general
 * config update cannot write a secret; and a new secret-looking field in the config type
 * fails the build until someone decides how it is protected.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const S = loadTs('src/main/configSecrets.ts');

const C = {
  signing: 'SIGNING-CANARY-7f3a9c1e5b2d4a60',
  bot: 'xoxb-BOT-CANARY-1111-2222-3333',
  groq: 'gsk_GROQ-CANARY-abcdefghijklmnop',
  org: 'ORG-CANARY-key-0123456789',
  hookA: 'HOOK-A-CANARY-aaaaaaaaaaaaaaaa',
  hookB: 'HOOK-B-CANARY-bbbbbbbbbbbbbbbb',
  legacy: 'LEGACY-CANARY-cccccccccccccccc'
};
const ALL_CANARIES = Object.values(C);

function legacyConfig() {
  return {
    onboardingComplete: true,
    slackEnabled: true,
    slackSigningSecret: C.signing,
    slackBotToken: C.bot,
    slackChannelId: 'C123',
    groqApiKey: C.groq,
    freeflowEnabled: true,
    webhookEnabled: true,
    webhookSecret: C.legacy,
    webhookTriggers: [
      { id: 'a', name: 'A', secret: C.hookA, enabled: true, mode: 'strict', schema: '{}', createdAt: 1 },
      { id: 'b', name: 'B', secret: C.hookB, enabled: false, mode: 'allow-all', schema: '{}', createdAt: 2 }
    ],
    orgTrigger: { enabled: true, apiKey: C.org, mode: 'strict' }
  };
}

function fakeVault({ available = true, failSet = [], corrupt = [] } = {}) {
  const map = new Map();
  return {
    map,
    get: (ref) => map.get(ref),
    set: (ref, v) => {
      if (failSet.includes(ref) || !available) return { ok: false, error: 'refused' };
      map.set(ref, corrupt.includes(ref) ? v + 'X' : v);
      return { ok: true };
    },
    has: (ref) => map.has(ref),
    delete: (ref) => { map.delete(ref); return { ok: true }; },
    available: () => available
  };
}

const leaks = (value) => ALL_CANARIES.filter((c) => JSON.stringify(value).includes(c));

test('legacyPlaintext finds every place a secret can hide', () => {
  const refs = S.legacyPlaintext(legacyConfig()).map((m) => m.ref).sort();
  assert.deepEqual(refs, [
    'cfg:groqApiKey', 'cfg:orgKey', 'cfg:slackBotToken', 'cfg:slackSigningSecret', 'cfg:webhook:a', 'cfg:webhook:b', 'cfg:webhook:legacy'
  ].sort());
});

test('the legacy single webhook secret becomes the `legacy` endpoint\'s only when that has none', () => {
  const only = S.legacyPlaintext({ webhookSecret: C.legacy });
  assert.deepEqual(only, [{ ref: 'cfg:webhook:legacy', value: C.legacy }]);
  const both = S.legacyPlaintext({ webhookSecret: C.legacy, webhookTriggers: [{ id: 'legacy', secret: C.hookA }] });
  assert.deepEqual(both, [{ ref: 'cfg:webhook:legacy', value: C.hookA }], 'the endpoint\'s own secret wins');
});

test('stripSecrets removes every secret and nothing else, and does not touch its input', () => {
  const input = legacyConfig();
  const before = JSON.stringify(input);
  const out = S.stripSecrets(input);
  assert.equal(JSON.stringify(input), before, 'the input is untouched');
  assert.deepEqual(leaks(out), []);
  assert.equal(out.slackEnabled, true);
  assert.equal(out.slackChannelId, 'C123');
  assert.equal(out.webhookTriggers.length, 2);
  assert.deepEqual(Object.keys(out.webhookTriggers[0]).sort(), ['createdAt', 'enabled', 'id', 'mode', 'name', 'schema']);
  assert.deepEqual(out.orgTrigger, { enabled: true, apiKey: '', mode: 'strict' });
});

test('publicConfig: no secret value in the renderer\'s view, whether it is in the vault or still in the file', () => {
  // (1) still in the file
  const v1 = fakeVault();
  const view1 = S.publicConfig(legacyConfig(), v1);
  assert.deepEqual(leaks(view1), [], 'plaintext in the file must not reach the renderer either');
  assert.deepEqual(view1.secretsSet, {
    slackSigningSecret: true, slackBotToken: true, groqApiKey: true, orgKey: true, webhooks: { a: true, b: true },
    plaintextRemaining: 7
  });
  assert.equal(view1.webhookTriggers[0].hasSecret, true);

  // (2) already migrated: the file is clean and the vault holds them
  const v2 = fakeVault();
  const m = S.migrateSecretsToVault(legacyConfig(), v2);
  assert.deepEqual(m.failed, []);
  const clean = { ...legacyConfig(), ...m.patch };
  const view2 = S.publicConfig(clean, v2);
  assert.deepEqual(leaks(view2), []);
  assert.equal(view2.secretsSet.webhooks.a, true);
  assert.equal(view2.secretsSet.groqApiKey, true);
  assert.equal(view2.secretsSet.plaintextRemaining, 0, 'nothing is left in the file');

  // (3) nothing set anywhere
  const view3 = S.publicConfig({ slackEnabled: false, webhookTriggers: [{ id: 'x', name: 'X' }] }, fakeVault());
  assert.deepEqual(view3.secretsSet, { slackSigningSecret: false, slackBotToken: false, groqApiKey: false, orgKey: false, webhooks: { x: false }, plaintextRemaining: 0 });
});

test('publicWebhooks drops the secret and says whether there is one', () => {
  const v = fakeVault();
  v.map.set('cfg:webhook:b', C.hookB);
  const list = S.publicWebhooks(legacyConfig().webhookTriggers, {}, v);
  assert.deepEqual(leaks(list), []);
  assert.deepEqual(list.map((t) => [t.id, t.hasSecret]), [['a', false], ['b', true]]);
});

test('readConfigSecret: the vault first, a not-yet-migrated file second, an invalid id never', () => {
  const v = fakeVault();
  const cfg = legacyConfig();
  assert.equal(S.readConfigSecret('slackBotToken', cfg, v), C.bot, 'falls back to the file');
  v.map.set('cfg:slackBotToken', 'from-the-vault');
  assert.equal(S.readConfigSecret('slackBotToken', cfg, v), 'from-the-vault');
  assert.equal(S.readConfigSecret('orgKey', cfg, v), C.org);
  assert.equal(S.readWebhookSecret('a', cfg, v), C.hookA);
  assert.equal(S.readWebhookSecret('../../etc', cfg, v), undefined);
  assert.equal(S.readWebhookSecret('missing', cfg, v), undefined);
});

test('migration: every secret moves, reads back, and the patch removes the plaintext', () => {
  const v = fakeVault();
  const r = S.migrateSecretsToVault(legacyConfig(), v);
  assert.deepEqual(r.failed, []);
  assert.equal(r.moved.length, 7, 'six secrets plus the legacy webhook one');
  assert.equal(v.map.get('cfg:webhook:legacy'), C.legacy);
  assert.equal(v.map.get('cfg:slackSigningSecret'), C.signing);
  assert.equal(v.map.get('cfg:webhook:a'), C.hookA);
  assert.equal(v.map.get('cfg:webhook:b'), C.hookB);
  assert.equal(v.map.get('cfg:orgKey'), C.org);
  const after = { ...legacyConfig(), ...r.patch };
  assert.deepEqual(S.legacyPlaintext(after), [], 'no plaintext survives');
  assert.deepEqual(leaks({ ...after }), [], 'and none is left anywhere in the config');
  assert.equal(after.slackEnabled, true, 'settings that are not secrets are untouched');
});

test('migration is idempotent: a second run finds nothing to do', () => {
  const v = fakeVault();
  const first = S.migrateSecretsToVault(legacyConfig(), v);
  const clean = { ...legacyConfig(), ...first.patch };
  const second = S.migrateSecretsToVault(clean, v);
  assert.deepEqual(second, { moved: [], failed: [], patch: {} });
});

test('migration keeps the plaintext of anything it could not store, and says so', () => {
  const v = fakeVault({ failSet: ['cfg:groqApiKey'] });
  const r = S.migrateSecretsToVault(legacyConfig(), v);
  assert.deepEqual(r.failed, ['cfg:groqApiKey']);
  assert.equal('groqApiKey' in r.patch, false, 'its plaintext is NOT removed');
  assert.equal('slackSigningSecret' in r.patch, true, 'the others are');
  const after = { ...legacyConfig(), ...r.patch };
  assert.deepEqual(S.legacyPlaintext(after).map((m) => m.ref), ['cfg:groqApiKey']);
});

test('migration with no usable vault changes nothing at all', () => {
  const v = fakeVault({ available: false });
  const r = S.migrateSecretsToVault(legacyConfig(), v);
  assert.equal(r.moved.length, 0);
  assert.equal(r.failed.length, 7);
  assert.deepEqual(r.patch, {}, 'nothing is scrubbed when nothing could be saved');
});

test('migration does not trust a write that does not read back', () => {
  const v = fakeVault({ corrupt: ['cfg:slackBotToken'] });
  const r = S.migrateSecretsToVault(legacyConfig(), v);
  assert.deepEqual(r.failed, ['cfg:slackBotToken']);
  assert.equal('slackBotToken' in r.patch, false);
});

test('a webhook secret that is already in the vault is not overwritten by an older plaintext one', () => {
  const v = fakeVault();
  v.map.set('cfg:webhook:a', 'NEWER-VALUE');
  const r = S.migrateSecretsToVault(legacyConfig(), v);
  assert.equal(v.map.get('cfg:webhook:a'), 'NEWER-VALUE');
  assert.ok(r.moved.includes('cfg:webhook:a'));
  assert.equal(S.legacyPlaintext({ ...legacyConfig(), ...r.patch }).length, 0, 'but the stale plaintext is gone');
});

test('withoutSecretKeys: the general config update cannot write a secret, or a trigger list that carries one', () => {
  const out = S.withoutSecretKeys({ ...legacyConfig(), mcpDefaults: { time: { enabled: true } } });
  assert.deepEqual(leaks(out), []);
  for (const k of ['slackSigningSecret', 'slackBotToken', 'groqApiKey', 'webhookSecret', 'webhookTriggers', 'orgTrigger']) {
    assert.equal(k in out, false, `${k} must be dropped`);
  }
  assert.equal(out.slackEnabled, true);
  assert.deepEqual(out.mcpDefaults, { time: { enabled: true } });
});

test('a new secret-looking field in the config type fails here until it is handled', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/main/config.ts'), 'utf8');
  const a = src.indexOf('export interface HarnessConfig');
  const body = src.slice(a, src.indexOf('\n}\n', a));
  const names = [...body.matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1]);
  const looksSecret = names.filter((n) => /secret|token|apikey|password|passphrase|credential|key/i.test(n));
  // numeric budgets that merely contain the word "token"
  const notSecrets = new Set(['costCapTokens', 'agentTokenCaps', 'defaultWorkerTokenCap']);
  const handled = new Set(S.SECRET_CONFIG_KEYS);
  const unhandled = looksSecret.filter((n) => !notSecrets.has(n) && !handled.has(n));
  assert.deepEqual(unhandled, [], `a config field that looks like a secret is not covered by configSecrets.ts: ${unhandled.join(', ')}`);
  for (const k of S.SECRET_CONFIG_KEYS) assert.ok(names.includes(k), `${k} is listed as a secret key but is not a config field`);
});
