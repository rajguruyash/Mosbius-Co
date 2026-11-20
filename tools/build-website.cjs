#!/usr/bin/env node
'use strict';

/**
 * The website's "production build".
 *
 * website/ is plain HTML, CSS and scripts with no bundler, so nothing needs compiling. What does need doing, every time,
 * is keeping the parts of the page that state facts about the product in step with the product, and refusing to ship a
 * page that says something the product does not. This script does that:
 *
 *   1. writes website/js/catalogue.js from the app's own data (tools/lib/catalogue.cjs): every provider with its
 *      group, how it connects and how far it has been checked; the coding agents; the locations; the counts;
 *   2. copies the settings screenshots from evidence/ui-packaged/ (real captures of the packaged app, taken by
 *      tools/ui-validate.cjs) into website/assets/ui/, byte for byte, so a screenshot cannot be edited by hand;
 *   3. fills every <!--gen:name-->value<!--/gen--> in website/index.html (counts, written as words) from that data;
 *   4. checks the files: every link, anchor, image, script and stylesheet resolves; every image has alt text; every
 *      script parses; no count is left typed by hand outside a generated marker; the rooms are the app's locations;
 *   5. runs the page's own scripts against that data on a stand-in page (tools/lib/site-dom.cjs) and reads what a
 *      visitor would get: every provider drawn once, each filter showing its own group, nothing rendered as
 *      "undefined", and no sentence that calls an account-based provider verified without saying it is not.
 *
 *   node tools/build-website.cjs          write what is generated, then check
 *   node tools/build-website.cjs --check  write nothing; fail if a generated file is stale, then check (CI uses this)
 *
 * It deploys nothing. Exit code 1 on any problem.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { buildCatalogue, ROOT } = require('./lib/catalogue.cjs');
const { runSite, leaves, find, hasClass } = require('./lib/site-dom.cjs');

const SITE = path.join(ROOT, 'website');

// ─── the screenshots: real captures of the packaged app, copied byte for byte ───────────────────────────────────────
const SHOTS = [
  { id: 'discover', from: 'evidence/ui-packaged/02-discover-en.png', title: 'Discover',
    alt: 'The Discover tab of Settings, Integrations and Skills: a card for every service, with filters by kind.',
    caption: 'Find a service and see how it connects. Local tools switch on with one click.' },
  { id: 'connected', from: 'evidence/ui-packaged/18-connected-time-on.png', title: 'Connected',
    alt: 'The Connected tab: a service switched on, with the other tabs of Settings above it.',
    caption: 'Switch services on and off, and choose which of their tools may be used.' },
  { id: 'skills', from: 'evidence/ui-packaged/13-skills-claude.png', title: 'Skills',
    alt: 'The Skills tab: an installed skill with its source, and a searchable catalogue of skills to install.',
    caption: 'Browse the catalogue, install a skill for the agent you choose, and see where it came from.' },
  { id: 'activity', from: 'evidence/ui-packaged/17-activity.png', title: 'Activity',
    alt: 'The Activity tab: a record of what was done and whether it was allowed.',
    caption: 'A running record of what each agent did and whether it was allowed.' }
];

const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
const word = (n) => (WORDS[n] ?? String(n));
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** What the <!--gen:name--> markers in index.html are filled with. Words, not digits: they read as prose. */
function markerValues(c) {
  const n = c.counts;
  return {
    'locations-word': word(n.locations),
    'locations-word-cap': cap(word(n.locations)),
    'locations-word-upper': word(n.locations).toUpperCase(),
    'agents-word': word(n.codingAgentsWithIntegrations),
    'agents-word-cap': cap(word(n.codingAgentsWithIntegrations)),
    'tabs-word': word(n.hubTabs),
    'rest-word': word(n.restTemplates),
    'local-word': word(n.localServers)
  };
}

function fillMarkers(html, values) {
  const used = new Set();
  const out = html.replace(/<!--gen:([a-z0-9-]+)-->([\s\S]*?)<!--\/gen-->/g, (_m, name) => {
    if (!(name in values)) throw new Error(`index.html uses an unknown generated marker: gen:${name}`);
    used.add(name);
    return `<!--gen:${name}-->${values[name]}<!--/gen-->`;
  });
  return { out, used };
}

