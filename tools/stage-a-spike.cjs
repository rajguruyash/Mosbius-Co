#!/usr/bin/env node
'use strict';

/**
 * Stage A: external verification spikes. This is NOT product code and nothing here is wired into the app.
 * It exists to answer, against the real providers, the questions the design could not answer from
 * documents: does a public client work without a secret, does the loopback redirect work, does a
 * refresh rotate, does revocation take effect, what do the real tool lists look like.
 *
 *   node tools/stage-a-spike.cjs metadata [provider ...]
 *       Public GETs and one unauthenticated MCP `initialize` per provider. Registers nothing, signs in to
 *       nothing, needs no account. Safe to run any time.
 *
 *   node tools/stage-a-spike.cjs dcr <provider> [--tool NAME] [--args JSON] [--reuse-probe] [--no-open] [--wait MINUTES] [--evidence FILE]
 *       Self-registering OAuth (RFC 7591). REGISTERS A CLIENT at the provider and needs a real sign-in that
 *       YOU complete in the browser. Run it only after you have said yes to that provider.
 *
 *   node tools/stage-a-spike.cjs device github --client-id ID [--tool NAME] [--args JSON] [--evidence FILE]
 *       Device flow (RFC 8628) with an app YOU created. Needs the app's public client id only.
 *
 *   node tools/stage-a-spike.cjs pkce google-calendar --client-id ID [--secret none|prompt] [--tool NAME] [--args JSON] [--redirect-port N]
 *       Authorization code + PKCE with a client YOU created. `--secret prompt` asks for the client secret at a
 *       hidden prompt (it needs a terminal); it is never an argument, never in the environment, never printed.
 *
 * Rules it keeps, each pinned by test/stage-a-spike.test.cjs:
 *   - It talks only to the hosts a provider is pinned to, over https. A metadata document that points
 *     anywhere else is refused before anything is sent.
 *   - Tokens, codes, verifiers and states live in memory for the length of one run. Nothing is written to disk
 *     except an evidence file of FACTS (status codes, field NAMES, lifetimes, tool names), which is scanned for
 *     every secret the run saw before it is written.
 *   - It prints what a call returned only as a count of items and bytes, never the content: the content is your
 *     data, and nobody needs to read it to know the call worked.
 *   - A tool is called only if you name it, and only if the server says it is read-only (or you pass
 *     --allow-unannotated for a tool the server did not describe). A tool that writes is never called.
 *   - The run ends by revoking what it can and says plainly what it could not revoke.
 *
 * Exit code: 0 only if every required step passed; 1 if any failed; 2 for a usage or setup error.
 */

const fs = require('node:fs');
const http = require('node:http');
const { spawn } = require('node:child_process');
const loadTs = require('../test/load-ts.cjs');

const { newCodeVerifier, challengeS256, newState, constantTimeEqual } = loadTs('src/main/oauth/pkce.ts');
const { formBody, parseJsonObject } = loadTs('src/main/oauth/http.ts');

const CLIENT_NAME = 'Mosbius & Co (Stage A test)';
const PROTOCOL = '2025-06-18';
const MAX_BODY = 1024 * 1024;
const MAX_PARAM = 2048;

/** What each provider is pinned to. Hosts are matched exactly; anything else is refused. */
const PROVIDERS = {
  notion:    { strategy: 'dcr', label: 'Notion',    mcp: 'https://mcp.notion.com/mcp',      hosts: ['mcp.notion.com'] },
  linear:    { strategy: 'dcr', label: 'Linear',    mcp: 'https://mcp.linear.app/mcp',      hosts: ['mcp.linear.app'] },
  sentry:    { strategy: 'dcr', label: 'Sentry',    mcp: 'https://mcp.sentry.dev/mcp',      hosts: ['mcp.sentry.dev'] },
  // Stripe's own resource metadata (served from the pinned mcp.stripe.com) names access.stripe.com/mcp as its authorization server.
  stripe:    { strategy: 'dcr', label: 'Stripe',    mcp: 'https://mcp.stripe.com',          hosts: ['mcp.stripe.com', 'access.stripe.com'] },
  // Atlassian serves no resource metadata at all (checked 2026-11-15); mcp.atlassian.com is itself the authorization server.
  atlassian: { strategy: 'dcr', label: 'Atlassian', mcp: 'https://mcp.atlassian.com/v1/mcp', hosts: ['mcp.atlassian.com'], authorizationServer: 'https://mcp.atlassian.com' },
  // Slack is listed so its public metadata can be read; a live run needs an app only its owner can create and
  // approve, and the PKCE opt-in is one-way, so there is no live strategy for it here.
  slack:     { strategy: 'byo', label: 'Slack', mcp: 'https://mcp.slack.com/mcp', hosts: ['mcp.slack.com', 'slack.com'] },
  github: {
    strategy: 'device', label: 'GitHub', mcp: 'https://api.githubcopilot.com/mcp/',
    hosts: ['api.githubcopilot.com', 'github.com', 'api.github.com'],
    deviceEndpoint: 'https://github.com/login/device/code',
    tokenEndpoint: 'https://github.com/login/oauth/access_token',
    scope: 'repo read:org'
  },
  'google-calendar': {
    strategy: 'pkce', label: 'Google Calendar', mcp: 'https://calendarmcp.googleapis.com/mcp/v1',
    hosts: ['calendarmcp.googleapis.com', 'accounts.google.com', 'oauth2.googleapis.com'],
    issuer: 'https://accounts.google.com',
    authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenEndpoint: 'https://oauth2.googleapis.com/token',
    revokeEndpoint: 'https://oauth2.googleapis.com/revoke',
    authorizeParams: { access_type: 'offline', prompt: 'consent' },
    issRequired: true,
    scope: 'https://www.googleapis.com/auth/calendar.calendarlist.readonly '
      + 'https://www.googleapis.com/auth/calendar.events.freebusy '
      + 'https://www.googleapis.com/auth/calendar.events.readonly'
  }
};

class Refused extends Error {}

// ─── what is said, what is kept, and what must never appear in either ───────

function makeRecorder(out = (l) => console.log(l)) {
  const secrets = new Map();                     // value -> what it is
  const lines = [];
  const steps = [];
  const facts = {};
  let blocked = 0;
  const track = (label, value) => { if (typeof value === 'string' && value.length >= 8) secrets.set(value, label); return value; };
  const found = (text) => [...secrets].filter(([v]) => text.includes(v)).map(([, label]) => label);
  const scrub = (text) => { let t = String(text); for (const [v] of secrets) if (t.includes(v)) t = t.split(v).join('«withheld»'); return t; };
  const say = (line) => {
    const raw = String(line);
    if (found(raw).length > 0) blocked++;
    const safe = scrub(raw);
    lines.push(safe);
    out(safe);
  };
  const step = (id, status, detail) => {
    steps.push({ id, status, detail: scrub(detail ?? '') });
    say(`  ${status.padEnd(4)}  ${id}${detail ? `  — ${detail}` : ''}`);
  };
  /** For the one thing that has to be shown whole: the authorization address the user opens by hand.
   *  It carries a PKCE challenge and a state, which are not credentials, and nothing else. It is neither
   *  scanned nor kept in `lines`, and the state is tracked only after it has been shown. */
  const raw = (line) => out(String(line));
  return { track, found, scrub, say, raw, step, steps, facts, lines, get blocked() { return blocked; } };
}

