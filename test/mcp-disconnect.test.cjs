'use strict';

/**
 * A failed credential deletion must never be reported as a successful
 * disconnect.
 *
 * `deleteSecret` reports failure as a RESULT. The callers that were written when
 * it threw used to answer "disconnected" whatever it returned, leaving a refresh
 * token in the store under a green tick. These tests drive the disconnect
 * orchestration with stores that refuse in every way a real one can.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { removeSecrets, disconnectBridged, notDisconnected } = loadTs('src/main/mcpDisconnect.ts');
const { McpAuthVault } = loadTs('src/main/mcpAuthVault.ts');
const { MCP_CATALOG, mcpSecretRefs, mcpTokenRef } = loadTs('src/shared/mcpCatalog.ts');

const GMAIL = MCP_CATALOG.find((e) => e.id === 'gmail');
const REFS = mcpSecretRefs(GMAIL);

/** A store whose delete can be made to fail in each way a real one can. */
function makeStore(initial, mode = {}) {
  const data = new Map(initial.map((r) => [r, 'sealed-' + r]));
  const calls = [];
  return {
    data, calls,
    delete(ref) {
      calls.push(ref);
      const m = typeof mode === 'function' ? mode(ref) : mode;
      if (m === 'refuse') return { ok: false, error: 'secret store unreadable (EACCES)' };
      if (m === 'throw') throw new Error('disk on fire');
      if (m === 'silent') return { ok: true };            // claims success, deletes nothing
      if (m === 'nothing') return undefined;               // reports nothing at all
      data.delete(ref);
      return { ok: true };
    },
    has: (ref) => data.has(ref)
  };
}

// ─── removeSecrets ──────────────────────────────────────────────────────────

test('removeSecrets: every ref gone is a success', () => {
  const store = makeStore(REFS);
  assert.deepEqual(removeSecrets(store, REFS), { ok: true, failed: [] });
  assert.equal(store.data.size, 0);
});

test('removeSecrets: a store that refuses is a failure that names what is still stored', () => {
  const store = makeStore(REFS, 'refuse');
  const r = removeSecrets(store, REFS);
  assert.equal(r.ok, false);
  assert.deepEqual(r.failed, REFS);
  assert.match(r.error, /2 stored credentials could not be removed/);
  assert.match(r.error, /EACCES/);
  assert.equal(store.data.size, 2, 'and they really are still there');
});

test('removeSecrets: a delete that throws is a failure', () => {
  const r = removeSecrets(makeStore(REFS, 'throw'), REFS);
  assert.equal(r.ok, false);
  assert.match(r.error, /disk on fire/);
});

test('removeSecrets: "ok" from a store that kept the secret is still a failure', () => {
  const r = removeSecrets(makeStore(REFS, 'silent'), REFS);
  assert.equal(r.ok, false, 'trusting the delete\'s own word is exactly the old bug');
  assert.match(r.error, /still stored after the delete/);
});

test('removeSecrets: a delete that reports nothing is not taken as success', () => {
  const r = removeSecrets(makeStore(REFS, 'nothing'), REFS);
  assert.equal(r.ok, false);
  assert.match(r.error, /did not confirm/);
});

test('removeSecrets: a store that cannot even say whether the secret is there counts as still stored', () => {
  const store = makeStore(REFS);
  store.has = () => { throw new Error('cannot read'); };
  assert.equal(removeSecrets(store, REFS).ok, false);
});

test('removeSecrets: one failure does not stop the others being removed', () => {
  const store = makeStore(REFS, (ref) => (ref.endsWith('client_secret') ? 'refuse' : 'ok'));
  const r = removeSecrets(store, REFS);
  assert.equal(r.ok, false);
  assert.deepEqual(r.failed, [REFS[1]]);
  assert.equal(store.data.has(REFS[0]), false, 'the client id that could be removed was');
  assert.equal(store.data.has(REFS[1]), true);
});

test('removeSecrets: the reason is one short line, whatever the store said', () => {
  const nasty = 'EACCES: permission denied, unlink \'/x/y\'\n\u001b[31mred\u001b[0m ' + 'z'.repeat(500);
  const store = makeStore(REFS);
  store.delete = () => ({ ok: false, error: nasty });
  const r = removeSecrets(store, REFS);
  assert.equal(/[\u0000-\u001f]/.test(r.error), false);
  assert.ok(r.error.length < 300, `the error is ${r.error.length} characters`);
});

