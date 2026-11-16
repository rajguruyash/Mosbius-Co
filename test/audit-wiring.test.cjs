'use strict';

/**
 * F5 wiring — nothing the user changes about a credential, a consent, a grant or an
 * engine goes unrecorded, and a record never carries a value.
 *
 * Two halves. The secret store is exercised for real (with a stand-in safeStorage): a
 * write or a removal tells the observer the REF and nothing else, a refused write tells
 * it nothing, and a broken observer cannot fail the write. The main process's own wiring
 * (it cannot be loaded under plain node) is pinned by reading its source, the way the
 * other handler-shape tests in this suite do.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'md-audit-wiring-'));
let encryptionAvailable = true;
const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron, filename: electron, loaded: true,
  exports: {
    app: { getPath: () => userData },
    safeStorage: {
      isEncryptionAvailable: () => encryptionAvailable,
      getSelectedStorageBackend: () => 'gnome_libsecret',
      encryptString: (s) => Buffer.from('enc:' + s, 'utf8'),
      decryptString: (b) => b.toString('utf8').slice(4)
    }
  }
};
const store = loadTs('src/main/integrations.ts');
test.after(() => { store.setSecretObserver(undefined); fs.rmSync(userData, { recursive: true, force: true }); });
test.beforeEach(() => {
  for (const n of fs.readdirSync(userData)) fs.rmSync(path.join(userData, n), { recursive: true, force: true });
  encryptionAvailable = true;
  store.setSecretObserver(undefined);
});

const SECRET = 'ghp_PLANTEDsecretVALUE0123456789abcdef';

test('storing a secret tells the observer the ref and never the value', () => {
  const seen = [];
  store.setSecretObserver((...args) => seen.push(args));
  assert.equal(store.setSecret('mcp:github', SECRET).ok, true);
  assert.deepEqual(seen, [['mcp:github', 'set']]);
  assert.equal(JSON.stringify(seen).includes(SECRET), false);
});

test('removing a secret notifies once, and removing one that is not there notifies nothing', () => {
  const seen = [];
  store.setSecret('int:x', SECRET);
  store.setSecretObserver((...args) => seen.push(args));
  assert.equal(store.deleteSecret('int:x').ok, true);
  assert.equal(store.deleteSecret('int:x').ok, true, 'idempotent');
  assert.equal(store.deleteSecret('never:existed').ok, true);
  assert.deepEqual(seen, [['int:x', 'clear']]);
});

test('a refused write (no OS encryption) tells the observer nothing', () => {
  const seen = [];
  store.setSecretObserver((...args) => seen.push(args));
  encryptionAvailable = false;
  assert.equal(store.setSecret('mcp:github', SECRET).ok, false);
  assert.deepEqual(seen, []);
});

test('an observer that throws cannot fail or undo the write', () => {
  store.setSecretObserver(() => { throw new Error('boom'); });
  assert.equal(store.setSecret('apikey:openai', SECRET).ok, true);
  assert.equal(store.getSecret('apikey:openai'), SECRET);
  assert.equal(store.deleteSecret('apikey:openai').ok, true);
  assert.equal(store.hasSecret('apikey:openai'), false);
});

// ─── the main process's wiring, read from its source ────────────────────────

const index = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8');

test('the MCP route feeds the durable trail as well as the in-memory list', () => {
  const m = /audit: \(e\) => \{[\s\S]{0,400}?\n    \}/.exec(index);
  assert.ok(m, 'the route audit callback was not found');
  assert.match(m[0], /mcpAudit\.push\(e\)/);
  assert.match(m[0], /recordAudit\(\{\s*kind: 'mcp'/);
});

test('the secret observer skips only the app\'s own rotating tokens and the audit key', () => {
  const m = /integrations\.setSecretObserver\(\(ref, change\) => \{([\s\S]*?)\n\}\);/.exec(index);
  assert.ok(m, 'the secret observer was not registered');
  assert.match(m[1], /ref === 'audit:key' \|\| ref === 'audit:head'/);
  assert.match(m[1], /\(oauth\|tokens\)/);
  assert.match(m[1], /recordAudit\(\{ kind: 'secret'/);
  // the ref goes in the record, never a value: the observer is not even handed one
  assert.equal(/getSecret/.test(m[1]), false);
});

test('consent changes, grants, engine switches, sign-ins, disconnects and capability changes are all recorded', () => {
  for (const needle of [
    "kind: 'consent'", "kind: 'grant'", "kind: 'engine'", "action: 'sign-in'", "action: 'disconnect'",
    "action: 'grant', detail: mcpIds", "action: 'revoke' })"
  ]) assert.ok(index.includes(needle), `not recorded: ${needle}`);
});

test('the audit trail is only readable by the app\'s own page', () => {
  for (const channel of ['audit:recent', 'audit:verify']) {
    const m = new RegExp(`ipcMain\\.handle\\('${channel}', \\(evt[^)]*\\) =>[^]*?fromAppPage\\(evt\\)`).exec(index);
    assert.ok(m, `${channel} must check the sender`);
  }
});

test('the audit anchor is kept in the encrypted store as well as beside the log, and closed with the app', () => {
  assert.match(index, /anchor: \{\s*read: \(\) => integrations\.getSecret\('audit:head'\),\s*write: \(v\) => integrations\.setSecret\('audit:head', v\)\.ok/);
  assert.match(index, /auditStoreInst\?\.close\(\)/);
});