// ─── http: no redirects, a hard timeout, a capped body, never a throw ───────

async function httpRaw(url, init = {}, { timeoutMs = 20_000, maxBytes = MAX_BODY, fetchFn = globalThis.fetch } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, { ...init, redirect: 'manual', signal: ac.signal });
    let text = '';
    const reader = res.body && typeof res.body.getReader === 'function' ? res.body.getReader() : null;
    if (reader) {
      const chunks = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) { try { await reader.cancel(); } catch { /* noop */ } return { ok: false, status: res.status, headers: res.headers, text: '', error: 'too-large' }; }
        chunks.push(Buffer.from(value));
      }
      text = Buffer.concat(chunks).toString('utf8');
    } else {
      text = await res.text();
    }
    return { ok: true, status: res.status, headers: res.headers, text };
  } catch (e) {
    return { ok: false, status: 0, headers: new Headers(), text: '', error: e && e.name === 'AbortError' ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}

/** Which addresses a run may talk to. Production: https and a pinned host. Tests: the stand-in's loopback. */
function makePolicy(provider, deps = {}) {
  const allowLoopback = deps.insecureLoopbackForTests === true;
  return {
    check(url, what) {
      let u;
      try { u = new URL(url); } catch { throw new Refused(`${what}: not an address`); }
      const loop = allowLoopback && u.protocol === 'http:' && u.hostname === '127.0.0.1';
      if (!loop && u.protocol !== 'https:') throw new Refused(`${what}: only https is used`);
      if (u.username || u.password) throw new Refused(`${what}: an address with credentials in it`);
      if (!provider.hosts.includes(u.host) && !provider.hosts.includes(u.hostname)) {
        throw new Refused(`${what}: host ${u.hostname} is not one of ${provider.label}'s`);
      }
      return u;
    }
  };
}

const INIT_BODY = (id = 1) => JSON.stringify({
  jsonrpc: '2.0', id, method: 'initialize',
  params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'mosbius-stage-a', version: '0' } }
});

function parseRpc(text, contentType, id) {
  if (!text) return null;
  if (/text\/event-stream/i.test(contentType || '')) {
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
      if (!data) continue;
      const obj = parseJsonObject(data);
      if (obj && (id === undefined || obj.id === id)) return obj;
    }
    return null;
  }
  return parseJsonObject(text);
}

// ─── discovery (RFC 9728 and RFC 8414), pinned ──────────────────────────────

async function getJson(ctx, url, what) {
  ctx.policy.check(url, what);
  const r = await ctx.http(url, { method: 'GET', headers: { accept: 'application/json' } });
  const obj = r.status === 200 ? parseJsonObject(r.text) : null;
  return { status: r.status, obj, error: r.error };
}

async function discover(p, ctx) {
  const { rec, policy } = ctx;
  const mcp = policy.check(p.mcp, 'the MCP address');
  const r0 = await ctx.http(p.mcp, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: INIT_BODY() });
  const www = r0.headers.get('www-authenticate') || '';
  const named = /resource_metadata="([^"]+)"/.exec(www);
  rec.step('discover.unauthenticated', r0.status === 401 ? 'PASS' : 'INFO',
    `an unauthenticated initialize answers HTTP ${r0.status || r0.error}; ${named ? 'its WWW-Authenticate names the resource metadata' : 'it does not name the resource metadata'}`);

  const base = `${mcp.protocol}//${mcp.host}`;
  const pathPart = mcp.pathname.replace(/\/$/, '');
  const candidates = [];
  if (named) { try { policy.check(named[1], 'resource_metadata'); candidates.push(named[1]); } catch (e) { rec.step('discover.resource_metadata', 'WARN', `ignored: ${e.message}`); } }
  if (pathPart) candidates.push(`${base}/.well-known/oauth-protected-resource${pathPart}`);
  candidates.push(`${base}/.well-known/oauth-protected-resource`);
  let rs = null;
  for (const u of candidates) { const r = await getJson(ctx, u, 'resource metadata'); if (r.obj) { rs = r.obj; break; } }
  let synthesized = false;
  if (!rs && p.authorizationServer) { rs = { resource: p.mcp, authorization_servers: [p.authorizationServer] }; synthesized = true; }
  rec.step('discover.resource', rs ? (synthesized ? 'INFO' : 'PASS') : 'FAIL',
    rs ? (synthesized ? 'the server publishes no resource metadata; the pinned authorization server is used instead' : `resource metadata found; scopes_supported: ${JSON.stringify(rs.scopes_supported ?? null)}`) : 'no resource metadata document was served');
  if (!rs) return { ok: false };

  const issuerFromRs = Array.isArray(rs.authorization_servers) && typeof rs.authorization_servers[0] === 'string' ? rs.authorization_servers[0] : base;
  const issuerUrl = policy.check(issuerFromRs, 'authorization server');
  const issuerBase = `${issuerUrl.protocol}//${issuerUrl.host}`;
  const issuerPath = issuerUrl.pathname.replace(/\/$/, '');
  const asCandidates = [
    `${issuerBase}/.well-known/oauth-authorization-server${issuerPath}`,
    `${issuerBase}${issuerPath}/.well-known/openid-configuration`,
    `${issuerBase}/.well-known/openid-configuration${issuerPath}`
  ];
  let as = null;
  for (const u of asCandidates) { const r = await getJson(ctx, u, 'authorization server metadata'); if (r.obj) { as = r.obj; break; } }
  rec.step('discover.authorization_server', as ? 'PASS' : 'FAIL', as ? 'authorization server metadata found' : 'no authorization server metadata was served');
  if (!as) return { ok: false };

  const sameIssuer = typeof as.issuer === 'string' && as.issuer.replace(/\/$/, '') === issuerFromRs.replace(/\/$/, '');
  rec.step('discover.issuer', sameIssuer ? 'PASS' : 'FAIL', sameIssuer ? 'the issuer in the metadata is the one that was asked' : 'the issuer in the metadata is not the one that was asked');
  if (!sameIssuer) return { ok: false };

  const endpoints = {};
  for (const k of ['authorization_endpoint', 'token_endpoint', 'registration_endpoint', 'revocation_endpoint']) {
    if (typeof as[k] !== 'string') continue;
    try { policy.check(as[k], k); endpoints[k] = as[k]; } catch (e) { rec.step(`discover.${k}`, 'FAIL', e.message); return { ok: false }; }
  }
  const methods = Array.isArray(as.token_endpoint_auth_methods_supported) ? as.token_endpoint_auth_methods_supported : [];
  const facts = {
    issuer: as.issuer,
    endpoints: Object.keys(endpoints),
    pkce: as.code_challenge_methods_supported ?? null,
    tokenAuthMethods: methods,
    grantTypes: as.grant_types_supported ?? null,
    scopesSupported: as.scopes_supported ?? rs.scopes_supported ?? null,
    issParameterSupported: as.authorization_response_iss_parameter_supported === true,
    clientIdMetadataDocument: as.client_id_metadata_document_supported === true,
    revocationSeparateFromToken: !!endpoints.revocation_endpoint && endpoints.revocation_endpoint !== endpoints.token_endpoint,
    resource: typeof rs.resource === 'string' ? rs.resource : null
  };
  rec.facts.discovery = facts;
  rec.step('discover.pkce', Array.isArray(facts.pkce) && facts.pkce.includes('S256') ? 'PASS' : 'FAIL', `code_challenge_methods_supported: ${JSON.stringify(facts.pkce)}`);
  rec.step('discover.public_client', methods.includes('none') ? 'PASS' : 'INFO', `token endpoint auth methods: ${JSON.stringify(methods)}`);
  rec.step('discover.registration', endpoints.registration_endpoint ? 'PASS' : 'INFO', endpoints.registration_endpoint ? 'dynamic client registration is offered' : 'no registration endpoint');
  rec.step('discover.revocation', endpoints.revocation_endpoint ? 'PASS' : 'INFO',
    endpoints.revocation_endpoint ? (facts.revocationSeparateFromToken ? 'a revocation endpoint is offered' : 'revocation is advertised at the token endpoint itself') : 'no revocation endpoint');
  rec.step('discover.iss', 'INFO', `authorization_response_iss_parameter_supported: ${facts.issParameterSupported}; client_id_metadata_document_supported: ${facts.clientIdMetadataDocument}`);
  return { ok: true, rs, as, endpoints, facts, issuer: as.issuer, resource: facts.resource || p.mcp, methods };
}

