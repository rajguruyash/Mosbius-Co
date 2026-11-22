'use strict';

/**
 * The landing page (website/) reads like a product page, and what it lists is what the app offers.
 *
 * The page is plain HTML with no bundler. The integration catalogue, the locations and the screenshots on it are generated
 * from the app's own data by tools/build-website.cjs, which also reads the page the way a visitor gets it. These tests run
 * that build in its check mode and pin the checks themselves, so they cannot quietly stop checking. They also keep the
 * engineering detail (test counts, verification labels, security findings, build caveats) off the public page and the
 * README: it lives in DEVELOPMENT.md, INTEGRATIONS.md and SECURITY_REPORT.md.
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

test('the website build passes in check mode: generated files current, links whole, no engineering wording', () => {
  const { problems } = site.build({ check: true });
  assert.deepEqual(problems, [], 'run `npm run website:build` and fix what it reports');
});

test('the catalogue the page is given is what the app offers: every provider that is available, nothing that is not', () => {
  assert.equal(read('website/js/catalogue.js'), site.dataFileText(data), 'website/js/catalogue.js is stale: run `npm run website:build`');
  const shown = data.groups.flatMap((g) => g.providers).map((p) => p.id);
  const offered = catalogue.providers.filter((p) => !p.notImplemented).map((p) => p.id);
  assert.deepEqual(shown, offered);
  assert.equal(shown.includes('salesforce'), false, 'a provider that is not available yet is not advertised');
  assert.equal(shown.length, catalogue.counts.providersImplemented);
  assert.equal(data.locations.length, catalogue.counts.locations);
  // the data file carries no verification vocabulary, counts, versions or findings
  const text = read('website/js/catalogue.js');
  assert.equal(site.ENGINEERING_TALK.test(JSON.stringify(data.groups.map((g) => [g.blurb, g.providers.map((p) => p.description)]))), false);
  for (const key of ['chip', 'chipLabel', 'notYetVerified', 'realAccountVerified', 'standInTested', 'counts', 'terms', 'agents', 'runs']) {
    assert.equal(text.includes(`"${key}"`), false, `the public data file has "${key}"`);
  }
  assert.equal(/\/Users\/|\/home\/[a-z]|[A-Z]:\\\\Users/.test(text), false, 'a personal path is in the data file');
  assert.equal(/gh[pousr]_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{30,}|xox[abp]-[0-9A-Za-z-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY/.test(text), false);
});

test('the screenshots are the app\'s own pictures, copied byte for byte, and nothing else is beside them', () => {
  assert.ok(site.SHOTS.length >= 4);
  for (const s of site.SHOTS) {
    assert.match(s.from, /^evidence\/ui-packaged\/[\w-]+\.png$/);
    assert.equal(Buffer.compare(fs.readFileSync(path.join(ROOT, s.from)), fs.readFileSync(path.join(SITE, 'assets', 'ui', `${s.id}.png`))), 0, `${s.id}.png is not the picture it is copied from`);
    assert.ok(s.alt.length > 30 && s.caption.length > 30, `${s.id} has alt text and a caption`);
  }
  assert.deepEqual(fs.readdirSync(path.join(SITE, 'assets', 'ui')).sort(), site.SHOTS.map((s) => `${s.id}.png`).sort());
  for (const shot of data.screenshots) assert.ok(shot.width > 0 && shot.height > 0);
});

test('as a visitor gets it: every provider once, each filter its own group, a description and a way in on every card', () => {
  const p = page();
  assert.deepEqual(p.missing, [], 'a script asks for an id index.html does not have');
  const cards = p.get('cards');
  const all = data.groups.flatMap((g) => g.providers);
  const names = () => find(cards, (e) => hasClass(e, 'name')).map((e) => e.textContent);
  assert.deepEqual(names(), all.map((x) => x.label));
  find(cards, (e) => hasClass(e, 'card')).forEach((card, i) => {
    assert.ok(find(card, (e) => hasClass(e, 'desc'))[0].textContent.length > 8, `${all[i].label} has a description`);
    assert.ok(find(card, (e) => hasClass(e, 'meta'))[0].textContent.length > 2, `${all[i].label} says how it is set up`);
    assert.equal(find(card, (e) => hasClass(e, 'tag')).length, 0, `${all[i].label} carries no status badge`);
  });
  const how = Object.fromEntries(find(cards, (e) => hasClass(e, 'card')).map((card, i) => [all[i].id, find(card, (e) => hasClass(e, 'meta'))[0].textContent]));
  assert.equal(how.git, 'Runs on your computer');
  assert.match(how.gmail, /Your own OAuth app/);
  assert.match(how.notion, /Sign in/);
  assert.match(how['brave-search'], /API key/);

  const chips = find(p.get('filters'), (e) => hasClass(e, 'chip'));
  assert.deepEqual(chips.map((c) => c.dataset.group), ['all', ...data.groups.map((g) => g.id)]);
  for (const chip of chips.slice(1)) {
    chip.click();
    const group = data.groups.find((g) => g.id === chip.dataset.group);
    assert.deepEqual(names(), group.providers.map((x) => x.label), `the ${group.title} filter`);
    assert.deepEqual(chips.filter((c) => c.getAttribute('aria-pressed') === 'true').map((c) => c.dataset.group), [group.id]);
  }
  assert.match(p.get('slots').textContent, /nothing until you allow it/);
  const shots = find(p.get('shots'), (e) => e.tagName === 'IMG');
  assert.equal(shots.length, data.screenshots.length);
  for (const host of p.filled) for (const text of leaves(host)) assert.equal(/\b(undefined|NaN|null)\b|\[object /.test(text), false, `#${host.id}: ${text}`);
});

test('the homepage is a product page: its sections, its three agents, its calls to action, and none of the removed ones', () => {
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  for (const id of ['top', 'team', 'spawn', 'places', 'cinema', 'features', 'huddle', 'agents', 'plug', 'skills', 'security', 'screens', 'download']) assert.ok(ids.has(id), `#${id} is on the page`);
  for (const id of ['status', 'status-table', 'status-generated', 'limits', 'legend', 'catalogue-counts', 'agent-cards', 'engines-note', 'skills-compat']) assert.equal(ids.has(id), false, `#${id} was removed`);
  const agents = [...html.matchAll(/<article class="agent-card">[\s\S]*?<h3>([^<]+)<\/h3>/g)].map((m) => m[1]);
  assert.deepEqual(agents, ['Claude Code', 'OpenAI Codex', 'Google Gemini CLI']);
  assert.match(html, /Works with Claude Code, OpenAI Codex and Google Gemini CLI\. You only need one\./);
  // download buttons point at the assets README.md gives, and README.md is what the releases really hold
  const direct = [...html.matchAll(/href="(https:\/\/github\.com\/rajguruyash\/Mosbius-Co\/releases\/download\/[^"]+)"/g)].map((m) => m[1]);
  assert.ok(direct.length >= 2, 'hero and download buttons');
  const readme = read('README.md');
  for (const url of direct) assert.ok(readme.includes(url), `${url} is not a download README.md gives`);
  assert.deepEqual([...new Set(direct)].map((u) => u.split('/').pop()).sort(), ['Mosbius-Co-1.1.0-mac-arm64.dmg']);
  // this release is for macOS on Apple silicon only, and the page says so: no Windows download is offered anywhere on it
  assert.equal(/win-x64|\.exe\b|Download for Windows/i.test(html), false, 'no Windows download for this release');
  assert.match(html, /macOS on Apple silicon only/);
  // the disclaimer and one credit stay
  assert.match(html, /a fan-made project, not affiliated with,\s+endorsed by, or connected to/);
  assert.equal((html.match(/Munder\s*Difflin/gi) ?? []).length, 1);
  // every script is the page's own file
  for (const [, attrs, body] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    assert.match(/\ssrc="([^"]+)"/.exec(attrs)?.[1] ?? '', /^js\/[\w-]+\.js$/);
    assert.equal(body.trim(), '');
  }
  const nav = /<nav class="nav">([\s\S]*?)<\/nav>/.exec(html)[1];
  const navTargets = [...nav.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
  for (const id of navTargets) assert.ok(ids.has(id), `the nav links to #${id}`);
  for (const id of ['agents', 'plug', 'skills', 'security', 'download']) assert.ok(navTargets.includes(id));
});

test('engineering detail stays out of the public page, its scripts and the README, and stays in the technical documents', () => {
  const FORBIDDEN = [
    'An honest status', 'stand-in tested', 'real-account verified', 'shell can read the pass', 'bearer value', 'F9',
    '50 of 50 checks', '39 of 39 checks', '26 of 26 checks', 'No real provider account has been used',
    'The published builds were made before', 'This website is a static page', 'WHERE IT STANDS', 'RUN WITH THE REAL CLI',
    'NEEDS ITS SANDBOX ON', 'Not yet verified', 'Locally tested', 'test harness', 'throwaway', 'npm ci', 'npm run dev',
    'built before the integrations and skills platform', 'This is the real thing'
  ];
  const publicFiles = ['website/index.html', 'website/js/integrations.js', 'website/js/ecosystem.js', 'website/js/catalogue.js', 'README.md'];
  for (const f of publicFiles) {
    const text = read(f);
    for (const phrase of FORBIDDEN) assert.equal(text.toLowerCase().includes(phrase.toLowerCase()), false, `${f} still says "${phrase}"`);
  }
  // README: no test counts, versions run, provider statistics or directory tables
  const readme = read('README.md');
  assert.equal(/\b\d+ (?:tests|checks|providers|MCP server|REST templates)\b/i.test(readme), false);
  assert.equal(/\| `src\//.test(readme), false, 'no source-directory table in the README');
  // ... and the detail did not vanish: it is where an engineer looks for it
  const dev = read('DEVELOPMENT.md'), sec = read('SECURITY_REPORT.md'), integ = read('INTEGRATIONS.md');
  assert.match(dev, /39 of 39 checks passed/);
  assert.match(dev, /Stand-in tested/);
  assert.match(dev, /There is no control yet to move an existing agent from one location to another/);
  assert.match(sec, /finding F9, left open on purpose/);
  assert.match(sec, /With the sandbox off, a command can read the pass from the Codex process/);
  assert.match(sec, /`mcp-remote` bridge leaves tokens in readable files/);
  assert.match(sec, /No real provider sign-in has been verified/);
  assert.match(sec, /A pass is a bearer value/);
  assert.match(integ, /Gemini's shell can read the pass/);
  assert.match(read('MOSBIUS_PLATFORM_ROADMAP.md'), /Full suite/);
  assert.ok(fs.existsSync(path.join(ROOT, 'evidence', 'codex', 'codex-live.json')));
});

test('README.md is the product README: its sections in order, each link real, the technical documents linked', () => {
  const readme = read('README.md');
  const headings = readme.split('\n').filter((l) => /^## /.test(l)).map((l) => l.slice(3));
  assert.deepEqual(headings, ['Features', 'The seven locations', 'Agent Huddle', 'Coding agents', 'Integrations and the MCP ecosystem', 'Skills', 'Agent access and permissions', 'Installation and downloads', 'Quick start', 'Feature previews', 'Technology', 'Documentation', 'Licence and credits']);
  for (const doc of ['INTEGRATIONS.md', 'SKILLS.md', 'SECURITY_REPORT.md', 'MCP_BROKER_DESIGN.md', 'DEVELOPMENT.md', 'MOSBIUS_PLATFORM_ROADMAP.md', 'CHANGELOG.md']) {
    assert.ok(readme.includes(`](${doc})`), `README.md links to ${doc}`);
    assert.ok(fs.existsSync(path.join(ROOT, doc)));
  }
  assert.ok(readme.split('\n').length < 215, 'the README stays short');
  const agents = readme.slice(readme.indexOf('## Coding agents'), readme.indexOf('## Integrations'));
  for (const name of ['Claude Code', 'OpenAI Codex', 'Google Gemini CLI']) assert.ok(agents.includes(`**${name}**`));
});

const HUDDLE_POINTS = [
  ['Your Agents, Always Within Reach', 'Huddle Mode'],
  ['Step In Only When It Matters', 'Intelligent Notifications'],
  ['Unified Agent Control', 'Switch between agents, inspect conversations, access terminals, send instructions, and manage tasks from a single compact interface. Your entire AI team stays coordinated and accessible from anywhere on your desktop.']
];

test('the Huddle section is simple: three points in the owner\'s own words, and videos and pictures that are the app\'s own captures, copied byte for byte, each used on the page', () => {
  assert.ok(html.includes('id="huddle"'));
  const section = /<section[^>]*id="huddle"[\s\S]*?<\/section>/.exec(html)[0];
  // the three points, exactly, and nothing else among them
  const points = [...section.matchAll(/<div class="feature"><h3>([^<]+)<\/h3><p>([^<]+)<\/p><\/div>/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(points, HUDDLE_POINTS);
  assert.equal([...section.matchAll(/class="feature"/g)].length, 3, 'no more than the three points');
  assert.match(section, /New in v1\.1\.0, for macOS on Apple silicon\./);
  assert.doesNotMatch(section, /Coming in the next release/, 'the Huddle is out: nothing says it is coming');
  assert.ok(site.proseOf(section).length < 900, 'the section stays short');
  assert.equal(site.engineeringTalk(site.proseOf(section), 'the Huddle section').length, 0);
  // the files
  const media = path.join(ROOT, 'screenshots', 'huddle');
  for (const f of site.HUDDLE_MEDIA) {
    assert.equal(Buffer.compare(fs.readFileSync(path.join(media, f)), fs.readFileSync(path.join(SITE, 'assets', 'huddle', f))), 0, `${f} is not the file it is copied from`);
    assert.ok(html.includes(`assets/huddle/${f}`), `${f} is not used on the page`);
  }
  assert.deepEqual(fs.readdirSync(path.join(SITE, 'assets', 'huddle')).sort(), [...site.HUDDLE_MEDIA].sort(), 'nothing else is beside them');
  // two videos, each silent, looping, playing inline, with a still and a name, and none that starts by itself
  const videos = [...section.matchAll(/<video\b[^>]*>/gi)].map((m) => m[0]);
  assert.equal(videos.length, 2);
  for (const v of videos) {
    for (const attr of ['muted', 'playsinline', 'loop', 'poster=', 'aria-label=', 'data-huddle-video']) assert.match(v, new RegExp(`\\s${attr}`), `a video has ${attr}`);
    assert.doesNotMatch(v, /\sautoplay\b/, 'nothing starts by itself: huddle.js starts a video while it is on screen');
  }
  assert.match(videos[0], /huddle-desktop-poster\.jpg/);
  // every picture says what it shows and has its size, so that the page does not jump as it loads
  const pictures = [...section.matchAll(/<img\b[^>]*assets\/huddle\/[^>]*>/gi)].map((m) => m[0]);
  assert.equal(pictures.length, site.HUDDLE_MEDIA.filter((f) => f.endsWith('.png')).length);
  for (const img of pictures) {
    assert.match(img, /\salt="[^"]{40,}"/, `alt text: ${img.slice(0, 60)}`);
    const file = /assets\/huddle\/([\w-]+\.png)/.exec(img)[1];
    const png = fs.readFileSync(path.join(SITE, 'assets', 'huddle', file));
    assert.deepEqual([Number(/\swidth="(\d+)"/.exec(img)?.[1]), Number(/\sheight="(\d+)"/.exec(img)?.[1])], [png.readUInt32BE(16), png.readUInt32BE(20)], `${file}: the width and height on the page are the picture's own`);
  }
  // a page that stays light, and the script that plays the videos is the page's own and keeps to reduced motion
  const bytes = site.HUDDLE_MEDIA.reduce((n, f) => n + fs.statSync(path.join(SITE, 'assets', 'huddle', f)).size, 0);
  assert.ok(bytes < 9 * 1024 * 1024, `the Huddle's pictures and videos are ${Math.round(bytes / 1024)} KB`);
  const js = read('website/js/huddle.js');
  assert.match(js, /reducedMotion/);
  assert.match(js, /IntersectionObserver/);
  assert.match(html, /<script src="js\/huddle\.js"><\/script>/);
});

test('the README shows the Huddle the same simple way: the three points, the videos as GIFs with the full video linked, the pictures, every file real', () => {
  const readme = read('README.md');
  const section = readme.slice(readme.indexOf('## Agent Huddle'), readme.indexOf('## Coding agents'));
  for (const [title, text] of HUDDLE_POINTS) assert.ok(section.includes(`**${title}.** ${text}`), `the README gives "${title}"`);
  assert.equal([...section.matchAll(/^- \*\*/gm)].length, 3, 'no more than the three points');
  assert.match(section, /> New in v1\.1\.0, for macOS on Apple silicon\./);
  assert.doesNotMatch(section, /Coming in the next release/, 'the Huddle is out: nothing says it is coming');
  const files = [...section.matchAll(/(?:src="|href=")(screenshots\/huddle\/[\w-]+\.(?:png|gif|mp4))/g)].map((m) => m[1]);
  for (const f of new Set(files)) assert.ok(fs.existsSync(path.join(ROOT, f)), `${f} is not in the repository`);
  for (const f of ['huddle-desktop.gif', 'huddle-desktop.mp4', 'huddle-approve.gif', 'huddle-answer.gif', 'huddle-story.mp4', 'huddle-compact.png', 'huddle-expanded.png', 'huddle-agent.png']) assert.ok(files.includes(`screenshots/huddle/${f}`), `${f} is shown or linked`);
  for (const m of section.matchAll(/<img\b[^>]*>/g)) assert.match(m[0], /\salt="[^"]{30,}"/, 'every picture has alt text');
  assert.ok(readme.includes('[Agent Huddle](#agent-huddle)'), 'the contents line links to it');
  // GitHub will not play a video inside a README: GIFs show the motion there, and the video is a link to the file
  assert.equal(/<video\b/i.test(readme), false);
  for (const f of ['huddle-desktop.gif', 'huddle-approve.gif', 'huddle-answer.gif']) assert.ok(fs.statSync(path.join(ROOT, 'screenshots', 'huddle', f)).size < 8 * 1024 * 1024, `${f} is small enough to show`);
});

