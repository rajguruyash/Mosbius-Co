'use strict';

/**
 * PHASE 4: the live gate for the in-app MCP broker.
 *
 * Every other test in this repository runs against a STAND-IN provider. This tool runs
 * the same checklist against the REAL servers, so that "verified" can mean something.
 * It drives the REAL broker (capabilities, grants, the MCP route, the OAuth engine) over
 * loopback exactly as an agent's CLI would, and records what happened. Nothing here is a
 * mock of the code under test: only the target can be a stand-in, and the report says
 * which it was.
 *
 *   node tools/verify-broker-live.cjs --no-account [--only gmail,google-calendar,google-drive,slack] [--evidence <file>]
 *       The REAL endpoints, with NO credentials: nothing needs an account for these steps.
 *       Google serves `initialize` and `tools/list` without one, so the real tool names and
 *       annotations, the response framing, the real 401 answers and the broker's handling of
 *       them can all be checked today. Steps that need a signed-in account are SKIPPED, not
 *       passed, and say so.
 *
 *   npx electron tools/verify-broker-live.cjs <id> --account [--prompt-client] [--use-app-profile]
 *                [--user-data <dir>] [--tool <name> --args '<json>'] [--keep-signin] [--evidence <file>]
 *       The REAL account. By default it uses a THROWAWAY profile (your real one is not touched),
 *       prompts for the OAuth client id and secret in this terminal (the secret is not echoed, and
 *       is never written anywhere but that profile's encrypted store), opens your browser for the
 *       real consent screen, and ends by revoking what it created. It GRANTS ONE READ-ONLY TOOL to
 *       one test agent and never any write tool.
 *
 * Output: PASS / FAIL / SKIP per step, then a JSON evidence file (tool names and annotations,
 * response framing, counts, codes). It NEVER holds or prints a token, a client secret, a
 * capability, an authorization code, or anything a tool returned: only shapes and sizes.
 * Before it ends it searches everything it kept for the secrets it knows, and says whether
 * it found any.
 *
 * What a PASS means: only that step, against that target. It does not infer.
 */

const http = require('node:http');
const { createHash } = require('node:crypto');

const PROTOCOL = '2025-03-26';
const HOUR = 3_600_000;
const probe = 'gate-probe-invalid-token';

const short = (s) => createHash('sha256').update(String(s)).digest('hex').slice(0, 10);

function httpCall(port, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', (e) => resolve({ error: e.code || e.message }));
    });
    req.on('error', (e) => resolve({ error: e.code || e.message }));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** A JSON-RPC answer from a JSON body or from the first `data:` line of an event stream. */
function readRpc(text) {
  try { return JSON.parse(text); } catch { /* maybe an event stream */ }
  for (const line of String(text).split(/\r?\n/)) {
    if (line.startsWith('data:')) { try { return JSON.parse(line.slice(5)); } catch { /* next */ } }
  }
  return null;
}

const rpc = (method, params, id) => JSON.stringify({ jsonrpc: '2.0', ...(id !== undefined ? { id } : {}), method, ...(params ? { params } : {}) });

/**
 * @typedef {object} GateOptions
 * @property {string} id                 catalogue id (gmail, google-calendar, google-drive, slack)
 * @property {string} url                the MCP endpoint (the real one, or a stand-in's)
 * @property {'real'|'stand-in'} target  what the endpoint is: written into the evidence
 * @property {object} provider           a CredentialProvider (the OAuth engine's, or one that adds no header)
 * @property {string[]} allowHosts       hosts the gate may talk to; anything else is refused
 * @property {string} [tokenEndpoint]    full URL, to count refreshes
 * @property {string} [revokeEndpoint]   full URL
 * @property {boolean} [allowInsecureLoopback]  stand-ins only
 * @property {object} [controller]       the OAuth engine (account mode)
 * @property {object} [hooks]            account-mode hooks: advanceClock, restartCheck, failureProvider, disconnect, clientCredentials
 * @property {string} [tool]             the one read-only tool to grant (default: the first read-only one with no required argument)
 * @property {object} [args]
 * @property {(line: string) => void} [log]
 */