// ─── the loopback listener: the same care as the app's own sign-in ──────────

function openLoopback({ path = '/callback', timeoutMs = 5 * 60_000, port: wantPort = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    let armed = null;
    const page = (res, status, title, line) => {
      const html = `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px system-ui,sans-serif;margin:3rem;max-width:34rem"><h1>${title}</h1><p>${line}</p></body>`;
      res.writeHead(status, {
        'content-type': 'text/html; charset=utf-8', 'content-length': String(Buffer.byteLength(html)), 'cache-control': 'no-store',
        'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', connection: 'close',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'"
      });
      res.end(html);
    };
    server.on('request', (req, res) => {
      const ignore = (status, reason) => { if (armed) armed.rejected.push(reason); page(res, status, 'Not a sign-in link', 'This address is not a sign-in the tool is waiting for.'); };
      if (!armed || armed.done) return ignore(410, 'finished');
      if (req.method !== 'GET') return ignore(405, 'method');
      const port = server.address().port;
      if (req.headers.host !== `127.0.0.1:${port}`) return ignore(400, 'host');
      const raw = req.url || '';
      if (raw.length > 4096) return ignore(414, 'too-long');
      if (raw.split('?', 1)[0] !== path) return ignore(404, 'path');
      const mode = req.headers['sec-fetch-mode']; const dest = req.headers['sec-fetch-dest'];
      if ((mode !== undefined && mode !== 'navigate') || (dest !== undefined && dest !== 'document')) return ignore(400, 'not-navigation');
      let q;
      try { q = new URL(raw, `http://127.0.0.1:${port}`).searchParams; } catch { return ignore(400, 'url'); }
      for (const k of ['state', 'code', 'error', 'iss']) if (q.getAll(k).length > 1) return ignore(400, 'duplicate-param');
      for (const v of q.values()) if (v.length > MAX_PARAM) return ignore(400, 'param-too-long');
      const state = q.get('state');
      if (!state || !constantTimeEqual(state, armed.state)) return ignore(400, 'state');
      if (armed.consumed) return ignore(400, 'replayed');
      armed.consumed = true;
      const end = (result) => { page(res, result.ok ? 200 : 400, result.ok ? 'Signed in' : 'Sign-in did not complete', result.ok ? 'You can close this tab and go back to the terminal.' : 'Go back to the terminal.'); armed.finish(result); };
      if (q.get('error') !== null) return end({ ok: false, error: q.get('error') === 'access_denied' ? 'denied' : 'provider-error' });
      const iss = q.get('iss');
      if (iss !== null ? !constantTimeEqual(iss, armed.issuer || '') : armed.issRequired) return end({ ok: false, error: iss === null ? 'iss-missing' : 'iss-mismatch' });
      const code = q.get('code');
      if (!code || !/^[A-Za-z0-9._~/+=-]{1,2048}$/.test(code)) return end({ ok: false, error: 'invalid-callback' });
      return end({ ok: true, code });
    });
    server.on('clientError', (_e, socket) => { try { socket.destroy(); } catch { /* noop */ } });
    server.once('error', reject);
    server.listen({ port: wantPort, host: '127.0.0.1', exclusive: true }, () => {
      const port = server.address().port;
      let timer;
      const close = () => { clearTimeout(timer); try { server.close(); server.closeAllConnections(); } catch { /* noop */ } };
      resolve({
        port, redirectUri: `http://127.0.0.1:${port}${path}`, close,
        arm({ state, issuer, issRequired }) {
          return new Promise((done) => {
            armed = { state, issuer, issRequired, consumed: false, done: false, rejected: [], finish: (r) => { if (armed.done) return; armed.done = true; clearTimeout(timer); done({ ...r, rejected: armed.rejected }); } };
            timer = setTimeout(() => armed.finish({ ok: false, error: 'timeout' }), timeoutMs);
            timer.unref?.();
          });
        }
      });
    });
  });
}

function defaultOpenUrl(url) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

// ─── MCP over Streamable HTTP ───────────────────────────────────────────────

