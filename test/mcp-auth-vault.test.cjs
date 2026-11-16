'use strict';

/**
 * The vault that keeps a bridged MCP server's OAuth tokens.
 *
 * mcp-remote can only hold tokens as plain JSON files, and left alone keeps
 * them in ~/.mcp-auth for ever (security audit, 2026-11-14). The vault's whole
 * job is the lifecycle round that: encrypted while idle, plaintext in a private
 * directory only while an agent is using the server, sealed again afterwards.
 * Each rule below is one way that lifecycle could quietly stop being true.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { McpAuthVault, bridgeArgs, revokeAtProvider } = loadTs('src/main/mcpAuthVault.ts');
const { MCP_CATALOG, MCP_REMOTE_PACKAGE, mcpTokenRef } = loadTs('src/shared/mcpCatalog.ts');

const CLIENT = { clientId: 'VAULT-CLIENT-ID', clientSecret: 'VAULT-CLIENT-SECRET' };
const TOKEN_FILE = 'b'.repeat(32) + '_tokens.json';
const tokens = (n = 1) => JSON.stringify({ access_token: `ACCESS-${n}`, refresh_token: `REFRESH-${n}` });

function setup(t, { refuse = false } = {}) {
  const base = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mosbius-vault-')), 'mcp-auth');
  t.after(() => fs.rmSync(path.dirname(base), { recursive: true, force: true }));
  const store = new Map();
  const vault = new McpAuthVault(() => base, {
    get: (ref) => store.get(ref),
    set: (ref, v) => { if (refuse) return { ok: false, error: 'no encryption' }; store.set(ref, v); return { ok: true }; },
    delete: (ref) => { store.delete(ref); }
  });
  const tokenPath = (id) => path.join(base, id, 'mcp-remote-v1', TOKEN_FILE);
  /** What mcp-remote does at the end of a sign-in: write its token file. */
  const writeTokens = (id, n = 1) => fs.writeFileSync(tokenPath(id), tokens(n), { mode: 0o600 });
  const seal = (id, n = 1) => store.set(mcpTokenRef(id), JSON.stringify({ files: { [TOKEN_FILE]: tokens(n) } }));
  return { base, store, vault, tokenPath, writeTokens, seal };
}

/** Every file under a directory, with its text. */
function everyFile(dir) {
  const out = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const n of fs.readdirSync(d)) {
      const p = path.join(d, n);
      if (fs.statSync(p).isDirectory()) walk(p); else out.push({ p, text: fs.readFileSync(p, 'utf8') });
    }
  };
  walk(dir);
  return out;
}

test('nothing is written for a server nobody has signed in to', (t) => {
  const { base, vault } = setup(t);
  assert.equal(vault.checkout('gmail', 'pty-1', CLIENT, 'scope'), undefined);
  assert.equal(fs.existsSync(base), false, 'the OAuth client reached the disk with no sign-in to use it');
  assert.equal(vault.isConnected('gmail'), false);
});

test('half a client is never checked out, signed in or not', (t) => {
  const { base, vault, seal } = setup(t);
  seal('gmail');
  assert.equal(vault.checkout('gmail', 'pty-1', { clientId: 'x', clientSecret: '' }), undefined);
  assert.equal(vault.checkout('gmail', 'pty-1', { clientId: '', clientSecret: 'y' }), undefined);
  assert.equal(fs.existsSync(base), false);
});

