'use strict';

/**
 * The REST broker wired the way index.ts wires it: the real integration
 * registry and the real (now atomic) secret store behind it, with only Electron
 * and the upstream API stood in. This is the check that existing REST
 * integrations still work after the broker and the store were reworked.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { startUpstream, call, json, bearer } = require('./fixtures/broker-helpers.cjs');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'md-rest-e2e-'));
const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron, filename: electron, loaded: true,
  exports: {
    app: { getPath: () => userData },
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from('enc:' + s, 'utf8'),
      decryptString: (b) => b.toString('utf8').replace(/^enc:/, '')
    }
  }
};

const integrations = loadTs('src/main/integrations.ts');
const { IntegrationBroker } = loadTs('src/main/integrationBroker.ts');
const { secretRefFor } = loadTs('src/shared/integrations.ts');

test.after(() => fs.rmSync(userData, { recursive: true, force: true }));

/** index.ts: `new IntegrationBroker({ getRecord: integrations.getRecord, getSecret: integrations.getSecret })` */
async function realBroker(t) {
  const broker = new IntegrationBroker({ getRecord: integrations.getRecord, getSecret: integrations.getSecret });
  const { port } = await broker.start();
  t.after(() => broker.stop());
  return { broker, port };
}

function register(base, over = {}) {
  const res = integrations.upsertRecord({
    id: 'e2e-api', label: 'E2E API', kind: 'custom-rest', baseUrl: base, authType: 'bearer', enabled: true, ...over
  });
  assert.equal(res.ok, true, res.error);
  return res.record;
}

test('a registered integration works through the real registry and secret store', async (t) => {
  const up = await startUpstream(t);
  register(up.base);
  assert.deepEqual(integrations.setSecret(secretRefFor('e2e-api'), 'REAL-API-KEY'), { ok: true });

  const { broker, port } = await realBroker(t);
  assert.deepEqual(integrations.enabledIds(), ['e2e-api']);
  const token = broker.grant('worker-1', integrations.enabledIds());

  const res = await call(port, { method: 'POST', path: '/i/e2e-api/v1/things?x=1', headers: { ...bearer(token), 'content-type': 'application/json' }, body: '{"hello":"world"}' });
  assert.equal(res.status, 200);
  assert.equal(up.last().url, '/v1/things?x=1');
  assert.equal(up.last().headers.authorization, 'Bearer REAL-API-KEY');
  assert.equal(up.last().body.toString(), '{"hello":"world"}');
  assert.equal(JSON.stringify(res.headers).includes('REAL-API-KEY'), false);
});

test('the secret on disk is ciphertext and the broker still decrypts it', async (t) => {
  const up = await startUpstream(t);
  register(up.base);
  integrations.setSecret(secretRefFor('e2e-api'), 'PLAINTEXT-MUST-NOT-APPEAR');
  const onDisk = fs.readFileSync(path.join(userData, 'integration-secrets.json'), 'utf8');
  assert.equal(onDisk.includes('PLAINTEXT-MUST-NOT-APPEAR'), false);
  const { broker, port } = await realBroker(t);
  const token = broker.grant('w', ['e2e-api']);
  await call(port, { path: '/i/e2e-api/x', headers: bearer(token) });
  assert.equal(up.last().headers.authorization, 'Bearer PLAINTEXT-MUST-NOT-APPEAR');
});

test('disabling or removing the record, or deleting the secret, takes effect on the next request', async (t) => {
  const up = await startUpstream(t);
  const rec = register(up.base);
  integrations.setSecret(secretRefFor('e2e-api'), 'KEY');
  const { broker, port } = await realBroker(t);
  const token = broker.grant('w', ['e2e-api']);
  const get = () => call(port, { path: '/i/e2e-api/x', headers: bearer(token) });
  assert.equal((await get()).status, 200);

  integrations.upsertRecord({ ...rec, enabled: false });
  const off = await get();
  assert.equal(off.status, 403);
  assert.deepEqual(json(off), { error: 'integration is disabled', code: 'forbidden' });
  integrations.upsertRecord({ ...rec, enabled: true });
  assert.equal((await get()).status, 200);

  assert.deepEqual(integrations.deleteSecret(secretRefFor('e2e-api')), { ok: true });
  const noSecret = await get();
  assert.equal(noSecret.status, 503);
  assert.equal(json(noSecret).code, 'no_secret');

  integrations.removeRecord('e2e-api');
  assert.equal((await get()).status, 404);
});

