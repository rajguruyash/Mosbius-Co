#!/usr/bin/env node
'use strict';

/**
 * Release gate: every download link this project advertises must name a real release asset, and the macOS download
 * (the front door of the README and the website) must offer the version in package.json.
 *
 * WHAT IT CHECKS. The links in README.md and website/index.html that point at
 * https://github.com/rajguruyash/Mosbius-Co/releases/download/<tag>/Mosbius-Co-<version>-<platform>.<ext>:
 *   1. the tag and the version in the file name agree (v1.1.0 <-> Mosbius-Co-1.1.0-...);
 *   2. no link is newer than package.json (a link to a release that is not out yet);
 *   3. every macOS link offers exactly package.json's version, so the front door is never a release behind;
 *   4. there is at least one macOS link on each page (a moved section must not turn this check into a pass).
 * A Windows link may be OLDER than package.json: the Windows installer is built and published on its own, and a page that
 * says so is more honest than a link to a file that does not exist.
 *
 * WHAT IT NO LONGER CHECKS. Until 1.1.0 this file checked RELEASE.md, docs/index.html and docs/llms.txt against
 * package.json. Those files are the upstream project's own text (Munder Difflin, with its own versions and its own release
 * host), not this project's release, and package.json had stayed at the upstream version while the published releases were
 * named 1.0.0 (their version was given on the command line). With package.json now carrying the real version, that check
 * could only ever fail, for reasons that have nothing to do with these downloads.
 *
 * Two modes:
 *   (default) offline: the rules above. Run this BEFORE tagging, when the assets do not exist yet.
 *   --live    also sends a HEAD request to each distinct URL and requires 200. Run this AFTER publishing the release,
 *             which is the only moment the answer is meaningful.
 */

const fs = require('node:fs');
const path = require('node:path');

const REPO = 'rajguruyash/Mosbius-Co';
const PAGES = ['README.md', 'website/index.html'];
const LINK = new RegExp(`https://github\\.com/${REPO.replace('/', '\\/')}/releases/download/(v[0-9][0-9.]*)/(Mosbius-Co-([0-9][0-9.]*)-([A-Za-z0-9._-]+))`, 'g');

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

/** What is wrong with the advertised downloads, and the links that were found. Pure: reads only the pages named. */
function findProblems({ root, version, pages = PAGES }) {
  const problems = [];
  const links = [];
  for (const rel of pages) {
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    for (const m of text.matchAll(LINK)) links.push({ page: rel, url: m[0], tag: m[1], name: m[2], fileVersion: m[3], platform: m[4] });
  }
  if (links.length === 0) problems.push('no download links found at all: did the downloads section move?');
  for (const l of links) {
    if (l.tag !== `v${l.fileVersion}`) problems.push(`${l.page}: ${l.url} (the tag is ${l.tag} but the file name carries ${l.fileVersion})`);
    if (compareVersions(l.fileVersion, version) > 0) problems.push(`${l.page}: ${l.url} (newer than package.json ${version}: that release is not out)`);
  }
  for (const rel of pages) {
    const mac = links.filter((l) => l.page === rel && /(^|-)mac(-|\.)/.test(l.platform));
    if (mac.length === 0) problems.push(`${rel} has no macOS download link`);
    for (const l of mac) {
      if (compareVersions(l.fileVersion, version) !== 0) problems.push(`${rel}: the macOS download offers ${l.fileVersion} but package.json says ${version}`);
    }
  }
  return { problems, links };
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
  const { problems, links } = findProblems({ root, version });
  if (process.argv.includes('--live')) {
    console.log(`Checking the advertised downloads against GitHub (package.json says ${version})...`);
    for (const url of [...new Set(links.map((l) => l.url))]) {
      const status = await head(url);
      if (status === 200) console.log(`  ok  ${url}`);
      else problems.push(`${url} (${status}: advertised but not downloadable)`);
    }
  }
  if (problems.length) {
    console.error(`\n✗ release links are wrong (${problems.length}):`);
    for (const p of problems) console.error(`  - ${p}`);
    console.error('\nFix README.md and website/index.html to match package.json before releasing.');
    process.exit(1);
  }
  console.log(`✓ release links consistent at v${version}`);
}

module.exports = { findProblems, compareVersions };

if (require.main === module) main();
