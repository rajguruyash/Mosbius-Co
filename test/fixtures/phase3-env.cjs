'use strict';

/**
 * The Phase 3 assembly, shared by the integration tests and the real-client check: the
 * in-app OAuth engine, the broker with its MCP route, the wiring rules and the hive, with a
 * stand-in OAuth provider and a stand-in MCP server behind them. `spawn()` and `teardown()`
 * mirror the spawn and teardown code in src/main/index.ts (test/mcp-route.test.cjs pins the
 * shape of that code, so the two cannot drift apart unseen).
 */
const http = require('node:http');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startIdp } = require('./oauth-idp.cjs');
const { makeEnv } = require('./oauth-env.cjs');
const { call, open } = require('./broker-helpers.cjs');
const loadTs = require('../load-ts.cjs');

const { IntegrationBroker } = loadTs('src/main/integrationBroker.ts');
const { HiveManager } = loadTs('src/main/hive.ts');
const { AuditLog } = loadTs('src/main/broker/audit.ts');
const { mcpIntegrationFor, eligibleIntegrationIds, sanitizeMcpGrants } = loadTs('src/main/mcpWiring.ts');
const { mcpOauthRef } = loadTs('src/shared/mcpCatalog.ts');

async function assemble(t, { ids = ['gmail'], grants = {}, classes, idpOpts, envOpts, upstreamUrl } = {}) {
  const idp = await startIdp(t, idpOpts);
  const env = await makeEnv(t, idp, { ids, ...envOpts });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mosbius-p3-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const cfg = {
    mcpEngine: Object.fromEntries(ids.map((i) => [i, 'broker'])),
    mcpDefaults: Object.fromEntries(ids.map((i) => [i, { enabled: true }])),
    mcpGrants: grants
  };
  const audit = new AuditLog();
  const broker = new IntegrationBroker({ getRecord: () => undefined, getSecret: () => undefined }, {
    mcp: {
      // the catalogue's real rules, with the upstream pointed at the stand-in (and, optionally, classes pinned)
      resolve: (id) => {
        const i = mcpIntegrationFor(id, cfg);
        return i ? { ...i, url: (typeof upstreamUrl === 'function' ? upstreamUrl() : upstreamUrl) ?? `${idp.issuer}/mcp`, ...(classes ? { classification: { toolClasses: classes } } : {}) } : undefined;
      },
      credentials: { accessHeaders: (s) => env.controller.provider.accessHeaders(s), rejected: (s, used) => env.controller.provider.rejected(s, used) },
      grants: () => sanitizeMcpGrants(cfg.mcpGrants),
      audit: (e) => audit.push(e)
    }
  });
  const started = await broker.start();
  assert.equal(started.ok, true);
  t.after(() => broker.stop());
  const hive = new HiveManager(() => home);
  const owners = new Map();

  const ctx = {
    idp, env, cfg, broker, hive, home, audit, owners,
    /** What index.ts does for a Claude agent, step for step. */
    async spawn(agentId, ptyId = `pty-${agentId}`) {
      const mcpIds = eligibleIntegrationIds(cfg, agentId, (id) => env.controller.status(id), Date.now());
      let token;
      if (mcpIds.length > 0) { token = broker.grantMcp(agentId, mcpIds); owners.set(agentId, ptyId); }
      const inj = await hive.ensureAgent({ id: agentId, name: agentId, provider: 'claude', cwd: home }, {
        mcpDefaults: cfg.mcpDefaults,
        mcpBroker: (cid) => (token !== undefined && mcpIds.includes(cid) ? { url: `${broker.url()}/m/${cid}`, authorization: `Bearer ${token}` } : undefined)
      });
      return { inj, token, mcpIds, file: path.join(home, 'hive', 'agents', agentId, 'mcp-config.json') };
    },
    /** teardownPty's MCP part. */
    teardown(agentId, ptyId = `pty-${agentId}`) {
      if (owners.get(agentId) === ptyId) { owners.delete(agentId); broker.revokeMcp(agentId); hive.removeMcpConfig(agentId); }
    },
    /** The agent's CLI: reads its config file and does what it says. */
    agent(file, id = 'gmail') {
      const c = JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers[`mosbius-${id}`];
      const u = new URL(c.url);
      const base = { ...c.headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
      return {
        config: c,
        post: (body, extra = {}) => call(Number(u.port), { method: 'POST', path: u.pathname, headers: { ...base, ...extra }, body }),
        stream: () => open(Number(u.port), { path: u.pathname, headers: { ...base, accept: 'text/event-stream' } })
      };
    },
    async signIn(id = 'gmail') {
      assert.deepEqual(await env.controller.signIn(id), { ok: true });
      await Promise.all(env.pendingBrowse);
    },
    record: (id = 'gmail') => JSON.parse(env.secrets.map.get(mcpOauthRef(id))),
    upstreamAuth: () => idp.requests('/mcp').map((r) => r.headers.authorization)
  };
  return ctx;
}

function until(fn, ms = 4000) {
  return new Promise((resolve) => {
    const end = Date.now() + ms;
    const tick = async () => { const v = await fn(); if (v) return resolve(v); if (Date.now() > end) return resolve(null); setTimeout(tick, 15); };
    tick();
  });
}


/**
 * A stand-in MCP server that a real MCP client can talk to: it checks the bearer against the
 * stand-in provider's live access tokens, answers initialize / ping / tools/list / tools/call,
 * acknowledges notifications, and has no event stream to offer (405 on GET, as the spec allows).
 */
function startOauthMcpServer(t, idp, { tools, listAsStream = false } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let rpc = {};
      try { rpc = JSON.parse(raw || '{}'); } catch { /* not json */ }
      seen.push({ method: req.method, headers: { ...req.headers }, rpc });
      const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      if (!idp.liveAccessTokens().includes(token)) {
        res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer error="invalid_token"' });
        return res.end('{"error":"invalid_token"}');
      }
      if (req.method === 'GET') { res.writeHead(405); return res.end(); }
      if (req.method === 'DELETE') { res.writeHead(200); return res.end(); }
      if (rpc.id === undefined) { res.writeHead(202); return res.end(); }
      const reply = (result) => {
        const body = JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result });
        if (listAsStream && rpc.method === 'tools/list') { res.writeHead(200, { 'content-type': 'text/event-stream' }); return res.end(`event: message\ndata: ${body}\n\n`); }
        res.writeHead(200, { 'content-type': 'application/json', ...(rpc.method === 'initialize' ? { 'mcp-session-id': 'stand-in-session' } : {}) });
        res.end(body);
      };
      if (rpc.method === 'initialize') return reply({ protocolVersion: rpc.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'stand-in', version: '0' } });
      if (rpc.method === 'tools/list') return reply({ tools });
      if (rpc.method === 'tools/call') return reply({ content: [{ type: 'text', text: `called ${rpc.params?.name}` }] });
      if (rpc.method === 'ping') return reply({});
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: 'Method not found' } }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    t.after(() => { server.closeAllConnections?.(); server.close(); });
    resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}/mcp` });
  }));
}

module.exports = { assemble, until, startOauthMcpServer };
