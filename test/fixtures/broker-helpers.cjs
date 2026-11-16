'use strict';

/**
 * Shared helpers for the broker test files: a plain HTTP client that never
 * follows redirects or retries, a recording upstream, and a stand-in MCP server.
 */
const http = require('node:http');

/** A recording upstream. `handler(req, res, entry)` may answer; the default is 200 "ok". */
function startUpstream(t, handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const entry = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) };
      seen.push(entry);
      if (handler) return handler(req, res, entry);
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      t.after(() => { server.closeAllConnections?.(); server.close(); });
      resolve({ server, seen, base: `http://127.0.0.1:${server.address().port}`, port: server.address().port, last: () => seen[seen.length - 1] });
    });
  });
}

/** Plain HTTP client. Resolves `{status, headers, body}` or `{error}`. */
function call(port, { method = 'GET', path = '/', headers = {}, body, host } = {}) {
  if (body !== undefined && !headers['content-length'] && ['GET', 'HEAD', 'DELETE', 'OPTIONS'].includes(method)) {
    headers = { ...headers, 'content-length': String(Buffer.byteLength(body)) };
  }
  if (host) headers = { ...headers, host };
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

/** Open a streaming request and hand back the response as soon as headers arrive. */
function open(port, { method = 'GET', path = '/', headers = {} } = {}) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers, agent: false }, (res) => {
      const events = { chunks: [], ended: false, error: null, closed: false };
      res.on('data', (c) => events.chunks.push(c));
      res.on('end', () => { events.ended = true; });
      res.on('error', (e) => { events.error = e.code || e.message; });
      res.on('close', () => { events.closed = true; });
      resolve({ status: res.statusCode, headers: res.headers, res, req, events, text: () => Buffer.concat(events.chunks).toString() });
    });
    req.on('error', (e) => resolve({ error: e.code || e.message }));
    req.end();
  });
}

const until = async (fn, ms = 3000, step = 10) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, step));
  }
  return null;
};

const json = (r) => JSON.parse(r.body.toString('utf8'));
const bearer = (token) => ({ authorization: `Bearer ${token}` });
const rpc = (method, params, id) => JSON.stringify({ jsonrpc: '2.0', ...(id !== undefined ? { id } : {}), method, ...(params ? { params } : {}) });

const DEFAULT_TOOLS = [
  { name: 'get_thing', description: 'reads', annotations: { readOnlyHint: true } },
  { name: 'put_thing', description: 'writes' },
  { name: 'send_thing', description: 'sends', annotations: { destructiveHint: true } },
  { name: 'mystery_thing', description: 'unclassified' }
];

/**
 * A stand-in for a protected MCP server (Streamable HTTP): bearer-protected,
 * answers initialize / tools/list / tools/call, speaks SSE on GET, and can be
 * told to misbehave through `config`.
 */
async function startMcpUpstream(t, { token = 'UPSTREAM-TOKEN', tools = DEFAULT_TOOLS } = {}) {
  const config = { listAs: 'json', redirect: false, tools, silentStream: false };
  let sessionCounter = 0;
  const up = await startUpstream(t, (req, res, entry) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, {
        'content-type': 'application/json',
        'www-authenticate': 'Bearer resource_metadata="http://upstream.invalid/.well-known/oauth-protected-resource"'
      });
      return res.end('{"error":"unauthorized"}');
    }
    if (config.redirect) { res.writeHead(302, { location: 'http://elsewhere.invalid/' }); return res.end(); }
    if (req.method === 'DELETE') { res.writeHead(200); return res.end(); }
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'set-cookie': 'sid=1', 'x-internal': 'do-not-forward' });
      res.flushHeaders();
      if (!config.silentStream) res.write('event: message\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{"n":1}}\n\n');
      entry.res = res;
      res.on('close', () => { entry.closed = true; });
      return;
    }
    let msg;
    try { msg = JSON.parse(entry.body.toString()); } catch { res.writeHead(400); return res.end(); }
    const batch = Array.isArray(msg);
    const answers = [];
    const headers = { 'content-type': 'application/json', 'set-cookie': 'sid=1', 'x-internal': 'do-not-forward', 'cache-control': 'no-store' };
    for (const m of batch ? msg : [msg]) {
      if (m.method === undefined || m.id === undefined) continue;
      if (m.method === 'initialize') {
        headers['mcp-session-id'] = `sess-${++sessionCounter}`;
        answers.push({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'stand-in', version: '0' } } });
      } else if (m.method === 'tools/list') {
        if (config.listAs === 'sse') {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          return res.end(`data: ${JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { tools: config.tools } })}\n\n`);
        }
        if (config.listAs === 'malformed') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{not json'); }
        if (config.listAs === 'error') answers.push({ jsonrpc: '2.0', id: m.id, error: { code: -32000, message: 'upstream tool list failed' } });
        else if (config.listAs === 'weird') answers.push({ jsonrpc: '2.0', id: m.id, result: { tools: 'not-an-array' } });
        else answers.push({ jsonrpc: '2.0', id: m.id, result: { tools: config.tools, nextCursor: 'page-2' } });
      } else if (m.method === 'tools/call') {
        answers.push({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: `called ${m.params && m.params.name}` }] } });
      } else {
        answers.push({ jsonrpc: '2.0', id: m.id, result: {} });
      }
    }
    if (!answers.length) { res.writeHead(202, headers); return res.end(); }
    res.writeHead(200, headers);
    res.end(JSON.stringify(batch ? answers : answers[0]));
  });
  return { ...up, config, token, calls: () => up.seen.filter((e) => e.method === 'POST') };
}

module.exports = { startUpstream, startMcpUpstream, call, open, until, json, bearer, rpc, DEFAULT_TOOLS };
