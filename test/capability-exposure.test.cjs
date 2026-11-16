'use strict';

/**
 * Where an agent's capability (the revocable handle it presents to the in-app broker) can be read, and who can
 * read it. The behaviour of the handle itself (256 random bits, one per agent and channel, replaced on re-grant,
 * revoked at once, useless on the other channel, never in a response or an audit record) is proved in
 * broker-capabilities.test.cjs and broker-isolation.test.cjs. These tests are the other half: how it is HANDED OVER.
 *
 *   MCP capability   Claude: a 0600 file the agent's own settings forbid it to read (and so are other agents' files);
 *                    Codex: one variable, kept out of the shell Codex runs for the model (codex-broker-wiring.test.cjs,
 *                    and measured on the real CLI in evidence/codex/codex-live.json); Gemini: one variable, NOT measured.
 *   REST capability  in the environment of a hired worker, BY DESIGN (the worker calls the broker with it), and only
 *                    when the worker was granted a REST integration. The default is no grant, so no variable.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const loadTs = require('./load-ts.cjs');

const { CapabilityRegistry } = loadTs('src/main/broker/capabilities.ts');
const ROOT = path.join(__dirname, '..');
const index = fs.readFileSync(path.join(ROOT, 'src/main/index.ts'), 'utf8');
const hive = fs.readFileSync(path.join(ROOT, 'src/main/hive.ts'), 'utf8');

test('the registry keeps only a digest of each token: the token itself is nowhere in what it holds', () => {
  const reg = new CapabilityRegistry();
  const token = reg.grant('agent-1', 'mcp', ['notion']);
  const digest = createHash('sha256').update(token, 'utf8').digest('hex');
  const held = [];
  const walk = (o, seen = new Set()) => {
    if (o && typeof o === 'object') {
      if (seen.has(o)) return; seen.add(o);
      if (o instanceof Map) { for (const [k, v] of o) { held.push(String(k)); walk(v, seen); } return; }
      if (o instanceof Set) { for (const v of o) walk(v, seen); return; }
      if (Buffer.isBuffer(o)) { held.push(o.toString('hex'), o.toString('base64url'), o.toString('utf8')); return; }
      for (const v of Object.values(o)) walk(v, seen);
    } else if (typeof o === 'string') held.push(o);
  };
  walk(reg);
  assert.ok(held.includes(digest), 'the digest is what is kept (so the registry can still recognise the token)');
  assert.equal(held.some((s) => s.includes(token)), false, 'and the token itself is not');
});

test('the REST variable is handed to a worker only when it was granted a REST integration', () => {
  const at = index.indexOf('brokerEnv.MD_BROKER_TOKEN = token;');
  assert.ok(at > 0, 'the one place the REST capability enters an environment');
  const before = index.slice(Math.max(0, at - 700), at);
  assert.match(before, /restIds\.length > 0/, 'guarded by a non-empty grant');
  assert.match(before, /restEligibleIds\(/, 'and the list comes from the grants, not from "everything enabled"');
  assert.equal((index.match(/MD_BROKER_TOKEN\s*=/g) ?? []).length, 1, 'there is exactly one such place');
  // a spawn that fails gives the capability back
  assert.match(index, /if \(!res\.ok\) \{ integrationBroker\.revoke\(workerId\)/);
});

test('an MCP capability is minted only for an agent that was granted something, and is dropped with the agent', () => {
  const at = index.indexOf('mcpToken = integrationBroker.grantMcp(');
  assert.ok(at > 0);
  const before = index.slice(Math.max(0, at - 700), at);
  assert.match(before, /eligibleIntegrationIds\(/);
  assert.match(before, /mcpIds\.length > 0/);
  assert.match(index, /integrationBroker\.revokeMcp\(opts\.hive\.id\)/, 'a failed provisioning revokes it');
  assert.match(index, /mcpCapabilityOwner/, 'only the process that minted a capability may revoke it, so a respawn cannot cut off the new one');
});

test('Claude: the agent\'s own MCP config, and every other agent\'s, are on its deny-read list', () => {
  assert.match(hive, /join\(dir, 'mcp-config\.json'\), \.\.\.this\.otherAgentMcpConfigs\(root, meta\.id\)/);
  assert.match(hive, /private otherAgentMcpConfigs\(/);
});

test('every CLI the app wires keeps the capability out of its command line', () => {
  // Codex gets the NAME of a variable on its command line, never its value; Gemini's settings name a variable too
  assert.match(hive, /bearer_token_env_var=\$\{JSON\.stringify\(variable\)\}/);
  assert.match(hive, /Authorization: `Bearer \$\$\{variable\}`/);
  // and Claude's file is written 0600 (checked end to end in mcp-broker-wiring.test.cjs)
  assert.match(hive, /mode: 0o600/);
});