function mcpClient(url, token, ctx) {
  let sid;
  let version = PROTOCOL;
  let nextId = 1;
  async function call(method, params, { notification = false } = {}) {
    const id = notification ? undefined : nextId++;
    const body = { jsonrpc: '2.0', ...(id !== undefined ? { id } : {}), method, ...(params ? { params } : {}) };
    const headers = {
      'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}`,
      ...(method === 'initialize' ? {} : { 'mcp-protocol-version': version }), ...(sid ? { 'mcp-session-id': sid } : {})
    };
    const r = await ctx.http(url, { method: 'POST', headers, body: JSON.stringify(body) });
    const got = r.headers.get('mcp-session-id');
    if (got) sid = got;
    return { status: r.status, rpc: notification ? null : parseRpc(r.text, r.headers.get('content-type'), id), error: r.error };
  }
  return {
    async initialize() {
      const r = await call('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'mosbius-stage-a', version: '0' } });
      if (r.rpc && r.rpc.result && typeof r.rpc.result.protocolVersion === 'string') version = r.rpc.result.protocolVersion;
      if (r.status === 200 || r.status === 202) await call('notifications/initialized', undefined, { notification: true });
      return r;
    },
    async listTools() {
      const tools = [];
      let cursor;
      for (let i = 0; i < 20; i++) {
        const r = await call('tools/list', cursor ? { cursor } : undefined);
        if (!r.rpc || !r.rpc.result || !Array.isArray(r.rpc.result.tools)) return { status: r.status, tools: null, error: r.error };
        tools.push(...r.rpc.result.tools);
        cursor = typeof r.rpc.result.nextCursor === 'string' ? r.rpc.result.nextCursor : undefined;
        if (!cursor) break;
      }
      return { status: 200, tools };
    },
    callTool: (name, args) => call('tools/call', { name, arguments: args ?? {} }),
    ping: () => call('tools/list')
  };
}

/** Counts only. By the server's own hints; the app trusts none of them, this is just a way to look. */
function classify(tools) {
  const c = { count: tools.length, read: 0, write: 0, destructiveOrUnsaid: 0, unannotated: 0, names: tools.map((t) => String(t.name)).slice(0, 80) };
  for (const t of tools) {
    const a = t && typeof t.annotations === 'object' && t.annotations ? t.annotations : null;
    if (!a) { c.unannotated++; c.destructiveOrUnsaid++; continue; }
    if (a.readOnlyHint === true) c.read++;
    else if (a.destructiveHint === false) c.write++;
    else c.destructiveOrUnsaid++;
  }
  return c;
}

async function mcpSteps(ctx, url, token, opts, label = 'mcp') {
  const { rec } = ctx;
  const client = mcpClient(url, token, ctx);
  const init = await client.initialize();
  rec.step(`${label}.initialize`, init.status === 200 || init.status === 202 ? 'PASS' : 'FAIL', `HTTP ${init.status || init.error}${init.rpc && init.rpc.error ? '; the server returned an error' : ''}`);
  if (!(init.status === 200 || init.status === 202)) return { ok: false, client };
  const list = await client.listTools();
  if (!list.tools) { rec.step(`${label}.tools_list`, 'FAIL', `HTTP ${list.status || list.error}`); return { ok: false, client }; }
  const summary = classify(list.tools);
  rec.facts[`${label}.tools`] = summary;
  rec.step(`${label}.tools_list`, 'PASS', `${summary.count} tools: ${summary.read} read-only by hint, ${summary.write} write, ${summary.destructiveOrUnsaid} destructive or unsaid (${summary.unannotated} without any hint)`);
  if (opts.tool) {
    const tool = list.tools.find((t) => t && t.name === opts.tool);
    if (!tool) { rec.step(`${label}.tool_call`, 'FAIL', `the server does not offer a tool called ${opts.tool}`); return { ok: true, client, tools: list.tools }; }
    const readOnly = tool.annotations && tool.annotations.readOnlyHint === true;
    if (!readOnly && !(opts.allowUnannotated && !tool.annotations)) {
      rec.step(`${label}.tool_call`, 'SKIP', `${opts.tool} is not marked read-only by the server, so it was not called (a tool that might write is never called by this tool)`);
      return { ok: true, client, tools: list.tools };
    }
    const r = await client.callTool(opts.tool, opts.args);
    const result = r.rpc && r.rpc.result;
    const items = result && Array.isArray(result.content) ? result.content.length : 0;
    const bytes = result ? Buffer.byteLength(JSON.stringify(result)) : 0;
    const ok = r.status === 200 && !!result && result.isError !== true;
    rec.facts[`${label}.call`] = { tool: opts.tool, ok, status: r.status, items, bytes, isError: result ? result.isError === true : null };
    rec.step(`${label}.tool_call`, ok ? 'PASS' : 'FAIL', ok ? `${opts.tool} answered with ${items} item(s), ${bytes} bytes (the content is not shown)` : `${opts.tool} did not succeed (HTTP ${r.status || r.error}${result && result.isError ? ', the tool reported an error' : ''})`);
  }
  return { ok: true, client, tools: list.tools };
}

async function accessWorks(ctx, url, token) {
  const r = await ctx.http(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}`, 'mcp-protocol-version': PROTOCOL },
    body: INIT_BODY(99)
  });
  return r.status;
}

// ─── token endpoints (form posts) ───────────────────────────────────────────

async function tokenPost(ctx, url, fields, headers = {}) {
  const r = await ctx.http(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', ...headers }, body: formBody(fields) });
  const obj = parseJsonObject(r.text);
  return { status: r.status, obj, error: r.error };
}

const errorCode = (obj) => (obj && typeof obj.error === 'string' && /^[a-z_]{1,40}$/.test(obj.error) ? obj.error : null);

function takeTokens(rec, obj) {
  rec.track('access_token', obj.access_token);
  rec.track('refresh_token', obj.refresh_token);
  return { access: obj.access_token, refresh: typeof obj.refresh_token === 'string' ? obj.refresh_token : null };
}

function tokenFacts(obj) {
  const known = new Set(['access_token', 'token_type', 'expires_in', 'scope', 'refresh_token', 'refresh_token_expires_in', 'id_token']);
  return {
    tokenType: typeof obj.token_type === 'string' ? obj.token_type : null,
    expiresIn: typeof obj.expires_in === 'number' ? obj.expires_in : null,
    scope: typeof obj.scope === 'string' ? obj.scope : null,
    refreshToken: typeof obj.refresh_token === 'string',
    refreshExpiresIn: typeof obj.refresh_token_expires_in === 'number' ? obj.refresh_token_expires_in : null,
    otherFields: Object.keys(obj).filter((k) => !known.has(k)).slice(0, 12)
  };
}

// ─── the end of every run ───────────────────────────────────────────────────

function finish(rec, opts, extra = {}) {
  const evidence = { at: new Date().toISOString(), tool: 'stage-a-spike', node: process.version, platform: process.platform, ...extra, facts: rec.facts, steps: rec.steps };
  const text = JSON.stringify(evidence);
  const leaked = rec.found(text).concat(rec.found(rec.lines.join('\n')));
  if (leaked.length > 0 || rec.blocked > 0) rec.step('leak.scan', 'FAIL', `a secret (${[...new Set(leaked)].join(', ') || 'a value this run held'}) would have been shown; it was withheld`);
  else rec.step('leak.scan', 'PASS', `no token, code, verifier or state appears in ${rec.lines.length} lines or the evidence`);
  const failed = rec.steps.filter((s) => s.status === 'FAIL');
  rec.say(failed.length ? `\n${failed.length} step(s) FAILED. Nothing here is verified until they pass.` : '\nEvery required step passed. Only what is listed above was exercised.');
  if (opts.evidence) {
    try { fs.writeFileSync(opts.evidence, JSON.stringify({ ...evidence, steps: rec.steps }, null, 2), { mode: 0o600 }); rec.say(`evidence (facts only, no secrets): ${opts.evidence}`); }
    catch { rec.say('the evidence file could not be written'); }
  }
  return { code: failed.length ? 1 : 0, evidence, steps: rec.steps, facts: rec.facts };
}

function newContext(p, deps) {
  const rec = deps.rec || makeRecorder(deps.out);
  const policy = makePolicy(p, deps);
  const http = deps.http || ((u, i, o) => httpRaw(u, i, { ...o, fetchFn: deps.fetch || globalThis.fetch, timeoutMs: deps.timeoutMs || 20_000 }));
  return { rec, policy, http };
}

// ─── metadata: public GETs only ─────────────────────────────────────────────

async function runMetadata(p, opts = {}, deps = {}) {
  const ctx = newContext(p, deps);
  ctx.rec.say(`\n${p.label}  (${p.mcp})`);
  try { await discover(p, ctx); }
  catch (e) { ctx.rec.step('discover', 'FAIL', e instanceof Refused ? e.message : 'the provider could not be reached'); }
  return finish(ctx.rec, opts, { mode: 'metadata', provider: p.label });
}

// ─── dcr: register, sign in, exchange, call, refresh, revoke ────────────────

async function runDcr(p, opts = {}, deps = {}) {
  const ctx = newContext(p, deps);
  await dcrRun(p, opts, deps, ctx);                      // it cleans up after itself, so the verdict includes the cleanup
  return finish(ctx.rec, opts, { mode: 'dcr', provider: p.label });
}

async function dcrRun(p, opts, deps, ctx) {
  const { rec, policy, http } = ctx;
  rec.say(`\n${p.label}: self-registering OAuth (a real client is registered, and you sign in)`);
  let lb = null;
  let access = null; let refresh = null; let client = null;
  try {
    const d = await discover(p, ctx);
    if (!d.ok) return;
    if (!d.endpoints.registration_endpoint || !d.endpoints.authorization_endpoint || !d.endpoints.token_endpoint) {
      rec.step('requirements', 'FAIL', 'the provider does not offer dynamic registration, authorization and token endpoints');
      return;
    }
    lb = await openLoopback({ timeoutMs: deps.signInTimeoutMs });
    const body = { client_name: CLIENT_NAME, redirect_uris: [lb.redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' };
    const reg = await http(d.endpoints.registration_endpoint, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) });
    const regObj = parseJsonObject(reg.text);
    if (!(reg.status === 200 || reg.status === 201) || !regObj || typeof regObj.client_id !== 'string') {
      rec.step('register', 'FAIL', `HTTP ${reg.status || reg.error}${errorCode(regObj) ? `; error: ${errorCode(regObj)}` : ''}; redirect URI offered: ${lb.redirectUri.replace(/:\d+/, ':<port>')}`);
      rec.facts.registration = { status: reg.status, error: errorCode(regObj) };
      return;
    }
    const echoed = Array.isArray(regObj.redirect_uris) && regObj.redirect_uris.length === 1 && regObj.redirect_uris[0] === lb.redirectUri;
    rec.track('registration_access_token', regObj.registration_access_token);
    rec.track('client_secret', regObj.client_secret);
    rec.facts.registration = {
      status: reg.status, fields: Object.keys(regObj).slice(0, 24), redirectEchoedExactly: echoed,
      authMethod: regObj.token_endpoint_auth_method ?? null, secretIssued: typeof regObj.client_secret === 'string',
      clientSecretExpiresAt: regObj.client_secret_expires_at ?? null, canUnregister: typeof regObj.registration_access_token === 'string' && typeof regObj.registration_client_uri === 'string'
    };
    client = { id: regObj.client_id, token: regObj.registration_access_token, uri: regObj.registration_client_uri };
    rec.step('register', 'PASS', `registered a public client; redirect URI accepted ${echoed ? 'exactly as sent' : 'but echoed differently'}; secret issued: ${rec.facts.registration.secretIssued}; can be unregistered: ${rec.facts.registration.canUnregister}`);
    if (rec.facts.registration.secretIssued) rec.step('register.public', 'WARN', 'the provider issued a client secret to a client that asked for none');

    const verifier = rec.track('code_verifier', newCodeVerifier());
    const state = newState();                                       // tracked once the address has been shown
    const url = new URL(d.endpoints.authorization_endpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', client.id);
    url.searchParams.set('redirect_uri', lb.redirectUri);
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', challengeS256(verifier));
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('resource', d.resource);
    if (p.scope) url.searchParams.set('scope', p.scope);
    policy.check(url.toString(), 'the authorization address');
    const waiting = lb.arm({ state, issuer: d.issuer, issRequired: d.facts.issParameterSupported });
    if (opts.noOpen) { rec.say('\nOpen this address in your browser (it holds no credential):'); rec.raw(url.toString()); rec.say(''); }
    else {
      rec.say(`\nOpening your browser at ${url.origin}${url.pathname} — sign in and approve, then come back here.`);
      try { await (deps.openUrl || defaultOpenUrl)(url.toString()); } catch { rec.say('the browser could not be opened; use --no-open to get the address'); }
    }
    rec.track('state', state);
    const cb = await waiting;
    if (cb.rejected.length) rec.step('callback.rejected', 'INFO', `${cb.rejected.length} request(s) to the loopback address were refused: ${[...new Set(cb.rejected)].join(', ')}`);
    if (!cb.ok) { rec.step('callback', 'FAIL', `the redirect did not complete: ${cb.error}`); return; }
    rec.track('authorization_code', cb.code);
    rec.step('callback', 'PASS', `the redirect arrived on the loopback address with the right state${d.facts.issParameterSupported ? ' and the right iss' : ''}`);

    const tok = await tokenPost(ctx, d.endpoints.token_endpoint, { grant_type: 'authorization_code', code: cb.code, redirect_uri: lb.redirectUri, client_id: client.id, code_verifier: verifier, resource: d.resource });
    if (tok.status !== 200 || !tok.obj || typeof tok.obj.access_token !== 'string') {
      rec.step('token', 'FAIL', `HTTP ${tok.status || tok.error}${errorCode(tok.obj) ? `; error: ${errorCode(tok.obj)}` : ''} — the exchange without a client secret did not work`);
      rec.facts.token = { status: tok.status, error: errorCode(tok.obj) };
      return;
    }
    ({ access, refresh } = takeTokens(rec, tok.obj));
    rec.facts.token = { status: tok.status, ...tokenFacts(tok.obj) };
    rec.step('token', 'PASS', `exchanged the code with no client secret; type ${rec.facts.token.tokenType}, lifetime ${rec.facts.token.expiresIn ?? 'unstated'} s, refresh token: ${rec.facts.token.refreshToken}`);

    const first = await mcpSteps(ctx, p.mcp, access, opts);
    const oldAccess = access;
    if (refresh) {
      const r = await tokenPost(ctx, d.endpoints.token_endpoint, { grant_type: 'refresh_token', refresh_token: refresh, client_id: client.id, resource: d.resource });
      if (r.status === 200 && r.obj && typeof r.obj.access_token === 'string') {
        const before = refresh;
        const next = takeTokens(rec, r.obj);
        access = next.access;
        const rotated = !!next.refresh && next.refresh !== before;
        if (next.refresh) refresh = next.refresh;
        rec.facts.refresh = { status: r.status, rotated, ...tokenFacts(r.obj) };
        rec.step('refresh', 'PASS', `refreshed with no client secret; the refresh token ${rotated ? 'was ROTATED (single use)' : 'was not rotated'}; lifetime ${rec.facts.refresh.expiresIn ?? 'unstated'} s`);
        const works = await accessWorks(ctx, p.mcp, access);
        rec.step('refresh.access', works === 200 || works === 202 ? 'PASS' : 'FAIL', `the new access token ${works === 200 || works === 202 ? 'works' : `is refused (HTTP ${works})`}`);
        const stillOld = await accessWorks(ctx, p.mcp, oldAccess);
        rec.facts.refresh.oldAccessStillWorks = stillOld === 200 || stillOld === 202;
        rec.step('refresh.old_access', 'INFO', `the access token from before the refresh ${rec.facts.refresh.oldAccessStillWorks ? 'still works' : 'no longer works'}`);
        if (opts.reuseProbe && rotated) {
          const reuse = await tokenPost(ctx, d.endpoints.token_endpoint, { grant_type: 'refresh_token', refresh_token: before, client_id: client.id, resource: d.resource });
          const after = await accessWorks(ctx, p.mcp, access);
          rec.facts.reuse = { oldRefreshStatus: reuse.status, oldRefreshError: errorCode(reuse.obj), newAccessAfter: after };
          rec.step('refresh.reuse', 'INFO', `presenting the OLD refresh token again: HTTP ${reuse.status}${errorCode(reuse.obj) ? ` (${errorCode(reuse.obj)})` : ''}; the new access token ${after === 200 || after === 202 ? 'still works' : `stopped working (HTTP ${after}): reuse killed the grant`}`);
        }
      } else {
        rec.facts.refresh = { status: r.status, error: errorCode(r.obj) };
        rec.step('refresh', 'FAIL', `HTTP ${r.status || r.error}${errorCode(r.obj) ? `; error: ${errorCode(r.obj)}` : ''}`);
      }
    } else rec.step('refresh', 'SKIP', 'the provider issued no refresh token');

    if (d.endpoints.revocation_endpoint) {
      const target = refresh || access;
      const rv = await tokenPost(ctx, d.endpoints.revocation_endpoint, { token: target, token_type_hint: refresh ? 'refresh_token' : 'access_token', client_id: client.id });
      const afterAccess = await accessWorks(ctx, p.mcp, access);
      let afterRefresh = null;
      if (refresh) { const r2 = await tokenPost(ctx, d.endpoints.token_endpoint, { grant_type: 'refresh_token', refresh_token: refresh, client_id: client.id, resource: d.resource }); afterRefresh = r2.status === 200 ? 'still works' : (errorCode(r2.obj) || `HTTP ${r2.status}`); }
      const revoked = rv.status === 200 && !(afterAccess === 200 || afterAccess === 202);
      rec.facts.revoke = { status: rv.status, accessAfter: afterAccess, refreshAfter: afterRefresh };
      rec.step('revoke', revoked ? 'PASS' : (rv.status === 200 ? 'WARN' : 'FAIL'),
        `HTTP ${rv.status || rv.error}; the access token then answers HTTP ${afterAccess}; the refresh token ${afterRefresh ?? 'was not tried'}${rv.status === 200 && !revoked ? ' — revocation was accepted but did not take effect at once' : ''}`);
    } else rec.step('revoke', 'SKIP', 'the provider offers no revocation endpoint: the sign-in can only be ended in the provider\'s own settings');
    if (first && first.ok === false) rec.step('mcp', 'FAIL', 'the MCP server could not be used with the token');
  } catch (e) {
    rec.step('run', 'FAIL', e instanceof Refused ? e.message : 'the run stopped on an unexpected error');
  } finally {
    access = null; refresh = null;
    if (lb) lb.close();
    if (client && client.token && client.uri) {
      try {
        policy.check(client.uri, 'the registration address');
        const del = await http(client.uri, { method: 'DELETE', headers: { authorization: `Bearer ${client.token}` } });
        rec.facts.unregister = { status: del.status };
        rec.step('unregister', del.status === 204 || del.status === 200 ? 'PASS' : 'INFO', `removed the test client (HTTP ${del.status || del.error})`);
      } catch { rec.step('unregister', 'INFO', 'the test client could not be removed'); }
    } else if (client) rec.step('unregister', 'INFO', 'the provider offers no way to remove the test client; it stays registered, with no access');
  }
  return;
}

// ─── device flow (RFC 8628), for GitHub ─────────────────────────────────────

async function runDevice(p, opts = {}, deps = {}) {
  const ctx = newContext(p, deps);
  await deviceRun(p, opts, deps, ctx);                      // it cleans up after itself, so the verdict includes the cleanup
  return finish(ctx.rec, opts, { mode: 'device', provider: p.label });
}

async function deviceRun(p, opts, deps, ctx) {
  const { rec, policy } = ctx;
  rec.say(`\n${p.label}: device flow with the app you created (client id only, no secret)`);
  let access = null; let refresh = null;
  try {
    if (!opts.clientId || !/^[A-Za-z0-9._-]{8,80}$/.test(opts.clientId)) { rec.step('setup', 'FAIL', 'pass the app\'s client id with --client-id'); return; }
    policy.check(p.deviceEndpoint, 'the device endpoint'); policy.check(p.tokenEndpoint, 'the token endpoint');
    const dc = await tokenPost(ctx, p.deviceEndpoint, { client_id: opts.clientId, ...(p.scope ? { scope: p.scope } : {}) });
    if (dc.status !== 200 || !dc.obj || typeof dc.obj.device_code !== 'string' || typeof dc.obj.user_code !== 'string') {
      const code = errorCode(dc.obj);
      rec.step('device_code', 'FAIL', `HTTP ${dc.status || dc.error}${code ? `; error: ${code}` : ''}${code === 'device_flow_disabled' ? ' — switch on "Enable Device Flow" in the app\'s settings' : ''}`);
      return;
    }
    rec.track('device_code', dc.obj.device_code);
    const interval = Number.isInteger(dc.obj.interval) ? dc.obj.interval : 5;
    rec.facts.device = { expiresIn: dc.obj.expires_in ?? null, interval, verificationUri: typeof dc.obj.verification_uri === 'string' ? dc.obj.verification_uri : null };
    rec.step('device_code', 'PASS', `a device code was issued; it expires in ${rec.facts.device.expiresIn ?? '?'} s and may be polled every ${interval} s`);
    rec.say(`\n  >>> Open ${dc.obj.verification_uri} and enter this code:  ${dc.obj.user_code}\n`);

    const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    let wait = interval; let tok = null; let slowDowns = 0; let polls = 0;
    const deadline = Date.now() + Math.min((Number(dc.obj.expires_in) || 900) * 1000, deps.pollBudgetMs || 15 * 60_000);
    for (;;) {
      await sleep(wait * 1000);
      polls++;
      const r = await tokenPost(ctx, p.tokenEndpoint, { client_id: opts.clientId, device_code: dc.obj.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' });
      const err = errorCode(r.obj);
      if (r.status === 200 && r.obj && typeof r.obj.access_token === 'string') { tok = r.obj; break; }
      if (err === 'authorization_pending') { if (Date.now() > deadline) break; continue; }
      if (err === 'slow_down') { slowDowns++; wait = (Number.isInteger(r.obj.interval) ? r.obj.interval : wait + 5); continue; }
      rec.step('device_poll', 'FAIL', `the flow ended with ${err || `HTTP ${r.status || r.error}`}`);
      return;
    }
    if (!tok) { rec.step('device_poll', 'FAIL', 'nobody entered the code in time'); return; }
    ({ access, refresh } = takeTokens(rec, tok));
    rec.facts.token = { ...tokenFacts(tok), polls, slowDowns };
    rec.step('token', 'PASS', `signed in with no client secret; lifetime ${rec.facts.token.expiresIn ?? 'unstated (does not expire)'}${rec.facts.token.expiresIn ? ' s' : ''}; refresh token: ${rec.facts.token.refreshToken}; scope: ${rec.facts.token.scope ?? 'unstated'}`);

    await mcpSteps(ctx, p.mcp, access, opts);
    if (refresh) {
      const r = await tokenPost(ctx, p.tokenEndpoint, { client_id: opts.clientId, grant_type: 'refresh_token', refresh_token: refresh });
      if (r.status === 200 && r.obj && typeof r.obj.access_token === 'string') {
        const before = refresh;
        const next = takeTokens(rec, r.obj);
        access = next.access; if (next.refresh) refresh = next.refresh;
        rec.facts.refresh = { status: r.status, rotated: !!next.refresh && next.refresh !== before, ...tokenFacts(r.obj) };
        rec.step('refresh', 'PASS', `refreshed with NO client secret; the refresh token ${rec.facts.refresh.rotated ? 'was rotated (single use)' : 'was not rotated'}`);
        const works = await accessWorks(ctx, p.mcp, access);
        rec.step('refresh.access', works === 200 || works === 202 ? 'PASS' : 'FAIL', `the new access token ${works === 200 || works === 202 ? 'works' : `is refused (HTTP ${works})`}`);
      } else {
        rec.facts.refresh = { status: r.status, error: errorCode(r.obj) };
        rec.step('refresh', 'FAIL', `HTTP ${r.status || r.error}${errorCode(r.obj) ? `; error: ${errorCode(r.obj)}` : ''} — a refresh without the client secret did not work`);
      }
    } else rec.step('refresh', 'INFO', 'no refresh token was issued: this token does not expire (an OAuth App) or the app does not use expiring tokens');
    rec.step('revoke', 'INFO', 'not attempted: GitHub\'s endpoints for revoking a token or an authorization need the app\'s client SECRET. End this sign-in at https://github.com/settings/applications (or settings/apps/authorizations for a GitHub App).');
  } catch (e) {
    rec.step('run', 'FAIL', e instanceof Refused ? e.message : 'the run stopped on an unexpected error');
  } finally { access = null; refresh = null; }
  return;
}

// ─── authorization code + PKCE with a client you created (Google) ───────────

async function runPkce(p, opts = {}, deps = {}) {
  const ctx = newContext(p, deps);
  await pkceRun(p, opts, deps, ctx);                      // it cleans up after itself, so the verdict includes the cleanup
  return finish(ctx.rec, opts, { mode: 'pkce', provider: p.label });
}

async function pkceRun(p, opts, deps, ctx) {
  const { rec, policy } = ctx;
  rec.say(`\n${p.label}: authorization code with PKCE, using the client you created`);
  let lb = null; let access = null; let refresh = null;
  try {
    if (!opts.clientId || !/^[A-Za-z0-9._-]{8,200}$/.test(opts.clientId)) { rec.step('setup', 'FAIL', 'pass the client id with --client-id'); return; }
    for (const k of ['authorizationEndpoint', 'tokenEndpoint', 'revokeEndpoint']) if (p[k]) policy.check(p[k], k);
    let secret = null;
    if (opts.secret === 'prompt') {
      const ask = deps.promptSecret || require('./verify-broker-live.cjs').promptLine;
      try { secret = await ask('OAuth client secret (not echoed; Enter for none): ', { hidden: true }); } catch (e) { rec.step('setup', 'FAIL', `the secret prompt needs a terminal: ${String(e && e.message).slice(0, 60)}`); return; }
      if (secret) rec.track('client_secret', secret);
    }
    rec.step('setup', 'INFO', `the client secret will be ${secret ? 'SENT with the exchange' : 'LEFT OUT of the exchange'}`);
    lb = await openLoopback({ path: '/oauth/callback', timeoutMs: deps.signInTimeoutMs, port: opts.redirectPort || 0 });
    const verifier = rec.track('code_verifier', newCodeVerifier());
    const state = newState();                                       // tracked once the address has been shown
    const url = new URL(p.authorizationEndpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', opts.clientId);
    url.searchParams.set('redirect_uri', lb.redirectUri);
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', challengeS256(verifier));
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('scope', p.scope);
    for (const [k, v] of Object.entries(p.authorizeParams || {})) url.searchParams.set(k, v);
    policy.check(url.toString(), 'the authorization address');
    const waiting = lb.arm({ state, issuer: p.issuer, issRequired: p.issRequired === true });
    if (opts.noOpen) { rec.say('\nOpen this address in your browser (it holds no credential):'); rec.raw(url.toString()); rec.say(''); }
    else {
      rec.say(`\nOpening your browser at ${url.origin}${url.pathname} — sign in and approve, then come back here.`);
      try { await (deps.openUrl || defaultOpenUrl)(url.toString()); } catch { rec.say('the browser could not be opened; use --no-open to get the address'); }
    }
    rec.track('state', state);
    const cb = await waiting;
    if (cb.rejected.length) rec.step('callback.rejected', 'INFO', `${cb.rejected.length} request(s) to the loopback address were refused: ${[...new Set(cb.rejected)].join(', ')}`);
    if (!cb.ok) { rec.step('callback', 'FAIL', `the redirect did not complete: ${cb.error}`); return; }
    rec.track('authorization_code', cb.code);
    rec.step('callback', 'PASS', 'the redirect arrived on the loopback address with the right state and iss');

    const fields = { grant_type: 'authorization_code', code: cb.code, redirect_uri: lb.redirectUri, client_id: opts.clientId, code_verifier: verifier };
    const tok = await tokenPost(ctx, p.tokenEndpoint, secret ? { ...fields, client_secret: secret } : fields);
    if (tok.status !== 200 || !tok.obj || typeof tok.obj.access_token !== 'string') {
      rec.facts.token = { status: tok.status, error: errorCode(tok.obj), secretSent: !!secret };
      rec.step('token', 'FAIL', `HTTP ${tok.status || tok.error}${errorCode(tok.obj) ? `; error: ${errorCode(tok.obj)}` : ''} — the exchange ${secret ? 'with' : 'without'} the client secret did not work${!secret ? '; run again with --secret prompt to learn whether the secret is what is missing' : ''}`);
      return;
    }
    ({ access, refresh } = takeTokens(rec, tok.obj));
    rec.facts.token = { status: tok.status, secretSent: !!secret, ...tokenFacts(tok.obj) };
    rec.step('token', 'PASS', `exchanged the code ${secret ? 'WITH' : 'WITHOUT'} a client secret; lifetime ${rec.facts.token.expiresIn ?? 'unstated'} s; refresh token: ${rec.facts.token.refreshToken}; scope granted: ${rec.facts.token.scope ?? 'unstated'}`);

    await mcpSteps(ctx, p.mcp, access, opts);
    if (refresh) {
      const r = await tokenPost(ctx, p.tokenEndpoint, secret ? { grant_type: 'refresh_token', refresh_token: refresh, client_id: opts.clientId, client_secret: secret } : { grant_type: 'refresh_token', refresh_token: refresh, client_id: opts.clientId });
      if (r.status === 200 && r.obj && typeof r.obj.access_token === 'string') {
        const before = refresh;
        const next = takeTokens(rec, r.obj);
        access = next.access; if (next.refresh) refresh = next.refresh;
        rec.facts.refresh = { status: r.status, rotated: !!next.refresh && next.refresh !== before, secretSent: !!secret, ...tokenFacts(r.obj) };
        rec.step('refresh', 'PASS', `refreshed ${secret ? 'with' : 'without'} the client secret; the refresh token ${rec.facts.refresh.rotated ? 'was rotated' : 'was not rotated'}`);
        const works = await accessWorks(ctx, p.mcp, access);
        rec.step('refresh.access', works === 200 || works === 202 ? 'PASS' : 'FAIL', `the new access token ${works === 200 || works === 202 ? 'works' : `is refused (HTTP ${works})`}`);
      } else {
        rec.facts.refresh = { status: r.status, error: errorCode(r.obj), secretSent: !!secret };
        rec.step('refresh', 'FAIL', `HTTP ${r.status || r.error}${errorCode(r.obj) ? `; error: ${errorCode(r.obj)}` : ''}`);
      }
    } else rec.step('refresh', 'INFO', 'no refresh token was issued (Google issues one only with access_type=offline and consent)');

    if (p.revokeEndpoint) {
      const target = refresh || access;
      const rv = await tokenPost(ctx, p.revokeEndpoint, { token: target });
      const after = await accessWorks(ctx, p.mcp, access);
      const dead = !(after === 200 || after === 202);
      rec.facts.revoke = { status: rv.status, accessAfter: after };
      rec.step('revoke', rv.status === 200 && dead ? 'PASS' : (rv.status === 200 ? 'WARN' : 'FAIL'), `HTTP ${rv.status || rv.error} with no client secret; the access token then answers HTTP ${after}`);
    }
  } catch (e) {
    rec.step('run', 'FAIL', e instanceof Refused ? e.message : 'the run stopped on an unexpected error');
  } finally { access = null; refresh = null; if (lb) lb.close(); }
  return;
}

// ─── the command line ───────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { _: [], flags: new Set(), values: {} };
  const valued = new Set(['tool', 'args', 'evidence', 'client-id', 'secret', 'wait', 'redirect-port']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const k = a.slice(2);
    if (valued.has(k)) { out.values[k] = argv[++i]; } else out.flags.add(k);
  }
  return out;
}

function optionsFrom(args) {
  let toolArgs;
  if (args.values.args !== undefined) { try { toolArgs = JSON.parse(args.values.args); } catch { throw new Error('--args must be JSON'); } }
  return {
    tool: args.values.tool, args: toolArgs, evidence: args.values.evidence, clientId: args.values['client-id'],
    secret: args.values.secret === 'prompt' ? 'prompt' : 'none', noOpen: args.flags.has('no-open'),
    redirectPort: args.values['redirect-port'] !== undefined && Number.isInteger(Number(args.values['redirect-port'])) && Number(args.values['redirect-port']) > 1024 && Number(args.values['redirect-port']) < 65536 ? Number(args.values['redirect-port']) : undefined,
    waitMinutes: args.values.wait !== undefined ? Math.min(Math.max(Number(args.values.wait) || 5, 1), 60) : undefined,
    reuseProbe: args.flags.has('reuse-probe'), allowUnannotated: args.flags.has('allow-unannotated')
  };
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const [cmd, ...names] = args._;
  let opts;
  try { opts = optionsFrom(args); } catch (e) { console.error(e.message); return 2; }
  const usage = () => { console.error('usage: node tools/stage-a-spike.cjs metadata [provider ...] | dcr <provider> | device github --client-id ID | pkce google-calendar --client-id ID  (see the header of this file)'); return 2; };
  if (cmd === 'metadata') {
    const list = names.length ? names : Object.keys(PROVIDERS);
    let code = 0;
    for (const n of list) { const p = PROVIDERS[n]; if (!p) { console.error(`unknown provider: ${n}`); return 2; } const r = await runMetadata(p, {}, {}); if (r.code) code = r.code; }
    return code;
  }
  const p = PROVIDERS[names[0]];
  if (!p) return usage();
  const wanted = { dcr: 'dcr', device: 'device', pkce: 'pkce' }[cmd];
  if (!wanted || p.strategy !== wanted) { console.error(`${names[0]} uses the "${p.strategy}" method`); return 2; }
  const run = { dcr: runDcr, device: runDevice, pkce: runPkce }[cmd];
  const deps = opts.waitMinutes ? { signInTimeoutMs: opts.waitMinutes * 60_000, pollBudgetMs: opts.waitMinutes * 60_000 } : {};
  return (await run(p, opts, deps)).code;
}

module.exports = { PROVIDERS, makeRecorder, httpRaw, makePolicy, discover, openLoopback, mcpClient, classify, runMetadata, runDcr, runDevice, runPkce, parseArgs, optionsFrom, main, CLIENT_NAME };

if (require.main === module) {
  main().then((code) => process.exit(code), (e) => { console.error('stage-a-spike failed:', e && e.message); process.exit(1); });
}
