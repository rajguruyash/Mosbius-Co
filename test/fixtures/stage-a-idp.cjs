'use strict';

/**
 * A stand-in authorization server plus MCP resource for the Stage A spike tool's tests. NOT a real
 * provider: every answer here is what the tests chose, and a pass against it proves only that the spike
 * behaves, never anything about Notion, GitHub or Google.
 *
 * It can be switched to misbehave the ways real providers do:
 *   dcr:            'open' | 'no-http-loopback' (rejects http redirect URIs) | 'none' (no registration endpoint)
 *   tokenAuth:      'none' (public clients accepted) | 'secret-required' (a secret is demanded, as Google's
 *                   Desktop clients may do) — for DCR clients it ISSUES a secret, then demands it
 *   rotate / reuseDetection:   refresh tokens are single use; presenting an old one kills the grant
 *   revokeKillsAccess:         false = revocation is accepted but access tokens keep working
 *   issParam / stateParam:     'correct' | 'wrong' | 'missing' on the redirect
 *   sse:            the MCP resource answers as text/event-stream
 *   evilTokenHost:  the metadata points the token endpoint at another host
 * Everything it receives is recorded in `log` so a test can assert what was and was not sent.
 */

const http = require('node:http');
const crypto = require('node:crypto');

const b64u = (b) => Buffer.from(b).toString('base64url');
const rand = (n = 24) => b64u(crypto.randomBytes(n));
const s256 = (v) => b64u(crypto.createHash('sha256').update(v, 'ascii').digest());
const VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;

const SENTINEL = 'SENTINEL-USER-DATA-4f9c1d';

