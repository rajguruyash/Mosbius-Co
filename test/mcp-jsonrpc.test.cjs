'use strict';

/**
 * JSON-RPC parsing and the tool-list filter. The body comes from an agent that
 * may have been prompt-injected, so every test here is also a statement that
 * nothing throws and nothing leaks.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const loadTs = require('./load-ts.cjs');

const {
  parseRpcBody, isRequest, rpcError, filterToolsResult, MAX_BATCH,
  RPC_PARSE_ERROR, RPC_INVALID_REQUEST, RPC_NOT_PERMITTED
} = loadTs('src/main/broker/jsonrpc.ts');

const buf = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v));

test('a single request, a notification and a response are all valid messages', () => {
  const req = parseRpcBody(buf({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
  assert.equal(req.ok, true);
  assert.equal(req.batch, false);
  assert.equal(isRequest(req.messages[0]), true);

  const note = parseRpcBody(buf({ jsonrpc: '2.0', method: 'notifications/initialized' }));
  assert.equal(note.ok, true);
  assert.equal(isRequest(note.messages[0]), false);

  for (const reply of [{ jsonrpc: '2.0', id: 'a', result: {} }, { jsonrpc: '2.0', id: 2, error: { code: -1, message: 'x' } }]) {
    const r = parseRpcBody(buf(reply));
    assert.equal(r.ok, true);
    assert.equal(isRequest(r.messages[0]), false);
    assert.equal(r.messages[0].method, undefined);
  }
});

test('an id that is not a finite number or a string is refused, including 1e999999', () => {
  for (const raw of ['{"jsonrpc":"2.0","id":1e999999,"method":"ping"}', '{"jsonrpc":"2.0","id":-1e999999,"method":"ping"}']) {
    assert.equal(parseRpcBody(Buffer.from(raw)).ok, false, raw);
  }
});

test('string, number and null ids are accepted; other id types are not', () => {
  for (const id of ['x', 0, 7, -3.5, null]) assert.equal(parseRpcBody(buf({ jsonrpc: '2.0', id, method: 'ping' })).ok, true, String(id));
  for (const id of [true, {}, [], 'x'.length === 1 ? { a: 1 } : 0]) assert.equal(parseRpcBody(buf({ jsonrpc: '2.0', id, method: 'ping' })).ok, false, JSON.stringify(id));
});

test('a batch is parsed whole and bounded', () => {
  const ok = parseRpcBody(buf([{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/x' }]));
  assert.equal(ok.ok, true);
  assert.equal(ok.batch, true);
  assert.equal(ok.messages.length, 2);

  assert.equal(parseRpcBody(buf([])).ok, false, 'an empty batch is invalid');
  const big = Array.from({ length: MAX_BATCH + 1 }, (_, i) => ({ jsonrpc: '2.0', id: i, method: 'ping' }));
  const refused = parseRpcBody(buf(big));
  assert.equal(refused.ok, false);
  assert.equal(refused.code, RPC_INVALID_REQUEST);
  assert.equal(parseRpcBody(buf(big.slice(0, MAX_BATCH))).ok, true);
  assert.equal(parseRpcBody(buf([{ jsonrpc: '2.0', id: 1, method: 'ping' }, 'junk'])).ok, false, 'one bad item spoils the batch');
});

test('bad JSON is a parse error; bad shapes are invalid requests', () => {
  const parse = parseRpcBody(buf('{not json'));
  assert.deepEqual([parse.ok, parse.code], [false, RPC_PARSE_ERROR]);
  assert.equal(parseRpcBody(buf('')).code, RPC_PARSE_ERROR);
  for (const bad of [null, 5, 'x', true, {}, { jsonrpc: '1.0', id: 1, method: 'x' }, { id: 1, method: 'x' }, { jsonrpc: '2.0', id: 1 },
    { jsonrpc: '2.0', id: 1, method: 5 }, { jsonrpc: '2.0', id: 1, method: '' }, { jsonrpc: '2.0', id: 1, method: 'a b' },
    { jsonrpc: '2.0', id: 1, method: 'x'.repeat(129) }, { jsonrpc: '2.0', id: 1, method: 'a\nb' }, { jsonrpc: '2.0', id: 1, method: '../etc' + '\u0000' }]) {
    const r = parseRpcBody(Buffer.from(JSON.stringify(bad)));
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.equal(r.code, RPC_INVALID_REQUEST);
  }
});

test('rpcError builds a standard error response, with a null id when there is none', () => {
  assert.deepEqual(rpcError(3, RPC_NOT_PERMITTED, 'no'), { jsonrpc: '2.0', id: 3, error: { code: -32003, message: 'no' } });
  assert.equal(rpcError(undefined, RPC_PARSE_ERROR, 'x').id, null);
  assert.equal(rpcError(null, RPC_PARSE_ERROR, 'x').id, null);
});

test('hostile keys in a message cannot pollute anything', () => {
  const body = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted2":true}},"name":"x"}}';
  const r = parseRpcBody(buf(body));
  assert.equal(r.ok, true);
  assert.equal({}.polluted, undefined);
  assert.equal({}.polluted2, undefined);
  assert.equal(Object.prototype.polluted, undefined);
});

test('absurd input never throws: deep nesting, huge numbers, odd unicode, binary', () => {
  const deep = '['.repeat(100_000) + ']'.repeat(100_000);
  for (const input of [deep, '{"jsonrpc":"2.0","id":1e999999,"method":"x"}', '{"jsonrpc":"2.0","id":1,"method":"\\ud800"}',
    Buffer.from([0xff, 0xfe, 0, 1, 2]), Buffer.alloc(1_000_000, 0x7b), '\u0000'.repeat(1000), '"' + 'a'.repeat(2_000_000) + '"']) {
    assert.doesNotThrow(() => parseRpcBody(buf(input)));
    assert.equal(parseRpcBody(buf(input)).ok, false);
  }
});

test('random bytes and random JSON-ish text never throw and are never accepted by accident', () => {
  let accepted = 0;
  for (let i = 0; i < 3000; i++) {
    const size = 1 + (crypto.randomBytes(1)[0] % 200);
    const r = parseRpcBody(crypto.randomBytes(size));
    if (r.ok) accepted++;
  }
  const alphabet = '{}[]":,0123456789.-etfnulsrai jsonpcvd';
  for (let i = 0; i < 3000; i++) {
    const n = 1 + (crypto.randomBytes(1)[0] % 80);
    let s = '';
    for (let j = 0; j < n; j++) s += alphabet[crypto.randomBytes(1)[0] % alphabet.length];
    assert.doesNotThrow(() => parseRpcBody(buf(s)));
  }
  assert.equal(accepted, 0);
});

// ─── tools/list filtering ───────────────────────────────────────────────────

const tool = (name, extra = {}) => ({ name, description: `d-${name}`, inputSchema: { type: 'object' }, ...extra });

test('the filter keeps only permitted tools, in order, with everything else about them intact', () => {
  const result = { tools: [tool('a'), tool('b', { annotations: { readOnlyHint: true } }), tool('c')], nextCursor: 'page-2' };
  const out = filterToolsResult(result, (t) => t.name !== 'b');
  assert.deepEqual(out.tools.map((t) => t.name), ['a', 'c']);
  assert.deepEqual(out.tools[0], tool('a'));
  assert.equal(out.nextCursor, 'page-2');
  assert.equal(result.tools.length, 3, 'the original is not mutated');
});

test('a list that cannot be read is an EMPTY list, never a pass-through', () => {
  for (const bad of [undefined, null, 5, 'x', [], {}, { tools: 'all' }, { tools: null }, { tools: { a: 1 } }]) {
    assert.deepEqual(filterToolsResult(bad, () => true).tools, [], JSON.stringify(bad));
  }
});

test('entries that are not tools are dropped even if the predicate would accept them', () => {
  const out = filterToolsResult({ tools: [null, 5, 'x', [], {}, { name: 5 }, { nope: 1 }, tool('real')] }, () => true);
  assert.deepEqual(out.tools.map((t) => t.name), ['real']);
});

test('only a string cursor survives, and no extra fields from the upstream are copied across', () => {
  const out = filterToolsResult({ tools: [], nextCursor: 5, secret: 'leak', _meta: { x: 1 } }, () => true);
  assert.deepEqual(out, { tools: [] });
  assert.deepEqual(filterToolsResult({ tools: [], nextCursor: 'c', secret: 'leak' }, () => true), { tools: [], nextCursor: 'c' });
});