// ─── disconnectBridged ──────────────────────────────────────────────────────

function deps(overrides = {}) {
  const order = [];
  const tokens = [{ access_token: 'A', refresh_token: 'R' }];
  const store = overrides.store ?? makeStore([...REFS]);
  const base = {
    order, store,
    cancelSignIn: (id) => order.push(`cancel:${id}`),
    vault: {
      readTokens: () => { order.push('read'); return tokens; },
      purge: () => { order.push('purge'); return { ok: true }; }
    },
    revoke: async (spec, toks) => { order.push('revoke'); return { attempted: toks.length, confirmed: toks.length }; },
    secrets: store
  };
  return { ...base, ...overrides, order, store, secrets: overrides.secrets ?? store };
}

test('a clean disconnect revokes first, then wipes, and says so', async () => {
  const d = deps();
  const res = await disconnectBridged(d, GMAIL);
  assert.deepEqual(res, { ok: true, revoked: true });
  assert.deepEqual(d.order, ['cancel:gmail', 'read', 'revoke', 'purge']);
  assert.equal(d.store.data.size, 0);
});

test('provider unreachable: still disconnected locally, and honest that it was not revoked', async () => {
  const d = deps({ revoke: async () => { throw new Error('offline'); } });
  const res = await disconnectBridged(d, GMAIL);
  assert.deepEqual(res, { ok: true, revoked: false });
  assert.equal(d.store.data.size, 0, 'the local wipe is not best-effort');
});

test('the OAuth client cannot be deleted: NOT disconnected, and the account stays shown as stored', async () => {
  const d = deps({ store: makeStore([...REFS], 'refuse') });
  const res = await disconnectBridged(d, GMAIL);
  assert.equal(res.ok, false);
  assert.equal(res.revoked, true, 'revocation did happen and is reported as such');
  assert.match(res.error, /^Not fully disconnected/);
  assert.match(res.error, /still on this computer/);
  assert.match(res.error, /already revoked at the provider/);
  assert.equal(d.store.data.size, 2);
});

test('the sealed tokens cannot be purged: NOT disconnected — but the client is still wiped', async () => {
  const d = deps({ vault: { readTokens: () => [{ refresh_token: 'R' }], purge: () => ({ ok: false, error: 'the sealed tokens are still stored' }) } });
  const res = await disconnectBridged(d, GMAIL);
  assert.equal(res.ok, false);
  assert.match(res.error, /sealed tokens are still stored/);
  assert.equal(d.store.data.size, 0, 'a failure in one place does not stop the rest being removed');
});

test('a purge that throws is a failure, not a crash and not a success', async () => {
  const d = deps({ vault: { readTokens: () => [], purge: () => { throw new Error('boom'); } } });
  const res = await disconnectBridged(d, GMAIL);
  assert.equal(res.ok, false);
  assert.match(res.error, /boom/);
});

test('a purge that says nothing is not a success', async () => {
  const d = deps({ vault: { readTokens: () => [], purge: () => undefined } });
  // an old-style vault that returns no result: the store check still has to hold
  const res = await disconnectBridged(d, GMAIL);
  assert.equal(res.ok, false, 'success needs an explicit ok from the purge');
});

test('a non-bridged entry is refused and nothing is touched', async () => {
  const notion = MCP_CATALOG.find((e) => e.spec.transport !== 'bridge');
  const d = deps();
  const res = await disconnectBridged(d, notion);
  assert.deepEqual(res, { ok: false, revoked: false, error: 'unknown server' });
  assert.deepEqual(d.order, []);
});

