'use strict';

/**
 * A message with a repeated key means different things to different JSON parsers (most take the
 * LAST value, some the first). The broker decides from its own reading and forwards the original
 * bytes, so such a body is refused: then there is only one thing the upstream can read.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { hasDuplicateKeys, parseRpcBody, RPC_INVALID_REQUEST } = loadTs('src/main/broker/jsonrpc.ts');

test('a repeated key is found at any depth, in objects inside arrays, and through escapes', () => {
  for (const text of [
    '{"a":1,"a":2}',
    '{"a":1,"b":2,"a":3}',
    '{"x":{"a":1,"a":2}}',
    '[{"a":1},{"b":2,"b":3}]',
    '{"a":1,"\\u0061":2}',
    '{"na\\u006De":"search","name":"send"}',
    '{"params":{"name":"search","name":"send"}}',
    '{"__proto__":1,"__proto__":2}',
    '{"a":{"b":1},"a":{"c":2}}',
    '{"a" : 1 ,\n "a" : 2}'
  ]) assert.equal(hasDuplicateKeys(text), true, text);
});

test('nothing else is: the same key in different objects, a value equal to a key, braces inside strings', () => {
  for (const text of [
    '{}', '[]', '{"a":1}', '{"a":1,"b":2}', '{"a":{"a":1}}', '[{"a":1},{"a":2}]', '{"a":"a","b":"a"}',
    '{"a":"{\\"a\\":1,\\"a\\":2}"}', '{"a":"x,\\"a\\":y"}', '{"k":[{"a":1},{"a":2},[{"a":3}]]}', '{"a":1,"A":2}', '{"a":1,"a ":2}',
    '{"":1,"x":2}', '"just a string"', '12', 'null', '{"a":[1,2,{"b":1}],"b":[{"a":1,"b":2}]}'
  ]) assert.equal(hasDuplicateKeys(text), false, text);
});

test('the parser refuses such a body as an invalid request, for a single message and for a batch', () => {
  const single = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search","name":"send"}}';
  assert.deepEqual(parseRpcBody(Buffer.from(single)), { ok: false, code: RPC_INVALID_REQUEST, message: 'Invalid Request' });
  const batch = `[{"jsonrpc":"2.0","id":1,"method":"ping"},${single}]`;
  assert.equal(parseRpcBody(Buffer.from(batch)).ok, false);
  assert.equal(parseRpcBody(Buffer.from('{"jsonrpc":"2.0","id":1,"method":"ping","method":"tools/call"}')).ok, false, 'two methods');
  assert.equal(parseRpcBody(Buffer.from('{"jsonrpc":"2.0","id":1,"method":"ping"}')).ok, true);
});

test('a hostile object with endless distinct keys is cut off, not scanned into the ground', () => {
  const keys = Array.from({ length: 100_050 }, (_, i) => `"k${i}":1`).join(',');
  assert.equal(hasDuplicateKeys(`{${keys}}`), true, 'more keys than any MCP message has: refused');
  const deep = '['.repeat(50_000) + ']'.repeat(50_000);
  assert.doesNotThrow(() => hasDuplicateKeys(deep));
});

// A second, independent implementation (a plain recursive-descent reader), as the oracle.
function reference(text) {
  let i = 0;
  let dup = false;
  const ws = () => { while (' \t\n\r'.includes(text[i])) i++; };
  const str = () => { let j = i + 1; while (text[j] !== '"') j += text[j] === '\\' ? 2 : 1; const raw = text.slice(i, j + 1); i = j + 1; return JSON.parse(raw); };
  const lit = () => { const m = /^(-?\d+(\.\d+)?([eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i)); i += m[0].length; };
  function value() { ws(); const c = text[i]; if (c === '{') return obj(); if (c === '[') return arr(); if (c === '"') return str(); return lit(); }
  function obj() {
    i++; ws(); const keys = new Set();
    if (text[i] === '}') { i++; return; }
    for (;;) { ws(); const k = str(); if (keys.has(k)) dup = true; keys.add(k); ws(); i++; value(); ws(); if (text[i] === ',') { i++; continue; } i++; return; }
  }
  function arr() { i++; ws(); if (text[i] === ']') { i++; return; } for (;;) { value(); ws(); if (text[i] === ',') { i++; continue; } i++; return; } }
  value();
  return dup;
}

test('DIFFERENTIAL FUZZ: agrees with an independent reader on thousands of generated documents', () => {
  let seed = 424242;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const KEYS = ['a', 'b', 'c', '\\u0061', '\\u0062', 'a\\n', 'x y', '__proto__', '', '{', '\\"', 'name', 'na\\u006de'];
  const STRS = ['', 'a', '{\\"a\\":1,\\"a\\":2}', 'x,\\"a\\":y', '\\"', '\\\\', '[', ']', '}', '\\u00e9'];
  const gen = (depth) => {
    const r = rnd();
    if (depth > 3 || r < 0.3) return pick(['1', '-2.5e3', 'true', 'null', `"${pick(STRS)}"`]);
    if (r < 0.6) { const n = Math.floor(rnd() * 4); return `[${Array.from({ length: n }, () => gen(depth + 1)).join(pick([',', ' , ', ',\n']))}]`; }
    const n = Math.floor(rnd() * 5);
    return `{${Array.from({ length: n }, () => `"${pick(KEYS)}"${pick([':', ' : '])}${gen(depth + 1)}`).join(pick([',', ' ,\n ']))}}`;
  };
  let dups = 0;
  for (let k = 0; k < 4000; k++) {
    const text = gen(0);
    JSON.parse(text);                                   // every sample is valid JSON
    const mine = hasDuplicateKeys(text);
    assert.equal(mine, reference(text), text);
    if (mine) dups++;
  }
  assert.ok(dups > 200 && dups < 3800, `the generator produces both kinds (${dups} with a repeat)`);
});
