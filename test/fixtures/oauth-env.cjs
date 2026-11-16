'use strict';

/**
 * Wiring for the OAuth tests: a controller built exactly as index.ts builds it,
 * except that its endpoints point at the stand-in provider, its secret store is an
 * in-memory one that can be made to fail, and "the user's browser" is a function.
 */

const http = require('node:http');
const net = require('node:net');
const loadTs = require('../load-ts.cjs');

const { OAuthController } = loadTs('src/main/oauth/controller.ts');
const { safeLog } = loadTs('src/main/oauth/types.ts');
const { mcpCatalogEntry, mcpSecretRefs, mcpOauthRef } = loadTs('src/shared/mcpCatalog.ts');

/** A port nothing is listening on right now. */
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

/** One raw HTTP GET with full control of the headers (a browser, or something pretending to be one). */
function rawGet(port, pathAndQuery, { headers = {}, method = 'GET', host } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: pathAndQuery, method,
      headers: { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-site': 'cross-site', ...(host ? { host } : {}), ...headers }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** The secret store: in memory, with the failures a real one has. */
function memorySecrets() {
  const s = {
    map: new Map(),
    sets: [],                      // every write, in order: [{ ref, ok }]
    failSet: false,                // set() refuses
    unreadable: false,             // the store cannot be read at all
    undecryptable: new Set(),      // refs present but whose get() answers undefined
    get: (ref) => (s.unreadable || s.undecryptable.has(ref) ? undefined : s.map.get(ref)),
    set: (ref, v) => {
      if (s.failSet) { s.sets.push({ ref, ok: false }); return { ok: false, error: 'the secret store refused' }; }
      s.map.set(ref, v); s.sets.push({ ref, ok: true, value: v }); return { ok: true };
    },
    has: (ref) => !s.unreadable && s.map.has(ref),
    readable: () => !s.unreadable,
    delete: (ref) => { if (s.unreadable) return { ok: false, error: 'secret store unreadable (EIO)' }; s.map.delete(ref); return { ok: true }; },
    refuseDelete: false,
    everything: () => [...s.map.entries()].map(([k, v]) => `${k}=${v}`).join('\n')
  };
  const realDelete = s.delete;
  s.delete = (ref) => (s.refuseDelete ? { ok: false, error: 'secret store unreadable (EACCES)' } : realDelete(ref));
  return s;
}

/**
 * @param idp   the stand-in provider
 * @param opts  { ids: ['gmail'], clientId, clientSecret, timeouts, policy }
 */
async function makeEnv(t, idp, opts = {}) {
  const ids = opts.ids ?? ['gmail'];
  const clock = { now: opts.start ?? 1_700_000_000_000, advance(ms) { clock.now += ms; } };
  idp.now = () => clock.now;
  const secrets = memorySecrets();
  const ports = {};
  for (const id of ids) {
    ports[id] = await freePort();
    const clientId = opts.clientId ?? `client-${id}`;
    const clientSecret = opts.clientSecret ?? `SECRET-${id}-DO-NOT-LEAK`;
    idp.addClient(clientId, clientSecret, [`http://127.0.0.1:${ports[id]}/oauth/callback`]);
    const [idRef, secretRef] = mcpSecretRefs(mcpCatalogEntry(id));
    secrets.map.set(idRef, clientId);
    secrets.map.set(secretRef, clientSecret);
  }
  const logs = [];
  const opened = [];
  const env = {
    idp, clock, secrets, ports, logs, opened,
    /** What the "browser" does when the app opens the authorization URL. null = nothing (a human who never finishes). */
    browser: opts.browser === undefined ? 'auto' : opts.browser,
    browseErrors: [],
    pendingBrowse: [],
    sleeps: [],
    controller: null,
    refsOf: (id) => [...mcpSecretRefs(mcpCatalogEntry(id)), mcpOauthRef(id)]
  };
  env.controller = new OAuthController({
    // the real catalogue, with its revocation URL pointed at the stand-in
    entry: (id) => {
      const e = mcpCatalogEntry(id);
      return e && e.spec.transport === 'bridge'
        ? { ...e, spec: { ...e.spec, revoke: idp.style === 'slack' ? idp.slackRevokeSpec() : idp.revokeSpec() } }
        : e;
    },
    // late-bound, so a test can swap a method on env.secrets after the controller exists
    secrets: { get: (r) => secrets.get(r), set: (r, v) => secrets.set(r, v), has: (r) => secrets.has(r), readable: () => secrets.readable() },
    // TEST SAFETY: nothing in this suite may ever reach a real provider.
    fetch: (url, init) => {
      if (!String(url).startsWith('http://127.0.0.1:')) throw new Error(`TEST SAFETY: refusing a request that leaves loopback: ${String(url).split('?')[0]}`);
      return fetch(url, init);
    },
    openUrl: async (url) => {
      opened.push(url);
      if (env.browser === 'auto') env.pendingBrowse.push(browse(url, env).catch((e) => { env.browseErrors.push(e); }));
      else if (typeof env.browser === 'function') env.pendingBrowse.push(Promise.resolve(env.browser(url, env)).catch((e) => { env.browseErrors.push(e); }));
    },
    now: () => clock.now,
    log: safeLog((line) => logs.push(line)),
    policy: opts.policy ?? { allowInsecureLoopback: true },
    // the stand-in's endpoints, but the catalogue's real scopes and parameters
    specOverride: (id) => {
      if (!ids.includes(id)) return undefined;
      if (opts.spec) return opts.spec(id);
      const real = mcpCatalogEntry(id).spec.oauth;
      return idp.spec({ scope: real.scope, authorizeParams: real.authorizeParams });
    },
    portOverride: (id) => ports[id],
    timeouts: { timeoutMs: 5000, exchangeTimeoutMs: 5000, refreshMs: 2000, retryDelaysMs: [0, 0], cooldownMs: 50, revokeMs: 2000, ...(opts.timeouts ?? {}) },
    sleep: async (ms) => { env.sleeps.push(ms); },
    random: opts.random
  });
  t.after(() => { env.controller.dispose(); });
  return env;
}

/** Poll until a condition holds. */
async function until(fn, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await new Promise((r) => setTimeout(r, 5)); }
  throw new Error('timed out waiting for a condition');
}

/** Play the user's browser: follow the authorization URL to the provider, then hit wherever it redirects. */
async function browse(authUrl, env, { callbackHeaders = {}, callbackHost } = {}) {
  const r1 = await fetch(authUrl, { redirect: 'manual' });
  const location = r1.headers.get('location');
  if (!location) return { authorize: { status: r1.status, text: await r1.text() }, callback: null, location: null };
  const u = new URL(location);
  const cb = await rawGet(Number(u.port), `${u.pathname}${u.search}`, { headers: callbackHeaders, host: callbackHost });
  return { authorize: { status: r1.status }, callback: cb, location };
}

module.exports = { makeEnv, memorySecrets, freePort, rawGet, browse, until, loadTs };
