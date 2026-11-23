'use strict';
// The release gate (tools/check-release-links.cjs): the downloads the README and the website advertise must name real
// releases, and the macOS download must offer package.json's version. A download is a release page (what the buttons open)
// or a file.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { findProblems, compareVersions, isWindowsTag, HISTORY_PAGES } = require('../tools/check-release-links.cjs');

const ROOT = path.resolve(__dirname, '..');
const BASE = 'https://github.com/rajguruyash/Mosbius-Co/releases/download';
const TAGS = 'https://github.com/rajguruyash/Mosbius-Co/releases/tag';
const mac = (v) => `${BASE}/v${v}/Mosbius-Co-${v}-mac-arm64.dmg`;
const win = (v) => `${BASE}/v${v}/Mosbius-Co-${v}-win-x64-setup.exe`;
const macPage = (v) => `${TAGS}/v${v}`;
const winPage = (v) => `${TAGS}/v${v}.0`;

/** A folder with a README and a page, each holding the links given, and the releases page when `history` is given. */
function pages(readmeLinks, siteLinks, history = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-links-'));
  fs.mkdirSync(path.join(dir, 'website'));
  fs.writeFileSync(path.join(dir, 'README.md'), readmeLinks.map((u) => `[get it](${u})`).join('\n'));
  fs.writeFileSync(path.join(dir, 'website', 'index.html'), siteLinks.map((u) => `<a href="${u}">get it</a>`).join('\n'));
  if (history) fs.writeFileSync(path.join(dir, 'website', 'releases.html'), history.map((u) => `<a href="${u}">open</a>`).join('\n'));
  return dir;
}

