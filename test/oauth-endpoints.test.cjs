'use strict';

/**
 * Which URLs the sign-in may talk to, and the catalogue's pinned OAuth specs.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { checkEndpoint, validateOauthSpec, validateRevokeSpec, PRODUCTION_POLICY, EndpointError, RESERVED_AUTHORIZE_PARAMS } = loadTs('src/main/oauth/endpoints.ts');
const { MCP_CATALOG, mcpOauthRef, mcpTokenRef } = loadTs('src/shared/mcpCatalog.ts');

const TEST_POLICY = { allowInsecureLoopback: true };
const BRIDGED = MCP_CATALOG.filter((e) => e.spec.transport === 'bridge');
const spec = (over = {}) => ({
  issuer: 'https://idp.example.com', authorizationEndpoint: 'https://idp.example.com/authorize',
  tokenEndpoint: 'https://idp.example.com/token', issParameter: 'optional', tokenResponse: 'oauth2', ...over
});

test('production policy: https only, and nothing else gets through', () => {
  assert.equal(checkEndpoint('https://accounts.google.com/o/oauth2/v2/auth', PRODUCTION_POLICY).hostname, 'accounts.google.com');
  for (const bad of [
    'http://accounts.google.com/o/oauth2/v2/auth', 'http://127.0.0.1:8080/token', 'https://user:pw@idp.example.com/token',
    'https://idp.example.com/token#frag', 'https://idp.example.com/token?x=1', 'ftp://idp.example.com/token',
    'javascript:alert(1)', 'file:///etc/passwd', 'data:text/plain,hi', '//idp.example.com/token', 'not a url', '',
    'https://1.2.3.4/token', 'https://[::1]/token', 'https://0x7f.1/token',
    'https://127.0.0.1/token', 'https://localhost/token', 'https://localhost:8443/token'
  ]) {
    assert.throws(() => checkEndpoint(bad, PRODUCTION_POLICY), EndpointError, bad);
  }
});

test('the test-only exception is plain http on a loopback address, and nothing wider', () => {
  assert.doesNotThrow(() => checkEndpoint('http://127.0.0.1:5000/token', TEST_POLICY));
  assert.doesNotThrow(() => checkEndpoint('http://localhost:5000/token', TEST_POLICY));
  for (const bad of ['http://idp.example.com/token', 'http://10.0.0.5/token', 'http://evil.localhost.example.com/token', 'http://127.0.0.1.evil.com/token']) {
    assert.throws(() => checkEndpoint(bad, TEST_POLICY), EndpointError, bad);
  }
});

test('a spec cannot override the parameters the sign-in sets itself', () => {
  for (const reserved of RESERVED_AUTHORIZE_PARAMS) {
    assert.throws(() => validateOauthSpec(spec({ authorizeParams: { [reserved]: 'x' } }), PRODUCTION_POLICY), EndpointError, reserved);
    assert.throws(() => validateOauthSpec(spec({ authorizeParams: { [reserved.toUpperCase()]: 'x' } }), PRODUCTION_POLICY), EndpointError, reserved.toUpperCase());
  }
  assert.doesNotThrow(() => validateOauthSpec(spec({ authorizeParams: { access_type: 'offline', prompt: 'consent' } }), PRODUCTION_POLICY));
  assert.throws(() => validateOauthSpec(spec({ authorizeParams: { 'bad key': 'x' } }), PRODUCTION_POLICY), EndpointError);
  assert.throws(() => validateOauthSpec(spec({ issParameter: 'maybe' }), PRODUCTION_POLICY), EndpointError);
  assert.throws(() => validateOauthSpec(spec({ tokenResponse: 'xml' }), PRODUCTION_POLICY), EndpointError);
});

test('revocation endpoints follow the same rule', () => {
  assert.doesNotThrow(() => validateRevokeSpec({ url: 'https://oauth2.googleapis.com/revoke', style: 'oauth2' }, PRODUCTION_POLICY));
  assert.throws(() => validateRevokeSpec({ url: 'http://oauth2.googleapis.com/revoke', style: 'oauth2' }, PRODUCTION_POLICY), EndpointError);
  assert.throws(() => validateRevokeSpec({ url: 'https://oauth2.googleapis.com/revoke', style: 'form' }, PRODUCTION_POLICY), EndpointError);
});

// ─── the catalogue ──────────────────────────────────────────────────────────

test('every bridged catalogue entry has a valid in-app spec under the PRODUCTION policy', () => {
  assert.equal(BRIDGED.length, 4);
  for (const e of BRIDGED) {
    assert.ok(e.spec.oauth, `${e.id} has no oauth spec`);
    assert.doesNotThrow(() => validateOauthSpec(e.spec.oauth, PRODUCTION_POLICY), e.id);
    assert.doesNotThrow(() => validateRevokeSpec(e.spec.revoke, PRODUCTION_POLICY), e.id);
  }
});

test('DRIFT GUARD: the pinned endpoints can only point at the reviewed provider hosts', () => {
  const reviewed = {
    'https://accounts.google.com': { auth: 'accounts.google.com', token: 'oauth2.googleapis.com', revoke: 'oauth2.googleapis.com' },
    'https://mcp.slack.com': { auth: 'slack.com', token: 'slack.com', revoke: 'slack.com' }
  };
  for (const e of BRIDGED) {
    const o = e.spec.oauth;
    const hosts = reviewed[o.issuer];
    assert.ok(hosts, `${e.id}: issuer ${o.issuer} has not been reviewed`);
    assert.equal(new URL(o.authorizationEndpoint).hostname, hosts.auth, `${e.id} authorization endpoint`);
    assert.equal(new URL(o.tokenEndpoint).hostname, hosts.token, `${e.id} token endpoint`);
    assert.equal(new URL(e.spec.revoke.url).hostname, hosts.revoke, `${e.id} revocation endpoint`);
  }
});

test('the catalogue pins exactly what the providers published (2026-11-15)', () => {
  const google = BRIDGED.filter((e) => e.spec.oauth.issuer === 'https://accounts.google.com');
  assert.deepEqual(google.map((e) => e.id).sort(), ['gmail', 'google-calendar', 'google-drive']);
  for (const e of google) {
    assert.equal(e.spec.oauth.authorizationEndpoint, 'https://accounts.google.com/o/oauth2/v2/auth');
    assert.equal(e.spec.oauth.tokenEndpoint, 'https://oauth2.googleapis.com/token');
    assert.deepEqual(e.spec.oauth.authorizeParams, { access_type: 'offline', prompt: 'consent' }, 'Google only issues a refresh token for offline access');
    assert.equal(e.spec.oauth.issParameter, 'required');
    assert.equal(e.spec.oauth.tokenResponse, 'oauth2');
  }
  const slack = BRIDGED.find((e) => e.id === 'slack').spec.oauth;
  assert.equal(slack.authorizationEndpoint, 'https://slack.com/oauth/v2_user/authorize');
  assert.equal(slack.tokenEndpoint, 'https://slack.com/api/oauth.v2.user.access');
  assert.equal(slack.tokenResponse, 'slack');
});

test('Slack asks for read scopes only until the user opts in to more', () => {
  const scope = BRIDGED.find((e) => e.id === 'slack').spec.oauth.scope.split(' ');
  assert.ok(scope.length > 5);
  for (const s of scope) assert.equal(/write|chat:|post/.test(s), false, `${s} writes`);
});

test('the in-app engine and the bridge keep their tokens under different refs', () => {
  for (const e of BRIDGED) {
    assert.notEqual(mcpOauthRef(e.id), mcpTokenRef(e.id));
    assert.equal(mcpOauthRef(e.id), `mcp:${e.id}:oauth`);
  }
});

test('the app never relaxes the endpoint policy: index.ts passes none', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
  const at = main.indexOf('new OAuthController(');
  assert.ok(at > 0);
  const block = main.slice(at, main.indexOf('\n});', at));
  assert.equal(/policy|allowInsecureLoopback|specOverride|portOverride/.test(block), false, 'a test-only seam is being set in production');
  assert.match(block, /\^https:/, 'only https URLs are ever opened in the browser');
});
