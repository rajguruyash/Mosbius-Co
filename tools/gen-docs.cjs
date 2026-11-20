#!/usr/bin/env node
'use strict';

/**
 * Writes the generated parts of DEVELOPMENT.md from the catalogue (tools/lib/catalogue.cjs), which is itself derived from the
 * data the app uses. Two blocks, each between a pair of markers:
 *
 *   <!-- gen:agents:start ... -->      the table of coding agents: what each was run with, and its caveats
 *   <!-- gen:catalogue:start ... -->   the integration catalogue: every provider, by group, with the six-word vocabulary
 *
 *   node tools/gen-docs.cjs          rewrite the blocks
 *   node tools/gen-docs.cjs --check  exit 1 if a block is not what the data says (the CI job and a test use this)
 *
 * INTEGRATIONS.md has its own generated block, written by tools/gen-support-matrix.cjs from the same data.
 */

const fs = require('node:fs');
const path = require('node:path');
const { buildCatalogue, ROOT } = require('./lib/catalogue.cjs');
const { agentsTableMd, catalogueMd } = require('./lib/render.cjs');

const FILE = path.join(ROOT, 'DEVELOPMENT.md');

function replaceBlock(text, name, body) {
  const start = new RegExp(`<!-- gen:${name}:start[^>]*-->`);
  const endMark = `<!-- gen:${name}:end -->`;
  const m = start.exec(text);
  const e = text.indexOf(endMark);
  if (!m || e < 0 || e < m.index) throw new Error(`DEVELOPMENT.md has no gen:${name} markers`);
  return `${text.slice(0, m.index + m[0].length)}\n\n${body.trim()}\n\n${text.slice(e)}`;
}

function render(text) {
  const c = buildCatalogue();
  let out = replaceBlock(text, 'agents', agentsTableMd(c));
  out = replaceBlock(out, 'catalogue', catalogueMd(c));
  return out;
}

if (require.main === module) {
  const text = fs.readFileSync(FILE, 'utf8');
  const next = render(text);
  if (process.argv.includes('--check')) {
    if (next !== text) { console.error('DEVELOPMENT.md is out of date: run `node tools/gen-docs.cjs` (npm run docs:gen)'); process.exit(1); }
    console.log('DEVELOPMENT.md matches the app\'s own data');
    process.exit(0);
  }
  fs.writeFileSync(FILE, next);
  console.log('rewrote the generated blocks in DEVELOPMENT.md');
}

module.exports = { render, replaceBlock };
