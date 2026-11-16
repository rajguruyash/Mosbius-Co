'use strict';

/**
 * The connection manager (src/main/connect/), against the Stage A stand-in provider.
 *
 * What a pass proves: the app's own code connects, keeps alive, and disconnects a hosted server the way the
 * standards say, refuses what it must, and never lets a token, a code or a secret out. What it does NOT prove:
 * anything about Notion, Linear, Sentry, Stripe, Atlassian or GitHub. Those are verified only by a real
 * sign-in, and are recorded as such in MOSBIUS_PLATFORM_ROADMAP.md.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const loadTs = require('./load-ts.cjs');
const { startStageAIdp } = require('./fixtures/stage-a-idp.cjs');

const { ConnectionManager } = loadTs('src/main/connect/manager.ts');
const { safeLog } = loadTs('src/main/oauth/types.ts');
const { mcpOauthRef } = loadTs('src/shared/mcpCatalog.ts');
const { connectRef } = loadTs('src/shared/connect.ts');

const ID = 'standin';

const rawGet = (target, headers = {}) => new Promise((resolve) => {
  const u = new URL(target);
  const req = http.request({ host: '127.0.0.1', port: u.port, path: u.pathname + u.search, method: 'GET', headers }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
  req.on('error', () => resolve(0));
  req.end();
});
const navigate = (target, headers = {}) => rawGet(target, { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', ...headers });
/** The user's browser: the authorization page, then the redirect to the loopback address. */
const browser = (before) => async (url) => {
  const r = await fetch(url, { redirect: 'manual' });
  const loc = r.headers.get('location');
  if (!loc) return;
  if (before) await before(loc);
  await navigate(loc);
};

function makeVault() {
  const v = {
    map: new Map(), failSet: false, unreadable: false,
    get: (r) => (v.unreadable ? undefined : v.map.get(r)),
    set: (r, x) => (v.failSet ? { ok: false, error: 'refused' } : (v.map.set(r, x), { ok: true })),
    has: (r) => v.map.has(r),
    readable: () => !v.unreadable,
    delete: (r) => v.map.delete(r)
  };
  return v;
}

function entryFor(idp, over = {}) {
  return {
    id: ID, label: 'Standin', description: '', tier: 'write', defaultEnabled: false, publisher: 'test', source: 'test', verified: '2026-11-15',
    spec: {
      transport: 'http', url: `${idp.base}/mcp`,
      connect: {
        hosts: [idp.host],
        methods: [{ kind: 'dcr' }, { kind: 'device', deviceEndpoint: `${idp.base}/login/device/code`, tokenEndpoint: `${idp.base}/login/oauth/access_token`, scope: 'repo' }],
        scopes: { read: 'read', write: 'read write' },
        ...over
      }
    }
  };
}

function setup(t, idp, opts = {}) {
  const vault = opts.vault ?? makeVault();
  const clock = { now: Date.now() };
  const logs = []; const audits = []; const changes = [];
  const entry = entryFor(idp, opts.connect);
  const mgr = new ConnectionManager({
    entry: (id) => (id === ID ? entry : undefined),
    secrets: vault, fetch: opts.fetch ?? ((u, i) => fetch(u, i)),
    openUrl: opts.openUrl ?? browser(),
    now: () => clock.now, log: safeLog((e) => logs.push(e)),
    policy: { allowInsecureLoopback: true },
    userClientId: opts.userClientId,
    audit: (e) => audits.push(e), onChange: (id) => changes.push(id),
    sleep: opts.sleep ?? (async () => {}),
    timeouts: { signInMs: 4000, requestMs: 5000, refreshMs: 5000, retryDelaysMs: [0, 0], cooldownMs: 20, revokeMs: 3000, ...(opts.timeouts ?? {}) }
  });
  t.after(() => mgr.dispose());
  return { mgr, vault, clock, logs, audits, changes, entry };
}

