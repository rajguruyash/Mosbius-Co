'use strict';

/**
 * Capability tokens: unique per agent and per channel, least privilege by
 * construction, and revocation that is synchronous.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { CapabilityRegistry, CHANNELS } = loadTs('src/main/broker/capabilities.ts');

test('a token is 256 random bits, base64url, and resolves to exactly the grant that minted it', () => {
  const reg = new CapabilityRegistry();
  const token = reg.grant('agent-1', 'rest', ['a', 'b']);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  const cap = reg.resolve(token);
  assert.equal(cap.agentId, 'agent-1');
  assert.equal(cap.channel, 'rest');
  assert.deepEqual([...cap.allowedIds].sort(), ['a', 'b']);
  assert.ok(Math.abs(cap.grantedAt - Date.now()) < 2000);
});

test('tokens are unique per agent and per channel: no two grants ever share one', () => {
  const reg = new CapabilityRegistry();
  const seen = new Set();
  for (let a = 0; a < 200; a++) {
    for (const channel of CHANNELS) seen.add(reg.grant(`agent-${a}`, channel, ['x']));
  }
  assert.equal(seen.size, 400);
  assert.equal(reg.size(), 400);
});

test('one agent holds a separate token per channel, and each resolves to its own channel', () => {
  const reg = new CapabilityRegistry();
  const rest = reg.grant('a', 'rest', ['r1']);
  const mcp = reg.grant('a', 'mcp', ['m1']);
  assert.notEqual(rest, mcp);
  assert.equal(reg.resolve(rest).channel, 'rest');
  assert.equal(reg.resolve(mcp).channel, 'mcp');
  assert.deepEqual([...reg.resolve(rest).allowedIds], ['r1']);
  assert.deepEqual([...reg.resolve(mcp).allowedIds], ['m1']);
  assert.notEqual(reg.resolve(rest).id, reg.resolve(mcp).id);
});

test('two agents never resolve to each other', () => {
  const reg = new CapabilityRegistry();
  const a = reg.grant('agent-a', 'mcp', ['x']);
  const b = reg.grant('agent-b', 'mcp', ['y']);
  assert.equal(reg.resolve(a).agentId, 'agent-a');
  assert.equal(reg.resolve(b).agentId, 'agent-b');
  assert.deepEqual([...reg.resolve(a).allowedIds], ['x']);
  assert.deepEqual([...reg.resolve(b).allowedIds], ['y']);
});

test('least privilege: nothing is granted unless listed, and an empty list reaches nothing', () => {
  const reg = new CapabilityRegistry();
  const cap = reg.resolve(reg.grant('a', 'mcp', []));
  assert.equal(cap.allowedIds.size, 0);
  const narrow = reg.resolve(reg.grant('b', 'rest', ['only-this']));
  assert.equal(narrow.allowedIds.has('only-this'), true);
  assert.equal(narrow.allowedIds.has('anything-else'), false);
  assert.equal(narrow.allowedIds.has('__proto__'), false);
  assert.equal(narrow.allowedIds.has('constructor'), false);
});

test('re-granting replaces that agent and channel only, and the old token dies at once', () => {
  const reg = new CapabilityRegistry();
  const rest1 = reg.grant('a', 'rest', ['x']);
  const mcp = reg.grant('a', 'mcp', ['x']);
  const other = reg.grant('b', 'rest', ['x']);
  const rest2 = reg.grant('a', 'rest', ['x', 'y']);
  assert.notEqual(rest1, rest2);
  assert.equal(reg.resolve(rest1), undefined);
  assert.ok(reg.resolve(rest2));
  assert.ok(reg.resolve(mcp), 'the other channel is untouched');
  assert.ok(reg.resolve(other), 'other agents are untouched');
  assert.equal(reg.size(), 3);
});

test('revocation is synchronous: the next lookup fails and listeners ran before revoke returned', () => {
  const reg = new CapabilityRegistry();
  const token = reg.grant('a', 'rest', ['x']);
  const heard = [];
  reg.onRevoke((cap, reason) => heard.push([cap.agentId, cap.channel, reason, reg.resolve(token) === undefined]));
  assert.equal(reg.revokeAgent('a'), 1);
  assert.equal(reg.resolve(token), undefined);
  assert.deepEqual(heard, [['a', 'rest', 'revoked', true]], 'the token was already dead when listeners were told');
});

test('revokeAgent removes every channel and is idempotent; other agents keep theirs', () => {
  const reg = new CapabilityRegistry();
  const r = reg.grant('a', 'rest', ['x']);
  const m = reg.grant('a', 'mcp', ['x']);
  const keep = reg.grant('b', 'mcp', ['x']);
  assert.equal(reg.revokeAgent('a'), 2);
  assert.equal(reg.revokeAgent('a'), 0);
  assert.equal(reg.revokeAgent('never-existed'), 0);
  assert.equal(reg.resolve(r), undefined);
  assert.equal(reg.resolve(m), undefined);
  assert.ok(reg.resolve(keep));
  assert.equal(reg.has('a', 'rest'), false);
  assert.equal(reg.has('b', 'mcp'), true);
});

test('revokeChannel takes one channel and leaves the other', () => {
  const reg = new CapabilityRegistry();
  const r = reg.grant('a', 'rest', ['x']);
  const m = reg.grant('a', 'mcp', ['x']);
  assert.equal(reg.revokeChannel('a', 'mcp'), true);
  assert.equal(reg.revokeChannel('a', 'mcp'), false);
  assert.equal(reg.resolve(m), undefined);
  assert.ok(reg.resolve(r));
});

test('revokeIntegration removes one id from live capabilities, in place, and tells listeners', () => {
  const reg = new CapabilityRegistry();
  const t1 = reg.grant('a', 'mcp', ['gmail', 'slack']);
  const t2 = reg.grant('b', 'mcp', ['slack']);
  const t3 = reg.grant('c', 'mcp', ['drive']);
  const t4 = reg.grant('a', 'rest', ['gmail']);
  const held = reg.resolve(t1); // what an in-flight request would be holding
  const heard = [];
  reg.onRevoke((cap, reason, id) => heard.push([cap.agentId, cap.channel, reason, id]));

  assert.equal(reg.revokeIntegration('slack', 'mcp'), 2);
  assert.equal(held.allowedIds.has('slack'), false, 'a held capability sees it immediately');
  assert.equal(held.allowedIds.has('gmail'), true, 'the rest of its reach is untouched');
  assert.deepEqual(heard.map((h) => h[0]).sort(), ['a', 'b']);
  assert.ok(heard.every((h) => h[2] === 'integration' && h[3] === 'slack'));
  assert.ok(reg.resolve(t2), 'the token itself survives; it just reaches nothing now');
  assert.equal(reg.resolve(t2).allowedIds.size, 0);
  assert.deepEqual([...reg.resolve(t3).allowedIds], ['drive']);

  assert.equal(reg.revokeIntegration('gmail'), 2, 'without a channel it applies to every channel');
  assert.equal(reg.resolve(t4).allowedIds.size, 0);
  assert.equal(reg.revokeIntegration('gmail'), 0);
});

test('clear revokes everything and says so', () => {
  const reg = new CapabilityRegistry();
  const tokens = [reg.grant('a', 'rest', ['x']), reg.grant('a', 'mcp', ['x']), reg.grant('b', 'rest', ['x'])];
  const heard = [];
  reg.onRevoke((cap, reason) => heard.push(reason));
  reg.clear();
  assert.equal(reg.size(), 0);
  for (const t of tokens) assert.equal(reg.resolve(t), undefined);
  assert.deepEqual(heard, ['cleared', 'cleared', 'cleared']);
});

test('a listener that throws cannot stop a revoke, and an unsubscribed one hears nothing', () => {
  const reg = new CapabilityRegistry();
  const token = reg.grant('a', 'rest', ['x']);
  let later = 0;
  reg.onRevoke(() => { throw new Error('observer bug'); });
  const off = reg.onRevoke(() => { later++; });
  off();
  assert.equal(reg.revokeAgent('a'), 1);
  assert.equal(reg.resolve(token), undefined);
  assert.equal(later, 0);
});

test('anything that is not exactly a live token resolves to nothing', () => {
  const reg = new CapabilityRegistry();
  const token = reg.grant('a', 'rest', ['x']);
  for (const bad of [undefined, null, '', ' ', 123, {}, [], token + 'x', token.slice(1), token.toUpperCase(), ` ${token}`, token.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')), 'x'.repeat(100_000)]) {
    assert.equal(reg.resolve(bad), undefined, String(bad).slice(0, 20));
  }
  assert.ok(reg.resolve(token));
});

test('invalid grants are refused, not silently accepted', () => {
  const reg = new CapabilityRegistry();
  assert.throws(() => reg.grant('', 'rest', []), TypeError);
  assert.throws(() => reg.grant(undefined, 'rest', []), TypeError);
  assert.throws(() => reg.grant('a', 'smtp', []), TypeError);
  assert.throws(() => reg.grant('a', 'rest', ['ok', '']), TypeError);
  assert.throws(() => reg.grant('a', 'rest', ['ok', 5]), TypeError);
  assert.equal(reg.size(), 0, 'a refused grant leaves nothing behind');
});

test('a failed grant does not revoke the token it would have replaced', () => {
  const reg = new CapabilityRegistry();
  const token = reg.grant('a', 'rest', ['x']);
  assert.throws(() => reg.grant('a', 'rest', ['ok', 5]), TypeError);
  assert.ok(reg.resolve(token));
});

test('describe shows what exists and never a token', () => {
  const reg = new CapabilityRegistry();
  const tokens = [reg.grant('a', 'rest', ['z', 'y']), reg.grant('a', 'mcp', ['m'])];
  const text = JSON.stringify(reg.describe());
  assert.deepEqual(reg.describe().map((d) => [d.agentId, d.channel, d.allowedIds]).sort(), [['a', 'mcp', ['m']], ['a', 'rest', ['y', 'z']]]);
  for (const t of tokens) assert.equal(text.includes(t), false);
});

test('the grant id is not the token and not derivable from it', () => {
  const reg = new CapabilityRegistry();
  const token = reg.grant('a', 'rest', ['x']);
  const cap = reg.resolve(token);
  assert.equal(token.includes(cap.id), false);
  assert.equal(cap.id.includes(token), false);
  assert.match(cap.id, /^[A-Za-z0-9_-]{12}$/);
});
