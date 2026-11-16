#!/usr/bin/env node
'use strict';

/**
 * A stand-in MCP server over stdio, for the host tests. It records what it is asked and how it
 * was started to the file named by FAKE_LOG (one JSON object per line), and misbehaves on demand
 * through tool names: `hang` never answers, `die` exits, `ask` makes requests of its client,
 * `noise` prints a line that is not JSON, `grandchild` starts a child process of its own.
 */
const fs = require('node:fs');
const readline = require('node:readline');
const { spawn } = require('node:child_process');

const log = process.env.FAKE_LOG;
const note = (e) => { if (log) fs.appendFileSync(log, JSON.stringify(e) + '\n'); };
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
note({ ev: 'start', pid: process.pid, env: Object.keys(process.env).sort(), cwd: process.cwd(), args: process.argv.slice(2),
  secret: process.env.NOTION_TOKEN || process.env.BRAVE_API_KEY || process.env.FAKE_SECRET });

const waiting = new Map(); // server-request id -> callback
let asking = null;
const rl = readline.createInterface({ input: process.stdin });
rl.on('close', () => { note({ ev: 'stdin-closed' }); process.exit(0); });
rl.on('line', (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (typeof m.method !== 'string') {                       // an answer to something this server asked
    note({ ev: 'answer', id: m.id, result: m.result, error: m.error });
    const cb = waiting.get(m.id);
    if (cb) { waiting.delete(m.id); cb(m); }
    return;
  }
  note({ ev: 'recv', method: m.method, id: m.id, params: m.method === 'initialize' ? m.params : undefined });
  if (m.method === 'initialize') {
    return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } });
  }
  if (m.method === 'notifications/initialized') {
    send({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'hello' } });
    return;
  }
  if (m.method === 'tools/list') {
    return send({ jsonrpc: '2.0', id: m.id, result: { tools: [
      { name: 'echo', description: 'echo', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
      { name: 'hang', inputSchema: { type: 'object' } },
      { name: 'slow_write', inputSchema: { type: 'object' } }
    ] } });
  }
  if (m.method === 'tools/call') {
    const n = m.params && m.params.name;
    const text = (t) => send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: t }] } });
    if (n === 'echo') return text(JSON.stringify(m.params.arguments ?? {}));
    if (n === 'hang') return;
    if (n === 'slow_write') {                              // an operation that has an effect, then takes its time
      const a = m.params.arguments || {};
      if (a.file) fs.writeFileSync(a.file, 'written-before-revocation');
      note({ ev: 'slow_write-started', file: a.file });
      return setTimeout(() => text('slow_write done'), a.ms || 1500);
    }
    if (n === 'die') { note({ ev: 'dying' }); process.exit(3); }
    if (n === 'noise') { process.stdout.write('this is a log line, not json\n'); return text('after noise'); }
    if (n === 'grandchild') {
      const c = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
      note({ ev: 'grandchild', pid: c.pid });
      return text(String(c.pid));
    }
    if (n === 'ask') {
      const got = {};
      const ask = (id, method, params) => new Promise((res) => { waiting.set(id, (r) => { got[method] = r; res(); }); send({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }); });
      asking = Promise.all([ask('p1', 'ping'), ask('r1', 'roots/list'), ask('s1', 'sampling/createMessage', { messages: [] })])
        .then(() => text(JSON.stringify(got)));
      return;
    }
    return text(`unknown tool ${n}`);
  }
  if (typeof m.id !== 'undefined') send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } });
});