test('a checkout writes the client and tokens owner-only, inside a private directory', (t) => {
  const { base, vault, seal, tokenPath } = setup(t);
  seal('gmail');
  const paths = vault.checkout('gmail', 'pty-1', CLIENT, 'a b');
  assert.equal(paths.configDir, path.join(base, 'gmail'));
  assert.deepEqual(JSON.parse(fs.readFileSync(paths.clientInfoFile, 'utf8')),
    { client_id: CLIENT.clientId, client_secret: CLIENT.clientSecret });
  assert.deepEqual(JSON.parse(fs.readFileSync(paths.metadataFile, 'utf8')), { scope: 'a b' });
  assert.equal(fs.readFileSync(tokenPath('gmail'), 'utf8'), tokens(1));

  if (process.platform !== 'win32') {
    for (const d of [base, paths.configDir, path.join(paths.configDir, 'mcp-remote-v1')]) {
      assert.equal(fs.statSync(d).mode & 0o777, 0o700, `${d} is readable by other users`);
    }
    for (const { p } of everyFile(base)) {
      assert.equal(fs.statSync(p).mode & 0o777, 0o600, `${p} is readable by other users`);
    }
  }
});

test('when the last agent using a server ends, its tokens are sealed and the plaintext is gone', (t) => {
  const { base, store, vault, seal, writeTokens } = setup(t);
  seal('gmail', 1);
  vault.checkout('gmail', 'pty-1', CLIENT);
  vault.checkout('gmail', 'pty-2', CLIENT);
  writeTokens('gmail', 2);            // mcp-remote refreshed the token mid-session

  vault.release('pty-1');
  assert.equal(vault.hasPlaintext('gmail'), true, 'pty-2 is still using it');

  vault.release('pty-2');
  assert.equal(vault.hasPlaintext('gmail'), false, 'plaintext tokens outlived their last user');
  assert.deepEqual(everyFile(base), []);
  // …and the REFRESHED tokens are what was kept, not the stale sealed copy.
  assert.match(store.get(mcpTokenRef('gmail')), /ACCESS-2/);
  assert.equal(vault.isConnected('gmail'), true);
});

test('one server ending does not touch another that is still in use', (t) => {
  const { vault, seal } = setup(t);
  seal('gmail'); seal('slack');
  vault.checkout('gmail', 'pty-1', CLIENT);
  vault.checkout('slack', 'pty-2', CLIENT);
  vault.release('pty-1');
  assert.equal(vault.hasPlaintext('gmail'), false);
  assert.equal(vault.hasPlaintext('slack'), true);
});

test('a sweep seals whatever a crash left behind, and removes what it does not recognise', (t) => {
  const { base, store, vault, seal, writeTokens } = setup(t);
  seal('gmail', 1);
  vault.checkout('gmail', 'pty-1', CLIENT);
  writeTokens('gmail', 7);
  fs.mkdirSync(path.join(base, 'Not A Catalogue Id'), { recursive: true });
  fs.writeFileSync(path.join(base, 'Not A Catalogue Id', 'x'), 'leftover');

  // A brand-new vault over the same directory: what the app has after a crash.
  const fresh = new McpAuthVault(() => base, {
    get: (ref) => store.get(ref), set: (ref, v) => { store.set(ref, v); return { ok: true }; }, delete: (ref) => store.delete(ref)
  });
  fresh.sweep();
  assert.equal(fs.existsSync(base), false, 'the sweep left plaintext on disk');
  assert.match(store.get(mcpTokenRef('gmail')), /ACCESS-7/);
});

test('a sign-in keeps its tokens encrypted and leaves no plaintext behind', (t) => {
  const { base, store, vault, writeTokens } = setup(t);
  const paths = vault.beginSignIn('slack', CLIENT);
  assert.equal(fs.existsSync(path.join(paths.configDir, 'mcp-remote-v1', TOKEN_FILE)), false,
    'a sign-in must start with no tokens, or mcp-remote would skip the browser');
  assert.equal(paths.metadataFile, undefined, 'no scope was given, so none is pinned');
  writeTokens('slack', 3);
  assert.equal(vault.hasPlainTokens('slack'), true);

  assert.equal(vault.endSignIn('slack'), true);
  assert.deepEqual(everyFile(base), []);
  assert.match(store.get(mcpTokenRef('slack')), /REFRESH-3/);
});