test('the counts on the page are generated: markers are filled from the data and no count is typed beside them', () => {
  const values = site.markerValues(catalogue);
  const { out } = site.fillMarkers(html, values);
  assert.equal(out, html, 'index.html has stale generated values: run `npm run website:build`');
  assert.equal(values['locations-word'], site.word(catalogue.counts.locations));
  assert.throws(() => site.fillMarkers('<!--gen:nope-->x<!--/gen-->', values), /unknown generated marker/);
  assert.equal(site.fillMarkers('a <!--gen:locations-word-->ninety<!--/gen--> b', values).out, `a <!--gen:locations-word-->${values['locations-word']}<!--/gen--> b`);
  assert.deepEqual(site.staleCountProblems(site.proseOf(html), 'index.html'), []);
});

test('the checks themselves: engineering wording, a typed count and an overclaim are caught, honest copy is not', () => {
  for (const bad of ['Every provider is stand-in tested.', 'Gemini: its shell can read the pass.', 'See the bearer value note.', 'Tested 39 of 39 checks passed today.', 'Run npm ci first.', 'Cross-built on a Mac.', 'Unsigned and not notarised.']) {
    assert.equal(site.engineeringTalk(bad, 'x').length, 1, bad);
  }
  for (const good of ['Connect services like GitHub, Notion and Slack.', 'Give each agent only the services it needs.', 'Take access away and it applies at once.', 'Download for macOS.']) {
    assert.deepEqual(site.engineeringTalk(good, 'x'), [], good);
  }
  assert.equal(site.staleCountProblems('It ships seven MCP servers.', 'x').length, 1);
  assert.deepEqual(site.staleCountProblems('Move it from one room to another.', 'x'), []);
  assert.equal(site.staleCountProblems(site.proseOf('<p>The seven local servers run here.</p>'), 'x').length, 1);
  assert.deepEqual(site.staleCountProblems(site.proseOf('<p>The <!--gen:local-word-->seven<!--/gen--> local servers run here.</p>'), 'x'), []);
  assert.equal(site.claimsProblems('Notion is verified.', accountLabels, 'x').length, 1);
  assert.deepEqual(site.claimsProblems('Notion is not verified.', accountLabels, 'x'), []);
  assert.equal(site.claimsProblems('It is production-ready.', accountLabels, 'x').length, 1);

  // a page that regresses is caught by the build: wording in the page, wording in a script, a script asking for a missing id
  const withTalk = html.replace('<h2>Your agents, one office.</h2>', '<h2>An honest status.</h2>');
  assert.notEqual(withTalk, html);
  assert.ok(site.engineeringTalk(site.proseOf(withTalk), 'x').length > 0);
  const r = site.renderedProblems({ html: html.replace('id="filters"', 'id="filters-gone"'), dataText: site.dataFileText(data), data, accountLabels });
  assert.ok(r.problems.some((m) => /asks for #filters/.test(m) || /did not render/.test(m)));
  const lie = JSON.parse(JSON.stringify(data));
  lie.groups[0].providers[0].description = 'Verified against a stand-in service.';
  const r2 = site.renderedProblems({ html, dataText: site.dataFileText(lie), data: lie, accountLabels });
  assert.ok(r2.problems.some((m) => /engineering wording/.test(m)), r2.problems.join('\n'));
});

test('the scanner that reads a script\'s words: strings in, comments and code out', () => {
  const lits = site.stringLiterals([
    '// seven MCP servers in a comment', '/* nine providers in a block comment */',
    'const a = \'it\\\'s here\'; const b = "two words";', 'const c = `x ${a + `${b}`} y`;', 'const url = \'https://example.test/a//b\';'
  ].join('\n'));
  assert.deepEqual(lits, ['it\'s here', 'two words', 'x … y', 'https://example.test/a//b']);
  for (const f of ['integrations.js', 'ecosystem.js']) {
    for (const lit of site.stringLiterals(read(`website/js/${f}`))) {
      assert.deepEqual(site.staleCountProblems(lit, f), []);
      assert.deepEqual(site.engineeringTalk(lit, f), []);
    }
  }
});

test('the page keeps working without the data file, and its rooms are the app\'s locations', () => {
  const p = runSite({ html, scripts: [{ name: 'integrations.js', source: read('website/js/integrations.js') }, { name: 'ecosystem.js', source: read('website/js/ecosystem.js') }] });
  assert.deepEqual(p.filled, []);
  const vm = require('node:vm');
  const sandbox = { window: {} };
  vm.runInNewContext(read('website/js/rooms-manifest.js'), sandbox);
  assert.deepEqual(Object.keys(sandbox.window.ROOMS.rooms).sort(), catalogue.locations.map((l) => l.id).sort());
});
