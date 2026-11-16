'use strict';

/**
 * Settings → Integrations & Skills is written in English, Simplified Chinese and Arabic (right-to-left).
 * These checks keep the three in step with the code that uses them: every key the hub's components ask for
 * exists in all three languages, none is empty, the placeholders survive translation, and the page uses
 * logical (direction-aware) CSS rather than left/right.
 *
 * Arabic and Chinese CORRECTNESS is not claimed here: the strings were written by an agent, not reviewed by a
 * native reader. What is tested is coverage, shape and direction.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const locale = (code) => JSON.parse(read(`src/renderer/src/i18n/locales/${code}.json`));
const LOCALES = { en: locale('en'), 'zh-CN': locale('zh-CN'), ar: locale('ar') };
const get = (tree, key) => key.split('.').reduce((o, p) => (o && typeof o === 'object' ? o[p] : undefined), tree);

const { PROVIDERS } = loadTs('src/shared/providers.ts');
const { AGENT_COMPAT } = loadTs('src/shared/agentCompat.ts');

const HUB_DIR = 'src/renderer/src/components/hub';
const hubFiles = fs.readdirSync(path.join(root, HUB_DIR)).filter((f) => /\.tsx?$/.test(f)).map((f) => `${HUB_DIR}/${f}`);
const sources = [...hubFiles, 'src/renderer/src/components/SettingsModal.tsx'].map((f) => [f, read(f)]);

/** Every ConnectError code, read from the union in the shared file. */
const connectCodes = [...read('src/shared/connect.ts').matchAll(/\|\s*'([a-z-]+)'\s*(?:\/\/.*)?\n/g)].map((m) => m[1]);

