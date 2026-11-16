'use strict';

/**
 * The sign-in method switch (`mcp:setEngine`) lives in the Electron-bound main file, so what can
 * be pinned without launching Electron is its SHAPE: the order of its steps and what it must never do.
 *   • going to the in-app engine copies an existing bridge sign-in BEFORE the engine is recorded;
 *   • going back cuts agent access through the broker BEFORE the engine is recorded;
 *   • it never deletes a stored credential, never signs in, never reads a token;
 *   • it answers only the app's own page and only for integrations that have an in-app engine.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8');
const start = src.indexOf("ipcMain.handle('mcp:setEngine'");
const handler = src.slice(start, src.indexOf("ipcMain.handle('mcp:grants:get'"));

test('the handler exists, checks the sender first, and only serves integrations with an in-app engine', () => {
  assert.ok(start > 0 && handler.length > 200);
  assert.ok(handler.indexOf('fromAppPage(evt)') > 0 && handler.indexOf('fromAppPage(evt)') < handler.indexOf('oauthEngineEntry'));
  // `oauthEngineEntry` is "a bridged service with an in-app OAuth engine" and nothing else; `capableMcpEntry`
  // (any integration the broker serves, since Stage B) would be too wide for this switch
  assert.match(handler, /const entry = oauthEngineEntry\(p\.id\);\s*if \(!entry\) return \{ ok: false, error: 'unknown server' \};/);
  assert.equal(handler.includes('capableMcpEntry'), false, 'the switch must not use the wider lookup');
  assert.match(handler, /if \(p\.engine !== 'bridge' && p\.engine !== 'broker'\) return \{ ok: false, error: 'unknown engine' \};/);
});

test('to the in-app engine: a waiting sign-in is cancelled and the bridge sign-in is COPIED before the engine is recorded', () => {
  const cancel = handler.indexOf('cancelMcpSignIn(entry.id)');
  const copy = handler.indexOf('oauthController.importFromBridge(entry.id)');
  const record = handler.indexOf('setMcpEngineFor(entry.id, p.engine)');
  assert.ok(cancel > 0 && copy > cancel && record > copy, 'cancel, then copy, then record');
});

test('back to the bridge: agent access through the broker is cut BEFORE the engine is recorded, and what was learnt is forgotten', () => {
  const cut = handler.indexOf('integrationBroker.revokeIntegration(entry.id)');
  const forget = handler.indexOf('integrationBroker.forgetMcpTools(entry.id)');
  const record = handler.indexOf('setMcpEngineFor(entry.id, p.engine)');
  assert.ok(cut > 0 && forget > cut && record > forget);
});

test('switching never deletes a credential, never signs in, never reads a token, never touches the bridge\'s vault', () => {
  for (const forbidden of ['deleteSecret', 'removeSecrets', 'secretRemover', '.delete(', 'signIn(', 'getSecret', 'readTokens', 'mcpVault', 'oauthController.revoke', 'forget(entry']) {
    assert.equal(handler.includes(forbidden), false, `the switch must not use ${forbidden}`);
  }
});

test('the answer carries a fixed code and the engine, never a token or a provider\'s text', () => {
  const returns = [...handler.matchAll(/return (\{[^;]*\});/g)].map((m) => m[1]);
  for (const r of returns) assert.match(r, /^\{ ok: (true|false)|^FORBIDDEN/, r);
  assert.match(handler, /return \{ ok: true, engine: p\.engine, imported \};/);
});
