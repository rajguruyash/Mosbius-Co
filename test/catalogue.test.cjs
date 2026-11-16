'use strict';

/**
 * The catalogue that README.md, INTEGRATIONS.md and the website are generated from (tools/lib/catalogue.cjs).
 *
 * It is derived from the files the app itself uses, so the documents cannot list a provider the app does not have, or
 * call one checked when it is not. These tests hold that derivation in place:
 *
 *   - every provider the app has is in exactly one documented group, so a new provider cannot be left out;
 *   - the six status words follow from the app's own status by a written rule, and nothing can be called
 *     "real-account verified" or "locally tested" without an evidence file in the repository;
 *   - every count is counted from the data, and the counts README.md types by hand agree with it;
 *   - what is said about each coding agent CLI is backed by a recorded run that passed;
 *   - the generated parts of README.md are current.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { buildCatalogue, flagsOf, GROUPS, TERMS, WAY_LABEL } = require('../tools/lib/catalogue.cjs');
const render = require('../tools/lib/render.cjs');
const docs = require('../tools/gen-docs.cjs');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

const { PROVIDERS } = loadTs('src/shared/providers.ts');
const { MCP_CATALOG } = loadTs('src/shared/mcpCatalog.ts');
const { INTEGRATION_TEMPLATES } = loadTs('src/shared/integrations.ts');
const { AGENT_COMPAT } = loadTs('src/shared/agentCompat.ts');
const world = JSON.parse(read('src/renderer/src/assets/himym/world.json'));
const en = JSON.parse(read('src/renderer/src/i18n/locales/en.json'));

const c = buildCatalogue();

test('every provider the app has is in exactly one documented group, and no group names one it does not have', () => {
  const app = PROVIDERS.filter((p) => p.category !== 'ai').map((p) => p.id);
  const grouped = GROUPS.flatMap((g) => g.providers);
  assert.equal(new Set(grouped).size, grouped.length, 'a provider is listed in two groups');
  assert.deepEqual([...grouped].sort(), [...app].sort(), 'add a new provider to a group in tools/lib/catalogue.cjs (or remove one that is gone)');
  assert.equal(c.providers.length, app.length);
  for (const g of c.groups) {
    assert.ok(g.providers.length > 0, `the group "${g.title}" is empty`);
    assert.ok(g.title && g.blurb, `the group ${g.id} has a title and a line about it`);
  }
  // the keys the agents' own engines use are not integrations: they are listed apart and never counted as providers
  const engineIds = PROVIDERS.filter((p) => p.category === 'ai').map((p) => p.id);
  assert.deepEqual(c.engineKeys.map((e) => e.id), engineIds);
  for (const id of engineIds) assert.equal(grouped.includes(id), false);
});

test('every provider has the words the app uses for it: a label, a description, and how it connects', () => {
  for (const p of c.providers) {
    assert.ok(p.label, `${p.id} has a label`);
    assert.ok(p.description.length > 8, `${p.id} has a description from the English locale`);
    assert.equal(p.description, String(en.hub.providers[p.id]).replace(/\s+/g, ' ').trim(), `${p.id}: the description is the app's own`);
    assert.ok(p.note.length > 8, `${p.id} says what was checked`);
    if (p.notImplemented) continue;
    assert.ok(p.connectsBy.length > 0, `${p.id} says how it connects`);
    for (const way of p.ways) assert.ok(WAY_LABEL[way], `the way "${way}" (${p.id}) has words for it`);
  }
});

test('the six status words follow from the app\'s own status by rule, and none can be claimed without evidence', () => {
  assert.deepEqual(TERMS.map((t) => t.id), ['implemented', 'locally-tested', 'stand-in-tested', 'real-account-verified', 'not-yet-verified', 'not-implemented']);
  for (const t of TERMS) assert.ok(t.label && t.meaning.length > 20, `${t.id} is defined`);

  const source = new Map(PROVIDERS.map((p) => [p.id, p]));
  for (const p of c.providers) {
    const src = source.get(p.id);
    assert.deepEqual(
      { implemented: p.implemented, locallyTested: p.locallyTested, standInTested: p.standInTested, realAccountVerified: p.realAccountVerified, notYetVerified: p.notYetVerified, notImplemented: p.notImplemented, chip: p.chip, chipLabel: p.chipLabel },
      flagsOf(src), `${p.id}: the flags are the rule's`);

    // exactly one of the three end states, never a mixture
    assert.equal(p.implemented, !p.notImplemented, `${p.id}: implemented and not implemented are opposites`);
    if (p.notImplemented) assert.equal(p.connectsBy.length, 0, `${p.id}: something not implemented offers no way to connect`);

    // "locally tested" is only ever a local server that needs no account, with its run in the repository
    if (p.locallyTested === 'yes') {
      assert.equal(src.verification.status, 'verified');
      assert.deepEqual(p.ways, ['local'], `${p.id}: locally tested means it runs on this computer and needs no account`);
      assert.ok(p.evidence && exists(p.evidence), `${p.id} is called locally tested, so its evidence file must be in the repository`);
      assert.equal(p.realAccountVerified, 'na');
      assert.equal(p.notYetVerified, false);
    }
    // anything that needs an account or a key is "not yet verified" until a real one has been used
    if (p.implemented && p.locallyTested !== 'yes') {
      assert.equal(p.notYetVerified, true, `${p.id} needs an account or a key and none has been used`);
      assert.equal(p.realAccountVerified, 'no');
    }
    // nothing is real-account verified without a file that shows it
    if (p.realAccountVerified === 'yes') assert.ok(p.evidence && exists(p.evidence), `${p.id} is called real-account verified without evidence`);
  }
  assert.equal(c.counts.realAccountVerified, 0, 'no real provider account has been used; a provider marked otherwise needs its evidence and this line changed with it');
});

test('the providers the documentation promises are there, each in the state that was actually reached', () => {
  const byLabel = new Map(c.providers.map((p) => [p.label, p]));
  const expect = {
    'locally-tested': ['Sequential Thinking', 'Time', 'Fetch', 'Filesystem', 'Git', 'Context7 docs', 'Browser'],
    'stand-in-tested': ['Notion', 'Google Calendar', 'Google Drive', 'Gmail', 'Slack', 'GitHub', 'Linear', 'Sentry', 'Stripe', 'Jira', 'Confluence', 'HubSpot', 'Your own REST API'],
    'partly-tested': ['Brave Search'],
    'not-implemented': ['Salesforce']
  };
  for (const [chip, labels] of Object.entries(expect)) {
    for (const label of labels) {
      const p = byLabel.get(label);
      assert.ok(p, `${label} is in the catalogue`);
      assert.equal(p.chip, chip, `${label} is ${chip}`);
    }
  }
  assert.equal(Object.values(expect).flat().length, c.providers.length, 'a provider was added or removed: say here which state it is in');
});

test('every count is counted from the data', () => {
  const n = c.counts;
  assert.equal(n.providers, c.providers.length);
  assert.equal(n.groups, GROUPS.length);
  assert.equal(n.mcpCatalogueEntries, MCP_CATALOG.length);
  assert.equal(n.restTemplates, INTEGRATION_TEMPLATES.length);
  assert.equal(n.locations, world.order.length);
  assert.equal(n.hubTabs, Object.keys(en.hub.tabs).length);
  assert.equal(n.codingAgentsWithIntegrations, AGENT_COMPAT.length);
  assert.equal(n.providersImplemented + n.notImplemented, n.providers);
  assert.equal(n.locallyTested + n.notYetVerified + n.notImplemented, n.providers, 'every provider is locally tested, not yet verified, or not implemented');
  assert.equal(n.localServers, c.providers.filter((p) => p.ways.length === 1 && p.ways[0] === 'local').length);
  // every MCP server and REST template a provider names is one the app has
  const mcpIds = new Set(MCP_CATALOG.map((m) => m.id));
  const restLabels = new Set(INTEGRATION_TEMPLATES.map((t) => t.label));     // a provider names a template by its label
  for (const p of c.providers) {
    for (const id of p.mcpServers) assert.ok(mcpIds.has(id), `${p.id} names the MCP server ${id}, which the app does not have`);
    for (const label of p.restTemplates) assert.ok(restLabels.has(label), `${p.id} names the REST template ${label}, which the app does not have`);
  }
  // and the other way round: every MCP server and every REST template the app has belongs to a documented provider
  const usedMcp = new Set(c.providers.flatMap((p) => p.mcpServers));
  const usedRest = new Set(c.providers.flatMap((p) => p.restTemplates));
  for (const id of mcpIds) assert.ok(usedMcp.has(id), `the MCP server ${id} belongs to no documented provider`);
  for (const label of restLabels) assert.ok(usedRest.has(label), `the REST template ${label} belongs to no documented provider`);
});

test('what is said about each coding agent is backed by a recorded run that passed', () => {
  assert.deepEqual(c.agents.map((a) => a.key), AGENT_COMPAT.map((a) => a.agent));
  for (const a of c.agents) {
    const compat = AGENT_COMPAT.find((x) => x.agent === a.key);
    assert.equal(a.label, compat.label);
    assert.deepEqual(a.skillFolders, compat.skillFolders);
    assert.match(a.version, /^\d+\.\d+\.\d+/, `${a.label}: the version is read from its run`);
    assert.match(a.installCommand ?? '', /^npm install -g @[a-z-]+\/[a-z-]+$/, `${a.label}: the install command is the app's own`);
    for (const [what, run] of [['integrations', a.run], ['skills', a.skillsRun]]) {
      if (a[what] !== 'verified') continue;
      assert.ok(run && exists(run.file), `${a.label}: "${what}: verified" needs its evidence file`);
      assert.ok(run.checks > 0, `${a.label}: the ${what} run made checks`);
      assert.equal(run.passed, run.checks, `${a.label}: every check of the ${what} run passed`);
      assert.match(run.date ?? '', /^\d{4}-\d{2}-\d{2}$/);
    }
    assert.equal(a.thirdPartyAccountUsed, false);
    assert.ok(['stand-in', 'real-model'].includes(a.runHow.kind));
    assert.match(a.runHow.text, /no third-party account/);
  }
  // the measured weaknesses are carried, not dropped
  const gemini = c.agents.find((a) => a.key === 'gemini');
  const codex = c.agents.find((a) => a.key === 'codex');
  assert.equal(gemini.shell.passHidden, 'no', 'Gemini\'s shell can read its pass (finding F9, open)');
  assert.equal(gemini.folderTrustRequired, true);
  assert.equal(codex.shell.onlyWhileSandboxed, true, 'Codex\'s protection holds only while its sandbox is on');
  const table = render.agentsTableMd(c);
  assert.match(table, /\| \*\*Gemini CLI\*\* \|.*\*\*Yes\*\* \(finding F9, left open/);
  assert.match(table, /\| \*\*Codex CLI\*\* \|.*only while Codex's OS sandbox is on/);
  assert.match(table, /\| \*\*Claude Code\*\* \|[^|]*\|[^|]*\| No \|/);
});

test('the runs behind the claims are all in the repository and all passed', () => {
  for (const [name, run] of Object.entries(c.runs)) {
    assert.ok(run, `the run "${name}" has its evidence file`);
    assert.ok(exists(run.file), `${run.file} exists`);
    assert.ok(run.checks > 0 && run.passed === run.checks, `${name}: ${run.passed} of ${run.checks} checks passed`);
  }
});

test('the locations are the app\'s own, in the order of their keys, and README.md lists every one with its boss', () => {
  assert.deepEqual(c.locations.map((l) => l.id), world.order);
  assert.deepEqual(c.locations.map((l) => l.key), world.order.map((_, i) => i + 1));
  const readme = read('README.md');
  for (const l of c.locations) {
    assert.ok(l.bossCharacter, `${l.id} has a boss`);
    const row = readme.split('\n').find((line) => new RegExp(`^\\| ${l.key} \\|`).test(line)) ?? '';
    const core = l.label.replace(/^The /i, '').toLowerCase();
    assert.ok(row.toLowerCase().includes(core), `README's location table, key ${l.key}, should be "${l.label}": ${row}`);
    assert.ok(row.toLowerCase().includes(`| ${l.bossCharacter} |`), `README's location table, key ${l.key}, should name ${l.bossCharacter} as the boss: ${row}`);
  }
  assert.match(readme, new RegExp(`Press \\*\\*1\\*\\* to \\*\\*${c.locations.length}\\*\\*`), 'README names the right keys');
});

test('README.md: the generated blocks are current, and the counts it types by hand agree with the data', () => {
  const readme = read('README.md');
  assert.equal(docs.render(readme), readme, 'README.md is out of date: run `npm run docs:gen`');

  const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
  const typed = readme.replace(/<!-- gen:[a-z]+:start[\s\S]*?<!-- gen:[a-z]+:end -->/g, ' ');
  const n = c.counts;
  const facts = [
    [/\b([a-z]+) locations\b/gi, n.locations, 'locations'],
    [/\b([a-z]+) tabs\b/gi, n.hubTabs, 'tabs in Integrations & Skills'],
    [/\b([a-z]+) templates\b/gi, n.restTemplates, 'REST templates'],
    [/\b([a-z]+) (?:agent )?CLIs\b/gi, n.codingAgentsWithIntegrations, 'agent CLIs']
  ];
  let seen = 0;
  for (const [re, value, what] of facts) {
    for (const m of typed.matchAll(re)) {
      const i = WORDS.indexOf(m[1].toLowerCase());
      if (i < 0) continue;      // "the tabs", "different CLIs": not a count
      seen++;
      assert.equal(i, value, `README.md says "${m[0]}", but the app has ${value} ${what}`);
    }
  }
  assert.ok(seen >= 4, 'the counts README.md types by hand were found and checked');
  // no digits-and-noun count is typed outside the generated blocks, where nothing would keep it right
  assert.equal(/\b\d+ (?:providers|MCP servers|REST templates|integrations|locations)\b/.test(typed), false, 'a provider or location count typed by hand belongs in a generated block');
});

test('README.md says the things that must not be lost', () => {
  const readme = read('README.md');
  // the fan-made disclaimer, wherever the product is described
  assert.match(readme, /fan-made/i);
  assert.match(readme, /not affiliated with/i);
  // the upstream project is credited once, on the last line, and nowhere else
  const lines = readme.trimEnd().split('\n');
  assert.equal(lines[lines.length - 1], 'Built upon the original Munder Difflin project; credit to its original creators for the foundational work.');
  assert.equal((readme.match(/Munder\s*Difflin/gi) ?? []).length, 1, 'the upstream project is named exactly once');
  // the honest status: no real account, and the platforms that were never run
  assert.match(readme, /No real provider sign-in has been verified/);
  assert.match(readme, /never run on Windows/i);
  assert.match(readme, /not built, not run/i);
  assert.match(readme, /never run on an Intel Mac/i);
  // the known limits are disclosed, not hidden
  assert.match(readme, /finding F9, left open on purpose/);
  assert.match(readme, /With the sandbox off, a command can read the pass from the Codex process/);
  assert.match(readme, /`mcp-remote` bridge leaves tokens in readable files/);
  // what does not exist is said not to exist
  assert.match(readme, /There is no control yet to move an existing agent from one location to another/);
  // every relative link and image in it points at a file that is in the repository
  const targets = [...readme.matchAll(/\]\(([^)\s]+)\)/g), ...readme.matchAll(/<img[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]);
  let local = 0;
  for (const t of targets) {
    if (/^(https?:|#|mailto:)/.test(t)) continue;
    local++;
    assert.ok(exists(decodeURI(t.split('#')[0])), `README.md points at ${t}, which is not in the repository`);
  }
  assert.ok(local > 10, 'the relative links and images were found and checked');
  // every in-page link has its heading
  const slug = (h) => h.trim().toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s/g, '-');
  const anchors = new Set(readme.split('\n').filter((l) => /^#{1,6} /.test(l)).map((l) => slug(l.replace(/^#+ /, ''))));
  for (const t of targets.filter((x) => x.startsWith('#'))) assert.ok(anchors.has(t.slice(1)), `README.md links to ${t}, which no heading produces`);
});

test('every npm script README.md tells you to run exists', () => {
  const readme = read('README.md');
  const scripts = JSON.parse(read('package.json')).scripts;
  const named = new Set([...readme.matchAll(/npm run ([a-z][a-z0-9:-]*)/g)].map((m) => m[1]));
  assert.ok(named.size >= 5, 'the scripts README.md names were found');
  for (const s of named) assert.ok(scripts[s], `README.md says \`npm run ${s}\`, which package.json does not have`);
  for (const s of ['docs:gen', 'docs:check', 'website:build', 'website:check']) assert.ok(scripts[s], `package.json has ${s}`);
});
