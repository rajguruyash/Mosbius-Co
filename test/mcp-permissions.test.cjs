'use strict';

/**
 * The MCP permission policy: least privilege by default.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  NO_ACCESS, normalizeGrant, effectiveGrant, classifyTool, toolAllowed, methodVerdict
} = loadTs('src/main/broker/permissions.ts');

const NOW = 1_700_000_000_000;

// ─── nothing is granted by default ──────────────────────────────────────────

test('no grants at all means no access', () => {
  for (const grants of [undefined, {}, { defaults: {} }, { agents: {} }, { defaults: {}, agents: { other: { gmail: { preset: 'write' } } } }]) {
    assert.equal(effectiveGrant(grants, 'agent', 'gmail', NOW).preset, 'none');
  }
});

test('the default applies to an agent with no entry of its own', () => {
  const grants = { defaults: { gmail: { preset: 'read' } } };
  assert.equal(effectiveGrant(grants, 'agent', 'gmail', NOW).preset, 'read');
  assert.equal(effectiveGrant(grants, 'agent', 'slack', NOW).preset, 'none', 'a default for one integration is not a default for another');
});

test("an agent's own entry beats the default, even when it is `none`", () => {
  const grants = {
    defaults: { gmail: { preset: 'write' } },
    agents: { cut: { gmail: { preset: 'none' } }, narrow: { gmail: { preset: 'read' } } }
  };
  assert.equal(effectiveGrant(grants, 'cut', 'gmail', NOW).preset, 'none');
  assert.equal(effectiveGrant(grants, 'narrow', 'gmail', NOW).preset, 'read');
  assert.equal(effectiveGrant(grants, 'anyone-else', 'gmail', NOW).preset, 'write');
});

test('an expired grant is no grant', () => {
  const grants = { defaults: { gmail: { preset: 'write', expiresAt: NOW } } };
  assert.equal(effectiveGrant(grants, 'a', 'gmail', NOW - 1).preset, 'write');
  assert.equal(effectiveGrant(grants, 'a', 'gmail', NOW).preset, 'none');
  assert.equal(effectiveGrant(grants, 'a', 'gmail', NOW + 1).preset, 'none');
});

test('config is untrusted: anything unrecognised becomes `none`', () => {
  for (const raw of [null, undefined, 5, 'write', [], {}, { preset: 'admin' }, { preset: 'WRITE' }, { preset: 7 }, { preset: ['write'] }]) {
    assert.equal(normalizeGrant(raw), NO_ACCESS, JSON.stringify(raw));
  }
  const g = normalizeGrant({ preset: 'read', allow: ['a', 5, '', 'b'], deny: 'nope', expiresAt: 'soon' });
  assert.deepEqual(g, { preset: 'read', allow: ['a', 'b'] });
});

test('names like __proto__ and constructor cannot be used to find a grant', () => {
  const grants = { defaults: { gmail: { preset: 'read' } }, agents: { real: { gmail: { preset: 'write' } } } };
  for (const agent of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    assert.equal(effectiveGrant(grants, agent, 'gmail', NOW).preset, 'read', agent);
  }
  for (const integration of ['__proto__', 'constructor', 'toString']) {
    assert.equal(effectiveGrant(grants, 'real', integration, NOW).preset, 'none', integration);
  }
  assert.equal(Object.prototype.preset, undefined, 'nothing leaked onto Object.prototype');
});

// ─── tool classes ───────────────────────────────────────────────────────────

test('a tool whose class is unknown is treated as destructive, so no preset reaches it', () => {
  assert.equal(classifyTool({ name: 'x' }), 'destructive');
  assert.equal(classifyTool({ name: 'x', annotations: { readOnlyHint: true } }), 'destructive', 'annotations are ignored until trusted');
  assert.equal(classifyTool({ name: 'x', annotations: { readOnlyHint: true } }, { trustAnnotations: false }), 'destructive');
  for (const preset of ['read', 'write']) assert.equal(toolAllowed({ preset }, 'x', classifyTool({ name: 'x' })), false, preset);
  assert.equal(toolAllowed({ preset: 'custom', allow: ['x'] }, 'x', classifyTool({ name: 'x' })), true, 'but naming it works');
});

test('a catalogue pin decides the class', () => {
  const policy = { toolClasses: { search: 'read', send: 'destructive' } };
  assert.equal(classifyTool({ name: 'search' }, policy), 'read');
  assert.equal(classifyTool({ name: 'send' }, policy), 'destructive');
  assert.equal(classifyTool({ name: 'other' }, policy), 'destructive', 'an unpinned tool is unclassified');
});

test('trusted annotations classify an unpinned tool, using the MCP spec defaults', () => {
  const policy = { trustAnnotations: true };
  const cls = (annotations) => classifyTool({ name: 'a', annotations }, policy);
  assert.equal(cls({ readOnlyHint: true }), 'read');
  assert.equal(cls({ readOnlyHint: false, destructiveHint: false }), 'write');
  assert.equal(cls({ destructiveHint: false }), 'write');
  assert.equal(cls({ destructiveHint: true }), 'destructive');
  assert.equal(cls({ readOnlyHint: false }), 'destructive', 'the spec says destructive is the default');
  assert.equal(cls({}), 'destructive', 'no hints at all: destructive');
  assert.equal(cls({ readOnlyHint: true, destructiveHint: true }), 'destructive', 'a contradiction resolves to the stricter reading');
  assert.equal(classifyTool({ name: 'a' }, policy), 'destructive', 'no annotations at all');
});

test('a server can only make a tool STRICTER than the catalogue says, never looser', () => {
  const pinnedDestructive = { toolClasses: { wipe: 'destructive' }, trustAnnotations: true };
  assert.equal(classifyTool({ name: 'wipe', annotations: { readOnlyHint: true } }, pinnedDestructive), 'destructive', 'a lying annotation cannot downgrade it');
  const pinnedRead = { toolClasses: { look: 'read' }, trustAnnotations: true };
  assert.equal(classifyTool({ name: 'look', annotations: { destructiveHint: true } }, pinnedRead), 'destructive', 'but it can tighten it');
  assert.equal(classifyTool({ name: 'look', annotations: { readOnlyHint: true } }, pinnedRead), 'read');
});

test('hostile annotation shapes and prototype names do not throw or confuse the classifier', () => {
  const policy = { trustAnnotations: true, toolClasses: { ok: 'read' } };
  for (const annotations of [null, 'x', 5, [], { readOnlyHint: 'true' }, { readOnlyHint: 1 }]) {
    assert.doesNotThrow(() => classifyTool({ name: 'a', annotations }, policy));
    assert.equal(classifyTool({ name: 'a', annotations }, policy), 'destructive', 'anything not exactly true reads as not-read-only');
  }
  for (const name of ['__proto__', 'constructor', 'toString']) assert.equal(classifyTool({ name }, policy), 'destructive');
});

// ─── tool permission ────────────────────────────────────────────────────────

const READ = { preset: 'read' };
const WRITE = { preset: 'write' };

test('`none` allows nothing, whatever the lists say', () => {
  assert.equal(toolAllowed(NO_ACCESS, 'x', 'read'), false);
  assert.equal(toolAllowed({ preset: 'none', allow: ['x'] }, 'x', 'read'), false);
});

test('the read preset reaches read tools only; write reaches read and write', () => {
  assert.deepEqual(['read', 'write', 'destructive'].map((c) => toolAllowed(READ, 't', c)), [true, false, false]);
  assert.deepEqual(['read', 'write', 'destructive'].map((c) => toolAllowed(WRITE, 't', c)), [true, true, false]);
});

test('NO PRESET EVER REACHES A DESTRUCTIVE TOOL', () => {
  for (const preset of ['read', 'write', 'custom']) assert.equal(toolAllowed({ preset }, 'send', 'destructive'), false, preset);
  assert.equal(toolAllowed({ preset: 'write', allow: ['something-else'] }, 'send', 'destructive'), false);
});

test('a destructive tool is reached only by naming it', () => {
  assert.equal(toolAllowed({ preset: 'custom', allow: ['send'] }, 'send', 'destructive'), true);
  assert.equal(toolAllowed({ preset: 'read', allow: ['send'] }, 'send', 'destructive'), true, 'a named extra on top of a preset');
  assert.equal(toolAllowed({ preset: 'custom', allow: ['send'] }, 'delete', 'destructive'), false, 'and only that one');
});

test('custom is exactly its allow list', () => {
  const g = { preset: 'custom', allow: ['a'] };
  assert.equal(toolAllowed(g, 'a', 'read'), true);
  assert.equal(toolAllowed(g, 'b', 'read'), false, 'a read tool that was not named stays out');
  assert.equal(toolAllowed({ preset: 'custom' }, 'a', 'read'), false);
});

test('deny always wins', () => {
  assert.equal(toolAllowed({ preset: 'write', deny: ['put'] }, 'put', 'write'), false);
  assert.equal(toolAllowed({ preset: 'custom', allow: ['send'], deny: ['send'] }, 'send', 'destructive'), false);
  assert.equal(toolAllowed({ preset: 'read', deny: ['look'] }, 'look', 'read'), false);
});

test('a tool that has never been listed is refused unless it is named', () => {
  assert.equal(toolAllowed(READ, 'unknown', undefined), false);
  assert.equal(toolAllowed(WRITE, 'unknown', undefined), false);
  assert.equal(toolAllowed({ preset: 'custom', allow: ['unknown'] }, 'unknown', undefined), true);
});

// ─── methods ────────────────────────────────────────────────────────────────

test('without a grant no method gets through, not even initialize', () => {
  for (const m of ['initialize', 'ping', 'tools/list', 'tools/call', 'resources/read', 'notifications/initialized', undefined]) {
    assert.equal(methodVerdict(m, NO_ACCESS).allow, false, String(m));
  }
});

test('the session methods and notifications pass with any grant', () => {
  for (const preset of ['read', 'write', 'custom']) {
    for (const m of ['initialize', 'ping', 'completion/complete', 'notifications/initialized', 'notifications/cancelled', 'notifications/roots/list_changed', 'logging/setLevel']) {
      assert.deepEqual(methodVerdict(m, { preset }), { allow: true, kind: 'passthrough' }, `${preset} ${m}`);
    }
  }
});

test('tools/list and tools/call are recognised and left to the tool-level check', () => {
  assert.deepEqual(methodVerdict('tools/list', READ), { allow: true, kind: 'tools/list' });
  assert.deepEqual(methodVerdict('tools/call', READ), { allow: true, kind: 'tools/call' });
});

test("a client's answer to a server request (no method) passes", () => {
  assert.deepEqual(methodVerdict(undefined, READ), { allow: true, kind: 'response' });
});

test('resources and prompts need the read or write preset, not custom', () => {
  for (const m of ['resources/list', 'resources/read', 'resources/subscribe', 'prompts/list', 'prompts/get']) {
    assert.equal(methodVerdict(m, READ).allow, true, m);
    assert.equal(methodVerdict(m, WRITE).allow, true, m);
    assert.equal(methodVerdict(m, { preset: 'custom', allow: ['x'] }).allow, false, m);
  }
});

test('every other method is denied: server-to-client requests, the unknown and the invented', () => {
  for (const m of ['sampling/createMessage', 'elicitation/create', 'roots/list', 'tasks/get', 'admin/reset', 'foo', 'tools/', 'tools/delete', 'notification/initialized', 'Initialize']) {
    const v = methodVerdict(m, WRITE);
    assert.equal(v.allow, false, m);
    assert.match(v.reason, /not permitted/);
  }
});
