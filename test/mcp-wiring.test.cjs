'use strict';

/**
 * The rules that decide what an agent may be given, and what a change to the grants may
 * say. Pure functions, so every rule is a table. The principle under all of it: nothing is
 * on until the user has said so, and said it at each of four levels.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  mcpIntegrationFor, eligibleIntegrationIds, sanitizeMcpGrants, applyGrantUpdate,
  withoutProtectedKeys, PROTECTED_CONFIG_KEYS, brokerCapableIds, consented, MAX_TOOL_NAMES, MAX_AGENT_ENTRIES
} = loadTs('src/main/mcpWiring.ts');
const { MCP_CATALOG } = loadTs('src/shared/mcpCatalog.ts');
const { effectiveGrant } = loadTs('src/main/broker/permissions.ts');

const NOW = 1_700_000_000_000;
const ALL = ['gmail', 'google-calendar', 'google-drive', 'slack'];
const connected = () => 'connected';

test('the broker serves EVERY catalogue integration (Stage B); a bridged one only once its engine is `broker`', () => {
  assert.deepEqual(brokerCapableIds().sort(), MCP_CATALOG.map((e) => e.id).sort());
  for (const e of MCP_CATALOG) {
    const consent = { mcpDefaults: { [e.id]: { enabled: true } } };
    if (ALL.includes(e.id)) {
      assert.equal(mcpIntegrationFor(e.id, consent), undefined, `${e.id} is on the bridge engine: the broker does not serve it`);
      assert.ok(mcpIntegrationFor(e.id, { ...consent, mcpEngine: { [e.id]: 'broker' } }), e.id);
    } else {
      const served = mcpIntegrationFor(e.id, consent);
      assert.ok(served, `${e.id} is served whenever it exists`);
      assert.equal(served.enabled, true);
      // consent is the only switch: the engine setting means nothing to it, and nothing is on by itself
      assert.equal(mcpIntegrationFor(e.id, {}).enabled, false, `${e.id} is off without consent`);
      assert.equal(mcpIntegrationFor(e.id, { mcpEngine: { [e.id]: 'broker' } }).enabled, false, `${e.id}: an engine flag is not consent`);
    }
  }
  assert.equal(mcpIntegrationFor('nope', {}), undefined);
});

test('an app-run local server is marked hosted and a hosted GitHub server is not; both carry the catalogue\'s pinned classes', () => {
  const on = (id) => mcpIntegrationFor(id, { mcpDefaults: { [id]: { enabled: true } } });
  for (const id of ['time', 'fetch', 'filesystem', 'git', 'notion', 'brave-search', 'playwright', 'sequential-thinking', 'context7']) {
    const i = on(id);
    assert.equal(i.hosted, true, id);
    assert.equal(i.url, `app-hosted://${id}`, 'a name, never an address an agent could be pointed at');
    assert.ok(i.headersMs >= 120_000, 'a slow tool is allowed time');
    assert.deepEqual(i.classification.toolClasses, MCP_CATALOG.find((e) => e.id === id).spec.toolClasses);
    assert.equal(i.classification.trustAnnotations, false);
  }
  const gh = on('github');
  assert.equal(gh.hosted, undefined);
  assert.equal(gh.url, 'https://api.githubcopilot.com/mcp/');
});

test('mcpIntegrationFor: undefined unless the engine is `broker`; enabled only on an explicit `true`; the URL is the catalogue\'s', () => {
  for (const id of ALL) {
    const entry = MCP_CATALOG.find((e) => e.id === id);
    assert.equal(mcpIntegrationFor(id, {}), undefined, 'no config at all');
    assert.equal(mcpIntegrationFor(id, { mcpEngine: {} }), undefined);
    assert.equal(mcpIntegrationFor(id, { mcpEngine: { [id]: 'bridge' }, mcpDefaults: { [id]: { enabled: true } } }), undefined, 'the bridge engine is not served');
    for (const junk of ['Broker', 'BROKER', true, 1, null, {}, ['broker']]) assert.equal(mcpIntegrationFor(id, { mcpEngine: { [id]: junk } }), undefined, JSON.stringify(junk));
    for (const on of [undefined, false, 'true', 1, null, {}]) {
      const i = mcpIntegrationFor(id, { mcpEngine: { [id]: 'broker' }, mcpDefaults: { [id]: { enabled: on } } });
      assert.equal(i.enabled, false, `consent ${JSON.stringify(on)} is not consent`);
    }
    const i = mcpIntegrationFor(id, { mcpEngine: { [id]: 'broker' }, mcpDefaults: { [id]: { enabled: true } } });
    assert.equal(i.enabled, true);
    assert.equal(i.url, entry.spec.url, 'the upstream is fixed by the catalogue');
    assert.match(i.url, /^https:\/\//);
    assert.deepEqual(i.classification, { toolClasses: undefined, trustAnnotations: false }, 'nothing pinned, no annotation trusted: every tool counts as unclassified');
  }
});

test('ELIGIBLE: an agent is given an entry only with ALL FOUR: the in-app engine, consent, a sign-in, and a grant for it', () => {
  const base = {
    mcpEngine: { gmail: 'broker' },
    mcpDefaults: { gmail: { enabled: true } },
    mcpGrants: { defaults: { gmail: { preset: 'read' } } }
  };
  assert.deepEqual(eligibleIntegrationIds(base, 'a1', connected, NOW), ['gmail']);

  const without = (patch) => ({ ...base, ...patch });
  assert.deepEqual(eligibleIntegrationIds(without({ mcpEngine: {} }), 'a1', connected, NOW), [], 'engine is the bridge');
  assert.deepEqual(eligibleIntegrationIds(without({ mcpEngine: { gmail: 'bridge' } }), 'a1', connected, NOW), []);
  assert.deepEqual(eligibleIntegrationIds(without({ mcpDefaults: { gmail: { enabled: false } } }), 'a1', connected, NOW), [], 'switched off');
  assert.deepEqual(eligibleIntegrationIds(without({ mcpDefaults: {} }), 'a1', connected, NOW), [], 'never switched on');
  assert.deepEqual(eligibleIntegrationIds(without({ mcpGrants: {} }), 'a1', connected, NOW), [], 'no grant');
  assert.deepEqual(eligibleIntegrationIds(without({ mcpGrants: undefined }), 'a1', connected, NOW), []);
  assert.deepEqual(eligibleIntegrationIds(without({ mcpGrants: { defaults: { gmail: { preset: 'none' } } } }), 'a1', connected, NOW), []);
  assert.deepEqual(eligibleIntegrationIds(without({ mcpGrants: { defaults: { gmail: { preset: 'read', expiresAt: NOW - 1 } } } }), 'a1', connected, NOW), [], 'an expired grant is no grant');
  assert.deepEqual(eligibleIntegrationIds(without({ mcpGrants: { defaults: { gmail: { preset: 'read' } }, agents: { a1: { gmail: { preset: 'none' } } } } }), 'a1', connected, NOW), [], 'this agent was cut off by name');
  assert.deepEqual(eligibleIntegrationIds(without({ mcpGrants: { defaults: { gmail: { preset: 'read' } }, agents: { a1: { gmail: { preset: 'none' } } } } }), 'a2', connected, NOW), ['gmail'], 'and only this agent');
  for (const state of ['unconfigured', 'signed-out', 'needs-signin', 'unavailable']) {
    assert.deepEqual(eligibleIntegrationIds(base, 'a1', () => state, NOW), [], `state ${state}`);
  }
});

test('ELIGIBLE: each integration is judged on its own, and a typo in the config grants nothing', () => {
  const cfg = {
    mcpEngine: { gmail: 'broker', slack: 'broker', 'google-drive': 'bridge' },
    mcpDefaults: { gmail: { enabled: true }, slack: { enabled: false }, 'google-drive': { enabled: true }, 'google-calendar': { enabled: true } },
    mcpGrants: { defaults: { gmail: { preset: 'read' }, slack: { preset: 'write' }, 'google-drive': { preset: 'write' }, 'google-calendar': { preset: 'write' }, 'g-mail': { preset: 'write' } } }
  };
  assert.deepEqual(eligibleIntegrationIds(cfg, 'a1', connected, NOW), ['gmail']);
  assert.deepEqual(eligibleIntegrationIds(cfg, 'a1', (id) => (id === 'gmail' ? 'signed-out' : 'connected'), NOW), []);
});

test('consented: only `true` counts', () => {
  assert.equal(consented({ mcpDefaults: { gmail: { enabled: true } } }, 'gmail'), true);
  for (const v of [undefined, false, 0, 1, 'yes', 'true', null, {}, []]) assert.equal(consented({ mcpDefaults: { gmail: { enabled: v } } }, 'gmail'), false);
  assert.equal(consented({}, 'gmail'), false);
});

// ─── grants ─────────────────────────────────────────────────────────────────

test('sanitizeMcpGrants: unknown integrations, presets, agents and junk are dropped, lists are bounded', () => {
  assert.deepEqual(sanitizeMcpGrants(undefined), { defaults: {}, agents: {} });
  for (const junk of [null, 1, 'x', [], true]) assert.deepEqual(sanitizeMcpGrants(junk), { defaults: {}, agents: {} });
  const big = Array.from({ length: MAX_TOOL_NAMES + 50 }, (_, i) => `t${i}`);
  const out = sanitizeMcpGrants({
    defaults: { gmail: { preset: 'write', allow: [...big, 'bad\nname', 5], deny: ['x'], extra: 'dropped' }, 'not-in-the-catalogue': { preset: 'write' }, slack: { preset: 'root' } },
    agents: { 'a-1': { gmail: { preset: 'read' }, 'not-an-integration': { preset: 'write' } }, '__proto__': { gmail: { preset: 'write' } }, '../x': { gmail: { preset: 'write' } }, 'a b': { gmail: { preset: 'write' } } }
  });
  assert.deepEqual(Object.keys(out.defaults).sort(), ['gmail', 'slack']);
  assert.equal(out.defaults.gmail.allow.length, MAX_TOOL_NAMES);
  assert.equal(out.defaults.gmail.allow.includes('bad\nname'), false);
  assert.equal('extra' in out.defaults.gmail, false);
  assert.deepEqual(out.defaults.slack, { preset: 'none' }, 'an unknown preset is none');
  assert.deepEqual(Object.keys(out.agents), ['a-1']);
  assert.deepEqual(Object.keys(out.agents['a-1']), ['gmail']);
  assert.equal(Object.prototype.hasOwnProperty.call(out.agents, '__proto__'), false);
  assert.equal({}.polluted, undefined);
});

test('sanitizeMcpGrants keeps at most MAX_AGENT_ENTRIES agents', () => {
  const agents = {};
  for (let i = 0; i < MAX_AGENT_ENTRIES + 25; i++) agents[`agent-${i}`] = { gmail: { preset: 'read' } };
  assert.equal(Object.keys(sanitizeMcpGrants({ agents }).agents).length, MAX_AGENT_ENTRIES);
});

test('applyGrantUpdate: a valid change for everyone, and for one agent; null removes', () => {
  let r = applyGrantUpdate(undefined, { id: 'gmail', agentId: null, grant: { preset: 'custom', allow: ['search_threads'], expiresAt: NOW + 1000 } });
  assert.deepEqual(r, { ok: true, grants: { defaults: { gmail: { preset: 'custom', allow: ['search_threads'], expiresAt: NOW + 1000 } }, agents: {} } });
  r = applyGrantUpdate(r.grants, { id: 'gmail', agentId: 'agent-7', grant: { preset: 'none' } });
  assert.deepEqual(r.grants.agents, { 'agent-7': { gmail: { preset: 'none' } } });
  assert.equal(effectiveGrant(r.grants, 'agent-7', 'gmail', NOW).preset, 'none', 'cut off by name while the default stands');
  assert.equal(effectiveGrant(r.grants, 'agent-8', 'gmail', NOW).preset, 'custom');
  r = applyGrantUpdate(r.grants, { id: 'gmail', agentId: 'agent-7', grant: null });
  assert.deepEqual(r.grants.agents, {}, 'removing the last override removes the agent');
  r = applyGrantUpdate(r.grants, { id: 'gmail', agentId: null, grant: null });
  assert.deepEqual(r.grants.defaults, {}, 'removing the default means no access');
});

test('applyGrantUpdate REFUSES anything it should: shapes, ids, presets, lists, expiry', () => {
  const ok = { id: 'gmail', agentId: null, grant: { preset: 'read' } };
  const refused = [
    [null, 'invalid request'], ['x', 'invalid request'], [[], 'invalid request'], [undefined, 'invalid request'],
    [{ ...ok, id: 'not-in-the-catalogue' }, 'unknown integration'], [{ ...ok, id: undefined }, 'unknown integration'], [{ ...ok, id: ['gmail'] }, 'unknown integration'], [{ ...ok, id: '__proto__' }, 'unknown integration'],
    [{ ...ok, agentId: '' }, 'invalid agent'], [{ ...ok, agentId: '../../x' }, 'invalid agent'], [{ ...ok, agentId: 'a'.repeat(129) }, 'invalid agent'], [{ ...ok, agentId: 5 }, 'invalid agent'], [{ ...ok, agentId: '__proto__' }, 'invalid agent'], [{ ...ok, agentId: 'a\nb' }, 'invalid agent'],
    [{ ...ok, grant: 'read' }, 'invalid grant'], [{ ...ok, grant: [] }, 'invalid grant'],
    [{ ...ok, grant: { preset: 'root' } }, 'unknown preset'], [{ ...ok, grant: {} }, 'unknown preset'], [{ ...ok, grant: { preset: ['read'] } }, 'unknown preset'], [{ ...ok, grant: { preset: 'READ' } }, 'unknown preset'],
    [{ ...ok, grant: { preset: 'read', allow: 'search' } }, 'allow must be a list of tool names'],
    [{ ...ok, grant: { preset: 'read', allow: [1] } }, 'allow holds something that is not a tool name'],
    [{ ...ok, grant: { preset: 'read', allow: ['a\nb'] } }, 'allow holds something that is not a tool name'],
    [{ ...ok, grant: { preset: 'read', allow: ['x'.repeat(257)] } }, 'allow holds something that is not a tool name'],
    [{ ...ok, grant: { preset: 'read', allow: Array.from({ length: MAX_TOOL_NAMES + 1 }, (_, i) => `t${i}`) } }, `allow may name at most ${MAX_TOOL_NAMES} tools`],
    [{ ...ok, grant: { preset: 'read', deny: { 0: 'x' } } }, 'deny must be a list of tool names'],
    [{ ...ok, grant: { preset: 'read', expiresAt: 'tomorrow' } }, 'invalid expiry'], [{ ...ok, grant: { preset: 'read', expiresAt: NaN } }, 'invalid expiry'],
    [{ ...ok, grant: { preset: 'read', expiresAt: Infinity } }, 'invalid expiry'], [{ ...ok, grant: { preset: 'read', expiresAt: -5 } }, 'invalid expiry'], [{ ...ok, grant: { preset: 'read', expiresAt: 0 } }, 'invalid expiry']
  ];
  for (const [input, error] of refused) assert.deepEqual(applyGrantUpdate({ defaults: { gmail: { preset: 'write' } } }, input), { ok: false, error }, JSON.stringify(input));
});

test('applyGrantUpdate: what is stored carries only the known fields, and `none` carries nothing else', () => {
  const r = applyGrantUpdate(undefined, { id: 'slack', agentId: null, grant: { preset: 'read', allow: ['a', 'a', 'b'], deny: [], expiresAt: NOW + 5, evil: { toString: 1 }, __proto__: { preset: 'write' } } });
  assert.deepEqual(r.grants.defaults.slack, { preset: 'read', allow: ['a', 'b'], expiresAt: NOW + 5 });
  const none = applyGrantUpdate(undefined, { id: 'slack', agentId: null, grant: { preset: 'none', allow: ['send'], expiresAt: NOW } });
  assert.deepEqual(none.grants.defaults.slack, { preset: 'none' }, 'no hidden allow list behind a `none`');
});

test('applyGrantUpdate never mutates what it was given, and never pollutes Object.prototype', () => {
  const current = { defaults: { gmail: { preset: 'read' } }, agents: { a1: { gmail: { preset: 'write' } } } };
  const before = JSON.stringify(current);
  applyGrantUpdate(current, { id: 'gmail', agentId: 'a1', grant: null });
  applyGrantUpdate(current, { id: 'slack', agentId: 'constructor', grant: { preset: 'read' } });
  applyGrantUpdate(current, JSON.parse('{"id":"gmail","agentId":null,"grant":{"preset":"read","__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}}'));
  assert.equal(JSON.stringify(current), before);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
});

test('applyGrantUpdate refuses a 201st agent with its own settings', () => {
  const agents = {};
  for (let i = 0; i < MAX_AGENT_ENTRIES; i++) agents[`agent-${i}`] = { gmail: { preset: 'read' } };
  const full = { defaults: {}, agents };
  assert.equal(applyGrantUpdate(full, { id: 'gmail', agentId: 'one-too-many', grant: { preset: 'read' } }).ok, false);
  assert.equal(applyGrantUpdate(full, { id: 'gmail', agentId: 'agent-3', grant: { preset: 'write' } }).ok, true, 'changing an existing one is fine');
});

test('FUZZ: random input never throws and never yields a grant outside the known presets', () => {
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const junk = [null, undefined, 0, 1, -1, NaN, 'x', '', 'gmail', 'read', [], {}, [1], { a: 1 }, true, false, 'a\n', '__proto__', 'constructor', Infinity];
  for (let i = 0; i < 600; i++) {
    const input = { id: pick(['gmail', 'slack', ...junk]), agentId: pick([null, 'a1', ...junk]), grant: pick([null, { preset: pick(['none', 'read', 'write', 'custom', ...junk]), allow: pick([undefined, ['a'], ...junk]), deny: pick([undefined, ['b'], ...junk]), expiresAt: pick([undefined, NOW, ...junk]) }, ...junk]) };
    let r;
    assert.doesNotThrow(() => { r = applyGrantUpdate(pick([undefined, { defaults: {} }, ...junk]), input); });
    if (r.ok) {
      for (const g of Object.values(r.grants.defaults ?? {})) assert.ok(['none', 'read', 'write', 'custom'].includes(g.preset));
      for (const per of Object.values(r.grants.agents ?? {})) for (const g of Object.values(per)) assert.ok(['none', 'read', 'write', 'custom'].includes(g.preset));
    } else assert.equal(typeof r.error, 'string');
  }
});

test('protected config keys are dropped from a general update, and only those', () => {
  assert.deepEqual([...PROTECTED_CONFIG_KEYS].sort(), ['connectClientIds', 'mcpEngine', 'mcpGrants', 'mcpTrustHints', 'restGrants']);
  const patch = { mcpGrants: { defaults: { gmail: { preset: 'write' } } }, restGrants: { defaults: { github: { preset: 'write' } } }, mcpEngine: { gmail: 'broker' }, mcpDefaults: { gmail: { enabled: true } }, godModel: 'x' };
  const kept = withoutProtectedKeys(patch);
  assert.deepEqual(Object.keys(kept).sort(), ['godModel', 'mcpDefaults']);
  assert.ok('mcpGrants' in patch, 'the input is not mutated');
  assert.deepEqual(withoutProtectedKeys({}), {});
  assert.equal(withoutProtectedKeys(null), null);
});

test('a catalogue server that is not bridged can now be granted, but only a real catalogue id', () => {
  assert.equal(applyGrantUpdate({}, { id: 'github', agentId: null, grant: { preset: 'read' } }).ok, true);
  assert.equal(applyGrantUpdate({}, { id: 'filesystem', agentId: 'a1', grant: { preset: 'write' } }).ok, true);
  assert.equal(applyGrantUpdate({}, { id: 'rm -rf', agentId: null, grant: { preset: 'read' } }).ok, false);
  const kept = sanitizeMcpGrants({ defaults: { github: { preset: 'read' }, 'not-in-the-catalogue': { preset: 'read' } } });
  assert.deepEqual(Object.keys(kept.defaults), ['github']);
});

test('an app-run server is eligible for an agent only with consent, a grant, its credential and its installed package', () => {
  const grant = { mcpDefaults: { notion: { enabled: true } }, mcpGrants: { defaults: { notion: { preset: 'read' } } } };
  const ready = () => 'connected';
  assert.deepEqual(eligibleIntegrationIds(grant, 'a1', ready, NOW), ['notion']);
  assert.deepEqual(eligibleIntegrationIds({ ...grant, mcpDefaults: {} }, 'a1', ready, NOW), [], 'switched off');
  assert.deepEqual(eligibleIntegrationIds({ ...grant, mcpGrants: {} }, 'a1', ready, NOW), [], 'no grant for this agent');
  assert.deepEqual(eligibleIntegrationIds(grant, 'a1', () => 'unconfigured', NOW), [], 'no credential, or not installed yet');
  assert.deepEqual(eligibleIntegrationIds({ ...grant, mcpEngine: { notion: 'bridge' } }, 'a1', ready, NOW), ['notion'], 'the engine switch belongs to bridged services only');
  assert.deepEqual(eligibleIntegrationIds({ ...grant, mcpGrants: { defaults: { notion: { preset: 'read' } }, agents: { a2: { notion: { preset: 'none' } } } } }, 'a2', ready, NOW), [], 'cut off by name');
});
