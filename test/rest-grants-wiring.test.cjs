'use strict';

/**
 * F3 wiring — what decides which workers get a REST capability, how a grant may be changed,
 * and that the main process uses all of it. The route itself is covered by
 * rest-grants-route.test.cjs; this is the glue around it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const W = loadTs('src/main/mcpWiring.ts');

const NOW = 1_800_000_000_000;
const cfg = (restGrants) => ({ restGrants });

test('a worker is eligible only for the integrations it was granted: the default is none', () => {
  assert.deepEqual(W.restEligibleIds(cfg(undefined), 'w1', ['github', 'linear'], NOW), []);
  assert.deepEqual(W.restEligibleIds(cfg({}), 'w1', ['github', 'linear'], NOW), []);
  const grants = { defaults: { github: { preset: 'read' } }, agents: { w2: { linear: { preset: 'write' }, github: { preset: 'none' } } } };
  assert.deepEqual(W.restEligibleIds(cfg(grants), 'w1', ['github', 'linear'], NOW), ['github']);
  assert.deepEqual(W.restEligibleIds(cfg(grants), 'w2', ['github', 'linear'], NOW), ['linear'], 'w2 was cut off from github by name and given linear');
  assert.deepEqual(W.restEligibleIds(cfg(grants), 'w1', ['linear'], NOW), [], 'a grant for something that is not enabled gives nothing');
});

test('an expired or "none" grant makes a worker ineligible', () => {
  assert.deepEqual(W.restEligibleIds(cfg({ defaults: { github: { preset: 'read', expiresAt: NOW - 1 } } }), 'w1', ['github'], NOW), []);
  assert.deepEqual(W.restEligibleIds(cfg({ defaults: { github: { preset: 'none' } } }), 'w1', ['github'], NOW), []);
  assert.deepEqual(W.restEligibleIds(cfg({ defaults: { github: { preset: 'read', expiresAt: NOW + 1 } } }), 'w1', ['github'], NOW), ['github']);
});

test('what a stored restGrants may say: well-formed integration slugs, known presets, bounded lists', () => {
  const out = W.sanitizeRestGrants({
    defaults: { github: { preset: 'read', allow: ['GET /a', 'bad\nname'], extra: 1 }, 'Bad_ID': { preset: 'write' }, linear: { preset: 'sudo' } },
    agents: { 'w-1': { jira: { preset: 'write', deny: ['DELETE /*'] } }, '../x': { github: { preset: 'read' } } }
  });
  assert.deepEqual(Object.keys(out.defaults).sort(), ['github', 'linear']);
  assert.deepEqual(out.defaults.github, { preset: 'read', allow: ['GET /a'] }, 'control characters and unknown fields are dropped');
  assert.deepEqual(out.defaults.linear, { preset: 'none' }, 'an unknown preset is none');
  assert.deepEqual(Object.keys(out.agents), ['w-1']);
  for (const junk of [null, 1, 'x', [], true, undefined]) assert.deepEqual(W.sanitizeRestGrants(junk), { defaults: {}, agents: {} });
  assert.equal(Object.prototype.hasOwnProperty.call(W.sanitizeRestGrants(JSON.parse('{"agents":{"__proto__":{"github":{"preset":"write"}}}}')).agents, '__proto__'), false);
});

test('a REST grant can be written only for a registered integration, with a valid preset and bounded tool lists', () => {
  const known = (id) => id === 'github';
  const set = (cur, input) => W.applyGrantUpdate(cur, input, known);
  assert.equal(set({}, { id: 'nope', agentId: null, grant: { preset: 'read' } }).ok, false, 'unknown integration');
  assert.equal(set({}, { id: 'github', agentId: null, grant: { preset: 'root' } }).ok, false, 'unknown preset');
  assert.equal(set({}, { id: 'github', agentId: '../x', grant: { preset: 'read' } }).ok, false, 'bad agent id');
  assert.equal(set({}, { id: 'github', agentId: null, grant: { preset: 'read', allow: 'GET /x' } }).ok, false, 'a list must be a list');
  assert.equal(set({}, { id: 'github', agentId: null, grant: { preset: 'read', allow: Array(201).fill('GET /x') } }).ok, false, 'bounded');
  const r = set({}, { id: 'github', agentId: null, grant: { preset: 'write', allow: ['DELETE /repos/a/b'] } });
  assert.deepEqual(r, { ok: true, grants: { defaults: { github: { preset: 'write', allow: ['DELETE /repos/a/b'] } }, agents: {} } });
  const per = set(r.grants, { id: 'github', agentId: 'w1', grant: { preset: 'none' } });
  assert.deepEqual(per.grants.agents, { w1: { github: { preset: 'none' } } });
  const removed = set(per.grants, { id: 'github', agentId: 'w1', grant: null });
  assert.deepEqual(removed.grants.agents, {}, 'removing an agent entry puts it back on the default');
  assert.deepEqual(set(r.grants, { id: 'github', agentId: null, grant: null }).grants.defaults, {}, 'removing the default means no access');
});

test('a MCP grant is unaffected: the original validation is the default', () => {
  assert.equal(W.applyGrantUpdate({}, { id: 'gmail', agentId: null, grant: { preset: 'read' } }).ok, true, 'gmail is a catalogue integration the MCP route serves');
  assert.equal(W.applyGrantUpdate({}, { id: 'not-in-the-catalogue', agentId: null, grant: { preset: 'read' } }).ok, false);
});

test('removing an integration removes every grant for it, for the default and for each agent', () => {
  const grants = { defaults: { github: { preset: 'read' }, linear: { preset: 'read' } }, agents: { w1: { github: { preset: 'write' } }, w2: { github: { preset: 'none' }, linear: { preset: 'read' } } } };
  const out = W.withoutGrantsFor(grants, 'github');
  assert.deepEqual(out.defaults, { linear: { preset: 'read' } });
  assert.deepEqual(out.agents, { w2: { linear: { preset: 'read' } } }, 'an agent left with nothing is dropped');
  assert.deepEqual(W.withoutGrantsFor(undefined, 'github'), { defaults: {}, agents: {} });
});

test('restGrants cannot be written through the general config update', () => {
  assert.ok(W.PROTECTED_CONFIG_KEYS.includes('restGrants'));
  assert.ok(W.PROTECTED_CONFIG_KEYS.includes('mcpGrants'));
  const out = W.withoutProtectedKeys({ notifications: true, restGrants: { defaults: { github: { preset: 'write' } } }, mcpGrants: {}, mcpEngine: {} });
  assert.deepEqual(out, { notifications: true });
});

// ─── the main process, from its source ──────────────────────────────────────

const main = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8');
const body = (re) => { const m = re.exec(main); assert.ok(m, `${re} not found`); return m[0]; };

test('the app\'s broker is built WITH the REST grants and the REST audit', () => {
  const b = body(/const integrationBroker = new IntegrationBroker\([\s\S]*?\n\}\);/);
  assert.match(b, /rest: \{\s*grants: currentRestGrants/);
  assert.match(b, /kind: 'rest'/);
});

test('a hired worker gets a REST capability only for what it was granted, and none at all when that is nothing', () => {
  const s = body(/if \(integrationBroker\.running\(\)\) \{\s*\/\/ Only the integrations this worker was GRANTED[\s\S]*?\n  \}/);
  assert.match(s, /restEligibleIds\(readConfig\(\), workerId, integrations\.enabledIds\(\), Date\.now\(\)\)/);
  assert.match(s, /if \(restIds\.length > 0\)/);
  assert.equal(/integrationBroker\.grant\(workerId, integrations\.enabledIds\(\)\)/.test(main), false, 'the old grant-everything call must be gone');
});

test('the REST grants handlers check the sender and validate against the registry', () => {
  assert.match(body(/ipcMain\.handle\('rest:grants:get'[^\n]*/), /fromAppPage\(evt\)/);
  const set = body(/ipcMain\.handle\('rest:grants:set'[\s\S]*?\n\}\);/);
  assert.match(set, /fromAppPage\(evt\)/);
  assert.match(set, /applyGrantUpdate\(readConfig\(\)\.restGrants, payload, \(id\) => !!integrations\.getRecord\(id\)\)/);
});

test('removing or disabling an integration cuts workers off at once and drops its grants', () => {
  const rm = body(/ipcMain\.handle\('integrations:remove'[\s\S]*?\n\}\);/);
  assert.match(rm, /revokeIntegration\(p\.id\)/);
  assert.match(rm, /withoutGrantsFor\(readConfig\(\)\.restGrants, p\.id\)/);
  const up = body(/ipcMain\.handle\('integrations:upsert'[\s\S]*?\n\}\);/);
  assert.match(up, /if \(!r\.record\.enabled\)[^\n]*revokeIntegration/);
});