async function runGate(o) {
  const loadTs = require('../test/load-ts.cjs');
  const { IntegrationBroker } = loadTs('src/main/integrationBroker.ts');
  const { classifyTool } = loadTs('src/main/broker/permissions.ts');
  const { AuditLog } = loadTs('src/main/broker/audit.ts');

  const id = o.id;
  const log = o.log ?? (() => {});
  const steps = [];
  const facts = { id, target: o.target, account: !!o.controller, url: o.url, tools: [], framing: {}, probes: {}, notes: [] };
  const transcript = [];
  const seen = [];                       // everything an "agent" received, kept only to search it for secrets
  const watch = new Set();               // the secret values to search for, never printed
  const say = (line) => { transcript.push(line); log(line); };
  const add = (n, step, ok, detail = '') => {
    steps.push({ n, step, ok, detail });
    say(`${ok === null ? 'SKIP' : ok ? 'PASS' : 'FAIL'}  [${n}] ${step}${detail ? ` — ${detail}` : ''}`);
    return ok === true;
  };
  const note = (text) => { facts.notes.push(text); say(`NOTE  ${text}`); };

  // ── a guard on the network: only the hosts this run is about, https only (stand-ins: loopback) ──
  const calls = [];
  const realFetch = globalThis.fetch;
  let netDown = false;
  const allowed = (u) => o.allowHosts.includes(u.host) && (u.protocol === 'https:' || (o.allowInsecureLoopback && /^(127\.0\.0\.1|localhost)(:|$)/.test(u.host)));
  const guarded = async (input, init) => {
    const u = new URL(typeof input === 'string' ? input : input.url);
    if (!allowed(u)) throw new Error(`GATE SAFETY: refused a request to ${u.origin}`);
    const method = (init && init.method) || 'GET';
    const href = `${u.origin}${u.pathname}`;
    let rpcName = null; let tool = null;
    if (init && init.body !== undefined) {
      try {
        const j = JSON.parse(Buffer.isBuffer(init.body) || init.body instanceof Uint8Array ? Buffer.from(init.body).toString('utf8') : String(init.body));
        if (j && !Array.isArray(j)) { rpcName = j.method ?? null; tool = rpcName === 'tools/call' ? (j.params && j.params.name) ?? null : null; }
      } catch { /* a form post, not JSON-RPC */ }
    }
    const kind = href === o.tokenEndpoint ? 'token-endpoint' : href === o.revokeEndpoint ? 'revoke' : 'mcp';
    calls.push({ method, kind, rpc: rpcName, tool });
    if (netDown && kind === 'token-endpoint') throw new Error('GATE: simulated network failure');
    return realFetch(input, init);
  };
  // the gate's own direct calls (to learn what the provider is) obey the same allow-list, and are not counted as broker traffic
  const directFetch = (input, init) => {
    const u = new URL(typeof input === 'string' ? input : input.url);
    if (!allowed(u)) throw new Error(`GATE SAFETY: refused a request to ${u.origin}`);
    return realFetch(input, init);
  };
  const sentSince = (mark) => calls.slice(mark);
  const toolCallsSince = (mark) => sentSince(mark).filter((c) => c.kind === 'mcp' && c.rpc === 'tools/call');
  globalThis.fetch = guarded;

  // ── the broker, exactly as the app builds it ──
  const state = { enabled: true, grants: {} };      // deny by default
  const audit = new AuditLog();
  let poisoned = false;
  const credentials = {
    accessHeaders: async (s) => {
      if (poisoned) { poisoned = false; return { ok: true, headers: { Authorization: `Bearer ${probe}` } }; }
      return o.provider.accessHeaders(s);
    },
    rejected: (s, used) => {
      // a probe token was refused: ask the REAL engine for a real refresh
      if (JSON.stringify(used).includes(probe)) { if (o.controller) o.controller.provider.markRejected(id); return; }
      if (o.provider.rejected) o.provider.rejected(s, used);
    }
  };
  const makeBroker = (creds) => new IntegrationBroker({ getRecord: () => undefined, getSecret: () => undefined }, {
    mcp: {
      resolve: (x) => (x === id ? { id, url: o.url, enabled: state.enabled, classification: o.classification } : undefined),
      credentials: creds,
      grants: () => state.grants,
      audit: (e) => audit.push(e)
    }
  });
  const broker = makeBroker(credentials);
  const extraBrokers = [];
  let capA; let capB; let port;
  const as = (cap, p = port) => ({
    post: async (body, extra = {}) => {
      const r = await httpCall(p, { method: 'POST', path: `/m/${id}`, headers: { authorization: `Bearer ${cap}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...extra }, body: typeof body === 'string' ? body : JSON.stringify(body) });
      if (r.body) seen.push(`${r.status} ${JSON.stringify(r.headers)} ${r.body.toString('utf8')}`);
      return { ...r, json: r.body ? readRpc(r.body.toString('utf8')) : null };
    }
  });
  const errorCode = (r) => r.json && r.json.error && r.json.error.code;
  for (const extra of o.watch || []) watch.add(extra);
  const watchSecrets = () => {
    if (o.controller) {
      const t = o.controller.provider.tokens(id);
      for (const v of [t.accessToken, t.refreshToken]) if (v) watch.add(v);
    }
    const cc = o.hooks && o.hooks.clientCredentials && o.hooks.clientCredentials();
    if (cc && cc.clientSecret) watch.add(cc.clientSecret);
  };

  const finish = async () => {
    // the leak scan: everything this run kept, against every secret it ever held
    watchSecrets();
    if (capA) watch.add(capA);
    if (capB) watch.add(capB);
    const kept = [transcript.join('\n'), seen.join('\n'), JSON.stringify(audit.recent()), JSON.stringify(facts)].join('\n');
    const leaked = [...watch].filter((s) => s && kept.includes(s)).length;
    // the tool-answers an agent saw legitimately echo what the agent itself sent; secrets are what we look for
    add('N.1', 'no token, client secret or capability appears in anything this run printed, kept or logged', leaked === 0, leaked === 0 ? `searched ${watch.size} secret values` : `${leaked} secret value(s) FOUND`);
    globalThis.fetch = realFetch;
    try { broker.stop(); } catch { /* noop */ }
    for (const b of extraBrokers) { try { b.stop(); } catch { /* noop */ } }
    const bad = steps.filter((s) => s.ok === false).length;
    return { steps, facts, transcript, ok: bad === 0, failed: bad, skipped: steps.filter((s) => s.ok === null).length, calls: calls.length };
  };

  try {
    const started = await broker.start();
    if (!started.ok) { add('0', 'the broker starts on loopback', false, started.error || ''); return await finish(); }
    port = started.port;
    capA = broker.grantMcp('agent-A', [id]);
    capB = broker.grantMcp('agent-B', [id]);
    const A = as(capA);
    const B = as(capB);

    // ── 1. OAuth authorization (account mode) ───────────────────────────────
    if (o.controller) {
      const c = o.controller;
      const before = c.status(id);
      if (!add('1.0', 'an OAuth client is stored for this integration', before !== 'unconfigured', `status ${before}`)) return await finish();
      const res = before === 'connected' ? { ok: true } : await c.signIn(id);
      if (!add('1.1', 'authorization in the browser: callback validation (state, PKCE, issuer) and code exchange', res.ok, res.ok ? 'tokens stored' : `refused with code "${res.error}"`)) return await finish();
      add('1.2', 'status is "connected"', c.status(id) === 'connected', `status ${c.status(id)}`);
      const held = c.provider.tokens(id);
      watchSecrets();
      add('1.3', 'a refresh token was issued', !!held.refreshToken, held.refreshToken ? 'yes' : 'NO: the sign-in lapses when the access token does');
      if (o.hooks && o.hooks.restartCheck) {
        const rc = await o.hooks.restartCheck();
        add('1.4', 'the sign-in survives a restart: a new engine over the same encrypted store is "connected" with tokens', rc.status === 'connected' && rc.hasTokens, `status ${rc.status}, tokens ${rc.hasTokens ? 'present' : 'absent'}`);
      } else add('1.4', 'the sign-in survives a restart', null, 'no restart hook in this run');
    } else {
      for (const n of ['1.0', '1.1', '1.2', '1.3', '1.4']) add(n, 'OAuth authorization, token persistence', null, 'needs a signed-in account');
    }

    // ── 2. what the provider really is (direct, not through the broker) ──────
    const direct = async (method, params, n, init = {}) => {
      const h = await o.provider.accessHeaders({ id });
      if (!h.ok) return { error: h.code };
      try {
        const r = await directFetch(o.url, { method: init.method ?? 'POST', redirect: 'manual', headers: { ...h.headers, accept: 'application/json, text/event-stream', ...(init.method === 'GET' ? {} : { 'content-type': 'application/json' }) }, ...(init.method === 'GET' ? {} : { body: rpc(method, params, n) }) });
        const text = await r.text();
        return { status: r.status, ctype: (r.headers.get('content-type') || '').toLowerCase(), session: r.headers.get('mcp-session-id'), bytes: text.length, json: init.method === 'GET' ? null : readRpc(text), challenge: !!r.headers.get('www-authenticate') };
      } catch { return { error: 'network' }; }
    };
    const init = await direct('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'mosbius-gate', version: '1' } }, 1);
    facts.framing.initialize = init.error ? { error: init.error } : { status: init.status, contentType: init.ctype, sessionHeader: !!init.session, protocolVersion: init.json && init.json.result && init.json.result.protocolVersion, bytes: init.bytes };
    const list = await direct('tools/list', undefined, 2);
    facts.framing.toolsList = list.error ? { error: list.error } : { status: list.status, contentType: list.ctype, sessionHeader: !!list.session, bytes: list.bytes, streamed: (list.ctype || '').startsWith('text/event-stream') };
    const rawTools = list.json && list.json.result && Array.isArray(list.json.result.tools) ? list.json.result.tools : null;
    const needsAccount = !o.controller && (init.status === 401 || init.status === 403);
    facts.framing.initialize = { ...(facts.framing.initialize || {}), challengeHeader: !!init.challenge };
    add('2.1', needsAccount ? 'the server answers `initialize` (it wants a signed-in account even for this)' : 'the server answers `initialize`', needsAccount ? null : init.status === 200 && !!(init.json && init.json.result), init.error ?? `HTTP ${init.status}, ${init.ctype || 'no content type'}, ${init.session ? 'issues a session id' : 'no session id (stateless)'}${needsAccount ? `, WWW-Authenticate ${init.challenge ? 'present' : 'absent'}` : ''}`);
    add('2.2', 'the server\'s response framing is recorded (JSON or event stream)', !!list.status, list.error ?? `tools/list: ${list.ctype || '?'}, ${list.bytes} bytes${facts.framing.toolsList.streamed ? ' (STREAMED)' : ' (plain JSON)'}`);
    for (const m of ['GET']) {
      const g = await direct(m, undefined, 0, { method: 'GET' });
      facts.probes.get = g.error ? { error: g.error } : { status: g.status, contentType: g.ctype };
      add('2.3', 'whether the server offers a GET event stream is recorded', !g.error, g.error ?? `GET → HTTP ${g.status}${g.status === 405 ? ' (no stream offered)' : ''}`);
    }
    if (rawTools) {
      for (const t of rawTools) {
        const a = { ...(t.annotations || {}) }; delete a.title;
        facts.tools.push({
          name: t.name, annotations: a,
          requiredArgs: Array.isArray(t.inputSchema && t.inputSchema.required) ? t.inputSchema.required : [],
          classNow: classifyTool(t, o.classification || {}),                       // what the broker does TODAY
          classIfAnnotationsTrusted: classifyTool(t, { trustAnnotations: true })   // information only
        });
      }
      add('2.4', 'the provider\'s real tool list is recorded (names, annotations, classes)', true, `${rawTools.length} tools; ${facts.tools.filter((t) => t.annotations.readOnlyHint === true).length} declare readOnlyHint, ${facts.tools.filter((t) => t.annotations.destructiveHint === true).length} declare destructiveHint, ${facts.tools.filter((t) => t.annotations.readOnlyHint === undefined && t.annotations.destructiveHint === undefined).length} declare neither`);
      add('2.5', 'with nothing pinned, every real tool counts as unclassified (destructive): no preset can reach any of them', facts.tools.every((t) => t.classNow === 'destructive'), `${facts.tools.filter((t) => t.classNow === 'destructive').length} of ${facts.tools.length}`);
    } else {
      add('2.4', 'the provider\'s real tool list is recorded', null, `the server does not list tools without a signed-in account (tools/list → HTTP ${list.status ?? '?'})`);
      add('2.5', 'every real tool counts as unclassified', null, 'no tool list');
    }

    // ── 3. deny by default, before anything reaches the provider ─────────────
    let mark = calls.length;
    const d0 = await A.post(rpc('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'agent', version: '0' } }, 1));
    add('3.1', 'with no grant, agent A is refused (403) and the provider is never contacted', d0.status === 403 && sentSince(mark).length === 0, `HTTP ${d0.status}, ${sentSince(mark).length} upstream requests`);
    mark = calls.length;
    const d1 = await A.post(rpc('tools/call', { name: 'anything', arguments: {} }, 2));
    add('3.2', 'with no grant, a tool call is refused and never reaches the provider', (d1.status === 403 || errorCode(d1) === -32003) && sentSince(mark).length === 0, `HTTP ${d1.status}, ${sentSince(mark).length} upstream requests`);

    // ── 4. discovery by the broker itself ────────────────────────────────────
    mark = calls.length;
    const disc = await broker.discoverMcpTools(id);
    if (rawTools) add('4.1', 'the broker can load the provider\'s tool list itself (for the Access panel)', disc.ok && disc.tools.length === rawTools.length, disc.ok ? `${disc.tools.length} tools` : `refused: ${disc.code}`);
    else add('4.1', 'the broker can load the provider\'s tool list itself', null, `needs credentials (${disc.ok ? 'it worked' : disc.code})`);

    // ── choose the ONE read-only tool to grant ───────────────────────────────
    let tool = o.tool;
    if (!tool && rawTools) {
      const pick = facts.tools.find((t) => t.annotations.readOnlyHint === true && t.annotations.destructiveHint !== true && t.requiredArgs.length === 0);
      tool = pick && pick.name;
    }
    const args = o.args || {};
    const picked = facts.tools.find((t) => t.name === tool);
    const readOnly = !picked || picked.annotations.readOnlyHint === true;
    if (tool && picked && !readOnly) { add('4.2', `the tool chosen for the test (${tool}) is declared read-only by the provider`, false, 'REFUSING to grant a tool that is not declared read-only'); return await finish(); }
    if (tool) add('4.2', `the ONE tool that will be granted: ${tool}`, true, picked ? `readOnlyHint ${picked.annotations.readOnlyHint}, destructiveHint ${picked.annotations.destructiveHint}` : 'not in the list that could be loaded');
    else add('4.2', 'a read-only tool to grant', null, 'none could be chosen without a tool list; pass --tool');

    // ── 5. grant that one tool to agent A only ───────────────────────────────
    state.grants = tool ? { agents: { 'agent-A': { [id]: { preset: 'custom', allow: [tool] } } } } : {};
    const granted = new Set(tool ? [tool] : []);
    if (tool) {
      const i2 = await A.post(rpc('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'agent', version: '0' } }, 1));
      add('5.1', 'after the grant, agent A\'s `initialize` goes through the broker', i2.status === 200 && !!(i2.json && i2.json.result), `HTTP ${i2.status}${i2.json && i2.json.error ? ` (JSON-RPC error ${errorCode(i2)})` : ''}`);
      const l2 = await A.post(rpc('tools/list', undefined, 2));
      const names = l2.json && l2.json.result && Array.isArray(l2.json.result.tools) ? l2.json.result.tools.map((t) => t.name) : null;
      if (rawTools) add('5.2', 'agent A\'s tool list is FILTERED to the one granted tool', !!names && names.length === 1 && names[0] === tool, names ? `${names.length} tool(s) listed` : `HTTP ${l2.status}`);
      else add('5.2', 'agent A\'s tool list is filtered', null, `no tool list from the provider (HTTP ${l2.status})`);
      const bl = await B.post(rpc('tools/list', undefined, 2));
      add('5.3', 'agent B (no grant) is refused the tool list', bl.status === 403, `HTTP ${bl.status}`);
    }

    // ── 6. the granted read executes ────────────────────────────────────────
    if (tool) {
      mark = calls.length;
      const r = await A.post(rpc('tools/call', { name: tool, arguments: args }, 3));
      const result = r.json && r.json.result;
      facts.probes.readCall = { status: r.status, contentType: (r.headers['content-type'] || '').split(';')[0], isError: !!(result && result.isError), contentItems: Array.isArray(result && result.content) ? result.content.length : null };
      if (o.controller) add('6.1', `agent A executes the permitted read (${tool})`, r.status === 200 && !!result && !result.isError, `HTTP ${r.status}; ${facts.probes.readCall.contentItems ?? '?'} content item(s); contents are not recorded`);
      else add('6.1', `the permitted read (${tool}) meets the provider's 401 without credentials: the broker answers "sign in again", with no upstream text and no WWW-Authenticate`, r.status === 401 && errorCode(r) === undefined && !('www-authenticate' in r.headers) && !/Google|googleapis|slack|invalid_token|OAuth/i.test(r.body.toString('utf8')), `HTTP ${r.status}; ${toolCallsSince(mark).length} upstream attempt(s)`);
      add('6.2', 'exactly the permitted call (and no other tool call) reached the provider', toolCallsSince(mark).every((c) => granted.has(c.tool)) && toolCallsSince(mark).length >= 1, `${toolCallsSince(mark).length} upstream tool call attempt(s), all for ${tool}`);
    }

    // ── 7. isolation between agents ─────────────────────────────────────────
    if (tool) {
      mark = calls.length;
      const bTry = await B.post(rpc('tools/call', { name: tool, arguments: args }, 4));
      add('7.1', 'agent B\'s own capability cannot make the call that A\'s grant allows', bTry.status === 403 && sentSince(mark).length === 0, `HTTP ${bTry.status}, ${sentSince(mark).length} upstream requests`);
      const sid = (await A.post(rpc('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'agent', version: '0' } }, 5))).headers['mcp-session-id'];
      if (sid) { const stolen = await B.post(rpc('tools/list', undefined, 6), { 'mcp-session-id': sid }); add('7.2', 'agent B cannot use agent A\'s upstream session id', stolen.status === 404 || stolen.status === 403, `HTTP ${stolen.status}`); }
      else add('7.2', 'agent B cannot use agent A\'s upstream session id', null, 'this provider issues no session ids (stateless)');
      const restTok = broker.grant('agent-A', [id]);
      const wrongChannel = await httpCall(port, { method: 'POST', path: `/m/${id}`, headers: { authorization: `Bearer ${restTok}`, 'content-type': 'application/json' }, body: rpc('ping', undefined, 7) });
      add('7.3', 'a REST-channel token is no use on the MCP route', wrongChannel.status === 401, `HTTP ${wrongChannel.status}`);
      const sacrificial = broker.grantMcp('agent-S', [id]);
      broker.revokeMcp('agent-S');
      const dead = await as(sacrificial).post(rpc('ping', undefined, 8));
      add('7.4', 'a capability whose agent has ended is dead on the very next request', dead.status === 401, `HTTP ${dead.status}`);
      note('RISK (documented, not fixed): a capability is a bearer handle. An agent that READS another agent\'s capability string can use it, within THAT agent\'s grants. Files are denied between agents, but a process-tree binding (design D4) is not built.');
    }

    // ── 8. ungranted tools and write operations never reach the provider ─────
    {
      mark = calls.length;
      const names = facts.tools.map((t) => t.name).filter((n) => !granted.has(n));
      const synthetic = ['definitely_not_a_tool', 'x'.repeat(300), 'bad\nname', ...(tool ? [tool.toUpperCase(), ` ${tool}`, `${tool}​`] : [])];
      let refused = 0; let wrong = [];
      for (const n of [...names, ...synthetic]) {
        await new Promise((res) => setTimeout(res, 120));      // under the broker's own 10-a-second limit: this step checks permissions, not the limiter
        const r = await A.post(rpc('tools/call', { name: n, arguments: {} }, 9));
        if (errorCode(r) === -32003 || r.status === 400 || r.status === 403) refused++; else wrong.push(`${String(n).slice(0, 30)}→${r.status}`);
      }
      const writes = facts.tools.filter((t) => t.annotations.readOnlyHint !== true);
      add('8.1', `every other tool, including ${writes.length} write/destructive ones, and look-alike names, is refused`, wrong.length === 0, `${refused} refused${wrong.length ? `; NOT refused: ${wrong.slice(0, 5).join(', ')}` : ''}`);
      add('8.2', 'none of those calls reached the provider', toolCallsSince(mark).length === 0, `${toolCallsSince(mark).length} upstream tool calls`);
      mark = calls.length;
      const dup = await A.post(`{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"${[...granted][0] ?? 'x'}","name":"${(names[0] ?? 'y')}","arguments":{}}}`);
      const batch = await A.post(JSON.stringify([{ jsonrpc: '2.0', id: 11, method: 'ping' }, { jsonrpc: '2.0', id: 12, method: 'tools/list' }]));
      const batchRefused = Array.isArray(batch.json) && batch.json.length === 2 && batch.json.every((a) => a && a.error && a.error.code === -32003);
      // with a grant the body is READ and refused for what it says; with none, the door is already shut (403) before the body is read
      const bothRefused = tool ? (dup.status === 400 && batchRefused) : (dup.status === 403 && batch.status === 403);
      add('8.3', 'a body with a repeated key, and a tool list inside a batch, are refused before the provider', bothRefused && sentSince(mark).length === 0, `repeated key HTTP ${dup.status}; batch ${batchRefused ? 'refused (every item)' : `HTTP ${batch.status}`}; ${sentSince(mark).length} upstream requests${tool ? '' : ' (no grant: refused at the door, before the body is read)'}`);
    }

    // ── 9. a rejected credential: refresh and replay once (or tell the agent to sign in) ──
    if (tool) {
      mark = calls.length;
      poisoned = true;
      const r = await A.post(rpc('tools/call', { name: tool, arguments: args }, 13));
      const attempts = toolCallsSince(mark).length;
      const refreshes = sentSince(mark).filter((c) => c.kind === 'token-endpoint').length;
      facts.probes.rejectedCredential = { status: r.status, upstreamAttempts: attempts, refreshes };
      if (o.controller) add('9.1', 'the provider\'s real 401 for a bad token leads to a real refresh and ONE replay that succeeds', r.status === 200 && attempts === 2 && refreshes === 1, `HTTP ${r.status}; ${attempts} upstream attempts; ${refreshes} refresh(es)`);
      else add('9.1', 'the provider\'s real 401 for a bad token reaches the agent as "sign in again" (no WWW-Authenticate, no upstream text, no loop)', r.status === 401 && attempts <= 2 && !('www-authenticate' in r.headers) && !/invalid_token|googleapis|slack/i.test(r.body.toString('utf8')), `HTTP ${r.status}; ${attempts} upstream attempt(s)`);
    }

    // ── 10. token expiry and a failing refresh, with an agent already running ──
    if (tool && o.controller && o.hooks && o.hooks.advanceClock) {
      mark = calls.length;
      o.hooks.advanceClock(2 * HOUR);
      const r = await A.post(rpc('tools/call', { name: tool, arguments: args }, 14));
      watchSecrets();
      const refreshes = sentSince(mark).filter((c) => c.kind === 'token-endpoint').length;
      add('10.1', 'a running agent\'s next call after the token EXPIRES is served after exactly one real refresh', r.status === 200 && refreshes === 1, `HTTP ${r.status}; ${refreshes} refresh request(s)`);

      mark = calls.length;
      state.enabled = false;
      const off = await A.post(rpc('tools/call', { name: tool, arguments: args }, 15));
      add('10.2', 'switching the integration OFF while the agent runs: its next call is refused and never reaches the provider', off.status === 403 && sentSince(mark).length === 0, `HTTP ${off.status}, ${sentSince(mark).length} upstream requests`);
      state.enabled = true;

      o.hooks.advanceClock(2 * HOUR);
      netDown = true;
      mark = calls.length;
      const down = await A.post(rpc('tools/call', { name: tool, arguments: args }, 16));
      netDown = false;
      add('10.3', 'a TRANSIENT refresh failure (provider unreachable) while the agent runs: it is told "unavailable" (503), not "sign in", and the sign-in is kept', down.status === 503 && o.controller.status(id) === 'connected', `HTTP ${down.status}; status ${o.controller.status(id)}`);
      o.hooks.advanceClock(10_000);                      // the provider's cool-down is measured on the engine's own clock
      const up = await waitFor(async () => (await A.post(rpc('tools/call', { name: tool, arguments: args }, 17))).status === 200, 20_000);
      add('10.4', 'and when the provider is reachable again the very same agent carries on, with no new sign-in', up, up ? 'recovered' : 'did not recover within 20 s');
      watchSecrets();

      if (o.hooks.failureProvider) {
        const fp = await o.hooks.failureProvider();
        const b2 = makeBroker({ accessHeaders: (s) => fp.provider.accessHeaders(s), rejected: (s, u) => fp.provider.rejected && fp.provider.rejected(s, u) });
        extraBrokers.push(b2);
        const p2 = (await b2.start()).port;
        const c2 = b2.grantMcp('agent-A', [id]);
        mark = calls.length;
        const f1 = await as(c2, p2).post(rpc('tools/call', { name: tool, arguments: args }, 18));
        const f2 = await as(c2, p2).post(rpc('tools/call', { name: tool, arguments: args }, 19));
        const f3 = await as(c2, p2).post(rpc('tools/call', { name: tool, arguments: args }, 20));
        const refreshCalls = sentSince(mark).filter((c) => c.kind === 'token-endpoint').length;
        add('10.5', 'a PERMANENT refresh failure (the provider\'s real "invalid client" for a wrong secret): the agent is told to sign in again, and the provider is asked once, not on every call', [f1, f2, f3].every((x) => x.status === 401 && !('www-authenticate' in x.headers)) && refreshCalls === 1, `HTTP ${f1.status}/${f2.status}/${f3.status}; ${refreshCalls} request(s) to the token endpoint; engine says "${fp.status()}"`);
        if (fp.dispose) fp.dispose();
        add('10.6', 'the real sign-in was not touched by that experiment', o.controller.status(id) === 'connected', `status ${o.controller.status(id)}`);
      }
    } else {
      const why = o.controller ? 'these shift the engine\'s clock, which is only done on a throwaway profile' : 'needs a signed-in account';
      for (const n of ['10.1', '10.3', '10.4', '10.5']) add(n, 'token expiry and refresh failure with an agent already running', null, why);
      // switching off needs no account
      if (!tool) add('10.2', 'switching the integration OFF while the agent runs', null, 'no tool was granted in this run');
      if (tool) {
        mark = calls.length;
        state.enabled = false;
        const off = await A.post(rpc('tools/call', { name: tool, arguments: args }, 15));
        state.enabled = true;
        add('10.2', 'switching the integration OFF while the agent runs: its next call is refused and never reaches the provider', off.status === 403 && sentSince(mark).length === 0, `HTTP ${off.status}, ${sentSince(mark).length} upstream requests`);
      }
    }

    // ── 11. disconnect with an agent already running (account mode) ──────────
    if (tool && o.controller && o.hooks && o.hooks.disconnect) {
      watchSecrets();
      const t0 = o.controller.provider.tokens(id);
      const old = { access: t0.accessToken, refresh: t0.refreshToken };
      const cc = o.hooks.clientCredentials && o.hooks.clientCredentials();
      const order = [];
      const d = await o.hooks.disconnect({ onDisconnected: (x) => { broker.revokeIntegration(x); order.push('agents-cut'); } });
      add('11.1', 'Disconnect: access is cut for agents FIRST, then the provider is asked to revoke, then everything stored is wiped', d.ok && order[0] === 'agents-cut', d.ok ? `done; provider ${d.revoked ? 'CONFIRMED the revocation' : 'did NOT confirm the revocation'}` : `FAILED: ${d.error}`);
      mark = calls.length;
      const after = await A.post(rpc('tools/call', { name: tool, arguments: args }, 21));
      add('11.2', 'the running agent\'s very next call after Disconnect is refused, and never reaches the provider', after.status === 403 && sentSince(mark).length === 0, `HTTP ${after.status}, ${sentSince(mark).length} upstream requests`);
      add('11.3', 'the OAuth client and the tokens are gone from the store', o.controller.status(id) === 'unconfigured', `status ${o.controller.status(id)}`);
      // what the PROVIDER thinks of the old tokens (not our code: the provider's behaviour, recorded)
      const t1 = Date.now();
      let refusedAfterMs = null;
      while (Date.now() - t1 < 15_000) {
        const r = await directFetch(o.url, { method: 'POST', redirect: 'manual', headers: { authorization: `Bearer ${old.access}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: rpc('tools/call', { name: tool, arguments: args }, 22) });
        const isRefused = r.status === 401 || r.status === 403;
        try { await r.arrayBuffer(); } catch { /* noop */ }
        if (isRefused) { refusedAfterMs = Date.now() - t1; break; }
        await new Promise((res) => setTimeout(res, 1000));
      }
      facts.probes.oldAccessTokenRefusedAfterMs = refusedAfterMs;
      add('11.4', 'the PROVIDER refuses the old access token after revocation', refusedAfterMs !== null, refusedAfterMs !== null ? `refused after ${refusedAfterMs} ms` : 'the provider STILL ACCEPTED it for 15 s (provider behaviour; see the report)');
      if (cc && o.tokenEndpoint && old.refresh) {
        const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: old.refresh, client_id: cc.clientId, client_secret: cc.clientSecret }).toString();
        const r = await directFetch(o.tokenEndpoint, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body });
        const txt = await r.text(); let code = ''; try { const j = JSON.parse(txt); code = String(j.error || (j.ok === false ? j.error : '')).replace(/[^a-z_]/gi, '').slice(0, 40); } catch { /* not JSON */ }
        add('11.5', 'the PROVIDER refuses the old refresh token after revocation', r.status >= 400 || !!code, `HTTP ${r.status}${code ? `, ${code}` : ''}`);
      } else add('11.5', 'the provider refuses the old refresh token', null, 'client credentials or token not available');
    } else if (o.controller) {
      for (const n of ['11.1', '11.2', '11.3', '11.4', '11.5']) add(n, 'Disconnect with an agent already running', null, 'not requested (--keep-signin)');
    } else {
      for (const n of ['11.1', '11.2', '11.3', '11.4', '11.5']) add(n, 'Disconnect and revocation', null, 'needs a signed-in account');
    }
  } catch (e) {
    add('X', 'the gate itself ran without an unexpected error', false, String(e && e.message).slice(0, 160));
  }
  return finish();

  async function waitFor(fn, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) { try { if (await fn()) return true; } catch { /* retry */ } await new Promise((r) => setTimeout(r, 750)); }
    return false;
  }
}

// ─── terminal prompts (the secret is never echoed and never leaves this process) ─────

/** Read one line from the terminal. `hidden` turns the echo off. Rejects when there is no terminal. */
function promptLine(question, { hidden = false, input = process.stdin, output = process.stdout } = {}) {
  return new Promise((resolve, reject) => {
    if (!input.isTTY) { reject(new Error('this needs a terminal: stdin is not a TTY')); return; }
    output.write(question);
    let buf = '';
    const cleanup = () => { input.removeListener('data', onData); try { input.setRawMode(false); } catch { /* noop */ } input.pause(); };
    const onData = (chunk) => {
      for (const ch of String(chunk)) {
        if (ch === '\r' || ch === '\n') { cleanup(); output.write('\n'); resolve(buf.trim()); return; }
        if (ch === '\u0003') { cleanup(); output.write('\n'); reject(new Error('cancelled')); return; }
        if (ch === '\u007f' || ch === '\b') { buf = buf.slice(0, -1); if (!hidden) output.write('\b \b'); continue; }
        if (ch < ' ') continue;
        buf += ch;
        if (!hidden) output.write(ch);
      }
    };
    input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');
    input.on('data', onData);
  });
}

/**
 * Is what was typed shaped like an OAuth client id / secret? Only the SHAPE is checked, so a paste from the
 * wrong place (a sentence, a URL, a path) is caught before it is stored and before a browser is sent to a
 * consent screen that can only say "client not found". Nothing typed is ever echoed back in a message.
 */
function clientIdProblem(id, value) {
  const v = String(value ?? '');
  if (!v) return 'it was empty';
  if (/\s/.test(v)) return 'it contains spaces or line breaks, which no client ID does';
  if (v.length > 200) return 'it is far too long for a client ID';
  const google = /^[0-9]+-[A-Za-z0-9_]+\.apps\.googleusercontent\.com$/;
  const slack = /^[0-9]+\.[0-9]+$/;
  if ((id === 'slack' ? !slack.test(v) : !google.test(v))) {
    return id === 'slack' ? 'a Slack client ID looks like 1234567890123.1234567890123' : 'a Google client ID looks like 123456789012-abcdefg' + '.apps.googleusercontent.com';
  }
  return null;
}
function clientSecretProblem(value) {
  const v = String(value ?? '');
  if (v.length < 8) return 'it is too short to be a client secret';
  if (/\s/.test(v)) return 'it contains spaces or line breaks, which no client secret does';
  if (v.length > 256) return 'it is far too long for a client secret';
  return null;
}

// ─── command line ───────────────────────────────────────────────────────────

function parseArgs(argv) {
  const a = { positional: [], flags: new Set(), values: {} };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x.startsWith('--')) {
      const name = x.slice(2);
      if (['only', 'evidence', 'user-data', 'tool', 'args'].includes(name)) a.values[name] = argv[++i];
      else a.flags.add(name);
    } else a.positional.push(x);
  }
  return a;
}

function printSummary(title, res) {
  console.log(`\n${title}: ${res.steps.length - res.failed - res.skipped} passed, ${res.failed} FAILED, ${res.skipped} skipped (needs an account or not applicable)`);
  if (res.failed) for (const s of res.steps.filter((x) => x.ok === false)) console.log(`   FAILED [${s.n}] ${s.step}${s.detail ? ` — ${s.detail}` : ''}`);
}

function writeEvidence(file, payload) {
  const fs = require('node:fs');
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), { mode: 0o600 });
  console.log(`evidence (names, annotations, counts and codes only; no token, secret or tool output): ${file}`);
}

async function mainNoAccount(args) {
  const loadTs = require('../test/load-ts.cjs');
  const { MCP_CATALOG } = loadTs('src/shared/mcpCatalog.ts');
  const wanted = (args.values.only || 'gmail,google-calendar,google-drive,slack').split(',').map((x) => x.trim()).filter(Boolean);
  const runs = [];
  let anyFailed = false;
  for (const id of wanted) {
    const entry = MCP_CATALOG.find((e) => e.id === id);
    if (!entry || entry.spec.transport !== 'bridge') { console.error(`unknown integration: ${id}`); process.exit(2); }
    console.log(`\n══ ${entry.label} — REAL endpoint ${entry.spec.url}, NO credentials ══`);
    const res = await runGate({
      id, url: entry.spec.url, target: 'real',
      provider: { accessHeaders: () => ({ ok: true, headers: {} }) },   // adds no Authorization header at all
      allowHosts: [new URL(entry.spec.url).host],
      tokenEndpoint: entry.spec.oauth && entry.spec.oauth.tokenEndpoint,
      classification: { toolClasses: entry.spec.toolClasses, trustAnnotations: entry.spec.trustAnnotations === true },
      log: (l) => console.log(l)
    });
    printSummary(entry.label, res);
    anyFailed = anyFailed || !res.ok;
    runs.push({ id, mode: 'real-endpoint-no-account', ok: res.ok, failed: res.failed, skipped: res.skipped, steps: res.steps, facts: res.facts });
  }
  const file = args.values.evidence || `phase4-evidence-no-account-${Date.now()}.json`;
  writeEvidence(file, { generatedAt: new Date().toISOString(), node: process.version, mode: 'real endpoints, no credentials', runs });
  console.log(anyFailed ? '\nSome checks FAILED.' : '\nNo check failed. Steps marked SKIP were NOT exercised: they need a signed-in account.');
  process.exit(anyFailed ? 1 : 0);
}

async function mainAccount(args) {
  const path = require('node:path');
  const os = require('node:os');
  const fs = require('node:fs');
  const loadTs = require('../test/load-ts.cjs');
  const id = args.positional[0];
  const { mcpCatalogEntry, mcpRedirectUri, mcpOauthRef, mcpSecretRefs } = loadTs('src/shared/mcpCatalog.ts');
  const entry = id ? mcpCatalogEntry(id) : undefined;
  if (!entry || entry.spec.transport !== 'bridge' || !entry.spec.oauth) {
    console.error('usage: npx electron tools/verify-broker-live.cjs <gmail|google-calendar|google-drive|slack> --account [--prompt-client] [--use-app-profile] [--user-data <dir>] [--tool <name> --args \'<json>\'] [--keep-signin] [--evidence <file>]');
    process.exit(2);
  }
  if (!process.versions.electron) { console.error(`The account run needs Electron (the encrypted store). Run:  npx electron tools/verify-broker-live.cjs ${id} --account`); process.exit(2); }

  const { app, shell } = require('electron');
  const pkg = require('../package.json');
  app.setName(pkg.productName);
  const explicit = args.values['user-data'] ? path.resolve(args.values['user-data']) : null;
  const useApp = args.flags.has('use-app-profile');
  const throwaway = !explicit && !useApp;
  if (throwaway && args.flags.has('keep-signin')) { console.error('--keep-signin needs --use-app-profile or --user-data (a throwaway profile is deleted at the end, which would leave the sign-in alive at the provider)'); process.exit(2); }
  const profile = explicit || (useApp ? app.getPath('userData') : fs.mkdtempSync(path.join(os.tmpdir(), `mosbius-gate-${id}-`)));
  // a throwaway profile is removed on EVERY way out, including a failure before the gate starts
  const cleanup = () => { if (throwaway) { try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 }); return true; } catch { return false; } } return true; };
  const bail = (code, message) => { if (message) console.error(message); cleanup(); app.exit(code); };
  process.on('uncaughtException', (e) => { console.error('verify-broker-live failed:', e && e.message); bail(1); });
  // Ctrl-C (or a kill) while a sign-in is waiting in the browser must not leave the profile behind. Electron turns
  // SIGINT/SIGTERM into an ordinary quit (a handler on `process` is NOT what runs), so the quit itself cleans up.
  app.on('quit', () => { cleanup(); });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => bail(130, `interrupted (${sig})`));
  if (profile !== app.getPath('userData')) app.setPath('userData', profile);
  await app.whenReady();
  if (process.platform === 'darwin' && app.dock) app.dock.hide();
  // Two processes on one encrypted store can destroy a rotated sign-in (see the Phase 4 report), so the gate
  // refuses to run beside the app: the app holds this profile's single-instance lock while it is open.
  if (!app.requestSingleInstanceLock()) return bail(2, 'The app (or another gate run) is open on this profile. Close it, or use the default throwaway profile.');

  const integrations = loadTs('src/main/integrations.ts');
  const { OAuthController } = loadTs('src/main/oauth/controller.ts');
  const { safeLog } = loadTs('src/main/oauth/types.ts');
  const { disconnectBridged } = loadTs('src/main/mcpDisconnect.ts');
  const { McpAuthVault } = loadTs('src/main/mcpAuthVault.ts');

  console.log(`profile: ${profile}${throwaway ? '  (throwaway: deleted at the end)' : ''}`);
  console.log(`redirect URI that must be registered with the provider: ${mcpRedirectUri(entry.spec.callbackPort)}`);
  console.log(`scopes requested: ${entry.spec.oauth.scope ?? entry.spec.scope ?? '(none)'}`);

  if (args.flags.has('prompt-client')) {
    const [idRef, secretRef] = mcpSecretRefs(entry);
    let clientId; let clientSecret;
    try {
      for (let attempt = 1; ; attempt++) {
        clientId = await promptLine('OAuth client ID: ');
        const why = clientIdProblem(id, clientId);
        if (!why) break;
        console.log(`That is not a client ID: ${why}. Nothing was stored.`);
        if (attempt >= 3) return bail(2, 'giving up after three tries: copy the client ID from Google Cloud Console, APIs & Services, Credentials');
      }
      for (let attempt = 1; ; attempt++) {
        clientSecret = await promptLine('OAuth client secret (not echoed): ', { hidden: true });
        const why = clientSecretProblem(clientSecret);
        if (!why) break;
        console.log(`That is not a client secret: ${why}. Nothing was stored.`);
        if (attempt >= 3) return bail(2, 'giving up after three tries');
      }
    } catch (e) { return bail(2, `verify-broker-live failed: ${e && e.message}`); }
    const a = integrations.setSecret(idRef, clientId); const b = integrations.setSecret(secretRef, clientSecret);
    if (!a.ok || !b.ok) return bail(2, 'the encrypted store refused the client');
    console.log('client stored in this profile\'s encrypted store.\n');
  }

  const clock = { offset: 0 };
  const secretsIO = { get: integrations.getSecret, set: integrations.setSecret, has: integrations.hasSecret, readable: integrations.secretStoreReadable };
  const build = (secrets, extra = {}) => new OAuthController({
    entry: mcpCatalogEntry, secrets, fetch: (u, i) => fetch(u, i),
    openUrl: async (url) => { if (!/^https:\/\//i.test(url)) throw new Error('refused'); await shell.openExternal(url); },
    now: () => Date.now() + clock.offset + (extra.extraOffset || 0),
    log: safeLog((line) => console.log('[oauth]', line))
  });
  const controller = build(secretsIO);
  const vault = new McpAuthVault(() => path.join(app.getPath('userData'), 'mcp-auth'), { get: integrations.getSecret, set: integrations.setSecret, delete: integrations.deleteSecret });
  const clientCredentials = () => {
    const [idRef, secretRef] = mcpSecretRefs(entry);
    const clientId = integrations.getSecret(idRef); const clientSecret = integrations.getSecret(secretRef);
    return clientId && clientSecret ? { clientId, clientSecret } : undefined;
  };
  const hosts = [entry.spec.url, entry.spec.oauth.tokenEndpoint, entry.spec.revoke && entry.spec.revoke.url, entry.spec.oauth.authorizationEndpoint].filter(Boolean).map((u) => new URL(u).host);

  const res = await runGate({
    id, url: entry.spec.url, target: 'real', provider: controller.provider, controller,
    allowHosts: [...new Set(hosts)], tokenEndpoint: entry.spec.oauth.tokenEndpoint, revokeEndpoint: entry.spec.revoke && entry.spec.revoke.url,
    classification: { toolClasses: entry.spec.toolClasses, trustAnnotations: entry.spec.trustAnnotations === true },
    tool: args.values.tool, args: args.values.args ? JSON.parse(args.values.args) : undefined,
    log: (l) => console.log(l),
    hooks: {
      // shifting the engine's clock writes shifted expiry times into the store: only a throwaway profile may take that
      advanceClock: throwaway ? (ms) => { clock.offset += ms; } : undefined,
      clientCredentials,
      restartCheck: async () => { const c2 = build(secretsIO); const r = { status: c2.status(id), hasTokens: c2.hasTokens(id) }; c2.dispose(); return r; },
      // an engine with the WRONG client secret and a copy of the tokens, in memory only: the real sign-in is never touched
      failureProvider: async () => {
        const [idRef, secretRef] = mcpSecretRefs(entry);
        const mem = new Map([[idRef, integrations.getSecret(idRef)], [secretRef, 'gate-wrong-client-secret'], [mcpOauthRef(id), integrations.getSecret(mcpOauthRef(id))]]);
        const c3 = build({ get: (r) => mem.get(r), set: (r, v) => { mem.set(r, v); return { ok: true }; }, has: (r) => mem.has(r), readable: () => true }, { extraOffset: 2 * 3_600_000 });
        return { provider: c3.provider, status: () => c3.status(id), dispose: () => c3.dispose() };
      },
      disconnect: args.flags.has('keep-signin') ? undefined : ({ onDisconnected }) => disconnectBridged({
        cancelSignIn: (x) => controller.cancel(x), vault,
        revoke: async () => ({ attempted: 0, confirmed: 0 }),
        secrets: { delete: integrations.deleteSecret, has: integrations.hasSecret },
        broker: { hasTokens: (x) => controller.hasTokens(x), revoke: (x) => controller.revoke(x), forget: (x) => controller.forget(x) },
        onDisconnected
      }, entry)
    }
  });
  printSummary(entry.label, res);
  const file = args.values.evidence || path.join(process.cwd(), `phase4-evidence-${id}-${Date.now()}.json`);
  writeEvidence(file, { generatedAt: new Date().toISOString(), electron: process.versions.electron, node: process.versions.node, platform: process.platform, mode: 'real account', integration: id, ok: res.ok, failed: res.failed, skipped: res.skipped, steps: res.steps, facts: res.facts });
  controller.dispose();
  if (throwaway) console.log(cleanup() ? 'throwaway profile deleted.' : `could not delete ${profile}; delete it by hand.`);
  console.log(res.ok
    ? '\nOnly the steps listed above were exercised. Anything not listed (or SKIP) is still unverified.'
    : '\nSome steps FAILED. Nothing is verified until they pass.');
  app.exit(res.ok ? 0 : 1);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.flags.has('no-account')) return mainNoAccount(args);
  if (args.flags.has('account')) return mainAccount(args);
  console.error('usage: node tools/verify-broker-live.cjs --no-account [--only <ids>] [--evidence <file>]\n       npx electron tools/verify-broker-live.cjs <id> --account [--prompt-client] ...');
  process.exit(2);
}

module.exports = { runGate, readRpc, httpCall, short, promptLine, parseArgs, clientIdProblem, clientSecretProblem };

const isEntry = require.main === module
  || (!!process.versions.electron && require('node:path').resolve(process.argv[1] || '') === __filename);
if (isEntry) {
  if (process.versions.electron) setTimeout(() => { console.error('verify-broker-live: gave up after 20 minutes'); process.exit(1); }, 20 * 60_000).unref();
  main().catch((e) => { console.error('verify-broker-live failed:', e && e.message); process.exit(1); });
}
