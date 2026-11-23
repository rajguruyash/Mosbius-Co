'use strict';

/**
 * The Releases page (website/releases.html), and the places that send people to a release.
 *
 * The page lists the four published releases (macOS and Windows, for 1.1.0 and for 1.0.0), newest first, each with a short
 * description and a button to its own page on GitHub, and it is reached from "Releases" in the top bar of the home page.
 * The README's and the website's download buttons open the release pages of the version in package.json. The general
 * rules (the current version's two releases are on the page, every card complete and linked to its own release) are in
 * tools/build-website.cjs, which the website test runs; these tests pin what the page says today and that the rules catch
 * a page that falls behind.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const site = require('../tools/build-website.cjs');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const REPO = 'https://github.com/rajguruyash/Mosbius-Co';
const version = JSON.parse(read('package.json')).version;
const html = read('website/releases.html');
const index = read('website/index.html');
const readme = read('README.md');
const cards = site.releaseCards(html);

test('"Releases" is in the top bar of the home page and of the page itself, and it goes to the page', () => {
  const nav = /<nav class="nav">([\s\S]*?)<\/nav>/.exec(index)[1];
  assert.match(nav, /<a href="releases\.html">Releases<\/a>/);
  assert.ok(fs.existsSync(path.join(ROOT, 'website', site.RELEASES_PAGE)));
  const own = /<nav class="nav">([\s\S]*?)<\/nav>/.exec(html)[1];
  assert.match(own, /<a\b[^>]*\shref="releases\.html"[^>]*\saria-current="page"[^>]*>Releases<\/a>/, 'the page marks itself as the current one');
  assert.match(own, /<a href="index\.html">Home<\/a>/, 'there is a way back to the home page, and it stays in the bar on a phone');
  assert.match(index, /<p><a href="releases\.html">Releases<\/a><\/p>/, 'and the footer of the home page links to it');
});

test('four releases, newest first: macOS and Windows for 1.1.0, then for 1.0.0, each with its date and its own page on GitHub', () => {
  assert.deepEqual(cards.map((c) => [c.tag, c.platform, c.date]), [
    ['v1.1.0', 'macOS · Apple silicon', '2026-11-23'],
    ['v1.1.0.0', 'Windows · 64-bit', '2026-11-23'],
    ['v1.0.0', 'macOS · Apple silicon', '2026-11-13'],
    ['v1.0.0.0', 'Windows · 64-bit', '2026-11-13']
  ]);
  for (const c of cards) {
    assert.deepEqual(c.links.map((l) => l.href), [`${REPO}/releases/tag/${c.tag}`], `${c.tag} links to its own release and nothing else`);
    assert.ok(c.text.length >= 60 && c.text.length <= 420, `${c.tag} has a small description`);
    assert.ok(html.includes(`id="${c.tag}"`), `${c.tag} can be linked to as #${c.tag}`);
  }
  // the version in package.json has its pair at the top
  assert.deepEqual(cards.slice(0, 2).map((c) => c.tag), [`v${version}`, `v${version}.0`]);
});

test('the cards say what is true: the Windows installers have not been tried on a real Windows computer, and the first release comes from before the Huddle', () => {
  const by = Object.fromEntries(cards.map((c) => [c.tag, c.text]));
  assert.match(by['v1.1.0'], /Huddle/);
  assert.match(by['v1.1.0.0'], /has not been tried on a real Windows computer yet/);
  assert.match(by['v1.0.0.0'], /has not been tried on a real Windows computer/);
  assert.match(by['v1.0.0'], /before the Huddle/);
  assert.match(by['v1.0.0.0'], /before the Huddle/);
  assert.doesNotMatch(by['v1.1.0'] + by['v1.0.0'], /Windows/, 'a macOS card talks about macOS');
});

test('the page keeps the fan-made disclaimer, runs no script, and says nothing the website build refuses', () => {
  assert.match(html, /a fan-made project, not affiliated with,\s+endorsed by, or connected to/);
  assert.equal(/<script\b/i.test(html), false, 'a page of cards needs no script');
  const prose = site.proseOf(html);
  assert.deepEqual(site.engineeringTalk(prose, 'releases.html'), []);
  assert.deepEqual(site.staleCountProblems(prose, 'releases.html'), []);
  const problems = [];
  site.checkReleasesPage(html, version, problems);
  assert.deepEqual(problems, []);
});

test('the build catches a page that falls behind: a missing release, a card that links elsewhere, cards out of order, a card with no date', () => {
  const run = (h, v = version) => { const found = []; site.checkReleasesPage(h, v, found); return found; };
  assert.deepEqual(run(html), []);
  // the next version is published and the page has not caught up
  const next = run(html, '1.2.0');
  assert.ok(next.some((m) => /does not list v1\.2\.0, the macOS release/.test(m)), next.join('\n'));
  assert.ok(next.some((m) => /does not list v1\.2\.0\.0, the Windows release/.test(m)), next.join('\n'));
  // a card that opens another release's page
  const wrong = html.replace('releases/tag/v1.1.0.0">Open v1.1.0.0', 'releases/tag/v1.1.0">Open v1.1.0.0');
  assert.notEqual(wrong, html);
  assert.ok(run(wrong).some((m) => /v1\.1\.0\.0: it needs exactly one link to .*releases\/tag\/v1\.1\.0\.0/.test(m)));
  // the oldest first
  const parts = html.split('<article class="release"');
  const reversed = [parts[0], ...parts.slice(1).reverse()].join('<article class="release"');
  assert.ok(run(reversed).some((m) => /it is newer than the card above it/.test(m)));
  // no date
  const undated = html.replace('<time datetime="2026-11-13">', '<time>');
  assert.notEqual(undated, html);
  assert.ok(run(undated).some((m) => /no release date/.test(m)));
  // a card that is a title and nothing else
  const bare = html.replace(/<p class="release-text">The first Windows build[^<]*<\/p>/, '<p class="release-text">Windows.</p>');
  assert.notEqual(bare, html);
  assert.ok(run(bare).some((m) => /v1\.0\.0\.0: the description is \d+ characters/.test(m)));
});

test('the README and the website buttons open the release pages of the version in package.json, one for each platform', () => {
  const macPage = `${REPO}/releases/tag/v${version}`;
  const winPage = `${REPO}/releases/tag/v${version}.0`;
  for (const [name, text] of [['README.md', readme], ['website/index.html', index]]) {
    assert.ok(text.includes(macPage), `${name} sends macOS to ${macPage}`);
    assert.ok(text.includes(winPage), `${name} sends Windows to ${winPage}`);
    assert.equal(/releases\/download\//.test(text), false, `${name} opens release pages, not files`);
  }
  assert.match(readme, /\[⬇ Download for macOS \(Apple silicon\)\]\(https:\/\/github\.com\/rajguruyash\/Mosbius-Co\/releases\/tag\/v1\.1\.0\)/);
  assert.match(readme, /\[⬇ Download for Windows \(64-bit\)\]\(https:\/\/github\.com\/rajguruyash\/Mosbius-Co\/releases\/tag\/v1\.1\.0\.0\)/);
  assert.match(readme, /\| Windows \| `\.exe` installer, 64-bit \| \[v1\.1\.0\.0\]\(/);
  assert.match(readme, /Intel Macs and Linux are not part of this release/);
  assert.match(readme, /The Windows installer is new and has not been tried on a real Windows computer yet/);
  assert.match(readme, /For macOS on Apple silicon and Windows\./);
});
