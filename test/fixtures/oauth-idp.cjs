'use strict';

/**
 * A stand-in OAuth provider for the in-app OAuth engine's tests — NOT a real one.
 *
 * It behaves the way a careful authorization server does, so the engine is tested
 * against something that actually refuses things:
 *
 *   GET  /authorize     validates client, EXACT redirect URI, S256 PKCE, state; answers 302
 *                       to the redirect URI with ?code&state&iss (or ?error)
 *   POST /token         authorization_code + refresh_token grants, client_secret_post,
 *                       PKCE verification, single-use codes (a replay is refused AND
 *                       revokes what the first use issued, RFC 6749 §4.1.2), code expiry,
 *                       optional refresh-token rotation, Slack-style envelope
 *   POST /revoke        Google style (form `token=`)
 *   POST /api/auth.revoke   Slack style (Bearer)
 *   POST /mcp           a protected MCP resource: valid, unexpired bearer or 401
 *
 * Everything it receives is recorded (`log`) so tests can assert what was and was not
 * sent: how many times a code was presented, that a client secret only ever travelled
 * in a token request body, that nothing was retried.
 *
 * Failures are injected per endpoint: `idp.inject('token', { status, body, delayMs, hang })`.
 */

const http = require('node:http');
const crypto = require('node:crypto');

const b64u = (b) => Buffer.from(b).toString('base64url');
const rand = (n = 24) => b64u(crypto.randomBytes(n));
const VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;
const s256 = (verifier) => b64u(crypto.createHash('sha256').update(verifier, 'ascii').digest());

