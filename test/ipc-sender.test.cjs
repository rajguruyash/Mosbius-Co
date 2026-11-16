'use strict';

/**
 * Which page may drive the handlers that change what agents can reach. Only the app's
 * own top-level page: the packaged index.html, or the dev server's origin.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { isTrustedSender } = loadTs('src/main/ipcSender.ts');

const PROD = { prodFileUrl: 'file:///Applications/Mosbius%20%26%20Co.app/Contents/Resources/app.asar/out/renderer/index.html' };
const DEV = { devOrigin: 'http://localhost:5173' };
const top = (url) => ({ url, parent: null });

test('packaged: the app\'s own index.html (whatever the hash or query) and nothing else', () => {
  assert.equal(isTrustedSender(top(PROD.prodFileUrl), PROD), true);
  assert.equal(isTrustedSender(top(`${PROD.prodFileUrl}#/settings`), PROD), true);
  assert.equal(isTrustedSender(top(`${PROD.prodFileUrl}?floor=2`), PROD), true);
  for (const url of [
    'file:///Applications/Mosbius%20%26%20Co.app/Contents/Resources/app.asar/out/renderer/other.html',
    'file:///tmp/evil.html', 'file:///Applications/Mosbius%20%26%20Co.app/Contents/Resources/app.asar/out/renderer/index.html/../../evil.html',
    'https://evil.example/index.html', 'http://localhost:5173/', 'about:blank', 'data:text/html,hi', 'javascript:1', 'blob:file:///x', '', 'not a url'
  ]) assert.equal(isTrustedSender(top(url), PROD), false, url);
});

test('development: the dev server\'s origin, not another port, host or scheme', () => {
  assert.equal(isTrustedSender(top('http://localhost:5173/'), DEV), true);
  assert.equal(isTrustedSender(top('http://localhost:5173/some/route?x=1#y'), DEV), true);
  for (const url of ['http://localhost:5174/', 'http://127.0.0.1:5173/', 'https://localhost:5173/', 'http://localhost.evil.example:5173/', 'file:///tmp/x.html', 'http://evil.example/'])
    assert.equal(isTrustedSender(top(url), DEV), false, url);
});

test('a sub-frame is never trusted, even at the right address; nor is a frame that cannot be read', () => {
  assert.equal(isTrustedSender({ url: PROD.prodFileUrl, parent: { url: 'x' } }, PROD), false);
  assert.equal(isTrustedSender({ url: 'http://localhost:5173/', parent: {} }, DEV), false);
  assert.equal(isTrustedSender({ url: PROD.prodFileUrl }, PROD), false, 'a missing parent is not "top-level"');
  assert.equal(isTrustedSender(null, PROD), false);
  assert.equal(isTrustedSender(undefined, PROD), false);
  assert.equal(isTrustedSender({ url: 5, parent: null }, PROD), false);
  assert.equal(isTrustedSender({ parent: null }, PROD), false);
});

test('with nothing configured, nothing is trusted', () => {
  assert.equal(isTrustedSender(top(PROD.prodFileUrl), {}), false);
  assert.equal(isTrustedSender(top('http://localhost:5173/'), {}), false);
  assert.equal(isTrustedSender(top('file:///x'), { prodFileUrl: 'garbage' }), false);
  assert.equal(isTrustedSender(top('http://localhost:5173/'), { devOrigin: 'garbage' }), false);
});

test('every privileged MCP handler in index.ts checks the sender before it does anything', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8');
  for (const channel of ['mcp:setEngine', 'mcp:grants:get', 'mcp:grants:set', 'mcp:tools:list', 'mcp:tools:refresh', 'mcp:activity']) {
    const at = src.indexOf(`ipcMain.handle('${channel}'`);
    assert.ok(at > 0, `${channel} is registered`);
    const body = src.slice(at, at + 400);
    assert.match(body, /if \(!fromAppPage\(evt\)\) return FORBIDDEN;|fromAppPage\(evt\) \? /, `${channel} must check where the call came from`);
  }
  // and the general config update cannot reach what they protect: the grants and the engine, and (since
  // Stage B) the secrets, which have their own write-only handlers
  assert.match(src, /writeConfig\(patch && typeof patch === 'object' \? withoutSecretKeys\(withoutProtectedKeys\(patch\)\) : patch\)/);
});

test('every connection and skills handler that reads or changes anything checks the sender first', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8');
  const channels = [
    'connect:list', 'connect:start', 'connect:cancel', 'connect:disconnect', 'connect:setClientId',
    'skills:install', 'skills:uninstall', 'skills:managed', 'skills:verify', 'skills:checkUpdate', 'skills:applyUpdate', 'skills:discardUpdate', 'skills:rollback'
  ];
  for (const channel of channels) {
    const at = src.indexOf(`ipcMain.handle('${channel}'`);
    assert.ok(at > 0, `${channel} is registered`);
    const body = src.slice(at, at + 420);
    assert.match(body, /if \(!fromAppPage\(evt\)\) return FORBIDDEN;|fromAppPage\(evt\) \? /, `${channel} must check where the call came from`);
  }
});

test('the skills channels take a target the app knows, and never build a path from page text', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8');
  const at = src.indexOf('function skillDepsFor(');
  assert.ok(at > 0, 'one function turns a target into folders');
  const body = src.slice(at, at + 700);
  assert.match(body, /target === undefined \|\| target === 'claude'/);
  assert.match(body, /target === 'agents'/);
  assert.match(body, /return null;/, 'any other target is refused');
  // the root is built from the home folder only
  assert.match(body, /join\(homedir\(\), '\.agents', 'skills'\)/);
});
