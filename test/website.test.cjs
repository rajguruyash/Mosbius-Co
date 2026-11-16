'use strict';

/**
 * The landing page (website/) says what the app says, and nothing more.
 *
 * The page is plain HTML with no bundler. Everything on it that states a fact about the product (which providers exist,
 * how each connects, how far each was checked, which agent CLIs are covered, how many locations there are) is generated
 * from the app's own data by tools/build-website.cjs, and that script also reads the page the way a visitor gets it.
 * These tests run that build in its check mode, so a stale data file, a broken link, a missing provider or an
 * overclaim fails the suite, and they pin the checks themselves, so the checks cannot quietly stop checking.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const site = require('../tools/build-website.cjs');
const { buildCatalogue } = require('../tools/lib/catalogue.cjs');
const { runSite, leaves, find, hasClass } = require('../tools/lib/site-dom.cjs');

const ROOT = path.join(__dirname, '..');
const SITE = path.join(ROOT, 'website');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const catalogue = buildCatalogue();
const data = site.buildData(catalogue);
const html = read('website/index.html');
const accountLabels = catalogue.providers.filter((p) => p.chip !== 'locally-tested' && p.id !== 'custom-rest').map((p) => p.label);

const page = () => runSite({
  html,
  scripts: [
    { name: 'catalogue.js', source: site.dataFileText(data) },
    { name: 'integrations.js', source: read('website/js/integrations.js') },
    { name: 'ecosystem.js', source: read('website/js/ecosystem.js') }
  ]
});

test('the website build passes in check mode: generated files current, links whole, nothing overclaimed', () => {
  const { problems } = site.build({ check: true });
  assert.deepEqual(problems, [], 'run `npm run website:build` and fix what it reports');
});

test('the data the page is given is the app\'s own, and is what is committed', () => {
  assert.equal(read('website/js/catalogue.js'), site.dataFileText(data), 'website/js/catalogue.js is stale: run `npm run website:build`');
  const flat = data.groups.flatMap((g) => g.providers);
  assert.deepEqual(flat.map((p) => p.id), catalogue.providers.map((p) => p.id));
  assert.deepEqual(data.agents.map((a) => a.label), ['Claude Code', 'Codex CLI', 'Gemini CLI']);
  assert.equal(data.counts.realAccountVerified, 0);
  // nothing that identifies the machine it was built on, and no credential-shaped value, ends up in a public file
  const text = read('website/js/catalogue.js');
  assert.equal(/\/Users\/|\/home\/[a-z]|[A-Z]:\\\\Users/.test(text), false, 'a personal path is in the data file');
  assert.equal(/gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{20,}|xox[abp]-[0-9A-Za-z-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY/.test(text), false, 'something shaped like a credential is in the data file');
});

test('the screenshots are the real captures of the packaged app, byte for byte, and nothing else is beside them', () => {
  assert.ok(site.SHOTS.length >= 4);
  for (const s of site.SHOTS) {
    assert.match(s.from, /^evidence\/ui-packaged\/[\w-]+\.png$/, `${s.id} comes from the packaged-app run`);
    const src = fs.readFileSync(path.join(ROOT, s.from));
    const copy = fs.readFileSync(path.join(SITE, 'assets', 'ui', `${s.id}.png`));
    assert.equal(Buffer.compare(src, copy), 0, `website/assets/ui/${s.id}.png is not the capture it is copied from`);
    assert.ok(s.alt.length > 40 && s.caption.length > 40, `${s.id} has alt text and a caption`);
  }
  assert.deepEqual(fs.readdirSync(path.join(SITE, 'assets', 'ui')).sort(), site.SHOTS.map((s) => `${s.id}.png`).sort());
  // the run those captures come from is recorded, and it passed
  const run = JSON.parse(read('evidence/ui-packaged/ui-validation.json'));
  const results = run.results ?? run.checks ?? [];
  assert.ok(results.length > 0 && results.every((r) => r.ok !== false));
  for (const shot of data.screenshots) assert.ok(shot.width > 0 && shot.height > 0, `${shot.id}: its size is read from the file`);
});

test('as a visitor gets it: every provider once, each filter its own group, each state in the data\'s words', () => {
  const p = page();
  assert.deepEqual(p.missing, [], 'a script asks for an id index.html does not have');
  const cards = p.get('cards');
  const all = data.groups.flatMap((g) => g.providers);
  const names = () => find(cards, (e) => hasClass(e, 'name')).map((e) => e.textContent);
  assert.deepEqual(names(), all.map((x) => x.label));

  const cardEls = find(cards, (e) => hasClass(e, 'card'));
  cardEls.forEach((card, i) => {
    const tags = find(card, (e) => hasClass(e, 'tag')).map((e) => e.textContent);
    assert.equal(tags[0], all[i].chipLabel.toUpperCase(), `${all[i].label}: the first tag is its state`);
    assert.equal(tags.includes('NOT YET VERIFIED'), all[i].notYetVerified, `${all[i].label}: "not yet verified" follows the data`);
    assert.equal(tags.some((t) => /^VERIFIED$|REAL-ACCOUNT VERIFIED/.test(t)), false, `${all[i].label} is not called verified`);
  });

  const chips = find(p.get('filters'), (e) => hasClass(e, 'chip'));
  assert.deepEqual(chips.map((c) => c.dataset.group), ['all', ...data.groups.map((g) => g.id)]);
  for (const chip of chips.slice(1)) {
    chip.click();
    const group = data.groups.find((g) => g.id === chip.dataset.group);
    assert.deepEqual(names(), group.providers.map((x) => x.label), `the ${group.title} filter`);
    assert.deepEqual(chips.filter((c) => c.getAttribute('aria-pressed') === 'true').map((c) => c.dataset.group), [group.id], 'one filter is pressed at a time');
    assert.match(p.get('cards-caption').textContent, new RegExp(`^Showing ${group.providers.length}: `));
  }
  // the legend defines every word the cards use
  const legend = find(p.get('legend'), (e) => e.tagName === 'DT').map((e) => e.textContent);
  assert.deepEqual(legend, data.terms.map((t) => t.label));
  // a new agent can reach nothing, and the panel says so
  assert.match(p.get('slots').textContent, /nothing until you allow it/);
});

test('as a visitor gets it: the agents, their limits, and a status that counts from the data', () => {
  const p = page();
  const agentText = leaves(p.get('agent-cards')).join('\n');
  for (const a of data.agents) {
    assert.ok(agentText.includes(a.label), `${a.label} has a card`);
    assert.ok(agentText.includes(`version run: ${a.version}`), `${a.label}: the version that was run`);
    assert.ok(agentText.includes(`${a.run.passed} of ${a.run.checks} checks passed`), `${a.label}: the run's own numbers`);
    assert.ok(agentText.includes(a.installCommand));
  }
  assert.match(agentText, /SHELL CAN READ THE PASS/);
  assert.match(agentText, /NEEDS ITS SANDBOX ON/);
  assert.match(agentText, /TRUSTED FOLDERS ONLY/);

  const limits = leaves(p.get('limits')).join('\n');
  for (const must of [
    /Gemini CLI: its shell can read the pass/, /Finding F9, left open on purpose/,
    /Codex CLI: the protection needs its sandbox/, /With the sandbox off, a command can read the pass/,
    /mcp-remote bridge, which keeps their tokens in readable files/, /Gmail/, /Slack/,
    /No real provider account has been used/, /Windows and Linux were not run/, /A pass is a bearer value/
  ]) assert.match(limits, must);

  const status = leaves(p.get('status-generated')).join('\n');
  assert.ok(status.includes(data.countsSentence));
  assert.match(status, /None has been verified with a real account/);
  for (const l of data.locations) assert.ok(status.includes(l.label), `${l.label} is in the status table`);
  // nothing the scripts drew is a missing value
  for (const host of p.filled) for (const text of leaves(host)) assert.equal(/\b(undefined|NaN|null)\b|\[object /.test(text), false, `#${host.id}: ${text}`);
});

test('the page itself: the disclaimer, one credit, the honest status, and no script from anywhere else', () => {
  assert.match(html, /a fan-made project, not affiliated with,\s+endorsed by, or connected to/);
  assert.equal((html.match(/Munder\s*Difflin/gi) ?? []).length, 1, 'the upstream project is credited once');
  assert.match(html, /Built upon the original Munder Difflin project; credit to its original creators for the\s+foundational work\./);
  assert.match(html, /has never been run on Windows hardware/);
  assert.match(html, /An AppImage target is configured\. Not built, not run\./);
  assert.match(html, /It is not deployed anywhere by the project/);
  assert.match(html, /not in these installers/);
  assert.match(html, /there is no control yet to move an agent from one room to another/);
  // every script is the page's own file: nothing is loaded from another origin, and nothing runs inline
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  assert.ok(scripts.length >= 10);
  for (const [, attrs, body] of scripts) {
    const src = /\ssrc="([^"]+)"/.exec(attrs)?.[1];
    assert.ok(src && /^js\/[\w-]+\.js$/.test(src), `a script is not one of the page's own files: ${attrs}`);
    assert.equal(body.trim(), '', 'no inline script');
  }
  // every section the nav points at is there, and every section can be reached from the nav
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const nav = /<nav class="nav">([\s\S]*?)<\/nav>/.exec(html)[1];
  const navTargets = [...nav.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
  for (const id of navTargets) assert.ok(ids.has(id), `the nav links to #${id}`);
  for (const id of ['agents', 'plug', 'skills', 'security', 'status', 'download']) assert.ok(navTargets.includes(id), `the nav reaches #${id}`);
  // the page and README.md point at the same published builds
  const tags = (text) => [...new Set([...text.matchAll(/releases\/tag\/(v[0-9.]+)/g)].map((m) => m[1]))].sort();
  assert.deepEqual(tags(html), tags(read('README.md')));
});

test('the counts on the page are generated: the markers are filled from the data and no count is typed beside them', () => {
  const values = site.markerValues(catalogue);
  const { out, used } = site.fillMarkers(html, values);
  assert.equal(out, html, 'index.html has stale generated values: run `npm run website:build`');
  assert.ok(used.has('locations-word') && used.has('agents-word') && used.has('rest-word') && used.has('local-word'));
  assert.equal(values['locations-word'], site.word(catalogue.counts.locations));
  assert.throws(() => site.fillMarkers('<!--gen:nope-->x<!--/gen-->', values), /unknown generated marker/);
  // a filled marker is rewritten from the data, whatever was typed inside it
  assert.equal(site.fillMarkers('a <!--gen:locations-word-->ninety<!--/gen--> b', values).out, `a <!--gen:locations-word-->${values['locations-word']}<!--/gen--> b`);
  assert.deepEqual(site.staleCountProblems(site.proseOf(html), 'index.html'), []);
});

test('the checks themselves: a typed count and an overclaim are caught, an honest sentence is not', () => {
  // counts
  assert.equal(site.staleCountProblems('It ships seven MCP servers.', 'x').length, 1);
  assert.equal(site.staleCountProblems('There are 22 providers here.', 'x').length, 1);
  assert.equal(site.staleCountProblems('Pick from twelve more integrations today.', 'x').length, 1);
  assert.deepEqual(site.staleCountProblems('Move it from one room to another.', 'x'), [], '"one" is not a count that goes stale');
  assert.deepEqual(site.staleCountProblems(site.proseOf('<p>The <!--gen:local-word-->seven<!--/gen--> local servers run here.</p>'), 'x'), [], 'a generated count is not a typed one');
  assert.equal(site.staleCountProblems(site.proseOf('<p>The seven local servers run here.</p>'), 'x').length, 1);

  // claims: a named account-based provider may not be called verified, unless the sentence says it is not
  const labels = accountLabels;
  assert.ok(labels.includes('Notion') && labels.includes('GitHub') && labels.includes('Gmail') && labels.includes('Slack'));
  assert.equal(labels.includes('Filesystem'), false, 'a local server that answered a real call may be called verified');
  assert.equal(site.claimsProblems('Notion is verified.', labels, 'x').length, 1);
  assert.equal(site.claimsProblems('GitHub and Slack: verified end to end.', labels, 'x').length, 1);
  assert.deepEqual(site.claimsProblems('Notion is not verified.', labels, 'x'), []);
  assert.deepEqual(site.claimsProblems('Nobody has signed in to Notion through the app yet, so it is not marked verified.', labels, 'x'), []);
  assert.deepEqual(site.claimsProblems('Filesystem is verified: it answered a real tool call.', labels, 'x'), []);
  assert.deepEqual(site.claimsProblems('Notion works. The local servers are verified.', labels, 'x'), [], 'the claim is judged sentence by sentence');
  // things the project cannot say of itself
  assert.equal(site.claimsProblems('It is production-ready.', labels, 'x').length, 1);
  assert.equal(site.claimsProblems('Fully tested on every platform.', labels, 'x').length, 1);
  assert.equal(site.claimsProblems('It works on Windows.', labels, 'x').length, 1);
  assert.deepEqual(site.claimsProblems('It has not been tested on Windows hardware.', labels, 'x'), []);

  // the page as rendered is held to the same rule: a data file that calls an account-based provider verified is caught
  const lie = JSON.parse(JSON.stringify(data));
  const notion = lie.groups.flatMap((g) => g.providers).find((x) => x.id === 'notion');
  notion.note = 'Notion is verified with a real account.';
  const r = site.renderedProblems({ html, dataText: site.dataFileText(lie), data: lie, accountLabels: labels });
  assert.ok(r.problems.some((m) => /calls "notion" verified/.test(m)), r.problems.join('\n'));
  // and a card that drifts from the data is caught
  const drift = JSON.parse(JSON.stringify(data));
  const r2 = site.renderedProblems({ html: html.replace('id="legend"', 'id="legend-gone"'), dataText: site.dataFileText(drift), data: drift, accountLabels: labels });
  assert.ok(r2.problems.some((m) => /asks for #legend/.test(m)), 'a script asking for an element the page does not have is caught');
});

test('the scanner that reads a script\'s words: strings in, comments and code out', () => {
  const lits = site.stringLiterals([
    '// seven MCP servers in a comment',
    '/* nine providers in a block comment */',
    'const a = \'it\\\'s here\'; const b = "two words";',
    'const c = `x ${a + `${b}`} y`;',
    'const url = \'https://example.test/a//b\';'
  ].join('\n'));
  assert.deepEqual(lits, ['it\'s here', 'two words', 'x … y', 'https://example.test/a//b']);
  // the two data-driven scripts type no count and no claim of their own
  for (const f of ['integrations.js', 'ecosystem.js']) {
    for (const lit of site.stringLiterals(read(`website/js/${f}`))) {
      assert.deepEqual(site.staleCountProblems(lit, f), []);
      assert.deepEqual(site.claimsProblems(lit, accountLabels, f), []);
    }
  }
});

test('the page keeps working without the data file: the two scripts stop quietly instead of throwing', () => {
  const p = runSite({ html, scripts: [{ name: 'integrations.js', source: read('website/js/integrations.js') }, { name: 'ecosystem.js', source: read('website/js/ecosystem.js') }] });
  assert.deepEqual(p.filled, []);
});

test('the rooms the page can show are the app\'s locations', () => {
  const vm = require('node:vm');
  const sandbox = { window: {} };
  vm.runInNewContext(read('website/js/rooms-manifest.js'), sandbox);
  assert.deepEqual(Object.keys(sandbox.window.ROOMS.rooms).sort(), catalogue.locations.map((l) => l.id).sort());
});
