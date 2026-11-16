'use strict';

/**
 * The one description of what Mosbius & Co. can connect an agent to, which coding agents it drives, and how far each
 * of them has been checked. It is DERIVED from the files the app itself uses, never typed again:
 *
 *   src/shared/providers.ts     every provider, how it connects, how far it has been checked (the Discover tab)
 *   src/shared/mcpCatalog.ts    the MCP servers behind those providers
 *   src/shared/integrations.ts  the REST templates
 *   src/shared/agentCompat.ts   what each coding agent CLI can do, and how far that was shown
 *   src/shared/agentProvider.ts the engines the app can start, and the command that installs each
 *   src/renderer/src/i18n/locales/en.json   the words the app uses for each provider
 *   src/renderer/src/assets/himym/world.json   the locations
 *   evidence/**                 the runs that back every "verified"
 *
 * README.md, INTEGRATIONS.md and the website all render from this object, so none of them can say something the app does
 * not, and none of them can drift from the others. If a provider is added to the app, it appears everywhere; if a status
 * changes in the app, it changes everywhere; if a provider has no website group, `test/catalogue.test.cjs` fails.
 *
 * What this file adds beyond the app's own data is only (1) the grouping used by the README and the website, and
 * (2) the six-word vocabulary below, derived by a rule that is written out here instead of being implied by a table.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const loadTs = require(path.join(ROOT, 'test', 'load-ts.cjs'));

/** The six words the documents use for "how far has this been checked". One meaning each, used the same everywhere. */
const TERMS = [
  { id: 'implemented', label: 'Implemented', meaning: 'The app has a way to connect an agent to it: code, a catalogue entry or REST template, and a card in Settings. It says nothing about whether it has been run against the real service.' },
  { id: 'locally-tested', label: 'Locally tested', meaning: 'The real server ran on the development Mac and answered a real tool call. It needs no account. macOS only.' },
  { id: 'stand-in-tested', label: 'Stand-in tested', meaning: 'The way the app connects to it (sign-in, sign-in code, your own app, a key, or the REST route) was run end to end against a stand-in service that behaves like a provider. It proves the app\'s side of the connection, not the provider\'s.' },
  { id: 'real-account-verified', label: 'Real-account verified', meaning: 'A real sign-in or key was used for a real call, and the evidence file is in the repository. Nothing is in this state yet.' },
  { id: 'not-yet-verified', label: 'Not yet verified', meaning: 'Implemented, but never run against the real service with a real account.' },
  { id: 'not-implemented', label: 'Not implemented', meaning: 'Not available in the app.' }
];

/**
 * How a provider is shown on the README and the website. Every provider except the AI engine keys (which are not
 * integrations) must appear in exactly one group; the test enforces it, so a new provider cannot be forgotten.
 */
const GROUPS = [
  { id: 'local', title: 'Local MCP tools', blurb: 'Run on your computer, need no account. The app installs each from a version-pinned, hash-checked lock and runs it itself.', providers: ['sequential-thinking', 'time', 'fetch', 'filesystem', 'git', 'context7', 'playwright'] },
  { id: 'dev', title: 'Developer tools', blurb: 'Code hosting and error tracking.', providers: ['github', 'sentry'] },
  { id: 'productivity', title: 'Productivity and knowledge', blurb: 'Issues, pages and documents.', providers: ['notion', 'linear', 'jira', 'confluence'] },
  { id: 'communication', title: 'Communication', blurb: 'Messages.', providers: ['slack'] },
  { id: 'google', title: 'Google Workspace', blurb: 'Reached with an OAuth app you register yourself; Google\'s servers are in Developer Preview.', providers: ['gmail', 'google-calendar', 'google-drive'] },
  { id: 'search', title: 'Search and research', blurb: 'Search the web.', providers: ['brave-search'] },
  { id: 'business', title: 'Business and payments', blurb: 'Payments and customer records.', providers: ['stripe', 'hubspot', 'salesforce'] },
  { id: 'custom', title: 'Custom APIs', blurb: 'Any REST API of your own.', providers: ['custom-rest'] }
];

const WAY_LABEL = {
  account: 'sign in with your account',
  device: 'sign-in code',
  'own-app': 'an OAuth app you register',
  key: 'a key you create',
  local: 'runs on this computer',
  engine: 'AI engines settings'
};

const json = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

/**
 * The flags for one provider, by rule (never by a hand-kept table):
 *   planned                    nothing is implemented
 *   verified                   a local server whose real tool call is on record: locally tested, no account, no stand-in
 *   limited                    a real server that started and listed its tools, but a call with a real key was never made
 *   everything else            implemented, and its connection path was run against a stand-in; never against the real service
 * `standInTested` is true only when the provider has a way in that the stand-in tests exercise: a sign-in (DCR), a sign-in
 * code (device flow), your own OAuth app (bridge and in-app engine), a key (private pipe or REST header), or a REST template.
 */