test('whatever fails, ok is true ONLY when nothing was left behind', async () => {
  // every combination of: provider revoke fails, purge fails, each delete fails
  const bools = [false, true];
  let cases = 0;
  for (const revokeFails of bools) for (const purgeFails of bools) for (const idFails of bools) for (const secretFails of bools) {
    cases++;
    const store = makeStore([...REFS], (ref) => ((ref.endsWith('client_id') && idFails) || (ref.endsWith('client_secret') && secretFails) ? 'refuse' : 'ok'));
    const d = deps({
      store,
      revoke: async () => { if (revokeFails) throw new Error('offline'); return { attempted: 1, confirmed: 1 }; },
      vault: { readTokens: () => [{ refresh_token: 'R' }], purge: () => (purgeFails ? { ok: false, error: 'x' } : { ok: true }) }
    });
    const res = await disconnectBridged(d, GMAIL);
    const leftBehind = store.data.size > 0 || purgeFails;
    assert.equal(res.ok, !leftBehind, `revokeFails=${revokeFails} purgeFails=${purgeFails} idFails=${idFails} secretFails=${secretFails}`);
    if (!res.ok) assert.ok(res.error.startsWith('Not fully disconnected'));
  }
  assert.equal(cases, 16);
});

test('notDisconnected never claims success', () => {
  assert.match(notDisconnected('why', false), /^Not fully disconnected: why\./);
  assert.equal(/revoked at the provider/.test(notDisconnected('why', false)), false);
});

// ─── the real vault, with a store that refuses ──────────────────────────────

function realVault(t, secrets) {
  const base = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mosbius-disc-')), 'mcp-auth');
  t.after(() => fs.rmSync(path.dirname(base), { recursive: true, force: true }));
  return { base, vault: new McpAuthVault(() => base, secrets) };
}

test('the vault: purge reports a store that refused the delete', (t) => {
  const kept = new Map([[mcpTokenRef('gmail'), '{"files":{}}']]);
  const { vault } = realVault(t, {
    get: (r) => kept.get(r), set: () => ({ ok: true }), delete: () => ({ ok: false, error: 'secret store unreadable (EIO)' })
  });
  const r = vault.purge('gmail');
  assert.equal(r.ok, false);
  assert.match(r.error, /EIO/);
});

test('the vault: purge reports a store that says ok but kept the tokens', (t) => {
  const kept = new Map([[mcpTokenRef('gmail'), '{"files":{}}']]);
  const { vault } = realVault(t, { get: (r) => kept.get(r), set: () => ({ ok: true }), delete: () => ({ ok: true }) });
  const r = vault.purge('gmail');
  assert.equal(r.ok, false);
  assert.match(r.error, /still stored/);
});

test('the vault: purge reports plaintext it could not remove', { skip: process.platform === 'win32' }, (t) => {
  const kept = new Map();
  const { base, vault } = realVault(t, { get: (r) => kept.get(r), set: () => ({ ok: true }), delete: () => ({ ok: true }) });
  const dir = path.join(base, 'gmail');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'client.json'), '{}');
  const real = fs.rmSync;
  fs.rmSync = (p, ...rest) => { if (String(p) === dir) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); return real(p, ...rest); };
  try {
    const r = vault.purge('gmail');
    assert.equal(r.ok, false);
    assert.match(r.error, /runtime token directory could not be removed/);
  } finally { fs.rmSync = real; }
});

test('the vault: a successful purge is ok and leaves nothing behind', (t) => {
  const kept = new Map([[mcpTokenRef('gmail'), '{"files":{}}']]);
  const { base, vault } = realVault(t, { get: (r) => kept.get(r), set: () => ({ ok: true }), delete: (r) => { kept.delete(r); return { ok: true }; } });
  fs.mkdirSync(path.join(base, 'gmail'), { recursive: true });
  assert.deepEqual(vault.purge('gmail'), { ok: true });
  assert.equal(kept.size, 0);
  assert.equal(fs.existsSync(path.join(base, 'gmail')), false);
});

// ─── no caller may drop a delete's result ───────────────────────────────────

test('GUARD: no code in src/main calls deleteSecret and ignores what it returns', () => {
  const root = path.join(__dirname, '..', 'src', 'main');
  const files = [];
  const walk = (d) => { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); fs.statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') && files.push(p); } };
  walk(root);
  const offenders = [];
  for (const f of files) {
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    lines.forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
      // a bare statement: `deleteSecret(…);` or `integrations.deleteSecret(…);` with nothing consuming it
      if (/^\s*(?:[\w.]+\.)?deleteSecret\(.*\);?\s*$/.test(code) && !/export function deleteSecret/.test(code)) {
        offenders.push(`${path.relative(root, f)}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(offenders, [], 'a deleteSecret result is being dropped:\n' + offenders.join('\n'));
});
