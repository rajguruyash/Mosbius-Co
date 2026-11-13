'use strict';
// Agent Manager safety checks (static: they read the source, they do not run CLIs).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const src = fs.readFileSync(path.join(__dirname, '..', 'src/main/agentManager.ts'), 'utf8');
const idx = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8');

test('the renderer cannot choose the command: agents:run takes an id and an action only', () => {
  const h = idx.slice(idx.indexOf("ipcMain.handle('agents:run'"), idx.indexOf("ipcMain.handle('agents:signin'"));
  assert.match(h, /AGENT_IDS\.includes/);
  assert.match(h, /kind !== 'install' && kind !== 'update'/);
  assert.doesNotMatch(h, /spawn|exec/);
});

test('sign-in checks never put personal fields into the result', () => {
  for (const f of ['email', 'orgName', 'orgId', 'subscriptionType', 'planTier']) {
    assert.doesNotMatch(src, new RegExp(`j\\.${f}|\\.${f}\\b`), `${f} must not be read`);
  }
});

test('Gemini credential files are only tested for existence, never opened', () => {
  assert.doesNotMatch(src, /readFileSync|readFile\(/);
  assert.match(src, /existsSync\(join\(dir, 'oauth_creds\.json'\)\)/);
});

test('Gemini is reported as probable, never as verified', () => {
  const g = src.slice(src.indexOf("id: 'gemini'"));
  assert.doesNotMatch(g.slice(0, g.indexOf('update:')), /'signed-in'/);
});