function pngSize(buf) {
  if (buf.length < 24 || buf.toString('latin1', 1, 4) !== 'PNG') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** Everything the page's scripts are given. Built from the catalogue and nothing else. */
function buildData(catalogue) {
  return {
    generatedBy: catalogue.generatedBy,
    // the catalogue the visitor sees: what the app offers today (nothing that is not available yet)
    groups: catalogue.groups.map((g) => ({
      id: g.id, title: g.title, blurb: g.blurb,
      providers: g.providers.filter((p) => !p.notImplemented).map((p) => ({
        id: p.id, label: p.label, description: p.description, ways: p.ways, connectsBy: p.connectsBy
      }))
    })).filter((g) => g.providers.length),
    locations: catalogue.locations.map((l) => ({ key: l.key, id: l.id, label: l.label })),
    screenshots: SHOTS.map((s) => {
      const src = path.join(ROOT, s.from);
      const size = fs.existsSync(src) ? pngSize(fs.readFileSync(src)) : null;
      return { id: s.id, title: s.title, file: `assets/ui/${s.id}.png`, alt: s.alt, caption: s.caption, width: size?.width ?? null, height: size?.height ?? null };
    })
  };
}

const dataFileText = (data) =>
  `/* GENERATED by tools/build-website.cjs from the app's own data (tools/lib/catalogue.cjs). Do not edit by hand:\n` +
  ` * \`npm run website:build\` rewrites it, and the website job in CI fails if the committed copy is stale. */\n` +
  `window.MOSBIUS_CATALOGUE = ${JSON.stringify(data, null, 2)};\n`;

// ─── checks on the words ─────────────────────────────────────────────────────────────────────────────────────────────
const NOUNS = '(?:MCP servers?|local servers?|REST (?:presets?|templates?|integrations?|APIs?)|providers?|integrations?|locations?|rooms?|reels?|tabs?|coding agents?|agent CLIs?|characters?)';
// "one" is left out on purpose: "one room to another" is not a count, and a count that can go stale is two or more
const COUNT_WORD = '(?:two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|\\d+)';
const STALE_COUNT = new RegExp(`\\b${COUNT_WORD}\\s+(?:more\\s+)?${NOUNS}\\b`, 'i');

/** Visible words with every generated region (marker and its value) removed: a number there is generated, not typed. */
function proseOf(html) {
  return html
    .replace(/<!--gen:[a-z0-9-]+-->[\s\S]*?<!--\/gen-->/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&mdash;/g, '—').replace(/&[a-z]+;/g, ' ')
    .replace(/\s+/g, ' ');
}

const sentences = (text) => String(text).split(/(?<=[.!?])\s+/);

/** Sentences that state a count the page typed by hand, where the number could go stale. */
function staleCountProblems(text, label) {
  const found = [];
  for (const s of sentences(text)) {
    const m = STALE_COUNT.exec(s);
    if (m) found.push(`${label}: a typed count ("${m[0]}") in: ${s.slice(0, 110)}`);
  }
  return found;
}

/** Sentences that name a provider and say "verified" without saying, in the same sentence, that it is not (or nothing is). */
function claimsProblems(text, providerLabels, label) {
  const found = [];
  const names = providerLabels.map((l) => l.toLowerCase());
  const NEGATION = /\b(not|never|no|none|nothing|nobody|without|isn't|aren't|hasn't|haven't|yet to|unverified)\b/i;
  for (const s of sentences(text)) {
    const lower = s.toLowerCase();
    if (!/\bverified\b/i.test(s)) continue;
    if (NEGATION.test(s)) continue;
    // a local server that answered a real call may be called verified; a named account-based provider may not
    const hit = names.find((n) => new RegExp(`(^|[^a-z])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`).test(lower));
    if (hit) found.push(`${label}: a sentence calls "${hit}" verified without saying it is not: ${s.slice(0, 120)}`);
  }
  // things this project cannot say of itself at all, unless the sentence is saying that it is not so
  const OVERCLAIM = /\b(production[- ]ready|fully tested|every provider (?:is )?verified|all providers (?:are )?verified|works on (?:windows|linux)|tested on (?:windows|linux)|connected to your (?:notion|slack|gmail|github))\b/i;
  for (const s of sentences(text)) {
    const m = OVERCLAIM.exec(s);
    if (m && !NEGATION.test(s)) found.push(`${label}: an unsupported claim: "${m[0]}" in: ${s.slice(0, 110)}`);
  }
  return found;
}

/**
 * Engineering-status wording that belongs in the technical documents, not on the public page: test counts, verification
 * labels, security findings, build and platform caveats. A genuine user-facing reason can allow a phrase here on purpose.
 */
const ENGINEERING_TALK = /an honest status|where it stands|stand-in|real-account|real account|not yet verified|locally tested|not implemented|shell can read|bearer|\bF9\b|\d+ of \d+ checks|checks passed|no real provider|published builds were made|installers were built before|static page|not deployed|test harness|throwaway|cross-built|notaris|unsigned|\bnpm (ci|run)\b|\bsandbox\b|broker|verified/i;
function engineeringTalk(text, label) {
  const found = [];
  for (const s of sentences(text)) { const m = ENGINEERING_TALK.exec(s); if (m) found.push(`${label}: engineering wording ("${m[0]}") in: ${s.slice(0, 100)}`); }
  return found;
}

/**
 * The string literals of a script, with comments left out and each `${...}` of a template replaced by a mark. It is a
 * scanner, not a parser: enough for the site's scripts, which have no regular-expression literal containing a quote.
 */
function stringLiterals(src) {
  const out = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === '/' && next === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (ch === '/' && next === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
    if (ch === '\'' || ch === '"') {
      let j = i + 1;
      let s = '';
      while (j < n && src[j] !== ch && src[j] !== '\n') { if (src[j] === '\\') { s += src[j + 1] ?? ''; j += 2; } else { s += src[j]; j++; } }
      out.push(s);
      i = j + 1;
      continue;
    }
    if (ch === '`') {
      let j = i + 1;
      let s = '';
      while (j < n && src[j] !== '`') {
        if (src[j] === '\\') { s += src[j + 1] ?? ''; j += 2; }
        else if (src[j] === '$' && src[j + 1] === '{') {
          let depth = 1;
          j += 2;
          while (j < n && depth) { if (src[j] === '{') depth++; else if (src[j] === '}') depth--; j++; }
          s += '…';
        } else { s += src[j]; j++; }
      }
      out.push(s);
      i = j + 1;
      continue;
    }
    i++;
  }
  return out;
}

const commentsOf = (src) => (src.match(/\/\*[\s\S]*?\*\/|(?<![:'"`\\])\/\/[^\n]*/g) ?? []).join(' ');

// ─── checks on the files ─────────────────────────────────────────────────────────────────────────────────────────────
function attrValues(html, attr) {
  const re = new RegExp(`\\s${attr}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'gi');
  const out = [];
  for (const m of html.replace(/<!--[\s\S]*?-->/g, '').matchAll(re)) out.push(m[2] ?? m[3]);
  return out;
}

const KNOWN_EXTERNAL = [/^https:\/\/fonts\.googleapis\.com(\/|$)/, /^https:\/\/fonts\.gstatic\.com\/?$/];
const REPO = 'https://github.com/rajguruyash/Mosbius-Co';

function checkLinks(html, problems) {
  const ids = new Set([...html.matchAll(/\sid\s*=\s*"([^"]+)"/g)].map((m) => m[1]));
  const targets = [...attrValues(html, 'href'), ...attrValues(html, 'src')];
  const seen = { anchors: 0, files: 0, external: 0 };
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const readmeDownloads = new Set([...readme.matchAll(/\((https:\/\/github\.com\/[^)\s]*\/releases\/download\/[^)\s]+)\)/g)].map((m) => m[1]));
  const readmeTags = new Set([...fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8').matchAll(/releases\/tag\/(v[0-9.]+)/g)].map((m) => m[1]));
  for (const t of targets) {
    if (t.startsWith('#')) {
      seen.anchors++;
      if (t.length > 1 && !ids.has(t.slice(1))) problems.push(`index.html links to ${t}, which no element has as its id`);
    } else if (/^https?:\/\//.test(t)) {
      seen.external++;
      if (KNOWN_EXTERNAL.some((re) => re.test(t))) continue;
      if (t === REPO || t === `${REPO}/releases`) continue;
      if (new RegExp(`^${REPO}/releases/download/v[0-9.]+/[\\w.-]+$`).test(t)) { if (!readmeDownloads.has(t)) problems.push(`index.html links to the download ${t}, which README.md does not give`); continue; }
      let m = new RegExp(`^${REPO}/releases/tag/(v[0-9.]+)$`).exec(t);
      if (m) { if (!readmeTags.has(m[1])) problems.push(`index.html links to release ${m[1]}, which README.md does not list`); continue; }
      m = new RegExp(`^${REPO}/blob/main/([^#?]+)(?:#.*)?$`).exec(t);
      if (m) { if (!fs.existsSync(path.join(ROOT, decodeURI(m[1])))) problems.push(`index.html links to ${t}, but ${m[1]} is not in the repository`); continue; }
      problems.push(`index.html links to ${t}, an address this page is not allowed to point at (add it on purpose, here, if it is right)`);
    } else if (/^(mailto:|data:|tel:|javascript:)/i.test(t)) {
      problems.push(`index.html uses ${t.slice(0, 30)}, which is not expected here`);
    } else {
      seen.files++;
      const file = path.join(SITE, t.split(/[?#]/)[0]);
      if (!fs.existsSync(file)) problems.push(`index.html refers to ${t}, which does not exist under website/`);
    }
  }
  return seen;
}

function checkImages(html, problems) {
  let n = 0;
  for (const m of html.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<img\b[^>]*>/gi)) {
    n++;
    if (!/\salt\s*=/.test(m[0])) problems.push(`an <img> has no alt attribute: ${m[0].slice(0, 80)}`);
  }
  return n;
}

function scriptSources(html) {
  return [...html.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<script\b[^>]*\ssrc\s*=\s*"([^"]+)"[^>]*>/gi)].map((m) => m[1]);
}

function checkScripts(html, problems) {
  const srcs = scriptSources(html);
  for (const s of srcs) {
    const file = path.join(SITE, s);
    if (!fs.existsSync(file)) continue;     // reported by checkLinks
    try { new vm.Script(fs.readFileSync(file, 'utf8'), { filename: s }); } catch (e) { problems.push(`${s} does not parse: ${e.message}`); }
  }
  const order = (name) => srcs.findIndex((s) => s.endsWith(name));
  for (const later of ['integrations.js', 'ecosystem.js']) {
    if (order('catalogue.js') < 0 || order(later) < 0 || order('catalogue.js') > order(later)) problems.push(`catalogue.js must be loaded before ${later}`);
  }
  return srcs.length;
}

/** The rooms the page can show must be the app's locations: no more, no fewer. */
function checkRooms(catalogue, problems) {
  const file = path.join(SITE, 'js', 'rooms-manifest.js');
  if (!fs.existsSync(file)) { problems.push('website/js/rooms-manifest.js is missing'); return; }
  const sandbox = { window: {} };
  try { vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: 'rooms-manifest.js' }); } catch (e) { problems.push(`rooms-manifest.js does not run: ${e.message}`); return; }
  const rooms = Object.keys(sandbox.window.ROOMS?.rooms ?? {}).sort();
  const app = catalogue.locations.map((l) => l.id).sort();
  if (rooms.join(',') !== app.join(',')) problems.push(`the page's rooms (${rooms.join(', ')}) are not the app's locations (${app.join(', ')}): re-export them with tools/himym/export.py`);
}

// ─── checks on the page as a visitor gets it ─────────────────────────────────────────────────────────────────────────
/**
 * Runs the page's data-driven scripts against `dataText` (the generated data file) and returns what is wrong with what
 * they drew. `accountLabels` are the providers that must never be called verified without a "not".
 */
function renderedProblems({ html, dataText, data, accountLabels }) {
  const problems = [];
  const read = (f) => ({ name: f, source: fs.readFileSync(path.join(SITE, 'js', f), 'utf8') });
  let page;
  try {
    page = runSite({ html, scripts: [{ name: 'catalogue.js', source: dataText }, read('integrations.js'), read('ecosystem.js')] });
  } catch (e) {
    return { problems: [`the page's scripts threw when run against the data: ${e.message}`], page: null };
  }
  for (const id of page.missing) problems.push(`a script asks for #${id}, which index.html does not have`);

  const all = data.groups.flatMap((g) => g.providers);
  const names = (host) => find(host, (e) => hasClass(e, 'name')).map((e) => e.textContent);
  const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

  const cards = page.get('cards');
  const filters = page.get('filters');
  if (!cards || !filters) return { problems: [...problems, 'the integrations section did not render (#cards or #filters is missing)'], page };

  // every provider the app offers, once, in the data's order, each with a description and how it is set up
  if (!same(names(cards), all.map((p) => p.label))) problems.push(`the integrations section does not show every provider once, in order: it shows ${names(cards).join(', ')}`);
  find(cards, (e) => hasClass(e, 'card')).forEach((card, i) => {
    const p = all[i];
    if (!p) return;
    if (!find(card, (e) => hasClass(e, 'desc')).some((e) => e.textContent.length > 8)) problems.push(`${p.label}: the card has no description`);
    if (!find(card, (e) => hasClass(e, 'meta')).some((e) => e.textContent.length > 2)) problems.push(`${p.label}: the card does not say how it is set up`);
  });
  // each filter shows its own group and nothing else
  const chips = find(filters, (e) => hasClass(e, 'chip'));
  if (chips.length !== data.groups.length + 1) problems.push(`there are ${chips.length} filters for ${data.groups.length} groups (expected one each, plus "all")`);
  for (const chip of chips) {
    chip.click();
    const want = chip.dataset.group === 'all' ? all : (data.groups.find((g) => g.id === chip.dataset.group)?.providers ?? []);
    if (!same(names(cards), want.map((p) => p.label))) problems.push(`the "${chip.textContent}" filter shows ${names(cards).join(', ') || 'nothing'}`);
    if (chip.getAttribute('aria-pressed') !== 'true') problems.push(`the "${chip.textContent}" filter is not marked as pressed after it is chosen`);
  }
  chips[0]?.click();

  const imgs = page.get('shots') ? find(page.get('shots'), (e) => e.tagName === 'IMG') : [];
  if (imgs.length !== data.screenshots.length) problems.push('the screenshots section does not show every screenshot');
  for (const img of imgs) {
    if (!img.getAttribute('alt')) problems.push(`a screenshot has no alt text: ${img.getAttribute('src')}`);
    if (!fs.existsSync(path.join(SITE, img.getAttribute('src') ?? '')) && !fs.existsSync(path.join(ROOT, SHOTS.find((s) => `assets/ui/${s.id}.png` === img.getAttribute('src'))?.from ?? '?'))) problems.push(`a screenshot points at a file that does not exist: ${img.getAttribute('src')}`);
  }

  // the words themselves
  for (const host of page.filled) {
    for (const text of leaves(host)) {
      if (/\b(undefined|NaN|null)\b|\[object /.test(text)) problems.push(`#${host.id} renders a missing value: ${text.slice(0, 90)}`);
      problems.push(...claimsProblems(text, accountLabels, `#${host.id} (as rendered)`));
      problems.push(...engineeringTalk(text, `#${host.id} (as rendered)`));
    }
  }
  return { problems, page };
}

// ─── the build ───────────────────────────────────────────────────────────────────────────────────────────────────────
function build({ check = false } = {}) {
  const problems = [];
  const stale = [];
  const catalogue = buildCatalogue();
  const data = buildData(catalogue);
  const dataText = dataFileText(data);

  const write = (file, content) => {
    const current = fs.existsSync(file) ? fs.readFileSync(file) : null;
    const same = current && Buffer.compare(current, Buffer.isBuffer(content) ? content : Buffer.from(content)) === 0;
    if (same) return;
    if (check) { stale.push(path.relative(ROOT, file)); return; }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };

  // 1. the data file
  write(path.join(SITE, 'js', 'catalogue.js'), dataText);

  // 2. the screenshots
  for (const s of SHOTS) {
    const src = path.join(ROOT, s.from);
    if (!fs.existsSync(src)) { problems.push(`the screenshot source ${s.from} is missing: run tools/ui-validate.cjs --packaged`); continue; }
    write(path.join(SITE, 'assets', 'ui', `${s.id}.png`), fs.readFileSync(src));
  }
  const uiDir = path.join(SITE, 'assets', 'ui');
  if (fs.existsSync(uiDir)) {
    for (const f of fs.readdirSync(uiDir)) {
      if (!SHOTS.some((s) => `${s.id}.png` === f)) problems.push(`website/assets/ui/${f} is not one of the screenshots this script copies: remove it, or add it here with its source`);
    }
  }

  // 3. the markers in index.html
  const indexFile = path.join(SITE, 'index.html');
  const html = fs.readFileSync(indexFile, 'utf8');
  let filled;
  try { filled = fillMarkers(html, markerValues(catalogue)); } catch (e) { problems.push(e.message); filled = { out: html, used: new Set() }; }
  write(indexFile, filled.out);
  const page = filled.out;

  if (stale.length) problems.push(`generated files are stale (run \`npm run website:build\`): ${stale.join(', ')}`);

  // 4. the files
  const seen = checkLinks(page, problems);
  const images = checkImages(page, problems);
  const scripts = checkScripts(page, problems);
  checkRooms(catalogue, problems);

  // the names that must never be called verified without saying they are not: every provider that is not a local server
  const accountLabels = catalogue.providers.filter((p) => p.chip !== 'locally-tested' && p.id !== 'custom-rest').map((p) => p.label);

  const prose = proseOf(page);
  problems.push(...staleCountProblems(prose, 'index.html'));
  problems.push(...claimsProblems(prose, accountLabels, 'index.html'));
  problems.push(...engineeringTalk(prose, 'index.html'));
  for (const f of fs.readdirSync(path.join(SITE, 'js')).filter((x) => x.endsWith('.js') && !/manifest|catalogue/.test(x))) {
    const src = fs.readFileSync(path.join(SITE, 'js', f), 'utf8');
    problems.push(...staleCountProblems(commentsOf(src), `js/${f} (comments)`));
    if (!['integrations.js', 'ecosystem.js'].includes(f)) continue;
    for (const lit of stringLiterals(src)) {
      problems.push(...staleCountProblems(lit, `js/${f}`));
      problems.push(...claimsProblems(lit, accountLabels, `js/${f}`));
      problems.push(...engineeringTalk(lit, `js/${f}`));
    }
  }
  for (const f of ['integrations.js', 'ecosystem.js']) {
    if (!fs.existsSync(path.join(SITE, 'js', f))) problems.push(`website/js/${f} is missing`);
  }

  // the screenshot captions live in the data, not in the page, so they are read as prose too
  const captions = SHOTS.map((x) => `${x.alt} ${x.caption}`).join(' ');
  problems.push(...staleCountProblems(captions, 'screenshot captions'));
  problems.push(...claimsProblems(captions, accountLabels, 'screenshot captions'));
  problems.push(...engineeringTalk(captions, 'screenshot captions'));
  problems.push(...engineeringTalk(data.groups.map((g) => `${g.blurb} ${g.providers.map((p) => p.description).join(' ')}`).join(' '), 'the catalogue the page shows'));

  // the data must not claim what the evidence cannot back
  for (const p of catalogue.providers) {
    if (p.realAccountVerified === 'yes' && !(p.evidence && fs.existsSync(path.join(ROOT, p.evidence)))) {
      problems.push(`${p.label} is marked real-account verified, but no evidence file for it is in the repository`);
    }
  }

  // 5. the page as a visitor gets it
  let rendered = { problems: [], page: null };
  if (fs.existsSync(path.join(SITE, 'js', 'integrations.js')) && fs.existsSync(path.join(SITE, 'js', 'ecosystem.js'))) {
    rendered = renderedProblems({ html: page, dataText, data, accountLabels });
    problems.push(...rendered.problems);
  }

  return {
    problems, stale, data,
    summary: [
      `website: ${data.groups.flatMap((g) => g.providers).length} catalogue entries in ${data.groups.length} groups, ${data.locations.length} locations, ${SHOTS.length} screenshots`,
      `checked: ${seen.anchors} anchors, ${seen.files} files, ${seen.external} external links, ${images} images, ${scripts} scripts, ${filled.used.size} generated markers; rendered ${rendered.page ? rendered.page.filled.length : 0} sections against the data`
    ]
  };
}

if (require.main === module) {
  const check = process.argv.includes('--check');
  const { problems, summary } = build({ check });
  for (const line of summary) console.log(line);
  if (problems.length) {
    console.error(`\n${problems.length} problem(s):`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(check ? 'the website\'s generated files are current and every check passed' : 'wrote the generated files; every check passed');
}

module.exports = { build, buildData, dataFileText, fillMarkers, markerValues, staleCountProblems, claimsProblems, engineeringTalk, ENGINEERING_TALK, proseOf, stringLiterals, renderedProblems, SHOTS, word, SITE };
