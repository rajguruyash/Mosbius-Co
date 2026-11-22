'use strict';
// The release gate (tools/check-release-links.cjs): the downloads the README and the website advertise must name real
// release files, and the macOS download must offer package.json's version.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { findProblems, compareVersions } = require('../tools/check-release-links.cjs');

const ROOT = path.resolve(__dirname, '..');
const BASE = 'https://github.com/rajguruyash/Mosbius-Co/releases/download';
const mac = (v) => `${BASE}/v${v}/Mosbius-Co-${v}-mac-arm64.dmg`;
const win = (v) => `${BASE}/v${v}/Mosbius-Co-${v}-win-x64-setup.exe`;

/** A folder with a README and a page, each holding the links given. */
function pages(readmeLinks, siteLinks) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-links-'));
  fs.mkdirSync(path.join(dir, 'website'));
  fs.writeFileSync(path.join(dir, 'README.md'), readmeLinks.map((u) => `[get it](${u})`).join('\n'));
  fs.writeFileSync(path.join(dir, 'website', 'index.html'), siteLinks.map((u) => `<a href="${u}">get it</a>`).join('\n'));
  return dir;
}

test('versions compare as dotted numbers of any length', () => {
  assert.equal(compareVersions('1.1.0', '1.1.0'), 0);
  assert.equal(compareVersions('1.0.0.0', '1.1.0'), -1);
  assert.equal(compareVersions('1.1.0', '1.0.0.0'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.0.0'), 0);
  assert.equal(compareVersions('0.4.6', '1.1.0'), -1);
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

test("this repository's own README and website advertise consistent downloads for the version in package.json", () => {
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  const { problems, links } = findProblems({ root: ROOT, version });
  assert.deepEqual(problems, []);
  assert.ok(links.length >= 2, 'the README and the website each offer the macOS download');
  assert.equal(links.some((l) => /win/i.test(l.platform)), false, 'no Windows download is advertised for this release');
});
