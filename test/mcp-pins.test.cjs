'use strict';

/**
 * F4 — every third-party package the app runs is pinned and hash-locked, and every tool of an
 * app-run server has a class that a maintainer chose from a real listing.
 *
 * Offline and fast: it reads the catalogue and the committed lock files. (Installing from the
 * locks and calling the tools is tools/verify-packages-live.cjs, which needs the network.)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const root = path.join(__dirname, '..');
const { MCP_CATALOG, MCP_REMOTE_PACKAGE, MCP_REMOTE_PACKAGE_SPEC, mcpPinnedPackages, mcpPackageOf } = loadTs('src/shared/mcpCatalog.ts');
const { classifyTool } = loadTs('src/main/broker/permissions.ts');

const stdio = MCP_CATALOG.filter((e) => mcpPackageOf(e));

test('every local server runs from ONE exact release of a named package, never a range, tag or "latest"', () => {
  assert.equal(stdio.length, 9);
  for (const e of stdio) {
    const p = mcpPackageOf(e);
    assert.match(p.version, /^\d+(\.\d+)*$/, `${e.id}: ${p.version} is not an exact release`);
    assert.ok(['npm', 'pypi'].includes(p.manager));
    assert.ok(p.name && p.bin, e.id);
    assert.equal('command' in e.spec, false, `${e.id} still carries a command an agent could be given`);
  }
  assert.deepEqual(mcpPinnedPackages().map((x) => x.lockId).sort(), [...stdio.map((e) => e.id), 'mcp-remote'].sort(), 'the bridge is pinned and locked too');
  assert.match(MCP_REMOTE_PACKAGE_SPEC.version, /^\d+\.\d+\.\d+$/);
  assert.equal(MCP_REMOTE_PACKAGE, `mcp-remote@${MCP_REMOTE_PACKAGE_SPEC.version}`);
});

test('the committed locks match the catalogue and name every file by hash (the offline check of the pin tool)', () => {
  const r = spawnSync(process.execPath, [path.join(root, 'tools', 'pin-mcp-packages.cjs'), '--check'], { encoding: 'utf8' });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  for (const { lockId } of mcpPinnedPackages()) assert.match(r.stdout, new RegExp(`✓ ${lockId}\\b`), lockId);
});

test('an npm lock resolves only to the npm registry and every entry has a sha512; a PyPI lock has a sha256 for every file', () => {
  for (const { lockId, pkg } of mcpPinnedPackages()) {
    const dir = path.join(root, 'resources', 'mcp-locks', lockId);
    if (pkg.manager === 'npm') {
      const lock = JSON.parse(fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8'));
      const entries = Object.entries(lock.packages).filter(([k]) => k !== '');
      assert.ok(entries.length >= 1, lockId);
      for (const [k, v] of entries) {
        assert.match(v.integrity ?? '', /^sha512-/, `${lockId}: ${k}`);
        assert.match(v.resolved ?? '', /^https:\/\/registry\.npmjs\.org\//, `${lockId}: ${k}`);
        assert.notEqual(v.hasInstallScript, true, `${lockId}: ${k} has an install script, which --ignore-scripts would skip`);
      }
      const top = lock.packages[`node_modules/${pkg.name}`];
      assert.equal(top.version, pkg.version, lockId);
    } else {
      const text = fs.readFileSync(path.join(dir, 'requirements.txt'), 'utf8');
      const blocks = text.split(/\n(?=[A-Za-z0-9])/).filter((b) => /^[A-Za-z0-9_.-]+==/.test(b));
      assert.ok(blocks.length >= 3, lockId);
      for (const b of blocks) assert.match(b, /--hash=sha256:[0-9a-f]{64}/, `${lockId}: ${b.split('==')[0]}`);
      assert.match(text, new RegExp(`^${pkg.name.replace(/-/g, '[-_]')}==${pkg.version.replace(/\./g, '\\.')}`, 'im'));
    }
  }
});

test('nothing in the app launches a third-party package unpinned: no npx -y, no uvx, no @latest', () => {
  // The MCP code. (The coding-agent CLIs - Codex, Gemini, OpenCode - are installed by an explicit
  // Install button with `npm install -g <pkg>@latest`, a different surface that is named in the
  // Stage B report as an unresolved risk; it is not an MCP server and is not scanned here.)
  const files = [];
  const walk = (d) => { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); if (fs.statSync(p).isDirectory()) walk(p); else if (/\.(ts|tsx)$/.test(n)) files.push(p); } };
  walk(path.join(root, 'src/main/broker'));
  for (const f of ['src/shared/mcpCatalog.ts', 'src/main/hive.ts', 'src/main/mcpAuthVault.ts', 'src/main/mcpPackages.ts', 'src/main/mcpLaunch.ts',
    'src/main/mcpCredentials.ts', 'src/main/mcpWiring.ts', 'src/main/index.ts', 'src/main/mcpImport.ts']) files.push(path.join(root, f));
  const offenders = [];
  for (const f of files) {
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    lines.forEach((l, i) => {
      if (/^\s*(\*|\/\/)/.test(l)) return;
      if (/\buvx\b/.test(l) && !/'uvx'|"uvx"/.test(l)) offenders.push(`${path.relative(root, f)}:${i + 1}: ${l.trim()}`);
      if (/@latest\b/.test(l)) offenders.push(`${path.relative(root, f)}:${i + 1}: ${l.trim()}`);
      if (/['"]-y['"]\s*,\s*['"][^'"]*(?<!@[0-9.]+)['"]/.test(l) && /npx/.test(l)) offenders.push(`${path.relative(root, f)}:${i + 1}: ${l.trim()}`);
    });
  }
  // the one remaining npx is the bridge, with its exact pin
  const bridge = fs.readFileSync(path.join(root, 'src/main/mcpAuthVault.ts'), 'utf8');
  assert.match(bridge, /'-y', MCP_REMOTE_PACKAGE,/, 'the bridge keeps its exact pin');
  assert.deepEqual(offenders, []);
});

test('every tool of every app-run server has a class, and every class names a tool that really exists', () => {
  for (const e of stdio) {
    const snap = path.join(root, 'resources', 'mcp-locks', e.id, 'tools.json');
    assert.ok(fs.existsSync(snap), `${e.id}: no tools.json (run tools/verify-packages-live.cjs --snapshot)`);
    const listing = JSON.parse(fs.readFileSync(snap, 'utf8'));
    assert.equal(listing.package, mcpPackageOf(e).name);
    assert.equal(listing.version, mcpPackageOf(e).version, `${e.id}: the listing is for another release than the pinned one`);
    const listed = listing.tools.map((t) => t.name).sort();
    const pinned = Object.keys(e.spec.toolClasses ?? {}).sort();
    assert.deepEqual(pinned, listed, `${e.id}: the pinned tools differ from the real listing`);
    for (const [name, cls] of Object.entries(e.spec.toolClasses)) assert.ok(['read', 'write', 'destructive'].includes(cls), `${e.id}.${name}`);
    assert.equal(e.spec.trustAnnotations === true, false, `${e.id} must not trust the server's own hints`);
  }
});

test('a pinned class is never LOOSER than the server\'s own hint unless it is on the reviewed list, with its reason', () => {
  // read-only hint absent or false, yet pinned `read`: each has a reason a maintainer wrote down
  const reviewed = {
    'sequential-thinking.sequentialthinking': 'only appends to its own in-memory notes; touches nothing outside the process',
    'notion.API-post-search': 'a POST in Notion\'s API but a search: nothing is changed',
    'notion.API-query-data-source': 'a POST in Notion\'s API but a query: nothing is changed',
    'brave-search.brave_web_search': 'no hints published; a search',
    'brave-search.brave_local_search': 'no hints published; a search',
    'brave-search.brave_video_search': 'no hints published; a search',
    'brave-search.brave_image_search': 'no hints published; a search',
    'brave-search.brave_news_search': 'no hints published; a search',
    'brave-search.brave_summarizer': 'no hints published; a lookup',
    'brave-search.brave_llm_context': 'no hints published; a lookup',
    'brave-search.brave_place_search': 'no hints published; a search',
    // pinned `write` although the server hints "destructive": a workspace edit the agent can already make itself
    'filesystem.write_file': 'overwrites a file in the agent\'s own workspace, where it can already do so',
    'filesystem.edit_file': 'edits a file in the agent\'s own workspace',
    'filesystem.move_file': 'moves a file inside the agent\'s own workspace',
    'playwright.browser_navigate': 'moves the browser to a page; the page\'s own effects are the page\'s',
    'playwright.browser_navigate_back': 'moves the browser back',
    'playwright.browser_tabs': 'lists, opens or closes the browser\'s own tabs',
    'playwright.browser_close': 'closes the browser\'s own page',
    'playwright.browser_resize': 'resizes the browser window',
    'playwright.browser_emulate_media': 'changes how the page renders',
    'playwright.browser_hover': 'moves the pointer; no click',
    // Notion's server marks every non-GET call destructive; these create or edit content, which Notion's page history restores
    'notion.API-patch-block-children': 'appends blocks; Notion\'s page history restores the page',
    'notion.API-update-a-block': 'edits one block; restorable from page history',
    'notion.API-patch-page': 'edits page properties; restorable from page history',
    'notion.API-post-page': 'creates a page; it can be trashed again',
    'notion.API-create-a-comment': 'adds a comment; it can be deleted again',
    'notion.API-update-a-data-source': 'edits a data source\'s schema; restorable from history',
    'notion.API-create-a-data-source': 'creates a data source; it can be trashed again',
    'notion.API-move-page': 'moves a page; it can be moved back',
    'notion.API-update-page-markdown': 'edits page content; restorable from page history'
  };
  const SEV = { read: 0, write: 1, destructive: 2 };
  const bad = [];
  for (const e of stdio) {
    const listing = JSON.parse(fs.readFileSync(path.join(root, 'resources', 'mcp-locks', e.id, 'tools.json'), 'utf8'));
    for (const t of listing.tools) {
      const cls = e.spec.toolClasses[t.name];
      const a = t.annotations ?? {};
      const hint = a.destructiveHint === true ? 'destructive' : a.readOnlyHint === true ? 'read' : a.readOnlyHint === false ? 'write' : undefined;
      if (hint !== undefined && SEV[cls] < SEV[hint] && !reviewed[`${e.id}.${t.name}`]) bad.push(`${e.id}.${t.name}: pinned ${cls}, the server hints ${hint}`);
      if (hint === undefined && cls === 'read' && !reviewed[`${e.id}.${t.name}`]) bad.push(`${e.id}.${t.name}: pinned read with no hint and no reviewed reason`);
    }
  }
  assert.deepEqual(bad, []);
  for (const [k, why] of Object.entries(reviewed)) assert.ok(why.length > 10, `${k} needs a real reason`);
});

test('pinned classes drive the permission model: presets reach read/write, never destructive, never an unpinned tool', () => {
  const git = MCP_CATALOG.find((e) => e.id === 'git');
  const policy = { toolClasses: git.spec.toolClasses, trustAnnotations: false };
  assert.equal(classifyTool({ name: 'git_status' }, policy), 'read');
  assert.equal(classifyTool({ name: 'git_commit' }, policy), 'write');
  assert.equal(classifyTool({ name: 'git_reset' }, policy), 'destructive');
  assert.equal(classifyTool({ name: 'git_push_everything' }, policy), 'destructive', 'a tool nobody classed is destructive');
  assert.equal(classifyTool({ name: 'git_status', annotations: { readOnlyHint: false, destructiveHint: true } }, policy), 'read', 'a server cannot talk its way to a different class when hints are not trusted');
});

test('the locks ship with the packaged app, where the main process looks for them', () => {
  const yml = fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8');
  assert.match(yml, /- from: resources\/mcp-locks\s*\n\s*to: mcp-locks/);
  const main = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf8');
  assert.match(main, /app\.isPackaged \? join\(process\.resourcesPath, 'mcp-locks'\) : join\(app\.getAppPath\(\), 'resources', 'mcp-locks'\)/);
});