/** Every static key a component passes to t(...) (quoted literals only); dynamic keys are enumerated below. */
function staticKeys() {
  const keys = new Set();
  for (const [, src] of sources) {
    for (const m of src.matchAll(/(['"`])((?:hub\.|settings\.nav\.integrations|settings\.connections\.(?:hubPointer|openHub))[A-Za-z0-9_.-]*)\1/g)) {
      if (!m[2].includes('$')) keys.add(m[2]);
    }
  }
  return [...keys].sort();
}

/** Keys built from a value at run time: each family and the values it can take. */
function dynamicKeys() {
  const out = [];
  const fam = (prefix, values) => { for (const v of values) out.push(`${prefix}.${v}`); };
  fam('hub.tabs', ['discover', 'connected', 'skills', 'access', 'activity']);
  fam('hub.cat', ['all', ...new Set(PROVIDERS.map((p) => p.category))]);
  fam('hub.providers', PROVIDERS.map((p) => p.id));
  fam('hub.verify', ['verified', 'limited', 'untested', 'planned', 'na']);
  fam('hub.wayShort', [...new Set(PROVIDERS.flatMap((p) => p.ways))]);
  fam('hub.method', ['dcr', 'device', 'public']);
  fam('hub.connect.errors', [...connectCodes, 'failed']);
  fam('hub.skills.integrity', ['ok', 'changed', 'missing']);
  fam('hub.skills.scope', ['user', 'project', 'bundled']);
  fam('hub.skills.target', ['claude', 'agents']);
  fam('hub.skills.update', ['added', 'removed', 'changed']);
  fam('hub.compat.status', ['verified', 'wired', 'unsupported']);
  fam('hub.compat.delivery', [...new Set(AGENT_COMPAT.map((a) => a.delivery))]);
  fam('hub.compat.shell', ['yes', 'no', 'unknown']);
  return out;
}

test('the ConnectError codes were read from the source (the check below is not empty)', () => {
  assert.ok(connectCodes.length >= 18, `read ${connectCodes.length} codes`);
  assert.ok(connectCodes.includes('denied') && connectCodes.includes('not-stored') && connectCodes.includes('no-browser'));
});

test('every key the hub asks for exists, and is a non-empty string, in all three languages', () => {
  const all = [...staticKeys(), ...dynamicKeys()];
  assert.ok(all.length > 200, `${all.length} keys checked`);
  const missing = [];
  for (const [code, tree] of Object.entries(LOCALES)) {
    for (const k of all) {
      const v = get(tree, k);
      if (typeof v !== 'string' || v.trim() === '') missing.push(`${code}: ${k}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('nothing in the hub subtree is unused: every string is reachable from the code', () => {
  const used = new Set([...staticKeys(), ...dynamicKeys()]);
  const leaves = [];
  (function walk(node, prefix) {
    for (const [k, v] of Object.entries(node)) {
      if (v && typeof v === 'object') walk(v, `${prefix}.${k}`);
      else leaves.push(`${prefix}.${k}`);
    }
  })(LOCALES.en.hub, 'hub');
  // keys the ConnectPanel builds inline, or that a later change may use
  const unused = leaves.filter((k) => !used.has(k));
  assert.deepEqual(unused, [], 'strings with no code that shows them (delete them, or use them)');
});

test('placeholders survive translation and nothing is left in English except product names', () => {
  const same = new Set(['hub.skills.target.claude']);
  const vars = (s) => [...String(s).matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => m[1]).sort().join(',');
  const problems = [];
  (function walk(node, prefix) {
    for (const [k, v] of Object.entries(node)) {
      const key = `${prefix}.${k}`;
      if (v && typeof v === 'object') { walk(v, key); continue; }
      for (const code of ['zh-CN', 'ar']) {
        const t = get(LOCALES[code], key);
        if (vars(v) !== vars(t)) problems.push(`${code} ${key}: [${vars(v)}] -> [${vars(t)}]`);
        if (t === v && /[A-Za-z]{4}/.test(v.replace(/\{\{[^}]*\}\}/g, '')) && !same.has(key)) problems.push(`${code} ${key} is still English`);
      }
    }
  })(LOCALES.en.hub, 'hub');
  assert.deepEqual(problems, []);
});

test('the Arabic and Chinese text is the right script', () => {
  const walkValues = (node, out = []) => { for (const v of Object.values(node)) (v && typeof v === 'object') ? walkValues(v, out) : out.push(v); return out; };
  const ar = walkValues(LOCALES.ar.hub).filter((s) => !/^[A-Za-z0-9 .{}:/·→←…\-–]*$/.test(s));
  const arabicShare = ar.filter((s) => /[؀-ۿ]/.test(s)).length / ar.length;
  assert.ok(arabicShare > 0.97, `Arabic strings with Arabic letters: ${(arabicShare * 100).toFixed(1)}%`);
  const zh = walkValues(LOCALES['zh-CN'].hub).filter((s) => !/^[A-Za-z0-9 .{}:/·→←…\-–]*$/.test(s));
  const hanShare = zh.filter((s) => /[一-鿿]/.test(s)).length / zh.length;
  assert.ok(hanShare > 0.97, `Chinese strings with Han characters: ${(hanShare * 100).toFixed(1)}%`);
});

test('the hub lays itself out with direction-aware CSS: no left/right in its styles', () => {
  const offenders = [];
  for (const [file, src] of sources.filter(([f]) => f.startsWith(HUB_DIR))) {
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    for (const m of code.matchAll(/\b(marginLeft|marginRight|paddingLeft|paddingRight|borderLeft|borderRight|left|right)\s*:/g)) {
      offenders.push(`${file}: ${m[1]}`);
    }
    for (const m of code.matchAll(/textAlign\s*:\s*['"](left|right)['"]/g)) offenders.push(`${file}: textAlign ${m[1]}`);
  }
  assert.deepEqual(offenders, [], 'use the logical forms (marginInlineStart, paddingInlineEnd, insetInlineStart, textAlign start/end)');
});

test('the settings page lists the hub, and the i18n keys for the nav and the pointer exist', () => {
  const src = read('src/renderer/src/components/SettingsModal.tsx');
  assert.match(src, /'Integrations & Skills'/);
  assert.match(src, /<IntegrationsHub config=\{config\} goSection=\{setActiveSection\} \/>/);
  for (const [code, tree] of Object.entries(LOCALES)) {
    for (const k of ['settings.nav.integrations', 'settings.connections.hubPointer', 'settings.connections.openHub']) assert.equal(typeof get(tree, k), 'string', `${code}: ${k}`);
  }
});
