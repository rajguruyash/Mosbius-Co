'use strict';

/**
 * Markdown for the generated parts of README.md and INTEGRATIONS.md, rendered from the catalogue object
 * (tools/lib/catalogue.cjs) and nothing else. No sentence in here states a count or a status by hand.
 */

const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
const MARK = { yes: '✓', partly: 'partly', no: '—', na: 'n/a' };

/** One short phrase for the state of a provider: exactly the words of the legend, no new ones. */
function statusPhrase(p) {
  if (p.notImplemented) return 'Not implemented';
  if (p.chip === 'locally-tested') return 'Locally tested';
  if (p.chip === 'partly-tested') return 'Partly tested locally · Not yet verified';
  return 'Stand-in tested · Not yet verified';
}

function legendMd(c) {
  return c.terms.map((t) => `- **${t.label}.** ${t.meaning}`).join('\n') +
    '\n- **✓, partly, —, n/a.** In the tables: yes, only in part, no, and "does not apply" (a local server needs no account, so nothing about an account applies to it).';
}

function providerTableMd(group) {
  const rows = [
    '| Provider | What an agent can do | Connects by | Implemented | Locally tested | Stand-in tested | Real-account verified | Status |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |'
  ];
  for (const p of group.providers) {
    rows.push(`| **${cell(p.label)}** | ${cell(p.description)} | ${cell(p.connectsBy.join(', ') || 'not available yet')} | ${MARK[p.implemented ? 'yes' : 'no']} | ${MARK[p.locallyTested]} | ${MARK[p.standInTested]} | ${MARK[p.realAccountVerified]} | ${statusPhrase(p)} |`);
  }
  return rows.join('\n');
}

function countsMd(c) {
  const n = c.counts;
  return `${n.providers} providers in ${n.groups} groups: ${n.providersImplemented} implemented, ${n.notImplemented} not implemented. ` +
    `${n.locallyTested} are locally tested (real tool calls), ${n.partlyTested} partly, ${n.standInTested} have had their connection path run against a stand-in, ` +
    `and **${n.realAccountVerified} have been verified with a real account**. Behind them are ${n.mcpCatalogueEntries} MCP server entries and ${n.restTemplates} REST templates.`;
}

function catalogueMd(c) {
  const parts = [countsMd(c), '', '**What the words mean**', '', legendMd(c), ''];
  for (const g of c.groups) {
    parts.push(`#### ${g.title}`, '', g.blurb, '', providerTableMd(g), '');
  }
  const engines = c.engineKeys.map((e) => e.label).join(', ');
  parts.push(`Not integrations, and not counted above: the keys the agents' own engines use (${engines}). The Discover tab lists them too, which is why it shows ${c.counts.providers + c.engineKeys.length} entries, but they are set under **Settings → AI engines**.`);
  return parts.join('\n');
}

/** The app's three words for how far something was shown (src/shared/agentCompat.ts), said in full. */
function supportWord(s) {
  if (s === 'verified') return 'Verified';
  if (s === 'wired') return 'Wired, not run';
  return 'Not supported';
}

function runPhrase(run) {
  if (!run) return 'no run recorded';
  return `${run.passed} of ${run.checks} checks`;
}

function agentsTableMd(c) {
  const rows = [
    '| Coding agent | Version run | How it is handed an integration | Can its shell read the pass? | Integrations | Skills |',
    '| --- | --- | --- | --- | --- | --- |'
  ];
  for (const a of c.agents) {
    const shell = a.shell.passHidden === 'yes'
      ? (a.shell.onlyWhileSandboxed ? 'No, **only while Codex\'s OS sandbox is on**; with it off, a command can read it from the Codex process' : 'No')
      : a.shell.passHidden === 'no' ? '**Yes** (finding F9, left open: no Gemini setting can stop it)' : 'Not measured';
    const trust = a.folderTrustRequired ? ' Loads integrations only in folders you have trusted in Gemini.' : '';
    const folders = a.skillFolders.map((f) => `\`${f}\``).join(', ');
    const integ = a.integrations === 'verified'
      ? `Verified: the real CLI, ${runPhrase(a.run)} passed${a.run ? ` (${a.run.date})` : ''}, with ${a.runHow.text}`
      : supportWord(a.integrations);
    const skills = a.skills === 'verified' ? `Verified: the real CLI lists skills from ${folders}` : `${supportWord(a.skills)}: it would read ${folders}`;
    rows.push(`| **${cell(a.label)}** | ${cell(a.version)} | ${cell(a.summary)}${trust} | ${shell} | ${integ} | ${skills} |`);
  }
  return rows.join('\n');
}

module.exports = { catalogueMd, agentsTableMd, providerTableMd, legendMd, countsMd, statusPhrase, MARK, cell };