function flagsOf(p) {
  const status = p.verification.status;
  const viaStandIn = p.ways.some((w) => ['account', 'device', 'own-app', 'key'].includes(w)) || p.rest.length > 0;
  if (status === 'planned') {
    return { implemented: false, locallyTested: 'no', standInTested: 'no', realAccountVerified: 'no', notYetVerified: false, notImplemented: true, chip: 'not-implemented', chipLabel: 'Not implemented' };
  }
  if (status === 'verified') {
    return { implemented: true, locallyTested: 'yes', standInTested: 'na', realAccountVerified: 'na', notYetVerified: false, notImplemented: false, chip: 'locally-tested', chipLabel: 'Locally tested' };
  }
  if (status === 'limited') {
    return { implemented: true, locallyTested: 'partly', standInTested: viaStandIn ? 'yes' : 'no', realAccountVerified: 'no', notYetVerified: true, notImplemented: false, chip: 'partly-tested', chipLabel: 'Partly tested locally' };
  }
  return { implemented: true, locallyTested: 'no', standInTested: viaStandIn ? 'yes' : 'no', realAccountVerified: 'no', notYetVerified: true, notImplemented: false, chip: 'stand-in-tested', chipLabel: 'Stand-in tested' };
}

/** Where the numbers and versions of a run live. Every file named here must exist and show a passing run. */
function runOf(rel) {
  if (!rel || !exists(rel)) return null;
  const j = json(rel);
  const results = Array.isArray(j.results) ? j.results : Array.isArray(j.checks) ? j.checks : [];
  const when = j.date ?? j.at ?? j.generatedAt ?? null;
  return { file: rel, checks: results.length, passed: results.filter((r) => r.ok !== false).length, date: when ? String(when).slice(0, 10) : null };
}

const sentence = (s) => String(s).replace(/\s+/g, ' ').trim();