test('a sign-in that produced nothing leaves nothing — not even the client', (t) => {
  const { base, store, vault } = setup(t);
  vault.beginSignIn('slack', CLIENT);
  assert.equal(vault.endSignIn('slack'), false);
  assert.deepEqual(everyFile(base), []);
  assert.equal(store.has(mcpTokenRef('slack')), false);
});

test('if the encrypted store refuses the tokens, the plaintext is still removed', (t) => {
  const { base, vault, writeTokens } = setup(t, { refuse: true });
  vault.beginSignIn('gmail', CLIENT);
  writeTokens('gmail');
  assert.equal(vault.endSignIn('gmail'), false, 'reported as not kept');
  assert.deepEqual(everyFile(base), [], 'failing open would leave tokens on disk for ever');
});

test('only token files are sealed, and only real ones', (t) => {
  const { base, store, vault, writeTokens } = setup(t);
  vault.beginSignIn('gmail', CLIENT);
  writeTokens('gmail');
  const dir = path.join(base, 'gmail', 'mcp-remote-v1');
  fs.writeFileSync(path.join(dir, 'b'.repeat(32) + '_code_verifier_x.txt'), 'VERIFIER');
  fs.writeFileSync(path.join(dir, 'c'.repeat(32) + '_tokens.json'), '{not json');
  fs.writeFileSync(path.join(dir, '../client.json'), JSON.stringify({ client_secret: 'NOPE' }));
  vault.endSignIn('gmail');
  const sealed = store.get(mcpTokenRef('gmail'));
  assert.deepEqual(Object.keys(JSON.parse(sealed).files), [TOKEN_FILE]);
  assert.equal(/VERIFIER|NOPE|VAULT-CLIENT-SECRET/.test(sealed), false, 'something other than tokens was sealed');
});

test('purge forgets the sealed tokens and every file, even while in use', (t) => {
  const { base, store, vault, seal } = setup(t);
  seal('google-drive');
  vault.checkout('google-drive', 'pty-1', CLIENT, 's');
  assert.deepEqual(vault.readTokens('google-drive')[0], { access_token: 'ACCESS-1', refresh_token: 'REFRESH-1' });

  vault.purge('google-drive');
  assert.equal(store.has(mcpTokenRef('google-drive')), false);
  assert.deepEqual(everyFile(base), []);
  assert.equal(vault.isConnected('google-drive'), false);
  assert.deepEqual(vault.readTokens('google-drive'), []);
  // the agent that was using it ending later must not resurrect anything
  vault.release('pty-1');
  assert.equal(store.has(mcpTokenRef('google-drive')), false);
});

test('an id that is not a plain catalogue id cannot name a directory', (t) => {
  const { vault } = setup(t);
  for (const bad of ['../x', 'a/b', '', 'UPPER', '.hidden']) {
    assert.throws(() => vault.purge(bad), /bad integration id/, bad);
  }
});

// ─── the command line ────────────────────────────────────────────────────────

test('the bridge command is pinned, loopback-only, and carries no secret', () => {
  assert.match(MCP_REMOTE_PACKAGE, /^mcp-remote@\d+\.\d+\.\d+$/, 'an unpinned package can change under a stored token');
  for (const e of MCP_CATALOG.filter((x) => x.spec.transport === 'bridge')) {
    const args = bridgeArgs(e.spec, { configDir: '/v', clientInfoFile: '/v/client.json', metadataFile: '/v/metadata.json' });
    assert.deepEqual(args.slice(0, 4), ['-y', MCP_REMOTE_PACKAGE, e.spec.url, String(e.spec.callbackPort)]);
    assert.deepEqual(args.slice(args.indexOf('--host'), args.indexOf('--host') + 2), ['--host', '127.0.0.1'],
      'left alone the redirect host differs by platform, and localhost may resolve to ::1');
    assert.equal(args[args.indexOf('--static-oauth-client-info') + 1], '@/v/client.json');
    // mcp-remote's debug log can contain whole token objects.
    assert.equal(args.includes('--debug'), false);
    // never widen the listener or accept plain http upstream
    for (const flag of ['--bind-host', '--allow-http', '--callback-path']) assert.equal(args.includes(flag), false, flag);
    assert.equal(args.some((a) => a.includes('${')), false, 'no value is taken from the environment');
  }
});

