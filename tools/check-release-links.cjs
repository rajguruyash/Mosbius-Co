#!/usr/bin/env node
'use strict';

/**
 * Release gate: every download this project advertises must point at a real release, and the macOS download (the front
 * door of the README and the website) must offer the version in package.json.
 *
 * WHAT IT CHECKS. In README.md and website/index.html, two kinds of link into https://github.com/rajguruyash/Mosbius-Co:
 *   - a release page, .../releases/tag/<tag>. A macOS release is tagged v<version> (v1.1.0) and the Windows installer of the
 *     same version v<version>.0 (v1.1.0.0): it is built and published on its own, so it carries a fourth number. The
 *     download buttons open these pages.
 *   - a file, .../releases/download/<tag>/Mosbius-Co-<version>-<platform>.<ext>. Earlier pages linked straight to these.
 * and these rules:
 *   1. a file link's tag and the version in its file name agree (v1.1.0 <-> Mosbius-Co-1.1.0-...);
 *   2. no link is newer than package.json (a link to a release that is not out yet);
 *   3. every macOS link offers exactly package.json's version, so the front door is never a release behind;
 *   4. there is at least one macOS link on each page (a moved section must not turn this check into a pass).
 * A Windows link may be OLDER than package.json: the Windows installer is built and published on its own, and a page that
 * says so is more honest than a link to a file that does not exist.
 * website/releases.html lists releases of every age, so it is held to rule 2 only, and it must name some.
 *
 * WHAT IT NO LONGER CHECKS. Until 1.1.0 this file checked RELEASE.md, docs/index.html and docs/llms.txt against
 * package.json. Those files are the upstream project's own text (Munder Difflin, with its own versions and its own release
 * host), not this project's release, and package.json had stayed at the upstream version while the published releases were
 * named 1.0.0 (their version was given on the command line). With package.json now carrying the real version, that check
 * could only ever fail, for reasons that have nothing to do with these downloads.
 *
 * Two modes:
 *   (default) offline: the rules above. Run this BEFORE tagging, when the releases do not exist yet.
 *   --live    also sends a HEAD request to each distinct URL and requires 200. Run this AFTER publishing the releases,
 *             which is the only moment the answer is meaningful.
 */

const fs = require('node:fs');
const path = require('node:path');

const REPO = 'rajguruyash/Mosbius-Co';
const PAGES = ['README.md', 'website/index.html'];
/** Pages that list releases of every age: they may name old ones, but none that is not out, and they must name some. */
const HISTORY_PAGES = ['website/releases.html'];
const REPO_RE = REPO.replace('/', '\\/');
const LINK = new RegExp(`https://github\\.com/${REPO_RE}/releases/download/(v[0-9][0-9.]*)/(Mosbius-Co-([0-9][0-9.]*)-([A-Za-z0-9._-]+))`, 'g');
const RELEASE_LINK = new RegExp(`https://github\\.com/${REPO_RE}/releases/tag/(v[0-9]+(?:\\.[0-9]+)+)`, 'g');

/** -1, 0 or 1 for dotted numbers of any length (the Windows release is tagged 1.0.0.0). */
function compareVersions(a, b) {
  const [x, y] = [a, b].map((v) => v.split('.').map(Number));
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const l = x[i] ?? 0;
    const r = y[i] ?? 0;
    if (l !== r) return l < r ? -1 : 1;
  }
  return 0;
}

/** A Windows installer's tag has a fourth number (v1.1.0.0); a macOS tag has three (v1.1.0). */
const isWindowsTag = (tag) => tag.slice(1).split('.').length === 4;

/** The release-page links in a text. */
function releaseLinks(text, page) {
  return [...text.matchAll(RELEASE_LINK)].map((m) => ({
    kind: 'release', page, url: m[0], tag: m[1], name: null, fileVersion: m[1].slice(1), platform: isWindowsTag(m[1]) ? 'win-release' : 'mac-release'
  }));
}

/** What is wrong with the advertised downloads, and the links that were found. Pure: reads only the pages named. */
function findProblems({ root, version, pages = PAGES, historyPages = [] }) {
  const problems = [];
  const links = [];
  const seen = new Set();
  for (const rel of pages) {
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    const found = [
      ...[...text.matchAll(LINK)].map((m) => ({ kind: 'download', page: rel, url: m[0], tag: m[1], name: m[2], fileVersion: m[3], platform: m[4] })),
      ...releaseLinks(text, rel)
    ];
    for (const l of found) {
      if (seen.has(`${l.page} ${l.url}`)) continue;      // the same button twice on a page is one link
      seen.add(`${l.page} ${l.url}`);
      links.push(l);
    }
  }
  if (links.length === 0) problems.push('no download links found at all: did the downloads section move?');
  for (const l of links) {
    if (l.kind === 'download' && l.tag !== `v${l.fileVersion}`) problems.push(`${l.page}: ${l.url} (the tag is ${l.tag} but the file name carries ${l.fileVersion})`);
    if (compareVersions(l.fileVersion, version) > 0) problems.push(`${l.page}: ${l.url} (newer than package.json ${version}: that release is not out)`);
  }
  const isMac = (l) => (l.kind === 'release' ? !isWindowsTag(l.tag) : /(^|-)mac(-|\.)/.test(l.platform));
  for (const rel of pages) {
    const mac = links.filter((l) => l.page === rel && isMac(l));
    if (mac.length === 0) problems.push(`${rel} has no macOS download link`);
    for (const l of mac) {
      if (compareVersions(l.fileVersion, version) !== 0) problems.push(`${rel}: the macOS download offers ${l.fileVersion} but package.json says ${version}`);
    }
  }
  const history = [];
  for (const rel of historyPages) {
    const file = path.join(root, rel);
    if (!fs.existsSync(file)) { problems.push(`${rel} is missing`); continue; }
    const found = releaseLinks(fs.readFileSync(file, 'utf8'), rel).filter((l, i, all) => all.findIndex((x) => x.url === l.url) === i);
    if (found.length === 0) problems.push(`${rel} lists no releases`);
    for (const l of found) {
      history.push(l);
      if (compareVersions(l.fileVersion, version) > 0) problems.push(`${rel}: ${l.url} (newer than package.json ${version}: that release is not out)`);
    }
  }
  return { problems, links, history };
}

async function head(url) {
  try {
    // GitHub answers an asset download with a redirect to its CDN: follow it, and a HEAD request is enough.
    return (await fetch(url, { method: 'HEAD', redirect: 'follow' })).status;
  } catch (e) {
    return `request failed: ${e.message}`;
  }
}

async function main() {
  const root = path.join(__dirname, '..');
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const { problems, links, history } = findProblems({ root, version, historyPages: HISTORY_PAGES });
  if (process.argv.includes('--live')) {
    console.log(`Checking the advertised releases against GitHub (package.json says ${version})...`);
    for (const url of [...new Set([...links, ...history].map((l) => l.url))]) {
      const status = await head(url);
      if (status === 200) console.log(`  ok  ${url}`);
      else problems.push(`${url} (${status}: advertised but not there)`);
    }
  }
  if (problems.length) {
    console.error(`\n✗ release links are wrong (${problems.length}):`);
    for (const p of problems) console.error(`  - ${p}`);
    console.error('\nFix README.md, website/index.html and website/releases.html to match package.json before releasing.');
    process.exit(1);
  }
  console.log(`✓ release links consistent at v${version}`);
}

module.exports = { findProblems, compareVersions, isWindowsTag, PAGES, HISTORY_PAGES };

if (require.main === module) main();
