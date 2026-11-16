'use strict';

/**
 * The provider manifest (src/shared/providers.ts): consistent with the catalogue, honest about verification.
 * The rule that matters most: nothing is marked verified (or limited) without a file in this repository that
 * proves it. A manifest that claims what nobody checked fails here, before it reaches a user.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { PROVIDERS, providerOfMcp } = loadTs('src/shared/providers.ts');
const { MCP_CATALOG } = loadTs('src/shared/mcpCatalog.ts');
const { INTEGRATION_TEMPLATES } = loadTs('src/shared/integrations.ts');
const ROOT = path.join(__dirname, '..');

test('ids are unique, and every catalogue entry and REST template named exists', () => {
  assert.equal(new Set(PROVIDERS.map((p) => p.id)).size, PROVIDERS.length);
  const mcp = new Set(MCP_CATALOG.map((e) => e.id));
  const rest = new Set(INTEGRATION_TEMPLATES.map((t) => t.label));
  for (const p of PROVIDERS) {
    for (const id of p.mcp) assert.ok(mcp.has(id), `${p.id}: no catalogue entry ${id}`);
    for (const label of p.rest) assert.ok(rest.has(label), `${p.id}: no REST template ${label}`);
  }
});

test('every catalogue entry is reachable from some provider, so none is hidden from the user', () => {
  for (const e of MCP_CATALOG) assert.ok(providerOfMcp(e.id), `${e.id} belongs to no provider`);
  for (const t of INTEGRATION_TEMPLATES) assert.ok(PROVIDERS.some((p) => p.rest.includes(t.label)), `REST template ${t.label} belongs to no provider`);
});

test('nothing is verified, or limited, without a real evidence file in the repository', () => {
  for (const p of PROVIDERS) {
    const v = p.verification;
    assert.ok(['verified', 'limited', 'untested', 'planned', 'na'].includes(v.status), p.id);
    assert.ok(v.note && v.note.length > 20, `${p.id}: a note that says what the evidence shows`);
    if (v.status === 'verified' || v.status === 'limited') {
      assert.ok(v.evidence && v.on, `${p.id}: ${v.status} needs a date and an evidence file`);
      assert.ok(fs.existsSync(path.join(ROOT, v.evidence)), `${p.id}: evidence file ${v.evidence} does not exist`);
      assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(ROOT, v.evidence), 'utf8')), `${p.id}: the evidence is not JSON`);
    } else {
      assert.equal(v.evidence, undefined, `${p.id}: ${v.status} must not point at evidence`);
    }
  }
});

test('only local servers are verified; every provider that needs an account or a key says untested until it has been tried', () => {
  for (const p of PROVIDERS) {
    if (p.verification.status === 'verified') assert.equal(p.category, 'local', `${p.id} is verified but is not a local server`);
  }
  for (const id of ['notion', 'linear', 'jira', 'confluence', 'sentry', 'stripe', 'github', 'google-calendar', 'google-drive', 'gmail', 'slack', 'hubspot']) {
    assert.equal(PROVIDERS.find((p) => p.id === id).verification.status, 'untested', id);
  }
});

test('a way that needs an account or a key is only offered where the catalogue can do it', () => {
  for (const p of PROVIDERS) {
    const entries = p.mcp.map((id) => MCP_CATALOG.find((e) => e.id === id));
    if (p.ways.includes('account')) assert.ok(entries.some((e) => e.spec.transport === 'http' && e.spec.connect?.methods.some((m) => m.kind === 'dcr')), `${p.id}: account sign-in, but no entry connects that way`);
    if (p.ways.includes('device')) assert.ok(entries.some((e) => e.spec.transport === 'http' && e.spec.connect?.methods.some((m) => m.kind === 'device')), `${p.id}: device sign-in, but no entry has it`);
    if (p.ways.includes('own-app')) assert.ok(entries.some((e) => e.spec.transport === 'bridge'), `${p.id}: own-app, but no bridged entry`);
    if (p.ways.includes('local')) assert.ok(entries.every((e) => e.spec.transport === undefined || e.spec.transport === 'stdio'), `${p.id}: local, but not run by the app`);
  }
});