async function startStageAIdp(t, opts = {}) {
  const o = {
    dcr: 'open', tokenAuth: 'none', rotate: false, reuseDetection: false, revokeKillsAccess: true, revocation: true,
    issSupported: true, issParam: 'correct', stateParam: 'correct', sse: false, evilTokenHost: false,
    registrationManagement: true, expiresIn: 3600, ...opts
  };
  const idp = {
    base: '', host: '', port: 0,
    clients: new Map(),      // client_id -> { secret, redirectUris:Set, loopbackAnyPort, path }
    codes: new Map(), grants: new Map(), access: new Map(), regTokens: new Map(),
    log: [], mcpCalls: [], sessions: new Set(),
    device: { mode: 'ok', pendingPolls: 2, slowDownOnPoll: 1, polls: 0, deviceCode: null, expiring: false, secretForRefresh: false },
    opts: o,
    set(k, v) { o[k] = v; },
    addClient({ id, secret = null, redirectUris = [], loopbackAnyPort = false, path = '/oauth/callback' }) {
      idp.clients.set(id, { secret, redirectUris: new Set(redirectUris), loopbackAnyPort, path });
    },
    requests(pathname) { return idp.log.filter((r) => r.path === pathname); },
    liveAccess() { return [...idp.access.entries()].filter(([, a]) => !a.revoked && a.exp > Date.now()).map(([k]) => k); },
    secretsSeen() { return [...idp.access.keys(), ...idp.grants.keys()]; },
    // Every tool carries a description and an inputSchema, as every real server's tools do: the MCP schema
    // requires it, Claude Code tolerates its absence and Codex does not (its typed client rejects the whole list).
    tools: [
      { name: 'search', description: 'search', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
      { name: 'fetch', description: 'fetch', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
      { name: 'create_page', description: 'create_page', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: false, destructiveHint: false } },
      { name: 'delete_page', description: 'delete_page', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: false, destructiveHint: true } },
      { name: 'mystery', description: 'mystery', inputSchema: { type: 'object', properties: {} } }
    ],
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); })
  };

  const readBody = (req) => new Promise((resolve) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => resolve(Buffer.concat(c).toString('utf8'))); });
  const json = (res, status, obj, extra = {}) => { const text = JSON.stringify(obj); res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...extra }); res.end(text); };
  const oerr = (res, status, error, description) => json(res, status, { error, ...(description ? { error_description: description } : {}) });

  const issueTokens = (grantKey, clientId, scope, withRefresh = true) => {
    const access = `at-${rand(20)}`;
    idp.access.set(access, { clientId, exp: Date.now() + o.expiresIn * 1000, revoked: false, grant: grantKey });
    const out = { access_token: access, token_type: 'Bearer', expires_in: o.expiresIn, scope };
    if (withRefresh) out.refresh_token = grantKey;
    return out;
  };
  const killGrant = (key) => { const g = idp.grants.get(key); if (g) g.revoked = true; for (const a of idp.access.values()) if (a.grant === key) a.revoked = true; };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const body = req.method === 'GET' ? '' : await readBody(req);
    const form = /json/.test(req.headers['content-type'] || '') ? {} : Object.fromEntries(new URLSearchParams(body));
    idp.log.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), form, headers: { ...req.headers }, rawBody: body });
    const p = url.pathname;

    // ── discovery ────────────────────────────────────────────────────────
    if (req.method === 'GET' && (p === '/.well-known/oauth-protected-resource' || p === '/.well-known/oauth-protected-resource/mcp')) {
      if (o.noResourceMetadata) { res.writeHead(404); return res.end(); }
      return json(res, 200, { resource: `${idp.base}`, authorization_servers: [idp.base], scopes_supported: ['default'] });
    }
    if (req.method === 'GET' && p === '/.well-known/oauth-authorization-server') {
      const meta = {
        issuer: idp.base, authorization_endpoint: `${idp.base}/authorize`,
        token_endpoint: o.evilTokenHost ? 'https://evil.example/token' : `${idp.base}/token`,
        code_challenge_methods_supported: ['S256'], grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: o.tokenAuth === 'none' ? ['none', 'client_secret_post'] : ['client_secret_post'],
        authorization_response_iss_parameter_supported: o.issSupported, scopes_supported: ['default']
      };
      if (o.dcr !== 'none') meta.registration_endpoint = `${idp.base}/register`;
      if (o.revocation) meta.revocation_endpoint = `${idp.base}/revoke`;
      return json(res, 200, meta);
    }

    // ── registration (RFC 7591 and 7592) ──────────────────────────────────
    if (p === '/register' && req.method === 'POST') {
      if (o.dcr === 'none') { res.writeHead(404); return res.end(); }
      let reg; try { reg = JSON.parse(body); } catch { return oerr(res, 400, 'invalid_client_metadata'); }
      if (!Array.isArray(reg.redirect_uris) || reg.redirect_uris.length === 0) return oerr(res, 400, 'invalid_redirect_uri');
      if (o.dcr === 'no-http-loopback' && reg.redirect_uris.some((u) => u.startsWith('http://'))) return oerr(res, 400, 'invalid_redirect_uri', 'redirect URIs must use https');
      const id = `client-${rand(9)}`;
      const secret = o.tokenAuth === 'secret-required' ? `secret-${rand(12)}` : null;
      idp.clients.set(id, { secret, redirectUris: new Set(reg.redirect_uris), loopbackAnyPort: false, path: null, dcr: true });
      const out = {
        client_id: id, client_id_issued_at: Math.floor(Date.now() / 1000), redirect_uris: reg.redirect_uris,
        grant_types: reg.grant_types, response_types: reg.response_types, token_endpoint_auth_method: secret ? 'client_secret_post' : 'none'
      };
      if (secret) { out.client_secret = secret; out.client_secret_expires_at = 0; }
      if (o.registrationManagement) {
        const rat = `rat-${rand(18)}`;
        idp.regTokens.set(id, rat);
        out.registration_access_token = rat;
        out.registration_client_uri = `${idp.base}/register/${id}`;
      }
      return json(res, 201, out);
    }
    if (p.startsWith('/register/') && req.method === 'DELETE') {
      const id = p.slice('/register/'.length);
      if ((req.headers.authorization || '') !== `Bearer ${idp.regTokens.get(id)}`) { res.writeHead(401); return res.end(); }
      idp.clients.delete(id); idp.regTokens.delete(id);
      res.writeHead(204); return res.end();
    }

    // ── authorize ─────────────────────────────────────────────────────────
    if (p === '/authorize' && req.method === 'GET') {
      const q = url.searchParams;
      const reject = (why) => json(res, 400, { error: 'invalid_request', why });
      const client = idp.clients.get(q.get('client_id'));
      if (!client) return reject('unknown client');
      const redirectUri = q.get('redirect_uri') || '';
      let okRedirect = client.redirectUris.has(redirectUri);
      if (!okRedirect && client.loopbackAnyPort) {
        try { const u = new URL(redirectUri); okRedirect = u.protocol === 'http:' && u.hostname === '127.0.0.1' && u.pathname === client.path; } catch { /* no */ }
      }
      if (!okRedirect) return reject('redirect_uri');
      if (q.get('response_type') !== 'code' || q.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(q.get('code_challenge') || '') || !q.get('state')) return reject('request');
      const code = `code-${rand(20)}`;
      idp.codes.set(code, { clientId: q.get('client_id'), redirectUri, challenge: q.get('code_challenge'), scope: q.get('scope') || '', used: false, resource: q.get('resource') });
      const back = new URL(redirectUri);
      if (o.consent === 'deny') back.searchParams.set('error', 'access_denied'); else back.searchParams.set('code', code);
      if (o.stateParam === 'correct') back.searchParams.set('state', q.get('state'));
      else if (o.stateParam === 'wrong') back.searchParams.set('state', 'not-the-state-you-sent');
      if (o.issParam === 'correct') back.searchParams.set('iss', idp.base);
      else if (o.issParam === 'wrong') back.searchParams.set('iss', 'https://evil.example');
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }

    // ── token ─────────────────────────────────────────────────────────────
    if (p === '/token' && req.method === 'POST') {
      const client = idp.clients.get(form.client_id);
      if (!client) return oerr(res, 401, 'invalid_client');
      if (client.secret) {
        if (!form.client_secret) return oerr(res, 400, o.dcr === 'open' && client.dcr ? 'invalid_client' : 'invalid_request', 'client_secret is missing.');
        if (form.client_secret !== client.secret) return oerr(res, 401, 'invalid_client');
      }
      if (form.grant_type === 'authorization_code') {
        const c = idp.codes.get(form.code);
        if (!c || c.used || c.clientId !== form.client_id || c.redirectUri !== form.redirect_uri) return oerr(res, 400, 'invalid_grant');
        c.used = true;
        if (!VERIFIER_RE.test(form.code_verifier || '') || s256(form.code_verifier) !== c.challenge) return oerr(res, 400, 'invalid_grant');
        const key = `rt-${rand(24)}`;
        idp.grants.set(key, { clientId: form.client_id, scope: c.scope, revoked: false, resource: form.resource });
        return json(res, 200, issueTokens(key, form.client_id, c.scope));
      }
      if (form.grant_type === 'refresh_token') {
        const g = idp.grants.get(form.refresh_token);
        if (!g || g.clientId !== form.client_id) return oerr(res, 400, 'invalid_grant');
        if (g.revoked) {
          if (o.reuseDetection && g.rotatedAway) killGrant(g.successor);
          return oerr(res, 400, 'invalid_grant');
        }
        if (o.rotate) {
          g.revoked = true;
          const next = `rt-${rand(24)}`;
          g.rotatedAway = true; g.successor = next;
          idp.grants.set(next, { clientId: g.clientId, scope: g.scope, revoked: false, resource: form.resource });
          return json(res, 200, issueTokens(next, g.clientId, g.scope));
        }
        return json(res, 200, issueTokens(form.refresh_token, g.clientId, g.scope, false));
      }
      return oerr(res, 400, 'unsupported_grant_type');
    }
    if (p === '/revoke' && req.method === 'POST') {
      const g = idp.grants.get(form.token);
      if (g && !g.revoked) { if (o.revokeKillsAccess) killGrant(form.token); else g.revoked = true; return json(res, 200, {}); }
      const a = idp.access.get(form.token);
      if (a && !a.revoked) { if (o.revokeKillsAccess) a.revoked = true; return json(res, 200, {}); }
      return json(res, 200, {});
    }

    // ── device flow (GitHub-shaped) ───────────────────────────────────────
    if (p === '/login/device/code' && req.method === 'POST') {
      if (idp.device.mode === 'disabled') return json(res, 200, { error: 'device_flow_disabled' });
      idp.device.deviceCode = `dc-${rand(20)}`; idp.device.polls = 0;
      return json(res, 200, { device_code: idp.device.deviceCode, user_code: 'ABCD-1234', verification_uri: `${idp.base}/login/device`, expires_in: 900, interval: 5 });
    }
    if (p === '/login/oauth/access_token' && req.method === 'POST') {
      if (form.grant_type === 'refresh_token') {
        const g = idp.grants.get(form.refresh_token);
        if (!g || g.revoked) return json(res, 200, { error: 'bad_refresh_token' });
        if (idp.device.secretForRefresh && !form.client_secret) return json(res, 200, { error: 'incorrect_client_credentials' });
        const next = `rt-${rand(24)}`; g.revoked = true;
        idp.grants.set(next, { clientId: g.clientId, scope: g.scope, revoked: false });
        return json(res, 200, issueTokens(next, g.clientId, g.scope));
      }
      if (form.device_code !== idp.device.deviceCode) return json(res, 200, { error: 'bad_verification_code' });
      idp.device.polls++;
      if (idp.device.mode === 'denied') return json(res, 200, { error: 'access_denied' });
      if (idp.device.mode === 'expired') return json(res, 200, { error: 'expired_token' });
      if (idp.device.polls === idp.device.slowDownOnPoll) return json(res, 200, { error: 'slow_down', interval: 10 });
      if (idp.device.polls <= idp.device.pendingPolls) return json(res, 200, { error: 'authorization_pending' });
      const key = `rt-${rand(24)}`;
      idp.grants.set(key, { clientId: form.client_id, scope: 'repo', revoked: false });
      return json(res, 200, issueTokens(key, form.client_id, 'repo', idp.device.expiring));
    }

    // ── the MCP resource ──────────────────────────────────────────────────
    // The streamable-HTTP transport's other two verbs, answered as the spec says a server without a
    // server-to-client stream answers them: GET is "405 Method Not Allowed", DELETE ends the session.
    // (An earlier version of this stand-in answered 404 to both. Claude Code does not mind; Codex reads a 404
    // on a live session as "session expired" and starts over, which no real server would provoke.)
    if (p === '/mcp' && (req.method === 'GET' || req.method === 'DELETE')) {
      const token = (req.headers.authorization || '').replace(/^Bearer /, '');
      const a = idp.access.get(token);
      if (!a || a.revoked || a.exp <= Date.now()) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"error":"invalid_token"}'); }
      if (req.method === 'GET') { res.writeHead(405, { allow: 'POST, DELETE' }); return res.end(); }
      const sid = req.headers['mcp-session-id'];
      if (sid && idp.sessions.delete(sid)) { res.writeHead(204); return res.end(); }
      res.writeHead(404); return res.end();
    }
    if (p === '/mcp' && req.method === 'POST') {
      const token = (req.headers.authorization || '').replace(/^Bearer /, '');
      const a = idp.access.get(token);
      if (!a || a.revoked || a.exp <= Date.now()) {
        res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': o.noResourceMetadata ? 'Bearer realm="OAuth"' : `Bearer resource_metadata="${idp.base}/.well-known/oauth-protected-resource"` });
        return res.end('{"error":"invalid_token"}');
      }
      let rpc = {}; try { rpc = JSON.parse(body); } catch { /* not json */ }
      idp.mcpCalls.push({ method: rpc.method, session: req.headers['mcp-session-id'], version: req.headers['mcp-protocol-version'], params: rpc.params });
      const reply = (obj, extra = {}) => {
        if (o.sse) { const text = `event: message\ndata: ${JSON.stringify(obj)}\n\n`; res.writeHead(200, { 'content-type': 'text/event-stream', ...extra }); return res.end(text); }
        return json(res, 200, obj, extra);
      };
      if (rpc.method === 'initialize') { const sid = `sess-${rand(8)}`; idp.sessions.add(sid); return reply({ jsonrpc: '2.0', id: rpc.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'stand-in', version: '1' } } }, { 'mcp-session-id': sid }); }
      if (rpc.method === 'notifications/initialized') { res.writeHead(202); return res.end(); }
      if (rpc.method === 'tools/list') return reply({ jsonrpc: '2.0', id: rpc.id, result: { tools: idp.tools } });
      if (rpc.method === 'tools/call') return reply({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: SENTINEL }] } });
      return reply({ jsonrpc: '2.0', id: rpc.id ?? null, error: { code: -32601, message: 'Method not found' } });
    }

    res.writeHead(404); res.end();
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  idp.port = server.address().port;
  idp.host = `127.0.0.1:${idp.port}`;
  idp.base = `http://${idp.host}`;
  t.after(() => idp.close());
  return idp;
}

module.exports = { startStageAIdp, SENTINEL, s256 };
