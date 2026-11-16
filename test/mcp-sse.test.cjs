'use strict';

/**
 * The event-stream reader the MCP route uses to find a JSON-RPC answer inside a
 * streamed `tools/list`. It reads whatever a server sends, so it is held to: the
 * WHATWG parsing rules, a hard cap on events, and never throwing.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { parseSse, findRpcResponse, sseMessage, MAX_SSE_EVENTS } = loadTs('src/main/broker/sse.ts');

test('events: LF, CRLF and CR line ends; one optional space after the colon', () => {
  for (const nl of ['\n', '\r\n', '\r']) {
    const text = `event: message${nl}data: {"a":1}${nl}${nl}data:{"b":2}${nl}${nl}`;
    assert.deepEqual(parseSse(text), [{ data: '{"a":1}', event: 'message' }, { data: '{"b":2}' }], JSON.stringify(nl));
  }
});

test('several data lines join with a newline; comments, retry and unknown fields are ignored; ids are kept', () => {
  const text = ': a comment\nretry: 10\nweird: x\nid: 7\ndata: one\ndata: two\ndata\n\n';
  assert.deepEqual(parseSse(text), [{ data: 'one\ntwo\n', id: '7' }]);
});

test('an event with no data line is not dispatched, and does not leak its fields into the next one', () => {
  const text = 'event: ping\nid: 1\n\ndata: x\n\n';
  assert.deepEqual(parseSse(text), [{ data: 'x' }]);
});

test('an event the server never finished (no blank line) is dropped, as a browser would', () => {
  assert.deepEqual(parseSse('data: done\n\ndata: cut off'), [{ data: 'done' }]);
  assert.deepEqual(parseSse('data: only this'), []);
});

test('an event is finished by a BLANK line, not by the end of the last line (a terminator at the very end is not a blank line)', () => {
  for (const nl of ['\n', '\r\n', '\r']) {
    assert.deepEqual(parseSse(`data: x${nl}`), [], `one terminator at the end finishes the line, not the event (${JSON.stringify(nl)})`);
    assert.deepEqual(parseSse(`data: a${nl}${nl}data: b${nl}`), [{ data: 'a' }]);
    assert.deepEqual(parseSse(`data: a${nl}${nl}`), [{ data: 'a' }]);
    assert.deepEqual(parseSse(`${nl}data: a${nl}${nl}`), [{ data: 'a' }], 'a leading blank line dispatches nothing');
  }
});

test('a leading byte-order mark is ignored; NUL in an id discards the id', () => {
  assert.deepEqual(parseSse('﻿data: x\n\n'), [{ data: 'x' }]);
  assert.deepEqual(parseSse('id: a\0b\ndata: x\n\n'), [{ data: 'x' }]);
});

test('empty, non-string and hostile input never throws and never loops for ever', () => {
  assert.deepEqual(parseSse(''), []);
  assert.deepEqual(parseSse(undefined), []);
  assert.deepEqual(parseSse(null), []);
  assert.deepEqual(parseSse(42), []);
  const many = 'data: x\n\n'.repeat(MAX_SSE_EVENTS + 500);
  assert.equal(parseSse(many).length, MAX_SSE_EVENTS, 'the number of events is capped');
  assert.equal(parseSse('data: x\n\n'.repeat(10), 3).length, 3);
  assert.equal(parseSse('\n'.repeat(200_000)).length, 0);
  assert.doesNotThrow(() => parseSse(':'.repeat(1_000_000)));
});

test('FUZZ: random bytes and random event-stream-shaped text never throw, and every event has string data', () => {
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const alphabet = ['data', 'event', 'id', 'retry', ':', ' ', '\n', '\r', '\r\n', '{', '}', '"', '\0', 'x', '1', '﻿', ' '];
  for (let i = 0; i < 400; i++) {
    let s = '';
    for (let j = 0, n = Math.floor(rnd() * 80); j < n; j++) s += alphabet[Math.floor(rnd() * alphabet.length)];
    const events = parseSse(s);
    for (const e of events) assert.equal(typeof e.data, 'string');
    assert.doesNotThrow(() => findRpcResponse(events, 1));
  }
  for (let i = 0; i < 100; i++) {
    const buf = Buffer.alloc(Math.floor(rnd() * 300));
    for (let j = 0; j < buf.length; j++) buf[j] = Math.floor(rnd() * 256);
    assert.doesNotThrow(() => parseSse(buf.toString('utf8')));
  }
});

test('findRpcResponse: only the answer to THIS request counts', () => {
  const ev = (o) => ({ data: typeof o === 'string' ? o : JSON.stringify(o) });
  const answer = { jsonrpc: '2.0', id: 7, result: { tools: [] } };
  // progress notes, a server request that shares the id, another id's answer, text, a batch
  const noise = [
    ev({ jsonrpc: '2.0', method: 'notifications/progress', params: {} }),
    ev({ jsonrpc: '2.0', id: 7, method: 'sampling/createMessage', params: {} }),
    ev({ jsonrpc: '2.0', id: 8, result: { tools: [{ name: 'x' }] } }),
    ev('not json'), ev('[{"jsonrpc":"2.0","id":7,"result":{}}]'), ev('null'), ev('7')
  ];
  assert.deepEqual(findRpcResponse([...noise, ev(answer)], 7), answer);
  assert.equal(findRpcResponse(noise, 7), undefined);
  assert.equal(findRpcResponse([], 7), undefined);
  // ids compare strictly: "7" is not 7
  assert.equal(findRpcResponse([ev({ jsonrpc: '2.0', id: '7', result: {} })], 7), undefined);
  assert.deepEqual(findRpcResponse([ev({ jsonrpc: '2.0', id: '7', result: {} })], '7'), { jsonrpc: '2.0', id: '7', result: {} });
  // the first answer wins; a later one cannot replace it
  const second = { jsonrpc: '2.0', id: 7, result: { tools: [{ name: 'later' }] } };
  assert.deepEqual(findRpcResponse([ev(answer), ev(second)], 7), answer);
  // an error is an answer
  const err = { jsonrpc: '2.0', id: 7, error: { code: -1, message: 'no' } };
  assert.deepEqual(findRpcResponse([ev(err)], 7), err);
  // an object with the id but neither result nor error is not an answer
  assert.equal(findRpcResponse([ev({ jsonrpc: '2.0', id: 7 })], 7), undefined);
});

test('sseMessage: one event, the JSON on one line however hostile its content', () => {
  const hostile = { text: 'a\nb\r\nc d', nested: { 'data: x': '\n\ndata: forged\n\n' } };
  const out = sseMessage(hostile);
  assert.equal(out.endsWith('\n\n'), true);
  const events = parseSse(out);
  assert.equal(events.length, 1, 'content cannot add a second event');
  assert.deepEqual(JSON.parse(events[0].data), hostile);
  assert.equal(events[0].event, 'message');
});