// ─── revoking at the provider ────────────────────────────────────────────────

const GOOGLE = { url: 'https://oauth2.googleapis.com/revoke', style: 'oauth2' };
const SLACK = { url: 'https://slack.com/api/auth.revoke', style: 'slack' };

function fakeFetch(answer) {
  const calls = [];
  const fn = async (url, init) => { calls.push({ url, init }); return answer(url, init); };
  return { fn, calls };
}

test('Google is sent the refresh token, in the body, with redirects refused', async () => {
  const { fn, calls } = fakeFetch(() => ({ status: 200, json: async () => ({}) }));
  const r = await revokeAtProvider(GOOGLE, [{ access_token: 'A', refresh_token: 'R/1+x' }], fn);
  assert.deepEqual(r, { attempted: 1, confirmed: 1 });
  assert.equal(calls[0].url, GOOGLE.url);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.redirect, 'error', 'a redirect would forward the token wherever the response said');
  assert.equal(calls[0].init.body, 'token=R%2F1%2Bx');
  assert.equal(calls[0].url.includes('R'), false, 'the token must not be in the URL');
});

test('a token Google no longer knows counts as revoked; a server error does not', async () => {
  const gone = fakeFetch(() => ({ status: 400, json: async () => ({ error: 'invalid_token' }) }));
  assert.equal((await revokeAtProvider(GOOGLE, [{ access_token: 'A' }], gone.fn)).confirmed, 1);
  const down = fakeFetch(() => ({ status: 503, json: async () => ({}) }));
  assert.deepEqual(await revokeAtProvider(GOOGLE, [{ access_token: 'A' }], down.fn), { attempted: 1, confirmed: 0 });
  const offline = fakeFetch(() => { throw new Error('offline'); });
  assert.deepEqual(await revokeAtProvider(GOOGLE, [{ access_token: 'A' }], offline.fn), { attempted: 1, confirmed: 0 });
});

test('Slack is sent each token as its own bearer, never in the URL or body', async () => {
  const { fn, calls } = fakeFetch(() => ({ status: 200, json: async () => ({ ok: true, revoked: true }) }));
  const r = await revokeAtProvider(SLACK, [{ access_token: 'xoxe.A', refresh_token: 'xoxe-1-R' }], fn);
  assert.deepEqual(r, { attempted: 2, confirmed: 2 });
  assert.deepEqual(calls.map((c) => c.init.headers.Authorization), ['Bearer xoxe.A', 'Bearer xoxe-1-R']);
  for (const c of calls) {
    assert.equal(c.url, SLACK.url);
    assert.equal(c.init.body, undefined);
    assert.equal(c.init.redirect, 'error');
  }
});

test('no token is ever sent to a URL that is not https, or when no endpoint is documented', async () => {
  const { fn, calls } = fakeFetch(() => ({ status: 200, json: async () => ({}) }));
  await revokeAtProvider({ url: 'http://oauth2.googleapis.com/revoke', style: 'oauth2' }, [{ access_token: 'A' }], fn);
  await revokeAtProvider(undefined, [{ access_token: 'A' }], fn);
  assert.equal(calls.length, 0);
});

test('every bridged entry revokes at its own provider, over TLS', () => {
  const hosts = { gmail: 'oauth2.googleapis.com', 'google-calendar': 'oauth2.googleapis.com', 'google-drive': 'oauth2.googleapis.com', slack: 'slack.com' };
  for (const e of MCP_CATALOG.filter((x) => x.spec.transport === 'bridge')) {
    const u = new URL(e.spec.revoke.url);
    assert.equal(u.protocol, 'https:');
    assert.equal(u.hostname, hosts[e.id], `${e.id} would send its tokens to ${u.hostname}`);
  }
});