function buildCatalogue() {
  const { PROVIDERS } = loadTs('src/shared/providers.ts');
  const { MCP_CATALOG } = loadTs('src/shared/mcpCatalog.ts');
  const { INTEGRATION_TEMPLATES } = loadTs('src/shared/integrations.ts');
  const { AGENT_COMPAT } = loadTs('src/shared/agentCompat.ts');
  const agentProvider = loadTs('src/shared/agentProvider.ts');
  const en = json('src/renderer/src/i18n/locales/en.json');
  const world = json('src/renderer/src/assets/himym/world.json');

  const providers = PROVIDERS.filter((p) => p.category !== 'ai');
  const engines = PROVIDERS.filter((p) => p.category === 'ai');

  const view = (p) => {
    const f = flagsOf(p);
    return {
      id: p.id,
      label: p.label,
      description: sentence(en.hub.providers[p.id] ?? ''),
      connectsBy: p.ways.map((w) => WAY_LABEL[w] ?? w),
      ways: [...p.ways],
      mcpServers: [...p.mcp],
      restTemplates: [...p.rest],
      appStatus: p.verification.status,
      note: sentence(p.verification.note),
      evidence: p.verification.evidence ?? null,
      checkedOn: p.verification.on ?? null,
      ...f
    };
  };

  const byId = new Map(providers.map((p) => [p.id, view(p)]));
  const groups = GROUPS.map((g) => ({ id: g.id, title: g.title, blurb: g.blurb, providers: g.providers.map((id) => byId.get(id)).filter(Boolean) }));

  // ── the coding agents ───────────────────────────────────────────────────────────────────────────────────────────
  const AGENT_FACTS = {
    claude: { providerId: 'claude', summary: 'Gets its integrations from a config file in its own folder that its own settings forbid it to read. Skills live in its own folder.' },
    codex: { providerId: 'codex', summary: 'Gets the broker address on its command line and the pass in one variable that is kept out of its shell\'s environment. Skills live in the shared agents folder.' },
    gemini: { providerId: 'gemini', summary: 'Gets a Gemini home of its own whose settings name one variable that holds the pass. Skills live in the shared agents folder.' }
  };
  const runFiles = {
    claude: { integrations: 'evidence/stage-b/stage-b-live.json', skills: 'evidence/claude/claude-skills-live.json' },
    codex: { integrations: 'evidence/codex/codex-live.json', skills: 'evidence/codex/codex-live.json' },
    gemini: { integrations: 'evidence/gemini/gemini-live.json', skills: 'evidence/gemini/gemini-live.json' }
  };
  const versionOf = (key) => {
    const j = json(runFiles[key].integrations);
    const raw = j.claude ?? j.codex ?? j.gemini ?? '';
    return String(raw).replace(/^(codex-cli|gemini-cli)\s+/, '').replace(/\s*\(Claude Code\)/, '');
  };
  const agents = AGENT_COMPAT.map((a) => {
    const facts = AGENT_FACTS[a.agent];
    const info = agentProvider.installInfoForProvider(facts.providerId) ?? {};
    const integrationsRun = runOf(a.integrationsEvidence[0]);
    const ev = json(a.integrationsEvidence[0]);
    // how real the run was, read from the run itself: a stand-in model and provider, or a real model with real local servers
    const how = ev.stands_in_for
      ? { kind: 'stand-in', text: 'a stand-in model and a stand-in provider; no model account and no third-party account' }
      : { kind: 'real-model', text: `a real model (${ev.model}) and the real pinned local servers; no third-party account` };
    return {
      key: a.agent,
      label: a.label,
      summary: facts.summary,
      integrations: a.integrations,
      skills: a.skills,
      version: versionOf(a.agent),
      installCommand: info.command ?? null,
      docsUrl: info.docsUrl ?? null,
      // what was shown, stated as a measurement
      shell: { passHidden: a.capabilityHiddenFromShell, onlyWhileSandboxed: a.shellProtectionNeedsSandbox },
      folderTrustRequired: a.folderTrustRequired,
      skillFolders: [...a.skillFolders],
      skillTarget: a.skillTarget,
      run: integrationsRun,
      skillsRun: runOf(a.skillsEvidence[0]),
      runHow: how,
      thirdPartyAccountUsed: false
    };
  });

  const supportedEngines = (() => {
    const presets = agentProvider.AGENT_PROVIDER_PRESETS;
    const list = Array.isArray(presets) ? presets : Object.entries(presets).map(([id, v]) => ({ id, ...v }));
    return list.map((p) => ({ id: p.id, label: p.label }));
  })();

  // ── the locations ───────────────────────────────────────────────────────────────────────────────────────────────
  const locations = world.order.map((id, i) => ({
    id,
    label: world.locations[id].label,
    key: i + 1,
    bossSeat: world.hq?.[id]?.boss ?? null,
    bossCharacter: world.hq?.[id]?.cast?.[0] ?? null
  }));

  // ── the runs behind the claims ──────────────────────────────────────────────────────────────────────────────────
  const runs = {
    localServers: runOf('evidence/stage-b/packages-node26.json'),
    claudeWithPinnedServers: runOf('evidence/stage-b/stage-b-live.json'),
    claudeSkills: runOf('evidence/claude/claude-skills-live.json'),
    codex: runOf('evidence/codex/codex-live.json'),
    gemini: runOf('evidence/gemini/gemini-live.json'),
    desktopAppDevelopment: runOf('evidence/ui/ui-validation.json'),
    desktopAppPackaged: runOf('evidence/ui-packaged/ui-validation.json')
  };

  const flat = groups.flatMap((g) => g.providers);
  const countWhere = (fn) => flat.filter(fn).length;

  return {
    generatedBy: 'tools/lib/catalogue.cjs, from src/shared/providers.ts, mcpCatalog.ts, integrations.ts, agentCompat.ts, agentProvider.ts, the English locale, the world file and evidence/**',
    terms: TERMS,
    groups,
    providers: flat,
    agents,
    supportedEngines,
    locations,
    engineKeys: engines.map((p) => ({ id: p.id, label: p.label })),
    hubTabs: Object.values(en.hub.tabs),
    runs,
    counts: {
      providers: flat.length,
      providersImplemented: countWhere((p) => p.implemented),
      groups: groups.length,
      mcpCatalogueEntries: MCP_CATALOG.length,
      localServers: countWhere((p) => p.locallyTested === 'yes'),
      restTemplates: INTEGRATION_TEMPLATES.length,
      accountSignIn: countWhere((p) => p.ways.includes('account')),
      ownAppProviders: countWhere((p) => p.ways.includes('own-app')),
      locallyTested: countWhere((p) => p.locallyTested === 'yes'),
      partlyTested: countWhere((p) => p.locallyTested === 'partly'),
      standInTested: countWhere((p) => p.standInTested === 'yes'),
      realAccountVerified: countWhere((p) => p.realAccountVerified === 'yes'),
      notYetVerified: countWhere((p) => p.notYetVerified),
      notImplemented: countWhere((p) => p.notImplemented),
      codingAgentsWithIntegrations: agents.length,
      supportedEngines: supportedEngines.filter((e) => e.id !== 'custom').length,
      locations: locations.length,
      hubTabs: Object.keys(en.hub.tabs).length
    }
  };
}

module.exports = { buildCatalogue, flagsOf, runOf, TERMS, GROUPS, WAY_LABEL, ROOT };
