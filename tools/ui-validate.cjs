#!/usr/bin/env node
'use strict';

/**
 * Drive the REAL built desktop app (Electron, out/main/index.js) on a throwaway profile and look at Settings →
 * Integrations & Skills the way a person would: screenshots, real clicks and key presses, text read from the page,
 * restarts, three languages (one right-to-left), narrow windows, light and dark.
 *
 *   npm run build && node tools/ui-validate.cjs [--out evidence/ui] [--keep] [--only name,name]
 *   node tools/ui-validate.cjs --packaged "dist/mac-arm64/Mosbius & Co.app/Contents/MacOS/Mosbius & Co" --out evidence/ui-packaged
 *     (the same tour against the PACKAGED app instead of the development build)
 *
 * What it uses: the real main process, preload and renderer; a throwaway --user-data-dir and a throwaway HOME, so
 * nothing of yours is read or written; the DevTools protocol over a loopback port, for as long as it runs.
 *
 * What it does NOT do, on purpose:
 *   - sign in anywhere, register anything at a provider or install anything from the network (those need your
 *     consent and your account, and are verified by the stand-in tests and the live runs, not here);
 *   - click Install on a catalogue skill. Skills here are seeded on disk through the production installer, with a
 *     fake GitHub, before the app starts.
 * The catalogue list itself is fetched by the app (a read of a public page), or shows its "could not be reached" state.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const OUT = path.resolve(flag('--out', path.join(ROOT, 'evidence', 'ui')));
const KEEP = argv.includes('--keep');
const ONLY = flag('--only') ? new Set(flag('--only').split(',')) : null;
const PACKAGED = flag('--packaged') ? path.resolve(flag('--packaged')) : null;
const ELECTRON = PACKAGED ?? path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');

if (!PACKAGED && !fs.existsSync(path.join(ROOT, 'out', 'main', 'index.js'))) { console.error('BLOCKED: run `npm run build` first (out/main/index.js is missing)'); process.exit(2); }
if (!fs.existsSync(ELECTRON)) { console.error(PACKAGED ? `BLOCKED: no packaged app at ${PACKAGED}` : 'BLOCKED: the Electron binary is not installed'); process.exit(2); }
if (typeof WebSocket !== 'function') { console.error('BLOCKED: this needs Node 22 (a global WebSocket)'); process.exit(2); }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mosbius-ui-'));
const FAKE_HOME = path.join(TMP, 'home');
const UD = path.join(TMP, 'userdata');
fs.mkdirSync(FAKE_HOME, { recursive: true });
fs.mkdirSync(UD, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
process.env.HOME = FAKE_HOME;              // the production installer below resolves ~ from this

const loadTs = require('../test/load-ts.cjs');
const { fakeGitHub, URL1, V1 } = require('../test/fixtures/fake-github.cjs');
const { installSkill } = loadTs('src/main/skills.ts');

const results = [];
const shots = [];
const check = (group, name, ok, detail = '') => { results.push({ group, name, ok: !!ok, detail }); console.log(`  ${ok ? 'PASS' : 'FAIL'}  [${group}] ${name}${detail ? `  — ${detail}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

// ── the app under test ───────────────────────────────────────────────────────────────────────────
let current = null;
/** Kill anything still running on this run's profile (the app starts helper processes of its own). */
function killStrays() {
  try {
    const out = require('node:child_process').execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    for (const line of out.split('\n')) {
      if (!line.includes(`--user-data-dir=${UD}`)) continue;
      const pid = Number(line.trim().split(/\s+/)[0]);
      if (pid && pid !== process.pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    }
  } catch { /* best effort */ }
}
/** Every app process this run started, so none outlives it, whatever happens. */
const spawned = new Set();
const killAll = () => { for (const c of spawned) { try { c.kill('SIGKILL'); } catch { /* gone */ } } };
process.on('exit', () => { killAll(); killStrays(); });
process.on('SIGINT', () => { killAll(); process.exit(130); });
process.on('SIGTERM', () => { killAll(); process.exit(143); });
let keyMode = process.env.UI_KEYS === 'synthetic' ? 'synthetic' : null;
async function launch({ lang = 'en', width = 1280, height = 860, theme = null } = {}) {
  killStrays();
  const port = await freePort();
  // A window that macOS thinks is covered or in the background stops producing frames, and the DevTools calls that need
  // a frame (screenshots, resizing) then wait forever. These switches keep the window rendering as it would for a person
  // sitting in front of it. They change nothing about what the app does.
  // --use-mock-keychain: the first use of the encrypted store makes macOS ask for Keychain access, and an unsigned app
  // is frozen until someone answers. A throwaway profile has nothing worth protecting, so the test uses Chromium's
  // mock keychain instead and nothing on your machine is asked or touched.
  const keepRendering = ['--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling', '--disable-features=CalculateNativeWinOcclusion', '--use-mock-keychain'];
  const child = spawn(ELECTRON, [...(PACKAGED ? [] : [ROOT]), `--user-data-dir=${UD}`, `--remote-debugging-port=${port}`, ...keepRendering], {
    env: { ...process.env, HOME: FAKE_HOME, ELECTRON_ENABLE_LOGGING: '0', MOSBIUS_UI_TEST: '1' }, stdio: ['ignore', 'pipe', 'pipe']
  });
  spawned.add(child);
  child.once('exit', () => spawned.delete(child));
  let log = '';
  child.stdout.on('data', (c) => { log += c; }); child.stderr.on('data', (c) => { log += c; });
  const target = await waitFor(async () => {
    try {
      const list = await new Promise((resolve, reject) => { http.get({ host: '127.0.0.1', port, path: '/json/list' }, (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); }).on('error', reject); });
      return list.find((t) => t.type === 'page' && /index\.html|localhost/.test(t.url)) ?? null;
    } catch { return null; }
  }, 40_000, 'the app window');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('devtools socket')); });
  let id = 0; const pending = new Map(); const events = [];
  ws.onmessage = (m) => { const o = JSON.parse(m.data); if (o.id && pending.has(o.id)) { const p = pending.get(o.id); pending.delete(o.id); o.error ? p.reject(new Error(o.error.message)) : p.resolve(o.result); } else if (o.method) events.push(o); };
  const send = (method, params = {}, ms = 20_000) => new Promise((resolve, reject) => {
    const i = ++id; pending.set(i, { resolve, reject });
    ws.send(JSON.stringify({ id: i, method, params }));
    // a call that is never answered must not hang the whole run
    setTimeout(() => { if (pending.has(i)) { pending.delete(i); reject(new Error(`devtools call timed out: ${method}`)); } }, ms);
  });
  const app = {
    child, port, send, events, log: () => log,
    /** When the page stops answering, ask the debugger where it is stuck (it runs on another thread). */
    async whereStuck() {
      try {
        await send('Debugger.enable', {}, 5000);
        const before = events.length;
        await send('Debugger.pause', {}, 5000);
        const end = Date.now() + 6000;
        while (Date.now() < end) {
          const ev = events.slice(before).find((e) => e.method === 'Debugger.paused');
          if (ev) return ev.params.callFrames.slice(0, 8).map((f) => `${f.functionName || '(anonymous)'} ${String(f.url).split('/').pop()}:${f.location.lineNumber + 1}`);
          await sleep(100);
        }
      } catch (e) { return [`(debugger did not answer: ${e.message})`]; }
      return ['(no pause event)'];
    },
    async ev(expression) {
      if (process.env.UI_TRACE) console.log('    ev>', expression.replace(/\s+/g, ' ').slice(0, 110));
      let r;
      try { r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); }
      catch (e) {
        if (/timed out/.test(e.message) && !app.stuckReported) { app.stuckReported = true; console.log('    the page stopped answering; it is executing:', JSON.stringify(await app.whereStuck())); }
        throw e;
      }
      if (r.exceptionDetails) throw new Error(`page error: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
      return r.result.value;
    },
    async shot(name, note = '') {
      const r = await send('Page.captureScreenshot', { format: 'png' });
      const file = path.join(OUT, `${name}.png`);
      fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
      shots.push({ name, file: path.relative(ROOT, file), note });
    },
    async size(w, h, mobile = false) { await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile }); },
    async key(key, code, mods = 0) {
      // Real input events first: what the browser itself sends for an arrow or Home. This Electron window does not
      // acknowledge them when it is not the frontmost window of a logged-in session, so the first miss switches to
      // events dispatched on the focused element, which run the same handlers; the evidence says which was used.
      const vk = { ArrowRight: 39, ArrowLeft: 37, Home: 36, End: 35, Tab: 9, Enter: 13, ' ': 32 }[key] ?? 0;
      if (keyMode === 'synthetic') info.keyboard = 'KeyboardEvents dispatched on the focused element (real input events were not acknowledged by this window)';
      if (keyMode !== 'synthetic') {
        try {
          await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, modifiers: mods, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }, 2500);
          await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers: mods, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }, 2500);
          keyMode = 'real'; info.keyboard = 'real input events';
          return;
        } catch { keyMode = 'synthetic'; info.keyboard = 'KeyboardEvents dispatched on the focused element (real input events were not acknowledged by this window)'; }
      }
      // dispatched from a timer, not inside the evaluate call: the handler then runs as it would for a real key press
      await app.ev(`setTimeout(() => { const el = document.activeElement || document.body; const o = { key: ${JSON.stringify(key)}, code: ${JSON.stringify(code)}, bubbles: true, cancelable: true }; el.dispatchEvent(new KeyboardEvent('keydown', o)); el.dispatchEvent(new KeyboardEvent('keyup', o)); }, 20); true`);
      await sleep(300);
    },
    async click(selector, text) {
      const pos = await app.ev(`(() => {
        const sel = ${JSON.stringify(selector)}, text = ${JSON.stringify(text ?? null)};
        const els = [...document.querySelectorAll(sel)].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
        const el = text === null ? els[0] : els.find((e) => (e.getAttribute('aria-label') || e.textContent || '').trim().toLowerCase().includes(text.toLowerCase()));
        if (!el) return null;
        el.scrollIntoView({ block: 'center', inline: 'nearest' });
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`);
      if (!pos) throw new Error(`nothing to click: ${selector} ${text ?? ''}`);
      for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
      await sleep(120);
    },
    async text() { return app.ev('document.body.innerText'); },
    async close() {
      try { ws.close(); } catch { /* gone */ }
      child.kill('SIGTERM');
      await Promise.race([new Promise((r) => child.once('exit', r)), sleep(5000)]);
      try { child.kill('SIGKILL'); } catch { /* gone */ }
      killStrays();
      await sleep(400);
    }
  };
  // language and theme are the user's own choices, kept by the app in localStorage
  await waitFor(() => app.ev('document.readyState === "complete" && !!document.body && document.body.innerText.length > 0').catch(() => false), 30_000, 'the page');
  await app.ev(`(() => { try { localStorage.setItem('cth.language', ${JSON.stringify(lang)}); localStorage.setItem('cth.skipHivePickerOnce', '1'); ${theme ? `localStorage.setItem('cth.theme', ${JSON.stringify(theme)});` : ''} } catch {} })()`);
  await send('Page.reload');
  await waitFor(() => app.ev('document.readyState === "complete" && document.body.innerText.length > 20').catch(() => false), 30_000, 'the page after reload');
  await app.size(width, height);
  // a window that is not frontmost does not take key events; tell the page it has focus (as a person at the keyboard would)
  await send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
  await send('Page.bringToFront').catch(() => {});
  await sleep(500);
  current = app;
  return app;
}
async function waitFor(fn, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(150); }
  throw new Error(`timed out waiting for ${what}`);
}

const seedConfig = (extra = {}) => fs.writeFileSync(path.join(UD, 'config.json'), JSON.stringify({ onboardingComplete: true, harnessHome: path.join(FAKE_HOME, 'Mosbius'), ...extra }, null, 2));
const readConfigFile = () => { try { return JSON.parse(fs.readFileSync(path.join(UD, 'config.json'), 'utf8')); } catch { return {}; } };

async function openHub(app, tab) {
  await app.ev(`window.dispatchEvent(new CustomEvent('cth:open-settings', { detail: { section: 'Integrations & Skills' } }))`);
  await waitFor(() => app.ev(`!!document.querySelector('[data-hub]')`), 15_000, 'the Integrations & Skills page');
  if (tab) { await app.click('[role="tab"]', null).catch(() => {}); await app.ev(`document.getElementById('hub-tab-${tab}')?.click()`); await sleep(250); }
}

/** The audit a person with a screen reader and a keyboard would care about. Reads the page; changes nothing. */
const AUDIT = `(() => {
  const root = document.querySelector('[data-hub]') || document.body;
  const visible = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const nameOf = (e) => {
    const lab = e.getAttribute('aria-label'); if (lab && lab.trim()) return lab.trim();
    const by = e.getAttribute('aria-labelledby'); if (by) { const t = by.split(/\\s+/).map((i) => document.getElementById(i)?.textContent || '').join(' ').trim(); if (t) return t; }
    if (e.id) { const l = document.querySelector('label[for="' + e.id + '"]'); if (l && l.textContent.trim()) return l.textContent.trim(); }
    if (e.closest('label') && e.closest('label').textContent.trim()) return e.closest('label').textContent.trim();
    const t = (e.textContent || '').trim(); if (t) return t;
    return (e.getAttribute('title') || e.getAttribute('placeholder') || '').trim();
  };
  const unnamed = [...root.querySelectorAll('button, [role=tab], input, select, textarea, a[href], summary')].filter(visible).filter((e) => !nameOf(e)).map((e) => e.outerHTML.slice(0, 100));
  const tabs = [...root.querySelectorAll('[role=tab]')];
  const selected = tabs.filter((t) => t.getAttribute('aria-selected') === 'true');
  const panel = root.querySelector('[role=tabpanel]');
  const panelLabelled = !!panel && !!document.getElementById(panel.getAttribute('aria-labelledby') || '');
  const tablist = !!root.querySelector('[role=tablist]');
  const rovers = tabs.filter((t) => t.tabIndex === 0).length;
  // contrast of every text-bearing element in the hub against the colour behind it
  const parse = (c) => { const m = c.match(/rgba?\\(([^)]+)\\)/); if (!m) return null; const p = m[1].split(/[ ,\\/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p[3] === undefined ? 1 : p[3] }; };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const behind = (e) => { let el = e; while (el) { const c = parse(getComputedStyle(el).backgroundColor); if (c && c.a > 0.9) return c; el = el.parentElement; } return { r: 255, g: 255, b: 255, a: 1 }; };
  const rows = [];
  for (const e of root.querySelectorAll('*')) {
    if (![...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
    if (!visible(e)) continue;
    const fg = parse(getComputedStyle(e).color); if (!fg) continue;
    const bg = behind(e);
    const a = lum(fg), b = lum(bg); const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    rows.push({ ratio: Math.round(ratio * 100) / 100, size: parseFloat(getComputedStyle(e).fontSize), text: e.textContent.trim().slice(0, 40) });
  }
  rows.sort((x, y) => x.ratio - y.ratio);
  const overflowX = document.documentElement.scrollWidth > window.innerWidth + 1;
  const hubOverflow = root.scrollWidth > root.clientWidth + 1;
  return { unnamed, tablist, tabs: tabs.length, selected: selected.length, panelLabelled, rovers, lowest: rows.slice(0, 6), textCount: rows.length, overflowX, hubOverflow, dir: document.documentElement.getAttribute('dir'), lang: document.documentElement.getAttribute('lang') };
})()`;

// ── scenarios ────────────────────────────────────────────────────────────────────────────────────
const scenarios = {
  async 'fresh-install'() {
    // nothing in the profile: the first run must start at onboarding, not in the middle of the app
    const app = await launch();
    const text = await app.text();
    check('fresh install', 'a profile with nothing in it starts at the first-run screen', /welcome|get started|set up|step|continue/i.test(text) && !(await app.ev(`!!document.querySelector('[data-hub]')`)), text.replace(/\s+/g, ' ').slice(0, 90));
    await app.shot('01-fresh-install');
    await app.close();
  },

  async 'hub-english'() {
    seedConfig();
    const app = await launch({ lang: 'en' });
    await app.click('button[aria-label="Settings"]');
    await waitFor(() => app.ev(`/Integrations & Skills/.test(document.body.innerText)`), 15_000, 'Settings');
    check('settings', 'Settings lists "Integrations & Skills" in its navigation', true);
    await app.click('button', 'Integrations & Skills');
    await waitFor(() => app.ev(`!!document.querySelector('[data-hub]')`), 10_000, 'the hub');
    const text = await app.text();
    check('settings', 'the hub opens on Discover with the plain-words intro', /Everything here is off until you turn it on/i.test(text) && /discover/i.test(text));
    await app.shot('02-discover-en');

    // nothing is on, connected or granted on a fresh start
    const cfg = readConfigFile();
    check('opt-in', 'nothing is switched on in a fresh profile', !Object.values(cfg.mcpDefaults ?? {}).some((v) => v && v.enabled === true));
    const connectedTab = await app.ev(`(() => { document.getElementById('hub-tab-connected').click(); return true; })()`);
    await sleep(300);
    check('opt-in', 'the Connected tab says nothing is connected', /Nothing is connected yet/.test(await app.text()) && connectedTab === true);
    await app.shot('03-connected-empty-en');

    // every provider card is there, with an honest label
    await app.ev(`document.getElementById('hub-tab-discover').click()`);
    await sleep(300);
    const cards = await app.ev(`[...document.querySelectorAll('[data-hub] [role=tabpanel] *')].filter((e) => e.children.length === 0 && /Not yet tested|Verified|Partly verified|Planned|Not applicable/.test(e.textContent || '')).map((e) => e.textContent.trim())`);
    check('discover', 'every provider except the five AI engines carries a verification label', cards.length >= 22, `${cards.length} labels`);
    check('discover', 'no provider that nobody has signed in to is marked Verified', !(await app.ev(`(() => { const t = document.body.innerText; return /Notion[\\s\\S]{0,200}Verified/.test(t.split('Linear')[0]); })()`)));

    // search
    await app.ev(`(() => { const i = document.querySelector('input[type=search]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, 'notion'); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await sleep(250);
    const hits = await app.ev(`[...document.querySelectorAll('[data-hub] [role=tabpanel] span')].filter((e) => e.textContent.trim() === 'Notion').length`);
    check('discover', 'search narrows the cards', hits >= 1 && !/Slack/.test(await app.text()), `${hits} Notion card(s)`);
    await app.shot('04-discover-search-en');

    // the failure flow: GitHub's code sign-in with no client id, no network involved
    await app.ev(`(() => { const i = document.querySelector('input[type=search]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, 'github'); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await sleep(250);
    await app.click('[data-hub] [role=tabpanel] button', 'Connect');
    await sleep(500);
    await app.shot('05-github-panel-en');
    const panelText = await app.text();
    check('connect', 'GitHub offers the code sign-in and asks for the app\'s client ID, not a password', /client id/i.test(panelText) && /sign in with a code/i.test(panelText) && !/password/i.test(panelText.replace(/never see your password/i, '')));
    const disabled = await app.ev(`(() => { const b = [...document.querySelectorAll('[data-provider="github"] button')].find((x) => /^connect$/i.test(x.textContent.trim())); return !!b && b.disabled; })()`);
    check('connect', 'with the Client ID field empty the Connect button is disabled, so nothing can be started by accident', disabled === true);
    // type something that is not a client id; the button wakes up and the app refuses it in words
    await app.ev(`(() => { const i = document.querySelector('[data-provider="github"] input[placeholder*="client" i]') || [...document.querySelectorAll('[data-provider="github"] input')][1]; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, 'not a client id!'); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await sleep(300);
    await app.click('[data-provider="github"] button', 'Connect');
    await sleep(900);
    const failure = await app.text();
    check('connect', 'a sign-in that cannot start says why, in words', /does not look like a client id/i.test(failure), failure.replace(/\s+/g, ' ').match(/(that does not[^.]*\.)/i)?.[1] ?? '');
    check('connect', 'and starts nothing: no waiting message, nothing connected', !/waiting for you to approve/i.test(failure) && !/is connected and switched on/i.test(failure));
    await app.shot('06-connect-failure-en');
    // what each CLI can do: the labels are the evidence's, and the Gemini caveats are on the page, not hidden
    await app.ev(`document.getElementById('hub-tab-access').click()`); await sleep(400);
    const accessText = await app.text();
    check('access', 'the Agent access tab says, per CLI, how far it was checked and whether its shell can read its pass', /Codex CLI[^\n]*verified[^\n]*cannot read its pass/i.test(accessText) && /Gemini CLI[^\n]*verified[^\n]*can read its pass/i.test(accessText), accessText.split('\n').filter((l) => /Gemini CLI ·/.test(l)).join(' | ').slice(0, 200));
    check('access', 'and says that Gemini loads integrations only in folders the person has trusted in it', /Gemini CLI[^\n]*trusted in that CLI itself/i.test(accessText));
    check('access', 'and says that Codex\'s protection holds only while its own OS sandbox is on, and that Gemini\'s shell has no such protection', /Codex CLI[^\n]*cannot read its pass[^\n]*only while the CLI's own OS sandbox is on/i.test(accessText) && !/Gemini CLI[^\n]*only while the CLI's own OS sandbox/i.test(accessText));
    await app.shot('06b-access-en');
    await app.close();
  },

  async 'keyboard-and-accessibility'() {
    seedConfig();
    const app = await launch({ lang: 'en' });
    await openHub(app);
    const a = await app.ev(AUDIT);
    check('accessibility', 'every button, tab, field and link in the hub has a name', a.unnamed.length === 0, a.unnamed.slice(0, 3).join(' | '));
    check('accessibility', 'the tabs form a tablist, exactly one is selected, and the panel is labelled by its tab', a.tablist && a.tabs === 5 && a.selected === 1 && a.panelLabelled);
    check('accessibility', 'only the selected tab is in the tab order (roving focus)', a.rovers === 1);
    check('accessibility', 'the page does not scroll sideways', !a.overflowX && !a.hubOverflow);
    // keyboard: focus the selected tab, arrow right moves selection, End goes to the last, Home to the first
    await app.ev(`document.getElementById('hub-tab-discover').focus()`);
    await app.key('ArrowRight', 'ArrowRight'); await sleep(200);
    const afterRight = await app.ev(`document.querySelector('[role=tab][aria-selected=true]').id`);
    await app.key('End', 'End'); await sleep(200);
    const afterEnd = await app.ev(`document.querySelector('[role=tab][aria-selected=true]').id`);
    await app.key('Home', 'Home'); await sleep(200);
    const afterHome = await app.ev(`document.querySelector('[role=tab][aria-selected=true]').id`);
    check('accessibility', 'Right arrow, End and Home move between tabs from the keyboard', afterRight === 'hub-tab-connected' && afterEnd === 'hub-tab-activity' && afterHome === 'hub-tab-discover', `${afterRight} / ${afterEnd} / ${afterHome}`);
    check('accessibility', 'focus follows the selection', await app.ev(`document.activeElement && document.activeElement.id === 'hub-tab-discover'`));
    // a visible focus indicator on a tab
    const focusRing = await app.ev(`(() => { const s = getComputedStyle(document.activeElement); return { outline: s.outlineStyle + ' ' + s.outlineWidth, shadow: s.boxShadow }; })()`);
    info.focusRing = focusRing;
    const worst = a.lowest[0];
    info.lowestContrast = a.lowest;
    check('accessibility', 'text contrast measured (reported, not claimed): the lowest ratio in the hub', true, a.lowest.map((r) => `${r.ratio}:1 "${r.text}" ${r.size}px`).slice(0, 3).join(' · '));
    check('accessibility', 'dark theme (the default): every text in the hub reaches 4.5:1, the WCAG AA level for normal text', worst === undefined || worst.ratio >= 4.5, worst ? `${worst.ratio}:1 "${worst.text}"` : '');
    await app.close();
  },

  async 'rtl-arabic'() {
    seedConfig();
    const app = await launch({ lang: 'ar' });
    await openHub(app);
    const a = await app.ev(AUDIT);
    check('rtl', 'the document is right-to-left in Arabic', a.dir === 'rtl' && a.lang === 'ar', `${a.dir}/${a.lang}`);
    const geo = await app.ev(`(() => {
      const tabs = [...document.querySelectorAll('[data-hub] [role=tab]')].map((t) => t.getBoundingClientRect());
      const hub = document.querySelector('[data-hub]').getBoundingClientRect();
      const first = tabs[0], last = tabs[tabs.length - 1];
      const intro = [...document.querySelectorAll('[data-hub] span')].find((s) => s.textContent.includes('اربط'));
      const ir = intro ? intro.getBoundingClientRect() : null;
      return { firstLeft: first.left, lastLeft: last.left, hubLeft: hub.left, hubRight: hub.right, introRight: ir ? ir.right : null, introDir: intro ? getComputedStyle(intro).direction : null };
    })()`);
    check('rtl', 'the first tab sits on the right and the last on the left', geo.firstLeft > geo.lastLeft, `first.left ${Math.round(geo.firstLeft)} > last.left ${Math.round(geo.lastLeft)}`);
    check('rtl', 'running text is laid out right-to-left and flush to the right edge', geo.introDir === 'rtl' && geo.introRight !== null && Math.abs(geo.introRight - geo.hubRight) < 24, `intro right ${Math.round(geo.introRight)} vs hub right ${Math.round(geo.hubRight)}`);
    await app.shot('07-discover-ar');
    // the arrow keys follow the reading direction: Left goes forward in RTL
    await app.ev(`document.getElementById('hub-tab-discover').focus()`);
    await app.key('ArrowLeft', 'ArrowLeft'); await sleep(200);
    check('rtl', 'Left arrow moves forward in right-to-left', (await app.ev(`document.querySelector('[role=tab][aria-selected=true]').id`)) === 'hub-tab-connected');
    await app.ev(`document.getElementById('hub-tab-skills').click()`); await sleep(500);
    await app.shot('08-skills-ar');
    await app.ev(`document.getElementById('hub-tab-access').click()`); await sleep(400);
    await app.shot('09-access-ar');
    check('rtl', 'the Agent access tab carries the folder-trust note in Arabic', /المجلدات التي وثق/.test(await app.text()));
    const noLeftover = await app.ev(`(() => { const t = document.querySelector('[data-hub]').innerText; return !/hub\\.[a-z]/.test(t); })()`);
    check('rtl', 'no raw translation key is shown on any Arabic tab', noLeftover);
    const a2 = await app.ev(AUDIT);
    check('rtl', 'the Arabic tabs have no unnamed controls and no sideways scroll', a2.unnamed.length === 0 && !a2.overflowX, a2.unnamed.slice(0, 2).join(' | '));
    await app.close();
  },

  async 'chinese-and-narrow'() {
    seedConfig();
    const app = await launch({ lang: 'zh-CN', width: 760, height: 900 });
    await openHub(app);
    const t = await app.text();
    check('i18n', 'Simplified Chinese: the hub and its tabs are in Chinese', /集成与技能/.test(t) && /发现/.test(t) && /已连接/.test(t));
    check('i18n', 'no raw translation key is shown', !(await app.ev(`/hub\\.[a-z]+\\.[a-z]/.test(document.querySelector('[data-hub]').innerText)`)));
    await app.shot('10-discover-zh-narrow');
    const a = await app.ev(AUDIT);
    check('responsive', 'at 760 px wide the page does not scroll sideways', !a.overflowX && !a.hubOverflow);
    await app.size(560, 900);
    await sleep(300);
    const narrow = await app.ev(AUDIT);
    check('responsive', 'at 560 px wide the hub still does not scroll sideways', !narrow.hubOverflow);
    await app.shot('11-discover-zh-560');
    await app.close();
  },

  async 'light-theme'() {
    // the app opens dark; the other theme is a choice the user makes and the app remembers
    seedConfig();
    const app = await launch({ lang: 'en', theme: 'light' });
    await openHub(app);
    const light = await app.ev(`(() => { const bg = getComputedStyle(document.body).backgroundColor; const m = bg.match(/\\d+/g).map(Number); return (m[0] + m[1] + m[2]) / 3 > 150; })()`);
    check('theme', 'the app is in its light theme when the user chose it', light === true);
    const a = await app.ev(AUDIT);
    info.lowestContrastLight = a.lowest;
    check('theme', 'light theme: every text in the hub reaches 4.5:1, the WCAG AA level for normal text', a.lowest.length === 0 || a.lowest[0].ratio >= 4.5, a.lowest[0] ? `${a.lowest[0].ratio}:1 "${a.lowest[0].text}"` : '');
    check('theme', 'light theme: the hub has no unnamed controls', a.unnamed.length === 0);
    await app.shot('12-discover-light');
    await app.close();
  },

  async 'skills-and-restart'() {
    // seeded through the production installer with a fake GitHub, before the app starts
    seedConfig({ mcpDefaults: {} });
    const gh = fakeGitHub();
    const deps = { home: FAKE_HOME, recordDir: path.join(UD, 'skill-installs'), getText: gh.getText };
    const r1 = await installSkill(URL1, 'demo', deps);
    const r2 = await installSkill(URL1, 'demo', { ...deps, recordDir: path.join(UD, 'skill-installs', 'agents'), root: path.join(FAKE_HOME, '.agents', 'skills'), agents: ['codex', 'gemini'] });
    check('skills', 'two skills were installed for the app to find (one per target) by the production installer', r1.ok && r2.ok);
    const app = await launch({ lang: 'en', width: 1280, height: 1000 });
    await openHub(app, 'skills');
    await waitFor(() => app.ev(`/installed by this app: 1/i.test(document.body.innerText)`), 15_000, 'the managed list');
    const text = await app.text();
    check('skills', 'the Skills tab lists what this app installed, with where it came from and at which commit', /demo/i.test(text) && /github\.com\/o\/r/.test(text) && /at aaaaaaa/i.test(text) && /unchanged/i.test(text));
    check('skills', 'it says what the guard removed from the copy', /taken out of the copy/i.test(text));
    check('skills', 'it names the CLI that reads this folder and labels it honestly', /claude code/i.test(text) && /verified/i.test(text));
    await app.shot('13-skills-claude');
    // the other target
    await app.click('[data-hub] [role=tabpanel] button', 'Codex CLI and Gemini CLI'); await sleep(500);
    const agentsText = await app.text();
    // Both CLIs of this folder have a recorded real run, so each says "verified" and the "not run" note is absent. (The labels
    // come from src/shared/agentCompat.ts, which the test suite ties to the evidence files.)
    check('skills', 'the shared-folder target lists its own skill, names the agents it serves, and labels each as the evidence allows', /installed by this app: 1/i.test(agentsText) && /codex cli/i.test(agentsText) && /gemini cli/i.test(agentsText) && !/wired, not run/i.test(agentsText) && !/has not run at least one of these CLIs/i.test(agentsText) && (agentsText.match(/verified/gi) ?? []).length >= 2);
    await app.shot('14-skills-agents');
    // integrity: change a file on disk, then press Check
    fs.appendFileSync(path.join(FAKE_HOME, '.agents', 'skills', 'demo', 'SKILL.md'), '\nsomeone added this line\n');
    await app.click('[data-hub] [role=tabpanel] button', 'Check'); await sleep(700);
    const changed = await app.text();
    check('skills', 'Check notices a file changed since the install, and says so', /changed since install/i.test(changed) && /has changed since it was installed/i.test(changed));
    await app.shot('15-skills-changed');
    // the Claude target was not touched by that
    await app.click('[data-hub] [role=tabpanel] button', 'Claude Code'); await sleep(500);
    check('skills', 'the same skill for the other target still reads Unchanged', /unchanged/i.test(await app.text()) && !/changed since install/i.test(await app.text()));
    // remove: two clicks
    await app.click('[data-hub] [role=tabpanel] button', 'Remove'); await sleep(200);
    check('skills', 'Remove asks for a second click before anything is deleted', fs.existsSync(path.join(FAKE_HOME, '.claude', 'skills', 'demo', 'SKILL.md')) && /click again to remove/i.test(await app.text()));
    await app.click('[data-hub] [role=tabpanel] button', 'Click again'); await sleep(900);
    check('skills', 'after the second click the skill folder and its record are gone', !fs.existsSync(path.join(FAKE_HOME, '.claude', 'skills', 'demo')) && !fs.existsSync(path.join(UD, 'skill-installs', 'demo.json')));
    check('skills', 'and the other target\'s skill and record are untouched', fs.existsSync(path.join(FAKE_HOME, '.agents', 'skills', 'demo', 'SKILL.md')) && fs.existsSync(path.join(UD, 'skill-installs', 'agents', 'demo.json')));
    await app.shot('16-skills-removed');
    // the activity trail recorded it, as metadata
    await app.ev(`document.getElementById('hub-tab-activity').click()`); await sleep(600);
    const act = await app.text();
    check('activity', 'the Activity tab shows the skill actions, newest first', /skill/i.test(act) && /uninstall/i.test(act));
    await app.click('[data-hub] [role=tabpanel] button', 'Check the record'); await sleep(900);
    check('activity', 'the audit record verifies as intact', /the record is intact/i.test(await app.text()));
    await app.shot('17-activity');
    await app.close();

    // restart: the same profile again
    const again = await launch({ lang: 'en', width: 1280, height: 1000 });
    await openHub(again, 'skills');
    await app0(again);
    check('restart', 'after a restart the removal still holds: Claude Code\'s list is empty', /installed by this app: 0/i.test(await again.text()));
    await again.click('[data-hub] [role=tabpanel] button', 'Codex CLI and Gemini CLI'); await sleep(500);
    check('restart', 'and the shared-folder target still shows it, flagged as changed (the file is still different on disk)', /changed since install/i.test(await again.text()));
    await again.ev(`document.getElementById('hub-tab-activity').click()`); await sleep(500);
    await again.click('[data-hub] [role=tabpanel] button', 'Check the record'); await sleep(900);
    check('restart', 'the audit chain still verifies after the restart', /the record is intact/i.test(await again.text()));
    await again.close();
  },

  async 'consent-persists'() {
    // switching an integration on is the user's act; it must survive a restart, and "off" must stay off
    seedConfig({ mcpOptInV1: true, mcpDefaults: { time: { enabled: true } } });
    const app = await launch({ lang: 'en' });
    await openHub(app, 'connected');
    check('consent', 'an integration the user switched on is listed on Connected, as on', /time/i.test(await app.text()) && /\bon\b/i.test(await app.ev(`document.querySelector('[data-entry="time"]')?.innerText || ''`)));
    await app.shot('18-connected-time-on');
    await app.click('[data-entry="time"] button[aria-pressed]');
    await sleep(700);
    const off = readConfigFile();
    check('consent', 'turning it off is written to the profile at once', off.mcpDefaults?.time?.enabled === false, JSON.stringify(off.mcpDefaults));
    await app.close();
    const again = await launch({ lang: 'en' });
    await openHub(again, 'connected');
    check('consent', 'after a restart it is still off', /OFF/i.test(await again.ev(`document.querySelector('[data-entry="time"]')?.innerText || ''`)));
    await again.close();
  },

  async 'upgrade-from-older-profile'() {
    // an older profile: a config without the newer keys, and a v1 skill record with no agents field
    // an older profile in which the six local servers shipped switched ON (no opt-in marker yet)
    const old = { onboardingComplete: true, harnessHome: path.join(FAKE_HOME, 'Mosbius'), mcpDefaults: { time: { enabled: true }, fetch: { enabled: true }, github: { enabled: true } } };
    fs.writeFileSync(path.join(UD, 'config.json'), JSON.stringify(old));
    const gh = fakeGitHub();
    const deps = { home: FAKE_HOME, recordDir: path.join(UD, 'skill-installs'), getText: gh.getText };
    fs.rmSync(path.join(FAKE_HOME, '.claude', 'skills', 'demo'), { recursive: true, force: true });
    fs.rmSync(path.join(UD, 'skill-installs'), { recursive: true, force: true });
    await installSkill(URL1, 'demo', deps);
    const recFile = path.join(UD, 'skill-installs', 'demo.json');
    const rec = JSON.parse(fs.readFileSync(recFile, 'utf8'));
    delete rec.agents; delete rec.repo; delete rec.skillPath; rec.v = 1;           // what an older version wrote
    fs.writeFileSync(recFile, JSON.stringify(rec));
    const app = await launch({ lang: 'en', width: 1280, height: 1000 });
    await openHub(app, 'skills');
    await waitFor(() => app.ev(`/installed by this app: 1/i.test(document.body.innerText)`), 15_000, 'the managed list');
    const text = await app.text();
    check('upgrade', 'a skill recorded by an older version still lists, with its source, and defaults to Claude Code', /demo/i.test(text) && /github\.com\/o\/r/.test(text) && /claude code/i.test(text));
    const cfg = readConfigFile();
    check('upgrade', 'the older config was read without being rewritten into something else', cfg.onboardingComplete === true);
    check('upgrade', 'the servers that used to ship ON are switched OFF once (nothing is reachable by an agent unless chosen), and a switch the user made themselves is left alone',
      cfg.mcpDefaults?.time?.enabled === false && cfg.mcpDefaults?.fetch?.enabled === false && cfg.mcpDefaults?.github?.enabled === true && cfg.mcpOptInV1 === true, JSON.stringify(cfg.mcpDefaults));
    await app.shot('19-upgrade-skills');
    await app.close();
  }
};

// ── run ──────────────────────────────────────────────────────────────────────────────────────────
const info = {};
(async () => {
  console.log(`electron ${require('electron/package.json').version} · node ${process.version} · ${process.platform}/${process.arch}\n  (throwaway profile ${UD}; HOME ${FAKE_HOME})\n`);
  let crashed = false;
  for (const [name, fn] of Object.entries(scenarios)) {
    if (ONLY && !ONLY.has(name)) continue;
    console.log(`\n# ${name}`);
    try { await fn(); } catch (e) {
      crashed = true;
      check('harness', `${name} ran to the end`, false, e instanceof Error ? e.message : String(e));
      // what was on screen when it stopped, so a failure can be read without re-running
      if (current) {
        try {
          await current.shot(`failure-${name}`, 'where the harness stopped');
          console.log('    on screen:', (await current.text()).replace(/\s+/g, ' ').slice(0, 220));
          console.log('    controls:', JSON.stringify(await current.ev(`[...document.querySelectorAll('button,[role=tab]')].slice(0, 24).map((b) => (b.getAttribute('aria-label') || b.textContent || '').trim().slice(0, 24))`)));
        } catch { /* the page is gone */ }
        console.log('    app log tail:', current.log().split('\n').slice(-12).join(' | ').slice(-900));
        console.log('    devtools events seen:', [...new Set(current.events.map((e) => e.method))].slice(0, 12).join(', '));
      }
    }
    if (current) { try { await current.close(); } catch { /* gone */ } current = null; }
    // each scenario starts from an empty profile, except the ones that deliberately restart inside themselves
    for (const f of fs.readdirSync(UD)) { try { fs.rmSync(path.join(UD, f), { recursive: true, force: true }); } catch { /* best effort */ } }
    for (const f of fs.readdirSync(FAKE_HOME)) { try { fs.rmSync(path.join(FAKE_HOME, f), { recursive: true, force: true }); } catch { /* best effort */ } }
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed; ${shots.length} screenshots in ${path.relative(ROOT, OUT)}`);
  const report = {
    tool: 'tools/ui-validate.cjs', date: new Date().toISOString(), target: PACKAGED ? `packaged app: ${path.basename(path.dirname(path.dirname(path.dirname(PACKAGED))))}` : 'development build (out/)', electron: require('electron/package.json').version, platform: `${process.platform}/${process.arch}`, node: process.version,
    not_done: ['no sign-in at any provider and no registration (needs the owner)', 'no install from the network (skills were seeded through the production installer with a fake GitHub)', 'macOS only: Windows and Linux were not run'],
    info, screenshots: shots, results
  };
  fs.writeFileSync(path.join(OUT, 'ui-validation.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(OUT, 'ui-validation.txt'), `${results.map((r) => `${r.ok ? 'PASS' : 'FAIL'}  [${r.group}] ${r.name}${r.detail ? `  — ${r.detail}` : ''}`).join('\n')}\n\n${results.length - failed.length}/${results.length} checks passed\n`);
  if (!KEEP) { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } }
  process.exit(failed.length || crashed ? 1 : 0);
})().catch((e) => { console.error(e); try { current?.child.kill('SIGKILL'); } catch { /* gone */ } process.exit(1); });

/** After a restart, wait until the managed list has rendered at least once. */
async function app0(app) { await waitFor(() => app.ev(`/installed by this app/i.test(document.body.innerText)`), 15_000, 'the managed list'); }