test('a damaged secret store never takes the broker down: it answers 503 until the store is restored', async (t) => {
  const up = await startUpstream(t);
  register(up.base);
  integrations.setSecret(secretRefFor('e2e-api'), 'KEY-ONE');
  const file = path.join(userData, 'integration-secrets.json');
  const { broker, port } = await realBroker(t);
  const token = broker.grant('w', ['e2e-api']);
  const get = () => call(port, { path: '/i/e2e-api/x', headers: bearer(token) });
  assert.equal((await get()).status, 200);

  // the backup is removed so there is nothing to recover from: the worst case
  fs.rmSync(`${file}.bak`);
  fs.writeFileSync(file, '{"int:e2e-api": "ZW5jOktFWS1PTkU=", ');
  const down = await get();
  assert.equal(down.status, 503, 'a clean refusal, not a crash and not an unauthenticated call');
  assert.equal(up.seen.length, 1, 'nothing was sent upstream without its credential');
  assert.equal(integrations.secretStoreStatus().state, 'corrupt-unrecovered');
  assert.ok(fs.readdirSync(userData).some((n) => n.includes('.corrupt-')), 'the damaged file was kept');

  // the user enters the credential again and the integration is back
  integrations.setSecret(secretRefFor('e2e-api'), 'KEY-TWO');
  assert.equal((await get()).status, 200);
  assert.equal(up.last().headers.authorization, 'Bearer KEY-TWO');
  integrations.acknowledgeSecretStoreProblem();
});

test('a damaged store with a good backup is restored and the integration keeps working', async (t) => {
  const up = await startUpstream(t);
  register(up.base);
  integrations.setSecret(secretRefFor('e2e-api'), 'KEEP-ME');
  const file = path.join(userData, 'integration-secrets.json');
  const { broker, port } = await realBroker(t);
  const token = broker.grant('w', ['e2e-api']);
  fs.writeFileSync(file, '');
  const res = await call(port, { path: '/i/e2e-api/x', headers: bearer(token) });
  assert.equal(res.status, 200);
  assert.equal(up.last().headers.authorization, 'Bearer KEEP-ME');
  assert.equal(integrations.secretStoreStatus().state, 'recovered-from-backup');
  integrations.acknowledgeSecretStoreProblem();
});

test('the three REST auth styles all still inject correctly through the real registry', async (t) => {
  const up = await startUpstream(t);
  const { broker, port } = await realBroker(t);
  const cases = [
    { id: 'via-bearer', authType: 'bearer', check: (h) => h.authorization === 'Bearer S-bearer' },
    { id: 'via-header', authType: 'header', authHeader: 'X-Api-Key', check: (h) => h['x-api-key'] === 'S-header' },
    { id: 'via-github', authType: 'github', kind: 'github', check: (h) => h.authorization === 'Bearer S-github' && h.accept === 'application/vnd.github+json' }
  ];
  for (const c of cases) {
    const { check, ...rest } = c;
    register(up.base, { ...rest, label: c.id });
    integrations.setSecret(secretRefFor(c.id), `S-${c.id.replace('via-', '')}`);
    const token = broker.grant(`w-${c.id}`, [c.id]);
    const res = await call(port, { path: `/i/${c.id}/x`, headers: bearer(token) });
    assert.equal(res.status, 200, c.id);
    assert.equal(check(up.last().headers), true, c.id);
    integrations.removeRecord(c.id);
    integrations.deleteSecret(secretRefFor(c.id));
  }
});