async function startIdp(t, opts = {}) {
  const idp = {
    issuer: null,                          // set once listening
    style: opts.style ?? 'oauth2',         // 'oauth2' | 'slack'
    accessTtlSec: opts.accessTtlSec ?? 3600,
    rotate: opts.rotate ?? false,          // issue a new refresh token on every refresh
    issuerParam: opts.issuerParam ?? 'correct',   // 'correct' | 'wrong' | 'missing'
    stateParam: 'correct',                 // 'correct' | 'wrong' | 'missing'
    consent: 'approve',                    // 'approve' | 'deny' | 'error'
    codeTtlMs: opts.codeTtlMs ?? 60_000,
    clients: new Map(),                    // client_id -> { secret, redirectUris:Set }
    auths: new Map(),                      // code -> authorization
    grants: new Map(),                     // refresh token -> { clientId, scope, revoked }
    access: new Map(),                     // access token -> { clientId, exp, revoked, grant }
    log: [],                               // every request
    injected: new Map(),                   // endpoint -> [{...}]
    stats: { pkceFailures: 0, replayedCodes: 0, authorizeRejections: [] },
    now: () => Date.now(),
    addClient(id, secret, redirectUris) { idp.clients.set(id, { secret, redirectUris: new Set(redirectUris) }); },
    /** Queue a failure for the next request(s) to an endpoint ('token' | 'revoke' | 'authorize' | 'mcp'). */
    inject(endpoint, spec, times = 1) {
      const q = idp.injected.get(endpoint) ?? [];
      for (let i = 0; i < times; i++) q.push(spec);
      idp.injected.set(endpoint, q);
    },
    requests(path) { return idp.log.filter((r) => r.path === path); },
    tokenRequests(grant) { return idp.log.filter((r) => r.path === '/token' && (!grant || r.form.grant_type === grant)); },
    /** The spec the engine is given in place of the catalogue's (loopback http, test only). */
    spec(over = {}) {
      return {
        issuer: idp.issuer, authorizationEndpoint: `${idp.issuer}/authorize`, tokenEndpoint: `${idp.issuer}/token`,
        authorizeParams: opts.authorizeParams, issParameter: opts.issParameter ?? 'required',
        tokenResponse: idp.style === 'slack' ? 'slack' : 'oauth2', ...over
      };
    },
    revokeSpec() { return { url: `${idp.issuer}/revoke`, style: 'oauth2' }; },
    slackRevokeSpec() { return { url: `${idp.issuer}/api/auth.revoke`, style: 'slack' }; },
    /** Force-expire every access token (as if time had passed). */
    expireAll() { for (const a of idp.access.values()) a.exp = 0; },
    revokeGrant(refreshToken) { const g = idp.grants.get(refreshToken); if (g) g.revoked = true; },
    liveAccessTokens() { return [...idp.access.entries()].filter(([, a]) => !a.revoked && a.exp > idp.now()).map(([k]) => k); },
    close: () => new Promise((r) => server.close(() => r())),
    port: 0
  };

  const takeInjected = (endpoint) => idp.injected.get(endpoint)?.shift();
  const readBody = (req) => new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
  const json = (res, status, obj, extra = {}) => {
    const text = JSON.stringify(obj);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...extra });
    res.end(text);
  };
  const oauthError = (res, status, error, extra = {}) =>
    idp.style === 'slack' ? json(res, 200, { ok: false, error }) : json(res, status, { error, error_description: `secret-looking description ${rand(6)}`, ...extra });

  async function applyInjection(endpoint, res) {
    const inj = takeInjected(endpoint);
    if (!inj) return false;
    if (inj.delayMs) await new Promise((r) => setTimeout(r, inj.delayMs));
    if (inj.hang) { return true; }                              // never answers
    if (inj.destroy) { res.socket.destroy(); return true; }
    if (inj.redirect) { res.writeHead(302, { location: inj.redirect }); res.end(); return true; }
    if (inj.raw !== undefined) { res.writeHead(inj.status ?? 200, { 'content-type': 'application/json' }); res.end(inj.raw); return true; }
    if (inj.status) { json(res, inj.status, inj.body ?? {}); return true; }
    return false;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const body = req.method === 'POST' ? await readBody(req) : '';
    const form = Object.fromEntries(new URLSearchParams(body));
    idp.log.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), form, headers: { ...req.headers }, rawBody: body });

    // ── authorization endpoint ───────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/authorize') {
      if (await applyInjection('authorize', res)) return;
      const q = url.searchParams;
      const reject = (why) => { idp.stats.authorizeRejections.push(why); json(res, 400, { error: 'invalid_request', why }); };
      const client = idp.clients.get(q.get('client_id'));
      if (!client) return reject('unknown client');
      const redirectUri = q.get('redirect_uri');
      if (!client.redirectUris.has(redirectUri)) return reject('redirect_uri does not match a registered one exactly');
      if (q.get('response_type') !== 'code') return reject('response_type');
      if (q.get('code_challenge_method') !== 'S256') return reject('only S256 is accepted');
      if (!/^[A-Za-z0-9_-]{43}$/.test(q.get('code_challenge') ?? '')) return reject('code_challenge shape');
      if (!q.get('state')) return reject('state is required');
      const back = new URL(redirectUri);
      if (idp.consent === 'deny') back.searchParams.set('error', 'access_denied');
      else if (idp.consent === 'error') back.searchParams.set('error', 'server_error');
      else {
        const code = `4/${rand(24)}`;
        idp.auths.set(code, {
          clientId: q.get('client_id'), redirectUri, challenge: q.get('code_challenge'), scope: q.get('scope') ?? '',
          createdAt: idp.now(), used: false, issued: null, requested: Object.fromEntries(q)
        });
        back.searchParams.set('code', code);
      }
      if (idp.stateParam === 'correct') back.searchParams.set('state', q.get('state'));
      else if (idp.stateParam === 'wrong') back.searchParams.set('state', 'not-the-state-you-sent');
      if (idp.issuerParam === 'correct') back.searchParams.set('iss', idp.issuer);
      else if (idp.issuerParam === 'wrong') back.searchParams.set('iss', 'https://evil.example');
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }

    // ── token endpoint ───────────────────────────────────────────────────
    if (req.method === 'POST' && url.pathname === '/token') {
      if (await applyInjection('token', res)) return;
      const client = idp.clients.get(form.client_id);
      if (!client || client.secret !== form.client_secret) return oauthError(res, 401, 'invalid_client');
      const issue = (grant, scope, sourceAuth) => {
        const access = `at-${rand(20)}`;
        idp.access.set(access, { clientId: form.client_id, exp: idp.now() + idp.accessTtlSec * 1000, revoked: false, grant });
        if (sourceAuth) { sourceAuth.issued = { access, refresh: grant }; }
        const tokens = { access_token: access, token_type: idp.style === 'slack' ? 'user' : 'Bearer', expires_in: idp.accessTtlSec, scope };
        return tokens;
      };
      if (form.grant_type === 'authorization_code') {
        const auth = idp.auths.get(form.code);
        if (!auth) return oauthError(res, 400, 'invalid_grant');
        if (auth.used) {
          idp.stats.replayedCodes++;
          // RFC 6749 §4.1.2: a replayed code revokes what the first use issued
          if (auth.issued) { const a = idp.access.get(auth.issued.access); if (a) a.revoked = true; const g = idp.grants.get(auth.issued.refresh); if (g) g.revoked = true; }
          return oauthError(res, 400, 'invalid_grant');
        }
        auth.used = true;                                                   // single use, success or not
        if (auth.clientId !== form.client_id) return oauthError(res, 400, 'invalid_grant');
        if (form.redirect_uri !== auth.redirectUri) return oauthError(res, 400, 'invalid_grant');
        if (idp.now() - auth.createdAt > idp.codeTtlMs) return oauthError(res, 400, 'invalid_grant');
        if (!VERIFIER_RE.test(form.code_verifier ?? '') || s256(form.code_verifier) !== auth.challenge) {
          idp.stats.pkceFailures++;
          return oauthError(res, 400, 'invalid_grant');
        }
        const refresh = `rt-${rand(24)}`;
        idp.grants.set(refresh, { clientId: form.client_id, scope: auth.scope, revoked: false });
        const out = issue(refresh, auth.scope, auth);
        out.refresh_token = refresh;
        return json(res, 200, idp.style === 'slack' ? { ok: true, ...out } : out);
      }
      if (form.grant_type === 'refresh_token') {
        const grant = idp.grants.get(form.refresh_token);
        if (!grant || grant.revoked || grant.clientId !== form.client_id) return oauthError(res, 400, 'invalid_grant');
        let refresh = form.refresh_token;
        if (idp.rotate) {
          grant.revoked = true;
          refresh = `rt-${rand(24)}`;
          idp.grants.set(refresh, { clientId: grant.clientId, scope: grant.scope, revoked: false });
        }
        const out = issue(refresh, grant.scope, null);
        if (idp.rotate) out.refresh_token = refresh;
        return json(res, 200, idp.style === 'slack' ? { ok: true, ...out } : out);
      }
      return oauthError(res, 400, 'unsupported_grant_type');
    }

    // ── revocation ───────────────────────────────────────────────────────
    if (req.method === 'POST' && url.pathname === '/revoke') {
      if (await applyInjection('revoke', res)) return;
      const token = form.token;
      const g = idp.grants.get(token);
      if (g && !g.revoked) {
        g.revoked = true;
        for (const a of idp.access.values()) if (a.grant === token) a.revoked = true;   // revoking the grant kills its access tokens
        return json(res, 200, {});
      }
      const a = idp.access.get(token);
      if (a && !a.revoked) { a.revoked = true; return json(res, 200, {}); }
      return json(res, 400, { error: 'invalid_token' });
    }
    if (req.method === 'POST' && url.pathname === '/api/auth.revoke') {
      if (await applyInjection('revoke', res)) return;
      const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      const a = idp.access.get(token);
      if (a && !a.revoked) { a.revoked = true; return json(res, 200, { ok: true, revoked: true }); }
      const g = idp.grants.get(token);
      if (g && !g.revoked) { g.revoked = true; return json(res, 200, { ok: true, revoked: true }); }
      return json(res, 200, { ok: false, error: 'invalid_auth' });
    }

    // ── a protected MCP resource ─────────────────────────────────────────
    if (url.pathname === '/mcp') {
      if (await applyInjection('mcp', res)) return;
      const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      const a = idp.access.get(token);
      if (!a || a.revoked || a.exp <= idp.now()) {
        res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer error="invalid_token"' });
        return res.end('{"error":"invalid_token"}');
      }
      let rpc = {};
      try { rpc = JSON.parse(body || '{}'); } catch { /* not json */ }
      if (rpc.method === 'tools/list') return json(res, 200, { jsonrpc: '2.0', id: rpc.id, result: { tools: [{ name: 'search', annotations: { readOnlyHint: true } }, { name: 'send', annotations: { destructiveHint: true } }] } });
      return json(res, 200, { jsonrpc: '2.0', id: rpc.id ?? null, result: { ok: true } });
    }

    res.writeHead(404); res.end();
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  idp.port = server.address().port;
  idp.issuer = `http://127.0.0.1:${idp.port}`;
  t.after(() => idp.close());
  return idp;
}

module.exports = { startIdp, s256, VERIFIER_RE };