test('versions compare as dotted numbers of any length', () => {
  assert.equal(compareVersions('1.1.0', '1.1.0'), 0);
  assert.equal(compareVersions('1.0.0.0', '1.1.0'), -1);
  assert.equal(compareVersions('1.1.0', '1.0.0.0'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.0.0'), 0);
  assert.equal(compareVersions('0.4.6', '1.1.0'), -1);
});

test('a Windows installer is tagged with a fourth number, a macOS release with three', () => {
  assert.equal(isWindowsTag('v1.1.0.0'), true);
  assert.equal(isWindowsTag('v1.0.0.0'), true);
  assert.equal(isWindowsTag('v1.1.0'), false);
});

test('a current macOS link and an older Windows link are fine: the Windows installer is published on its own', () => {
  const dir = pages([mac('1.1.0'), win('1.0.0.0')], [mac('1.1.0'), win('1.0.0.0')]);
  assert.deepEqual(findProblems({ root: dir, version: '1.1.0' }).problems, []);
});

test('a macOS link one release behind is a problem on the page that has it', () => {
  const dir = pages([mac('1.1.0')], [mac('1.0.0')]);
  const { problems } = findProblems({ root: dir, version: '1.1.0' });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /website\/index\.html: the macOS download offers 1\.0\.0 but package\.json says 1\.1\.0/);
});

test('a link to a release that is not out yet, or whose tag and file name disagree, is a problem', () => {
  const newer = findProblems({ root: pages([mac('1.1.0'), win('1.2.0')], [mac('1.1.0')]), version: '1.1.0' }).problems;
  assert.ok(newer.some((p) => /newer than package\.json 1\.1\.0/.test(p)));
  const mixed = `${BASE}/v1.1.0/Mosbius-Co-1.0.0-mac-arm64.dmg`;
  const bad = findProblems({ root: pages([mac('1.1.0'), mixed], [mac('1.1.0')]), version: '1.1.0' }).problems;
  assert.ok(bad.some((p) => /the tag is v1\.1\.0 but the file name carries 1\.0\.0/.test(p)));
});

test('a page with no macOS link, or no links at all, does not pass', () => {
  assert.ok(findProblems({ root: pages([win('1.0.0.0')], [mac('1.1.0')]), version: '1.1.0' }).problems.some((p) => /README\.md has no macOS download link/.test(p)));
  assert.ok(findProblems({ root: pages([], []), version: '1.1.0' }).problems.some((p) => /no download links found/.test(p)));
});

test('release pages count like files: macOS must be current, a Windows page may lag, and neither may be ahead', () => {
  const ok = findProblems({ root: pages([macPage('1.1.0'), winPage('1.1.0')], [macPage('1.1.0'), winPage('1.0.0')]), version: '1.1.0' });
  assert.deepEqual(ok.problems, []);
  assert.deepEqual(ok.links.map((l) => `${l.page} ${l.kind} ${l.platform}`).sort(), [
    'README.md release mac-release', 'README.md release win-release',
    'website/index.html release mac-release', 'website/index.html release win-release'
  ]);
  const behind = findProblems({ root: pages([macPage('1.1.0')], [macPage('1.0.0')]), version: '1.1.0' }).problems;
  assert.equal(behind.length, 1);
  assert.match(behind[0], /website\/index\.html: the macOS download offers 1\.0\.0 but package\.json says 1\.1\.0/);
  const early = findProblems({ root: pages([macPage('1.1.0'), winPage('1.2.0')], [macPage('1.1.0')]), version: '1.1.0' }).problems;
  assert.ok(early.some((p) => /newer than package\.json 1\.1\.0/.test(p)));
});

test('a page whose only release is the Windows one has no macOS link, and the same button twice is one link', () => {
  assert.ok(findProblems({ root: pages([winPage('1.1.0')], [macPage('1.1.0')]), version: '1.1.0' }).problems.some((p) => /README\.md has no macOS download link/.test(p)));
  const twice = findProblems({ root: pages([macPage('1.1.0'), macPage('1.1.0')], [macPage('1.1.0')]), version: '1.1.0' });
  assert.equal(twice.links.filter((l) => l.page === 'README.md').length, 1);
});

test('the releases page may list old releases, but none that is not out, and it must list some', () => {
  const dir = pages([macPage('1.1.0')], [macPage('1.1.0')], [macPage('1.1.0'), winPage('1.1.0'), macPage('1.0.0'), winPage('1.0.0')]);
  const ok = findProblems({ root: dir, version: '1.1.0', historyPages: ['website/releases.html'] });
  assert.deepEqual(ok.problems, []);
  assert.deepEqual(ok.history.map((l) => l.tag), ['v1.1.0', 'v1.1.0.0', 'v1.0.0', 'v1.0.0.0']);
  const ahead = findProblems({ root: pages([macPage('1.1.0')], [macPage('1.1.0')], [macPage('1.2.0')]), version: '1.1.0', historyPages: ['website/releases.html'] }).problems;
  assert.ok(ahead.some((p) => /website\/releases\.html: .*newer than package\.json 1\.1\.0/.test(p)));
  const none = findProblems({ root: pages([macPage('1.1.0')], [macPage('1.1.0')], []), version: '1.1.0', historyPages: ['website/releases.html'] }).problems;
  assert.ok(none.some((p) => /website\/releases\.html lists no releases/.test(p)));
  const missing = findProblems({ root: pages([macPage('1.1.0')], [macPage('1.1.0')]), version: '1.1.0', historyPages: ['website/releases.html'] }).problems;
  assert.ok(missing.some((p) => /website\/releases\.html is missing/.test(p)));
});

test("this repository's own README and website send each platform to its release page for the version in package.json", () => {
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  const { problems, links, history } = findProblems({ root: ROOT, version, historyPages: HISTORY_PAGES });
  assert.deepEqual(problems, []);
  for (const page of ['README.md', 'website/index.html']) {
    const onPage = links.filter((l) => l.page === page);
    assert.ok(onPage.some((l) => l.url === macPage(version)), `${page} sends macOS to the v${version} release page`);
    assert.ok(onPage.some((l) => l.url === winPage(version)), `${page} sends Windows to the v${version}.0 release page`);
    assert.equal(onPage.some((l) => l.kind === 'download'), false, `${page} opens release pages, not files`);
  }
  assert.deepEqual(history.map((l) => l.tag), ['v1.1.0', 'v1.1.0.0', 'v1.0.0', 'v1.0.0.0'], 'the releases page lists the four published releases, newest first');
});