const headerToken = async (mgr) => { const r = await mgr.accessHeaders({ id: ID }); return r.ok ? r.headers.Authorization.replace(/^Bearer /, '') : null; };
const allSecrets = (idp) => [...idp.secretsSeen(), ...idp.codes.keys(), ...idp.regTokens.values(), ...[...idp.clients.values()].map((c) => c.secret).filter(Boolean)];

// ─── self-registering sign-in ───────────────────────────────────────────────

test('dcr: connects with a client the app registered itself, no secret, the resource named, and the page sees facts only', async (t) => {
  const idp = await startStageAIdp(t);
  const { mgr, vault, logs, audits } = setup(t, idp);
  assert.equal(mgr.status(ID), 'signed-out');
  assert.deepEqual(await mgr.connect(ID), { ok: true });
  assert.equal(mgr.status(ID), 'connected');

  const reg = JSON.parse(idp.requests('/register')[0].rawBody);
  assert.equal(reg.token_endpoint_auth_method, 'none');
  assert.match(reg.redirect_uris[0], /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  assert.equal(reg.scope, 'read', 'read-only unless asked for more');
  const auth = idp.requests('/authorize')[0].query;
  assert.equal(auth.resource, idp.base);
  assert.equal(auth.code_challenge_method, 'S256');
  assert.equal(auth.scope, 'read');
  assert.equal('client_secret' in idp.requests('/token')[0].form, false);

  const token = await headerToken(mgr);
  assert.ok(idp.liveAccess().includes(token), 'the header carries the provider\'s own access token');

  // what the page may see
  const s = mgr.summary(ID);
  assert.equal(s.status, 'connected');
  assert.equal(s.method, 'dcr');
  assert.equal(s.hasRefresh, true);
  assert.equal(s.canRevoke, true);
  assert.equal(s.pending, undefined);
  const shown = JSON.stringify(s) + JSON.stringify(logs) + JSON.stringify(audits);
  for (const secret of allSecrets(idp)) assert.equal(shown.includes(secret), false, 'a secret reached the summary, the log or the audit');
  // what is stored: sealed, in the vault, nowhere else
  assert.ok(vault.map.has(connectRef(ID)) && vault.map.has(mcpOauthRef(ID)));
  assert.equal(audits.some((a) => a.action === 'connect.end' && a.decision === 'allow'), true);
});

test('dcr: a wider tier asks for more, and nothing is asked for that was not chosen', async (t) => {
  const idp = await startStageAIdp(t);
  const { mgr } = setup(t, idp);
  assert.deepEqual(await mgr.connect(ID, { tier: 'write' }), { ok: true });
  assert.equal(idp.requests('/authorize')[0].query.scope, 'read write');
});

test('refresh: an expired token is renewed with no secret and the resource, and a rotated refresh token is saved first', async (t) => {
  const idp = await startStageAIdp(t, { rotate: true });
  const { mgr, vault, clock } = setup(t, idp);
  await mgr.connect(ID);
  const first = await headerToken(mgr);
  clock.now += 3 * 3600_000;                                    // the access token is long expired
  const second = await headerToken(mgr);
  assert.notEqual(second, first);
  assert.ok(idp.liveAccess().includes(second));
  const refreshReq = idp.requests('/token').filter((r) => r.form.grant_type === 'refresh_token');
  assert.equal(refreshReq.length, 1);
  assert.equal('client_secret' in refreshReq[0].form, false);
  assert.equal(refreshReq[0].form.resource, idp.base);
  const stored = JSON.parse(vault.map.get(mcpOauthRef(ID)));
  assert.equal(stored.refreshToken, [...idp.grants.keys()].at(-1), 'the rotated refresh token is the one on disk');
});

test('refresh: a 401 from the provider\'s server makes the next request refresh instead of reusing the token', async (t) => {
  const idp = await startStageAIdp(t);
  const { mgr } = setup(t, idp);
  await mgr.connect(ID);
  const used = await mgr.accessHeaders({ id: ID });
  mgr.rejected({ id: ID }, used.headers);
  const next = await headerToken(mgr);
  assert.notEqual(next, used.headers.Authorization.replace(/^Bearer /, ''));
  assert.equal(idp.requests('/token').filter((r) => r.form.grant_type === 'refresh_token').length, 1);
});

test('F1 for connections: two managers on one store, a provider that rotates: the loser adopts the winner\'s tokens', async (t) => {
  const idp = await startStageAIdp(t, { rotate: true });
  const vault = makeVault();
  const a = setup(t, idp, { vault });
  await a.mgr.connect(ID);
  const b = setup(t, idp, { vault });
  b.clock.now = a.clock.now;
  a.clock.now += 3 * 3600_000; b.clock.now = a.clock.now;
  const [x, y] = await Promise.all([a.mgr.accessHeaders({ id: ID }), b.mgr.accessHeaders({ id: ID })]);
  assert.equal(x.ok && y.ok, true);
  assert.equal(JSON.parse(vault.map.get(mcpOauthRef(ID))).dead, undefined, 'the stored sign-in is alive');
});

test('a grant the provider has ended is marked so, and the manager asks the user to sign in again', async (t) => {
  const idp = await startStageAIdp(t);
  const { mgr, clock } = setup(t, idp);
  await mgr.connect(ID);
  for (const k of idp.grants.keys()) idp.grants.get(k).revoked = true;
  clock.now += 3 * 3600_000;
  assert.deepEqual(await mgr.accessHeaders({ id: ID }), { ok: false, code: 'sign_in_required' });
  assert.equal(mgr.status(ID), 'needs-signin');
  assert.equal(mgr.summary(ID).status, 'needs-signin');
});

// ─── what must be refused ───────────────────────────────────────────────────

test('refusals: a provider that will not register us, a denied consent, and a metadata document pointing off the pinned hosts', async (t) => {
  {
    const idp = await startStageAIdp(t, { dcr: 'no-http-loopback' });
    const { mgr, vault } = setup(t, idp);
    assert.deepEqual(await mgr.connect(ID), { ok: false, error: 'registration-failed' });
    assert.equal(vault.map.size, 0);
    assert.equal(mgr.summary(ID).lastError, 'registration-failed');
  }
  {
    const idp = await startStageAIdp(t, { consent: 'deny' });
    const { mgr, vault } = setup(t, idp);
    assert.deepEqual(await mgr.connect(ID), { ok: false, error: 'denied' });
    assert.equal(vault.map.size, 0);
    assert.equal(idp.requests('/token').length, 0);
  }
  {
    const idp = await startStageAIdp(t, { evilTokenHost: true });
    const { mgr } = setup(t, idp);
    assert.deepEqual(await mgr.connect(ID), { ok: false, error: 'discovery-failed' });
    assert.equal(idp.requests('/register').length, 0, 'nothing was registered at a provider whose metadata points elsewhere');
  }
  {
    const idp = await startStageAIdp(t, { dcr: 'none' });
    const { mgr } = setup(t, idp);
    assert.deepEqual(await mgr.connect(ID, { method: 'dcr' }), { ok: false, error: 'not-available' });
  }
});

test('a forged callback is ignored, a wrong iss ends the sign-in before any code is exchanged', async (t) => {
  {
    const idp = await startStageAIdp(t);
    const forged = async (loc) => {
      const wrong = new URL(loc); wrong.searchParams.set('state', 'y'.repeat(43));
      assert.equal(await rawGet(wrong.toString()), 400);
      assert.equal(await rawGet(loc, { Host: 'evil.example' }), 400);
      assert.equal(await rawGet(loc, { 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' }), 400);
      assert.equal((await fetch(loc, { method: 'POST' })).status, 405);
    };
    const { mgr } = setup(t, idp, { openUrl: browser(forged) });
    assert.deepEqual(await mgr.connect(ID), { ok: true });
  }
  {
    const idp = await startStageAIdp(t, { issParam: 'wrong' });
    const { mgr, vault } = setup(t, idp);
    assert.deepEqual(await mgr.connect(ID), { ok: false, error: 'invalid-callback' });
    assert.equal(idp.requests('/token').length, 0);
    assert.equal(vault.map.size, 0);
  }
});

test('cancel while waiting ends the sign-in and frees the address; a second sign-in while one waits is refused', async (t) => {
  const idp = await startStageAIdp(t);
  let release;
  const gate = new Promise((r) => { release = r; });
  const { mgr, vault } = setup(t, idp, { openUrl: async () => { await gate; } });
  const first = mgr.connect(ID);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(mgr.summary(ID).pending.kind, 'browser');
  assert.deepEqual(await mgr.connect(ID), { ok: false, error: 'in-progress' });
  mgr.cancel(ID);
  release();
  assert.deepEqual(await first, { ok: false, error: 'cancelled' });
  assert.equal(vault.map.size, 0);
  assert.equal(mgr.summary(ID).pending, undefined);
  assert.equal(idp.requests('/token').length, 0);
});

test('cancel while the service\'s details are still being read reports "cancelled", not a discovery failure', async (t) => {
  // Found by a flake under load: the test above sometimes cancelled during discovery and got "discovery-failed". Here
  // discovery is made to wait for the cancel, so the same thing happens on every machine at every speed.
  const idp = await startStageAIdp(t);
  const asked = [];
  const slow = (url, init) => {
    asked.push(String(url));
    if (!/\.well-known/.test(String(url))) return fetch(url, init);
    return new Promise((_, reject) => {
      const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      if (init?.signal?.aborted) return abort();
      init?.signal?.addEventListener('abort', abort, { once: true });
    });
  };
  const { mgr, vault } = setup(t, idp, { fetch: slow });
  const first = mgr.connect(ID);
  const end = Date.now() + 3000;
  while (!asked.some((u) => /\.well-known/.test(u)) && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
  assert.ok(asked.some((u) => /\.well-known/.test(u)), 'discovery had started');
  mgr.cancel(ID);
  assert.deepEqual(await first, { ok: false, error: 'cancelled' });
  assert.equal(vault.map.size, 0);
  assert.equal(mgr.summary(ID).pending, undefined);
  assert.equal(idp.requests('/register').length, 0, 'nothing was registered');
  assert.equal(mgr.summary(ID).lastError, 'cancelled');
});

test('nothing is left behind when the store refuses what the sign-in produced', async (t) => {
  const idp = await startStageAIdp(t);
  const vault = makeVault();
  vault.failSet = true;
  const { mgr } = setup(t, idp, { vault });
  assert.deepEqual(await mgr.connect(ID), { ok: false, error: 'not-stored' });
  assert.equal(vault.map.size, 0);
  assert.equal(mgr.status(ID), 'signed-out');
});

test('a malformed record asks for a new sign-in, and an unreadable store is "unavailable", never "signed out"', async (t) => {
  const idp = await startStageAIdp(t);
  const { mgr, vault } = setup(t, idp);
  await mgr.connect(ID);
  vault.map.set(connectRef(ID), '{"not":"a record"}');
  mgr.dispose();
  const again = setup(t, idp, { vault });
  assert.equal(again.mgr.status(ID), 'needs-signin');
  vault.unreadable = true;
  assert.equal(again.mgr.status(ID), 'unavailable');
  assert.deepEqual(await again.mgr.accessHeaders({ id: ID }), { ok: false, code: 'unavailable' });
});

// ─── disconnecting ──────────────────────────────────────────────────────────

test('disconnect: asks the provider to forget, removes the registered client, wipes the vault, and says what it did', async (t) => {
  const idp = await startStageAIdp(t);
  const { mgr, vault, audits } = setup(t, idp);
  await mgr.connect(ID);
  const token = await headerToken(mgr);
  const report = await mgr.disconnect(ID);
  assert.deepEqual(report, { ok: true, revoked: { attempted: 1, confirmed: 1 }, unregistered: true, wiped: true, endAtProvider: false });
  const rv = idp.requests('/revoke')[0].form;
  assert.equal(rv.token_type_hint, 'refresh_token');
  assert.ok(rv.client_id, 'a public client names itself');
  assert.equal(idp.liveAccess().includes(token), false, 'the access token died with the grant');
  assert.equal(idp.clients.size, 0, 'the client the app registered is gone');
  assert.equal(vault.map.size, 0);
  assert.equal(mgr.status(ID), 'signed-out');
  assert.deepEqual(await mgr.accessHeaders({ id: ID }), { ok: false, code: 'sign_in_required' });
  assert.equal(audits.at(-1).action, 'disconnect');
});

test('disconnect with the provider unreachable still wipes everything, and tells the user to finish at the provider', async (t) => {
  const idp = await startStageAIdp(t);
  const { mgr, vault } = setup(t, idp);
  await mgr.connect(ID);
  await idp.close();
  const report = await mgr.disconnect(ID);
  assert.equal(report.wiped, true);
  assert.equal(report.revoked.confirmed, 0);
  assert.equal(report.endAtProvider, true);
  assert.equal(vault.map.size, 0);
});

test('reconnecting replaces the sign-in, and the old client and token are released at the provider', async (t) => {
  const idp = await startStageAIdp(t);
  const { mgr } = setup(t, idp);
  await mgr.connect(ID);
  const firstClient = [...idp.clients.keys()][0];
  assert.deepEqual(await mgr.connect(ID), { ok: true });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(idp.clients.has(firstClient), false, 'the first registration was removed');
  assert.equal(idp.requests('/revoke').length >= 1, true);
  assert.equal(mgr.status(ID), 'connected');
});

// ─── device flow ────────────────────────────────────────────────────────────

test('device: the code is shown while it waits, the token is kept, and a refresh needs no secret', async (t) => {
  const idp = await startStageAIdp(t);
  idp.device.expiring = true;
  let seen;
  const { mgr, clock } = setup(t, idp, { sleep: async () => { seen ??= mgr.summary(ID).pending; } });
  assert.deepEqual(await mgr.connect(ID, { method: 'device', clientId: 'Iv1.test-client-id' }), { ok: true });
  assert.equal(seen.kind, 'device');
  assert.equal(seen.userCode, 'ABCD-1234');
  assert.equal(new URL(seen.verificationUri).host, idp.host);
  assert.equal(mgr.summary(ID).method, 'device');
  assert.equal(mgr.summary(ID).canRevoke, false, 'a device grant cannot be revoked without the app\'s secret');
  const first = await headerToken(mgr);
  clock.now += 3 * 3600_000;
  const second = await headerToken(mgr);
  assert.notEqual(second, first);
  for (const r of idp.log.filter((x) => x.path.startsWith('/login'))) assert.equal('client_secret' in r.form, false);
});

test('device: disconnect wipes locally and says the sign-in must also be ended at the provider', async (t) => {
  const idp = await startStageAIdp(t);
  const { mgr, vault } = setup(t, idp);
  await mgr.connect(ID, { method: 'device', clientId: 'Iv1.test-client-id' });
  const report = await mgr.disconnect(ID);
  assert.deepEqual(report, { ok: true, revoked: { attempted: 0, confirmed: 0 }, unregistered: null, wiped: true, endAtProvider: true });
  assert.equal(vault.map.size, 0);
});

test('device: no client id, a bad one, a disabled flow, a denial and an expired code are each a clear, fixed answer', async (t) => {
  const idp = await startStageAIdp(t);
  const { mgr } = setup(t, idp);
  assert.deepEqual(await mgr.connect(ID, { method: 'device' }), { ok: false, error: 'needs-client-id' });
  assert.deepEqual(await mgr.connect(ID, { method: 'device', clientId: 'no spaces allowed' }), { ok: false, error: 'bad-client-id' });
  assert.equal(mgr.methodsOf(ID).find((m) => m.kind === 'device').available, false);
  for (const [mode, expect] of [['disabled', 'device-flow-disabled'], ['denied', 'denied'], ['expired', 'expired']]) {
    idp.device.mode = mode;
    assert.deepEqual(await mgr.connect(ID, { method: 'device', clientId: 'Iv1.test-client-id' }), { ok: false, error: expect }, mode);
  }
  // a user-supplied id (kept by the app) makes the method available
  const withId = setup(t, idp, { userClientId: () => 'Iv1.users-own-app' });
  assert.equal(withId.mgr.methodsOf(ID).find((m) => m.kind === 'device').available, true);
});

test('device: a refresh token GitHub says is bad ends the sign-in (its answer is HTTP 200 with an error)', async (t) => {
  const idp = await startStageAIdp(t);
  idp.device.expiring = true;
  const { mgr, clock } = setup(t, idp);
  await mgr.connect(ID, { method: 'device', clientId: 'Iv1.test-client-id' });
  for (const g of idp.grants.values()) g.revoked = true;
  clock.now += 3 * 3600_000;
  assert.deepEqual(await mgr.accessHeaders({ id: ID }), { ok: false, code: 'sign_in_required' });
  assert.equal(mgr.status(ID), 'needs-signin');
});

// ─── the catalogue entries ──────────────────────────────────────────────────

test('every real catalogue entry with a connect spec is well formed: pinned https hosts, an https endpoint, and no secret anywhere', () => {
  const { MCP_CATALOG } = loadTs('src/shared/mcpCatalog.ts');
  const { makeHostPolicy } = loadTs('src/main/connect/policy.ts');
  const { PRODUCTION_POLICY } = loadTs('src/main/oauth/endpoints.ts');
  const withConnect = MCP_CATALOG.filter((e) => e.spec.transport === 'http' && e.spec.connect);
  assert.deepEqual(withConnect.map((e) => e.id).sort(), ['atlassian', 'github', 'linear', 'notion-hosted', 'sentry', 'stripe']);
  for (const e of withConnect) {
    const c = e.spec.connect;
    const policy = makeHostPolicy(c.hosts, PRODUCTION_POLICY);
    assert.doesNotThrow(() => policy.check(e.spec.url, `${e.id} url`), e.id);
    for (const m of c.methods) {
      assert.ok(['dcr', 'device', 'public'].includes(m.kind));
      for (const k of ['deviceEndpoint', 'tokenEndpoint', 'authorizationEndpoint', 'revocationEndpoint']) if (m[k]) assert.doesNotThrow(() => policy.check(m[k], `${e.id} ${k}`), `${e.id} ${k}`);
    }
    if (c.authorizationServer) assert.doesNotThrow(() => policy.check(c.authorizationServer, `${e.id} authorizationServer`));
    // no property that could hold a secret, and no value shaped like a credential
    const walk = (v, where) => {
      if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${where}[${i}]`));
      if (v && typeof v === 'object') return Object.entries(v).forEach(([k, x]) => { assert.equal(/secret|password|api_?key|bearer/i.test(k), false, `${e.id}: ${where}.${k}`); walk(x, `${where}.${k}`); });
      if (typeof v === 'string') assert.equal(/(ghp_|gho_|ghu_|github_pat_|xox[abp]-|sk_live|sk-ant|AIza|Bearer )/.test(v), false, `${e.id}: ${where} looks like a credential`);
    };
    walk(c, 'connect');
    assert.equal(e.defaultEnabled, false);
  }
  for (const id of ['notion-hosted', 'linear', 'sentry', 'stripe', 'atlassian']) {
    const e = withConnect.find((x) => x.id === id);
    assert.deepEqual(e.spec.connect.methods, [{ kind: 'dcr' }], `${id} connects by self-registration`);
    assert.equal(e.spec.toolClasses, undefined, `${id}: no tool is classified until a real listing exists, so none is reachable by a preset`);
  }
});
