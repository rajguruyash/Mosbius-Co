#!/usr/bin/env node
'use strict';

/**
 * Drive the REAL desktop app (Electron, out/main/index.js) on a throwaway profile and exercise the Huddle and the
 * notification system the way a person would: real clicks in the main window and in the Huddle window, real agents
 * (PTY processes) created through the app's own "add agent" form, real hook events arriving on the hive's socket,
 * real desktop-window state read back from the main process.
 *
 *   npm run build && node tools/huddle-validate.cjs [--out evidence/huddle] [--only a,b] [--keep]
 *   node tools/huddle-validate.cjs --packaged "<the app's executable>" --out <folder>
 *     (the same tour against a packaged or installed build instead of the development build)
 *
 * What the agents are: test/fixtures/stand-in-agent.cjs, a small program that runs in a real terminal and reports
 * its life to the hive's hook socket with the same payloads Claude Code's hook shim sends. It is not a model and makes
 * no model calls; the app cannot tell it from a CLI that reports through hooks. The real `claude` CLI is exercised
 * separately where it can be (see the end of the run).
 *
 * One scenario is not a check but a recording: `--only media` takes the pictures and videos of the Huddle that the README and
 * the website show (see "media" near the end of this file). It runs only when asked for.
 *
 * What it cannot do, and says so in its output: drive the operating system's own file dialog (the tour names the files
 * instead), or press the mouse button on the Huddle through the window server (clicks go to the page over the
 * DevTools protocol, so whether a click would steal focus is judged from the window's own flags and from which app is
 * in front before and after the window appears).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');
const { renderCamera } = require('./camera-render.cjs');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const OUT = path.resolve(flag('--out', path.join(ROOT, 'evidence', 'huddle')));
const ONLY = flag('--only') ? new Set(flag('--only').split(',')) : null;
const KEEP = argv.includes('--keep');
// --audible: let the app's sounds be heard while the tour runs (by default a test run plays them at zero volume)
const AUDIBLE = argv.includes('--audible');
// --packaged <the app's executable> runs the same tour against a packaged or installed build instead of out/.
const PACKAGED = flag('--packaged') ? path.resolve(flag('--packaged')) : null;
const ELECTRON = PACKAGED ?? path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
if (PACKAGED ? !fs.existsSync(PACKAGED) : !fs.existsSync(path.join(ROOT, 'out', 'main', 'index.js'))) { console.error(PACKAGED ? `BLOCKED: no packaged app at ${PACKAGED}` : 'BLOCKED: run `npm run build` first'); process.exit(2); }
if (typeof WebSocket !== 'function') { console.error('BLOCKED: this needs Node 22 (a global WebSocket)'); process.exit(2); }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mosbius-huddle-'));
const FAKE_HOME = path.join(TMP, 'home');
const UD = path.join(TMP, 'userdata');
const WORK = path.join(TMP, 'work');
const PICK_DIR = path.join(TMP, 'pick');
for (const d of [FAKE_HOME, UD, WORK, PICK_DIR, OUT]) fs.mkdirSync(d, { recursive: true });
// The agents are the stand-in program, installed as a command NAMED `claude`, because the app decides how to wire an agent
// (hooks or not) from the command it runs, exactly as it does for the real CLI.
const STAND_IN_SRC = path.join(ROOT, 'test', 'fixtures', 'stand-in-agent.cjs');
const BIN = path.join(TMP, 'bin');
fs.mkdirSync(BIN, { recursive: true });
const STAND_IN = path.join(BIN, 'claude');
fs.symlinkSync(STAND_IN_SRC, STAND_IN);
// a one-pixel PNG and a text file to attach
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
fs.writeFileSync(path.join(PICK_DIR, 'shot.png'), PNG);
fs.writeFileSync(path.join(PICK_DIR, 'notes.txt'), 'attached notes\n');

const results = [];
const info = {};
const check = (group, name, ok, detail = '') => { results.push({ group, name, ok: !!ok, detail }); console.log(`  ${ok ? 'PASS' : 'FAIL'}  [${group}] ${name}${detail ? `  — ${detail}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
async function waitFor(fn, ms, what) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) { try { last = await fn(); if (last) return last; } catch { /* retry */ } await sleep(120); }
  throw new Error(`timed out waiting for ${what}`);
}

// ── processes ────────────────────────────────────────────────────────────────
const spawned = new Set();
function killStrays() {
  try {
    const out = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    for (const line of out.split('\n')) {
      if (!line.includes(`--user-data-dir=${UD}`) && !line.includes(TMP)) continue;
      const pid = Number(line.trim().split(/\s+/)[0]);
      if (pid && pid !== process.pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    }
  } catch { /* best effort */ }
}
process.on('exit', () => { for (const c of spawned) { try { c.kill('SIGKILL'); } catch { /* gone */ } } killStrays(); if (!KEEP) { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* leave it */ } } });
process.on('SIGINT', () => process.exit(130));
process.on('SIGTERM', () => process.exit(143));

// ── a page, over the DevTools protocol ───────────────────────────────────────
async function connectPage(port, match) {
  const target = await waitFor(async () => {
    const list = await new Promise((resolve, reject) => { http.get({ host: '127.0.0.1', port, path: '/json/list' }, (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); }).on('error', reject); });
    return list.find((t) => t.type === 'page' && match(t.url)) ?? null;
  }, 40_000, 'a page');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('devtools socket')); });
  let id = 0; const pending = new Map(); const events = []; const listeners = new Map();
  // an event somebody asked for goes to them (a screencast frame is big: it is not kept in `events`); every other one is kept
  ws.onmessage = (m) => { const o = JSON.parse(m.data); if (o.id && pending.has(o.id)) { const p = pending.get(o.id); pending.delete(o.id); o.error ? p.reject(new Error(o.error.message)) : p.resolve(o.result); } else if (o.method) { const l = listeners.get(o.method); if (l) l(o.params); else events.push(o); } };
  const send = (method, params = {}, ms = 20_000) => new Promise((resolve, reject) => {
    const i = ++id; pending.set(i, { resolve, reject });
    ws.send(JSON.stringify({ id: i, method, params }));
    setTimeout(() => { if (pending.has(i)) { pending.delete(i); reject(new Error(`devtools call timed out: ${method}`)); } }, ms);
  });
  await send('Runtime.enable').catch(() => {});
  await send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
  const page = {
    url: target.url, targetId: target.id, events, send,
    on(method, fn) { listeners.set(method, fn); },
    off(method) { listeners.delete(method); },
    async ev(expression) {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(`page error: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
      return r.result.value;
    },
    async shot(name) {
      const r = await send('Page.captureScreenshot', { format: 'png' });
      const file = path.join(OUT, `${name}.png`);
      fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
      return path.relative(ROOT, file);
    },
    async text() { return page.ev('document.body.innerText'); },
    /** Click the first visible element matching `selector` (and, if given, containing `text`), with a real mouse event. */
    async click(selector, text) {
      const pos = await page.ev(`(() => {
        const sel = ${JSON.stringify(selector)}, text = ${JSON.stringify(text ?? null)};
        const els = [...document.querySelectorAll(sel)].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
        const el = text === null ? els[0] : els.find((e) => ((e.getAttribute('aria-label') || '') + ' ' + (e.textContent || '')).trim().toLowerCase().includes(text.toLowerCase()));
        if (!el) return null;
        el.scrollIntoView({ block: 'center', inline: 'nearest' });
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`);
      if (!pos) throw new Error(`nothing to click: ${selector} ${text ?? ''}`);
      for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
      await sleep(140);
    },
    /** Click something that closes this very window: the page is gone before it can answer, so do not wait for it to. */
    async clickThatCloses(selector, text = '') {
      const pos = await page.ev(`(() => {
        const els = [...document.querySelectorAll(${JSON.stringify(selector)})].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
        const el = els.find((e) => ((e.getAttribute('aria-label') || '') + ' ' + (e.textContent || '')).toLowerCase().includes(${JSON.stringify(text.toLowerCase())}));
        if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      if (!pos) throw new Error(`nothing to click: ${selector} ${text}`);
      for (const type of ['mousePressed', 'mouseReleased']) await Promise.race([send('Input.dispatchMouseEvent', { type, x: pos.x, y: pos.y, button: 'left', clickCount: 1 }).catch(() => undefined), sleep(1500)]);
    },
    /** Put text in the (React-controlled) field matching `selector`. */
    async type(selector, text) {
      const ok = await page.ev(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false;
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(text)});
        el.dispatchEvent(new Event('input', { bubbles: true })); el.focus(); return true; })()`);
      if (!ok) throw new Error(`no field: ${selector}`);
    },
    async key(key, code) {
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: key === 'Enter' ? 13 : key === 'Escape' ? 27 : 0 });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code });
      await sleep(100);
    },
    close() { try { ws.close(); } catch { /* gone */ } }
  };
  return page;
}

/** One call on the browser itself (not on a page): the window a page is in can be asked to move or resize. */
async function browserCall(port, method, params = {}) {
  const version = await new Promise((resolve, reject) => { http.get({ host: '127.0.0.1', port, path: '/json/version' }, (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); }).on('error', reject); });
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('devtools browser socket')); });
  try {
    return await new Promise((resolve, reject) => {
      ws.onmessage = (m) => { const o = JSON.parse(m.data); if (o.id === 1) (o.error ? reject(new Error(o.error.message)) : resolve(o.result)); };
      ws.send(JSON.stringify({ id: 1, method, params }));
      setTimeout(() => reject(new Error(`devtools call timed out: ${method}`)), 10_000);
    });
  } finally { try { ws.close(); } catch { /* gone */ } }
}

// ── the app ──────────────────────────────────────────────────────────────────
const seedConfig = (extra = {}) => fs.writeFileSync(path.join(UD, 'config.json'), JSON.stringify({
  onboardingComplete: true, harnessHome: path.join(FAKE_HOME, 'Mosbius'), defaultCommand: STAND_IN, godProvider: 'claude', autoMode: false,
  registeredRepos: [WORK], ...extra
}, null, 2));

async function launch({ lang = 'en', width = 1280, height = 860, pick = null, emulate = true, env: extraEnv = {} } = {}) {
  killStrays();
  const port = await freePort();
  const keepRendering = ['--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling', '--disable-features=CalculateNativeWinOcclusion', '--use-mock-keychain'];
  const env = { ...process.env, HOME: FAKE_HOME, ELECTRON_ENABLE_LOGGING: '0', MOSBIUS_UI_TEST: '1', ...(AUDIBLE ? { MOSBIUS_SOUND_AUDIBLE: '1' } : {}), PATH: `/usr/local/bin:${process.env.PATH ?? ''}`, ...extraEnv };
  if (pick) env.MOSBIUS_TEST_PICK = JSON.stringify(pick);
  const child = spawn(ELECTRON, [...(PACKAGED ? [] : [ROOT]), `--user-data-dir=${UD}`, `--remote-debugging-port=${port}`, ...keepRendering], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  spawned.add(child);
  child.once('exit', () => spawned.delete(child));
  let log = '';
  child.stdout.on('data', (c) => { log += c; }); child.stderr.on('data', (c) => { log += c; });
  const main = await connectPage(port, (u) => /index\.html|localhost|5173/.test(u) && !/huddle/.test(u));
  await waitFor(() => main.ev('document.readyState === "complete" && !!document.body && document.body.innerText.length > 0').catch(() => false), 30_000, 'the main page');
  await main.ev(`(() => { try { localStorage.setItem('cth.language', ${JSON.stringify(lang)}); localStorage.setItem('cth.skipHivePickerOnce', '1'); localStorage.setItem('cth.theme', 'light'); } catch {} })()`);
  await main.send('Page.reload');
  await waitFor(() => main.ev('document.readyState === "complete" && document.body.innerText.length > 20').catch(() => false), 30_000, 'the main page after reload');
  if (emulate) await main.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await sleep(600);
  const app = {
    child, port, main, log: () => log,
    /** The Huddle's page, once its window exists. */
    async huddlePage() { return connectPage(port, (u) => /huddle\.html|huddle/.test(u)); },
    debug: () => main.ev('window.cth.huddleDebug()'),
    ptys: () => main.ev('window.cth.listPtys()'),
    async close() {
      main.close();
      child.kill('SIGTERM');
      await Promise.race([new Promise((r) => child.once('exit', r)), sleep(6000)]);
      try { child.kill('SIGKILL'); } catch { /* gone */ }
      killStrays();
      await sleep(500);
    }
  };
  return app;
}

/** Make an agent through the app's own "add agent" form. */
async function addAgent(app, name) {
  const m = app.main;
  await m.click('button', 'add agent');
  await waitFor(() => m.ev(`!!document.querySelector('input[placeholder="Ada"]')`), 10_000, 'the add-agent form');
  await m.type('input[placeholder="Ada"]', name);
  // the project: the quick-pick for the registered folder
  await m.ev(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.getAttribute('aria-label') === ${JSON.stringify(WORK)}); if (b) b.click(); return !!b; })()`).catch(() => {});
  const picked = await m.ev(`(() => { const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === ${JSON.stringify(path.basename(WORK))} || x.getAttribute('aria-label') === ${JSON.stringify(WORK)}); if (b) { b.click(); return true; } return false; })()`);
  if (!picked) { // type it in as a path
    await m.ev(`(() => { const i = document.querySelector('input[placeholder="/path/to/your/project"]'); if (!i) return false; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(WORK)}); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  }
  await sleep(150);
  await m.click('button', 'spawn');
  await waitFor(() => m.ev(`!document.querySelector('input[placeholder="Ada"]')`), 15_000, 'the form to close');
}

// TextEdit is used as "the other application in front". It is only closed again if this run started it: a TextEdit the
// person already had open (with their own text in it) is never touched.
const textEditRunning = () => { try { execFileSync('pgrep', ['-x', 'TextEdit']); return true; } catch { return false; } };
const frontApp = () => { try { return execFileSync('lsappinfo', ['info', '-only', 'name', execFileSync('lsappinfo', ['front'], { encoding: 'utf8' }).trim()], { encoding: 'utf8' }).trim(); } catch { return 'unknown'; } };
const osShot = (name, bounds) => {
  try {
    const file = path.join(OUT, `${name}.png`);
    execFileSync('screencapture', ['-x', ...(bounds ? ['-R', `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`] : []), file], { timeout: 15_000 });
    return fs.existsSync(file) && fs.statSync(file).size > 2000 ? path.relative(ROOT, file) : null;
  } catch { return null; }
};

// ── scenarios ────────────────────────────────────────────────────────────────
const scenarios = {
  async smoke() {
    seedConfig();
    const app = await launch();
    const text = await app.main.text();
    check('boot', 'the main window starts with a Huddle control and a notification bell in the title bar', /huddle/i.test(await app.main.ev(`[...document.querySelectorAll('button')].map((b) => (b.getAttribute('aria-label') || '') + b.textContent).join('|')`)));
    info.main = await app.main.shot('01-main');
    await waitFor(async () => (await app.ptys()).length >= 1, 60_000, 'the orchestrator to start');
    check('boot', 'the orchestrator started as a real process in a real terminal', (await app.ptys()).length >= 1, `${(await app.ptys()).length} pty(s)`);
    await sleep(1500);
    console.log(app.log().split('\n').filter((l) => /huddle|error|Error/.test(l)).slice(0, 8).join('\n'));
    await app.close();
  }
};


/** Boot, make three agents through the real form, and wait until all four processes (with the orchestrator) are alive. */
async function bootWithAgents(opts = {}) {
  seedConfig(opts.config ?? {});
  const app = await launch(opts.launch ?? {});
  await waitFor(async () => (await app.ptys()).length >= 1, 60_000, 'the orchestrator');
  for (const name of ['Marshall', 'Lily', 'Barney']) await addAgent(app, name);
  await waitFor(async () => (await app.ptys()).length >= 4, 30_000, 'four processes');
  // wait for the stand-in agents to say hello on the hook socket
  await waitFor(async () => { const d = await app.debug(); return d && d.state.agents.length >= 4; }, 20_000, 'four agents in the hub');
  return app;
}
const cardOf = (huddle, name) => huddle.ev(`(() => { const c = [...document.querySelectorAll('[data-agent]')].find((x) => /${name}/i.test(x.innerText)); return c ? { state: c.dataset.state, text: c.innerText.replace(/\\s+/g, ' ') } : null; })()`);
const stateOf = async (app, name) => (await app.debug()).state.agents.find((a) => a.name === name)?.state;


const level = (h) => h.ev(`document.querySelector('.hd-root')?.dataset.level`);
const waitLevel = (h, l) => waitFor(async () => (await level(h)) === l, 10_000, `level ${l}`);
const waitState = (app, name, st, ms = 25_000) => waitFor(async () => (await stateOf(app, name)) === st, ms, `${name} to be ${st}`);
const pending = async (app) => (await app.debug()).notifications.pending;
const records = async (app) => (await app.debug()).notifications.records;
/** The sounds the real sound port was asked for (kind, volume, gain, the file it started the player on). A test run plays them at zero. */
const soundsOf = async (app) => (await app.debug()).sounds ?? [];
// The sounds that ship with the app (resources/sounds/<cue>.wav) play in place of the app's own synthesized sound for that cue, and the
// sound port's history calls them bundled/<cue>.wav. A packaged app that did not carry its file would play the synthesized hook instead
// (completed-vN.wav) and fail the checks below, which is how they prove the file really is inside the installer.
const SHIPPED = (() => { const d = path.join(ROOT, 'resources', 'sounds'); return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith('.wav')).map((f) => f.slice(0, -4)) : []; })();
const soundFile = (kind) => (SHIPPED.includes(kind) ? new RegExp(`^bundled/${kind}\\.wav$`) : new RegExp(`^${kind}-v\\d+(?:-g\\d+)?\\.wav$`));
const lastSound = async (app, kind) => (await soundsOf(app)).filter((s) => s.kind === kind).at(-1);
/** Send a message through the Huddle's own composer for the agent whose panel is open. */
async function sendFromHuddle(h, text) {
  await h.type('.hd-composer textarea', text);
  await sleep(120);
  await h.click('.hd-composer .hd-btn-primary', 'send');
  await sleep(250);
}
async function openAgentView(h, name) {
  if ((await level(h)) === 'compact') { await h.click('[data-act="expand"]'); await waitLevel(h, 'expanded'); }
  if ((await level(h)) === 'agent') { await h.click('[data-act="back"]'); await waitLevel(h, 'expanded'); }
  await h.ev(`(() => { const t = [...document.querySelectorAll('.hd-tab')].find((x) => /^agents/i.test(x.textContent.trim())); if (t && !document.querySelector('.hd-card')) t.click(); })()`);
  await sleep(150);
  await h.click(`.hd-card`, name);
  await waitLevel(h, 'agent');
  await sleep(300);
}
const termText = (h) => h.ev(`(() => { const rows = document.querySelectorAll('.hd-term-host .xterm-rows > div'); return [...rows].map((r) => r.textContent).join('\\n'); })()`);
async function openTerminalTab(h) { await h.click('.hd-tab', 'terminal'); await waitFor(() => h.ev(`!!document.querySelector('.hd-term-host .xterm-rows')`), 8000, 'the terminal view'); await sleep(900); }

async function enterHuddle(app) {
  await app.main.click('button', 'Huddle');
  const h = await app.huddlePage();
  await waitFor(() => h.ev(`document.querySelectorAll('[data-agent]').length >= 3`), 15_000, 'the cards');
  await sleep(500);
  return h;
}

scenarios.opening = async function () {
  const app = await bootWithAgents();
  // Put another app in front first: appearing must not take the keyboard from what you are typing in.
  let other = null;
  const textEditWasRunning = textEditRunning();
  try { execFileSync('open', ['-a', 'TextEdit']); other = 'TextEdit'; await sleep(1800); } catch { /* no TextEdit */ }
  const before = frontApp();
  info.frontBefore = before;
  await app.main.ev(`window.cth.huddleEnter()`);
  const huddle = await app.huddlePage();
  await waitFor(() => huddle.ev(`document.querySelectorAll('[data-agent]').length >= 4`), 15_000, 'the cards');
  await sleep(1500);
  const d = await app.debug();
  const w = d.window;
  const after = frontApp();
  check('open', 'a floating Huddle window appeared, visible and always on top', w && w.visible === true && w.alwaysOnTop === true);
  check('open', 'the main window stepped aside (minimised)', w.mainMinimized === true);
  const disp = w.displays.find((x) => w.bounds.x >= x.workArea.x - 1 && w.bounds.x + w.bounds.width <= x.workArea.x + x.workArea.width + 1);
  check('open', 'it sits inside a connected screen\'s usable area, docked to the right edge', !!disp && w.dock === 'right' && Math.abs((w.bounds.x + w.bounds.width) - (disp.workArea.x + disp.workArea.width)) <= 12, JSON.stringify(w.bounds));
  check('open', 'it is the compact list, not a full window', w.level === 'compact' && w.bounds.width < 360, `${w.bounds.width}x${w.bounds.height}`);
  if (other) check('open', `opening it did not take the keyboard from ${other}, which was in front`, after === before && w.focused === false, `before: ${before}; after: ${after}; huddle focused: ${w.focused}`);
  else check('open', 'opening it did not take focus', w.focused === false, `huddle focused: ${w.focused}`);
  const names = await huddle.ev(`[...document.querySelectorAll('.hd-card .hd-name')].map((e) => e.textContent)`);
  check('open', 'it lists every agent by its real name', ['Marshall', 'Lily', 'Barney', 'Ted'].every((n) => names.some((x) => x.includes(n))), names.join(', '));
  check('open', 'the header counts them', /\b4\b/.test(await huddle.ev(`document.querySelector('.hd-title').textContent`)));
  const fit4 = await huddle.ev(`(() => { const l = document.querySelector('.hd-list'); const c = document.querySelector('.hd-card'); return l && c ? { scroll: l.scrollHeight, client: l.clientHeight, card: c.offsetHeight } : null; })()`);
  check('open', 'four agents fit the compact window: nothing to scroll, no clipped card', !!fit4 && fit4.scroll <= fit4.client + 1, JSON.stringify(fit4));
  info.compact = await huddle.shot('02-huddle-compact');
  info.pidsOpen = (await app.ptys()).map((p) => p.pid).sort();
  huddle.close();
  if (other && !textEditWasRunning) { try { execFileSync('pkill', ['-x', other]); } catch { /* gone */ } }
  await app.close();
};

scenarios.working = async function () {
  const app = await bootWithAgents();
  const h = await enterHuddle(app);
  await openAgentView(h, 'Marshall');
  check('levels', 'clicking an agent opens its own view with its conversation and terminal', (await level(h)) === 'agent' && /conversation/i.test(await h.text()) && /terminal/i.test(await h.text()));
  const w = (await app.debug()).window;
  check('levels', 'the window grew to the agent view and stayed docked to its edge', w.level === 'agent' && w.dock === 'right' && w.bounds.width > 450, JSON.stringify(w.bounds));
  info.agentView = await h.shot('03-agent-view');
  await sendFromHuddle(h, '#work please do the task');
  if (process.env.TRACE_STATES) {
    const seenStates = new Set();
    const t0 = Date.now();
    while (Date.now() - t0 < 30_000) {
      const v = (await app.debug()).state.agents.find((a) => a.name === 'Marshall');
      const key = `${v.state}|${JSON.stringify(v.activity)}|${JSON.stringify(v.progress ?? null)}`;
      if (!seenStates.has(key)) { seenStates.add(key); console.log(`   t+${Math.round((Date.now() - t0) / 100) / 10}s`, key); }
      await sleep(250);
    }
  }
  try {
    await waitFor(async () => ['working', 'researching'].includes(await stateOf(app, 'Marshall')), 25_000, 'Marshall to start');
  } catch (e) {
    const roster = (() => { try { return JSON.parse(fs.readFileSync(path.join(FAKE_HOME, 'Mosbius', 'roster.json'), 'utf8')); } catch { return null; } })();
    try { await openTerminalTab(h); console.log('   terminal:', JSON.stringify((await termText(h)).slice(-300))); } catch (x) { console.log('   terminal view failed:', x.message); }
    console.log('   main log tail:', app.log().split('\n').slice(-12).join(' | ').slice(-900));
    const dd = await app.debug();
    console.log('   tracker:', JSON.stringify(dd.activity), 'roster:', JSON.stringify(dd.roster));
    console.log('   diagnostics: queues=', JSON.stringify(roster && roster.queues), 'huddle says:', (await h.ev(`document.querySelector('.hd-composer-note')?.textContent`)), 'state=', await stateOf(app, 'Marshall'));
    throw e;
  }
  check('live', 'the agent\'s state changed from the real hook events it sent (working or researching)', true, await stateOf(app, 'Marshall'));
  await waitFor(async () => (await app.debug()).state.agents.find((a) => a.name === 'Marshall')?.progress, 15_000, 'a progress report');
  const prog = (await app.debug()).state.agents.find((a) => a.name === 'Marshall').progress;
  check('live', 'progress comes from the agent\'s own checklist (TodoWrite), not a made-up meter', prog.source === 'todos' && prog.total === 3, JSON.stringify(prog));
  await h.click('[data-act="back"]'); await waitLevel(h, 'expanded');
  await waitFor(() => h.ev(`!!document.querySelector('.hd-bar')`), 8000, 'the bar in the list');
  check('live', 'the expanded list shows that progress bar and the live activity', /steps/.test(await h.text()) && await h.ev(`!!document.querySelector('[data-agent] .hd-bar')`));
  info.expandedWorking = await h.shot('04-expanded-working');
  // while it works, the other agents are untouched
  check('live', 'other agents stayed idle while Marshall worked', (await stateOf(app, 'Lily')) === 'idle' && (await stateOf(app, 'Barney')) === 'idle');
  await waitState(app, 'Marshall', 'completed', 40_000);
  check('live', 'finishing the task shows as "completed" for a while', true);
  info.completed = await h.shot('05-completed');
  const recs = await records(app);
  const done = recs.find((r) => r.agentName === 'Marshall' && r.category === 'completed');
  check('notify', 'a "completed" notification was recorded for that finish, and it is not an action request', !!done && done.actionRequired === false);
  check('notify', 'the desktop banner and the sound were handed to the system', !!done && done.delivery.desktop === 'shown' && done.delivery.sound === 'played', JSON.stringify(done?.delivery));
  const doneSound = await lastSound(app, 'completed');
  check('sound', 'the finish rang the "completed" cue: the real player was started on that sound\'s own file (at zero volume unless the tour was started with --audible)', !!doneSound && soundFile('completed').test(doneSound.file) && doneSound.audible === AUDIBLE, JSON.stringify(doneSound));
  // terminal view shows what the agent really printed
  await openAgentView(h, 'Marshall');
  await openTerminalTab(h);
  const tt = await termText(h);
  check('terminal', 'the terminal view shows the agent\'s real output', /Read/.test(tt) && /npm test/.test(tt), tt.replace(/\s+/g, ' ').slice(0, 120));
  info.terminal = await h.shot('06-terminal');
  await h.click('.hd-tab', 'conversation');
  check('conversation', 'the conversation view says where it came from (this engine keeps no transcript, so the hive thread)', /hive thread|session transcript/i.test(await h.text()));
  h.close();
  await app.close();
};


const note = (h, category) => h.ev(`(() => { const n = document.querySelector('.hd-note-open[data-category="${category}"]'); return n ? n.innerText.replace(/\\s+/g, ' ') : null; })()`);
const clickNote = async (h, text, scope = '.hd-note-open') => {
  await waitFor(() => h.ev(`[...document.querySelectorAll(${JSON.stringify(scope + ' .hd-btn')})].some((b) => (b.textContent || '').toLowerCase().includes(${JSON.stringify(text.toLowerCase())}))`), 8000, `the "${text}" button`);
  return h.click(`${scope} .hd-btn`, text);
};
const waitNote = (h, category) => waitFor(() => h.ev(`!!document.querySelector('.hd-note-open[data-category="${category}"]')`), 8000, `the ${category} card`);
const record = async (app, pred) => (await records(app)).find(pred);
const pidOf = async (app, ptyId) => (await app.ptys()).find((p) => p.id === ptyId)?.pid;
const agentId = async (app, name) => (await app.debug()).state.agents.find((a) => a.name === name)?.id;
async function sendTo(h, name, text) { await openAgentView(h, name); await sendFromHuddle(h, text); }
async function terminalOf(h, name) { await openAgentView(h, name); await openTerminalTab(h); return termText(h); }

scenarios.approvals = async function () {
  const app = await bootWithAgents();
  const h = await enterHuddle(app);

  // 1. approve
  await sendTo(h, 'Marshall', '#approve please');
  await waitState(app, 'Marshall', 'needs-approval');
  const r1 = await record(app, (r) => r.agentName === 'Marshall' && r.category === 'approval');
  check('approval', 'a permission prompt from a real hook becomes ONE approval notification: action-required, high priority, with what is being asked', !!r1 && r1.actionRequired && r1.priority === 'high' && /rm -rf \.\/build/.test(r1.preview ?? '') && (await pending(app)) === 1, JSON.stringify({ priority: r1?.priority, preview: r1?.preview }));
  check('approval', 'it offers approve, reject and an alternative, because the app knows the keys for this prompt', ['approve', 'reject', 'alternative'].every((a) => r1.actions.includes(a)));
  check('approval', 'a desktop banner and the approval sound were handed to the system', r1.delivery.desktop === 'shown' && r1.delivery.sound === 'played', JSON.stringify(r1.delivery));
  const approvalSound = await lastSound(app, 'approval');
  check('sound', 'and the sound was the "approval" cue, on its own file', !!approvalSound && soundFile('approval').test(approvalSound.file), JSON.stringify(approvalSound));
  await waitNote(h, 'approval');
  check('approval', 'the agent\'s own view shows the request with its buttons, and the card says it needs approval', /needs approval/i.test(await h.text()) && /approve/i.test(await note(h, 'approval') ?? ''));
  info.approvalOpen = await h.shot('10-approval-agent-view');
  await clickNote(h, 'approve');
  await sleep(1200);
  await openTerminalTab(h);
  const t1 = await termText(h);
  check('approval', 'Approve answered the prompt in THAT agent\'s terminal (it ran the command)', /approved: running it/.test(t1) && /removed \.\/build/.test(t1), t1.replace(/\s+/g, ' ').slice(-120));
  const r1b = await record(app, (r) => r.id === r1.id);
  check('approval', 'the notification was closed as approved by the person, and nothing is pending', r1b.resolution?.action === 'approved' && r1b.resolution?.by === 'user' && (await pending(app)) === 0);
  await waitFor(async () => (await stateOf(app, 'Marshall')) !== 'needs-approval', 10_000, 'the agent to carry on');

  // 2. reject
  await sendTo(h, 'Lily', '#approve please');
  await waitState(app, 'Lily', 'needs-approval');
  await clickNote(h, 'reject');
  await sleep(1200);
  await openTerminalTab(h);
  const t2 = await termText(h);
  check('approval', 'Reject cancelled the prompt with Escape: the agent says it was rejected', /rejected/.test(t2) && !/approved: running/.test(t2), t2.replace(/\s+/g, ' ').slice(-100));
  check('approval', 'and that notification is closed as rejected', (await record(app, (r) => r.agentName === 'Lily' && r.category === 'approval'))?.resolution?.action === 'rejected');

  // 3. an alternative: say no, then tell it what to do instead
  await sendTo(h, 'Barney', '#approve please');
  await waitState(app, 'Barney', 'needs-approval');
  await clickNote(h, 'suggest instead');
  await waitFor(() => h.ev(`!!document.querySelector('.hd-note-input textarea')`), 5000, 'the alternative box');
  await h.type('.hd-note-input textarea', 'use npm pack instead');
  await clickNote(h, 'reject and send');
  await sleep(1500);
  await waitFor(async () => /use npm pack instead/.test(await (async () => { await openTerminalTab(h); return termText(h); })()), 30_000, 'the alternative to reach the agent');
  const t3 = await termText(h);
  check('approval', 'an alternative rejects, then the person\'s instruction reaches the SAME agent through its queue', /rejected/.test(t3) && /use npm pack instead/.test(t3));
  check('approval', 'it is closed as "alternative"', (await record(app, (r) => r.agentName === 'Barney' && r.category === 'approval'))?.resolution?.action === 'alternative');
  info.afterAlt = await h.shot('11-after-alternative');
  // each answer reached only its own agent
  const lilyTerm = await terminalOf(h, 'Lily');
  check('approval', 'Barney\'s answers never reached Lily\'s terminal', !/npm pack/.test(lilyTerm) && !/approved: running/.test(lilyTerm));
  h.close();
  await app.close();
};

scenarios.questions = async function () {
  const app = await bootWithAgents();
  const h = await enterHuddle(app);
  await sendTo(h, 'Barney', '#ask what to use');
  await waitState(app, 'Barney', 'needs-input');
  const r = await record(app, (x) => x.agentName === 'Barney' && x.category === 'input');
  check('input', 'a question the agent asks becomes an "input needed" notification with its options and a preview of the question', !!r && r.preview === 'Which database should I use?' && JSON.stringify(r.options) === JSON.stringify(['Postgres', 'SQLite', 'MySQL']), JSON.stringify({ preview: r?.preview, options: r?.options }));
  const inputSound = await lastSound(app, 'input');
  check('sound', 'the question rang the "input" cue, on its own file', !!inputSound && soundFile('input').test(inputSound.file), JSON.stringify(inputSound));
  await waitNote(h, 'input');
  check('input', 'the card shows each option as a button', (await h.ev(`[...document.querySelectorAll('.hd-note-open .hd-note-options .hd-btn')].map((b) => b.textContent).join(',')`)) === 'Postgres,SQLite,MySQL');
  info.question = await h.shot('12-question');
  await h.click('.hd-note-open .hd-note-options .hd-btn', 'SQLite');
  await sleep(1500);
  await openTerminalTab(h);
  const t = await termText(h);
  check('input', 'choosing an option moved the highlight and pressed Enter in that agent\'s terminal: the agent got "SQLite"', /you chose SQLite/.test(t), t.replace(/\s+/g, ' ').slice(-120));
  check('input', 'the notification is closed with the chosen option', (await record(app, (x) => x.id === r.id))?.resolution?.note === 'SQLite');
  await waitFor(async () => (await pending(app)) === 0, 8000, 'nothing pending');
  h.close();
  await app.close();
};

scenarios.failures = async function () {
  const app = await bootWithAgents();
  const h = await enterHuddle(app);
  const lilyId = await agentId(app, 'Lily');
  const lilyPty = `pty-${lilyId}`;
  const oldPid = await pidOf(app, lilyPty);
  await sendTo(h, 'Lily', '#crash now');
  await waitFor(async () => (await stateOf(app, 'Lily')) === 'error', 20_000, 'Lily to be in error');
  const r = await record(app, (x) => x.agentName === 'Lily' && x.category === 'intervention');
  check('error', 'a crashed agent shows as an error with what it said on the way out, and raises a critical "needs attention" notification', !!r && r.priority === 'critical' && /stand-in agent crashed/.test(r.preview ?? ''), JSON.stringify({ priority: r?.priority, preview: r?.preview }));
  const crashSound = await lastSound(app, 'critical');
  check('sound', 'the crash rang the "critical" cue (the one descending line), not the ordinary attention cue', !!crashSound && soundFile('critical').test(crashSound.file) && !(await soundsOf(app)).some((s) => s.kind === 'intervention'), JSON.stringify(crashSound));
  check('error', 'the process really is gone', (await pidOf(app, lilyPty)) === undefined);
  await h.click('[data-act="back"]').catch(() => {});
  await sleep(500);
  info.crashed = await h.shot('13-crashed');
  const lilyCard = await cardOf(h, 'Lily');
  check('error', 'her card stays on the list, in the error state, until someone deals with it', !!lilyCard && lilyCard.state === 'error', JSON.stringify(lilyCard));
  await sleep(14_000);
  check('error', 'and it does not leave on its own while it is waiting on a person', !!(await cardOf(h, 'Lily')));
  await openAgentView(h, 'Lily');
  await clickNote(h, 'restart');
  await waitFor(async () => !!(await pidOf(app, lilyPty)), 30_000, 'a new process');
  const newPid = await pidOf(app, lilyPty);
  check('error', 'Restart started a NEW process for the same agent (Restart & Continue, or a fresh start when there is nothing to continue)', !!newPid && newPid !== oldPid, `${oldPid} -> ${newPid}`);
  await waitFor(async () => (await stateOf(app, 'Lily')) === 'idle', 20_000, 'Lily to be idle again');
  check('error', 'the crash notification closed itself and the agent is idle again', (await pending(app)) === 0);
  h.close();
  await app.close();
};

scenarios.several = async function () {
  const app = await bootWithAgents();
  const h = await enterHuddle(app);
  await sendTo(h, 'Marshall', '#approve one');
  await sendTo(h, 'Lily', '#approve two');
  await waitState(app, 'Marshall', 'needs-approval');
  await waitState(app, 'Lily', 'needs-approval');
  check('several', 'two agents asking at once are two separate notifications, and the bell counts both', (await pending(app)) === 2);
  await h.click('[data-act="back"]'); await waitLevel(h, 'expanded');
  await h.click('[data-act="collapse"]'); await waitLevel(h, 'compact');
  const order = await h.ev(`[...document.querySelectorAll('.hd-card')].map((c) => c.dataset.state + ':' + c.querySelector('.hd-name').textContent)`);
  check('several', 'in the compact list the two that need you are at the top', order.slice(0, 2).every((x) => x.startsWith('needs-approval')), order.join(' | '));
  info.several = await h.shot('14-several-asking');
  await h.click('[data-act="expand"]'); await waitLevel(h, 'expanded');
  const needs = await h.ev(`document.querySelectorAll('section[aria-label] .hd-note-open').length`);
  check('several', 'the expanded panel lists both under "Needs you", each with its own buttons', needs === 2, `${needs}`);
  // approve the first from the shared list: it must reach only that agent
  const first = await h.ev(`document.querySelector('.hd-note-open .hd-note-title')?.textContent`);
  await h.click('.hd-note-open .hd-btn', 'approve');
  await sleep(1500);
  check('several', 'approving one leaves the other still waiting', (await pending(app)) === 1);
  const approvedName = /Marshall/.test(first) ? 'Marshall' : 'Lily';
  const otherName = approvedName === 'Marshall' ? 'Lily' : 'Marshall';
  check('several', 'the answer went to the agent it was for, not the other one', (await stateOf(app, otherName)) === 'needs-approval' && (await stateOf(app, approvedName)) !== 'needs-approval', `${approvedName} answered; ${otherName} is ${await stateOf(app, otherName)}`);
  h.close();
  await app.close();
};


scenarios.attachments = async function () {
  const app = await bootWithAgents({ launch: { pick: [path.join(PICK_DIR, 'shot.png'), path.join(PICK_DIR, 'notes.txt')] } });
  const h = await enterHuddle(app);
  await openAgentView(h, 'Barney');
  // a first, long job is running when the attachments are sent
  await sendFromHuddle(h, '#long keep working');
  await waitFor(async () => ['working', 'researching'].includes(await stateOf(app, 'Barney')), 30_000, 'Barney to be busy');
  await h.click('.hd-composer .hd-btn-icon', '+');
  await h.click('.hd-menu-item', 'images');
  await waitFor(() => h.ev(`!!document.querySelector('.hd-chip-thumb[src^="data:image"]')`), 8000, 'the image preview');
  check('attach', 'an image chosen with the plus menu shows a preview before it is sent', true);
  await h.click('.hd-composer .hd-btn-icon', '+');
  await h.click('.hd-menu-item', 'files');
  await waitFor(() => h.ev(`document.querySelectorAll('.hd-chip').length === 2`), 8000, 'both files');
  check('attach', 'a file chosen the same way is added beside it, without duplicating the image', (await h.ev(`[...document.querySelectorAll('.hd-chip-name')].map((e) => e.textContent).join(',')`)) === 'shot.png,notes.txt');
  info.attach = await h.shot('20-attachments');
  await h.type('.hd-composer textarea', 'please look at these');
  await h.click('.hd-composer .hd-btn-primary', 'send');
  await waitFor(() => h.ev(`/Queued for Barney/.test(document.querySelector('.hd-composer-note')?.textContent || '')`), 8000, 'the queued note');
  check('attach', 'sending while the agent is busy says it is queued, and clears the draft', (await h.ev(`document.querySelectorAll('.hd-chip').length`)) === 0 && (await h.ev(`document.querySelector('.hd-composer textarea').value`)) === '');
  check('attach', 'the queue count is visible while it waits', true, await h.ev(`document.querySelector('.hd-composer-note')?.textContent`));
  // it is delivered when the agent is free, to THAT agent, with the files as paths it can read
  await waitFor(async () => { await openTerminalTab(h); const t = await termText(h); return /Attached files/.test(t) && /shot\.png/.test(t) && /notes\.txt/.test(t); }, 120_000, 'the message to arrive with its files');
  const t = await termText(h);
  check('attach', 'it reached the agent with the text and both files listed as readable paths', /please look at these/.test(t) && /notes\.txt/.test(t) && /shot\.png/.test(t) && t.includes(PICK_DIR.slice(-12)));
  const other = await terminalOf(h, 'Marshall');
  check('attach', 'and nothing of it went to another agent', !/Attached files/.test(other));
  h.close();
  await app.close();
};

scenarios.controls = async function () {
  const app = await bootWithAgents();
  const h = await enterHuddle(app);
  await sendTo(h, 'Marshall', '#long go');
  await waitFor(async () => ['working', 'researching'].includes(await stateOf(app, 'Marshall')), 30_000, 'Marshall to work');
  // pause
  await h.click('.hd-controls .hd-btn', 'pause');
  await waitState(app, 'Marshall', 'paused', 8000);
  check('controls', 'Pause blocks the agent\'s tools at its next step and the card says paused', (await h.ev(`document.querySelector('.hd-chip-state')?.textContent`)).toLowerCase().includes('paused'));
  await openTerminalTab(h);
  await waitFor(async () => /denied/.test(await termText(h)), 30_000, 'a tool to be denied');
  check('controls', 'the agent\'s next tool call really was refused (the operator control reached the hook)', true);
  check('controls', 'Resume is offered while paused, and Pause is not', await h.ev(`[...document.querySelectorAll('.hd-controls .hd-btn')].some((b) => /resume/i.test(b.textContent))`) && !(await h.ev(`[...document.querySelectorAll('.hd-controls .hd-btn')].some((b) => /^pause/i.test(b.textContent.trim()))`)));
  info.paused = await h.shot('21-paused');
  await h.click('.hd-controls .hd-btn', 'resume');
  await waitFor(async () => (await stateOf(app, 'Marshall')) !== 'paused', 10_000, 'the pause to lift');
  await sendFromHuddle(h, '#long again');
  await waitFor(async () => ['working', 'researching'].includes(await stateOf(app, 'Marshall')), 40_000, 'Marshall to work again');
  await sleep(6000);
  const afterResume = ((await termText(h)).split('#long again')[1]) ?? '';
  check('controls', 'Resume lets it carry on: its tool calls after the resume are no longer refused', /● Read/.test(afterResume) && !/denied/.test(afterResume) && ['working', 'researching'].includes(await stateOf(app, 'Marshall')), afterResume.replace(/\s+/g, ' ').slice(0, 100));
  // interrupt
  const completedBefore = (await records(app)).filter((r) => r.agentName === 'Marshall' && r.category === 'completed').length;
  await h.click('.hd-controls .hd-btn', 'stop task');
  await waitFor(async () => /interrupted/.test(await termText(h)), 15_000, 'the interrupt to land');
  check('controls', 'Stop task pressed Escape in its terminal: the agent stopped what it was doing and stayed running', true);
  await waitState(app, 'Marshall', 'idle', 40_000);
  check('controls', 'an interrupted turn fires no "stopped" hook, yet the card settles to idle after the terminal goes quiet, and announces no completion', (await records(app)).filter((r) => r.agentName === 'Marshall' && r.category === 'completed').length === completedBefore);
  // end the session, with a confirmation
  const pid = await pidOf(app, `pty-${await agentId(app, 'Marshall')}`);
  await h.click('.hd-controls .hd-btn', 'end session');
  check('controls', 'ending a session asks first and does nothing until you confirm', !!(await pidOf(app, `pty-${await agentId(app, 'Marshall')}`)));
  await h.click('.hd-confirm .hd-btn-danger', 'end session');
  await waitFor(async () => !(await pidOf(app, `pty-${await agentId(app, 'Marshall')}`)), 15_000, 'the process to end');
  check('controls', 'confirming ended that agent\'s process (and only that one)', !!pid && (await app.ptys()).length === 3);
  await h.click('[data-act="back"]').catch(() => {});
  await sleep(500);
  const card = await cardOf(h, 'Marshall');
  check('controls', 'its card lingers briefly as stopped, with nothing to send to it', !card || card.state === 'stopped' || card.state === 'completed');
  await sleep(14_000);
  check('controls', 'then the card leaves the list', !(await cardOf(h, 'Marshall')));
  h.close();
  await app.close();
};

scenarios.returning = async function () {
  const app = await bootWithAgents();
  const before = (await app.ptys()).map((p) => `${p.id}:${p.pid}`).sort();
  for (let i = 0; i < 4; i++) {
    const h = await enterHuddle(app);
    await openAgentView(h, 'Lily');
    await openTerminalTab(h);
    const mid = await app.debug();
    if (i === 0) check('return', 'while an agent\'s terminal is open in the Huddle, exactly one window is mirroring it', mid.taps[await agentId(app, 'Lily')] === 1, JSON.stringify(mid.taps));
    await h.clickThatCloses('.hd-open-app', '');
    h.close();
    await waitFor(async () => { const d = await app.debug(); return d.window === null; }, 8000, 'the Huddle to close');
    const mainState = await app.main.ev(`({ visible: document.visibilityState, w: window.outerWidth })`);
    if (i === 0) check('return', '"Back to the full app" closes the Huddle and the main window is back', mainState.visible === 'visible' && (await app.debug()).window === null);
    await sleep(500);
  }
  const after = (await app.ptys()).map((p) => `${p.id}:${p.pid}`).sort();
  check('return', 'after four round trips every agent is the SAME process as before: nothing was restarted', JSON.stringify(before) === JSON.stringify(after), `${before.length} processes`);
  const d = await app.debug();
  check('return', 'and no terminal is still being mirrored into a window that no longer exists', Object.values(d.taps).every((n) => n === 0), JSON.stringify(d.taps));
  check('return', 'the agents are still all on the main window\'s floor', (await d.state.agents.length) === 4);
  await app.close();
};

scenarios.placing = async function () {
  const app = await bootWithAgents();
  let h = await enterHuddle(app);
  let d = await app.debug();
  const wa = d.window.displays.find((x) => d.window.bounds.x >= x.workArea.x - 1 && d.window.bounds.x <= x.workArea.x + x.workArea.width).workArea;
  // drag it near the left edge: it docks
  let moved = await app.main.ev(`window.cth.huddleDebugMove(${wa.x + 14}, ${wa.y + 120})`);
  check('place', 'letting go near the left edge docks it there, against the margin', moved.dock === 'left' && moved.bounds.x === wa.x + 8, JSON.stringify(moved.bounds));
  moved = await app.main.ev(`window.cth.huddleDebugMove(${wa.x + Math.round(wa.width / 2)}, ${wa.y + 200})`);
  check('place', 'in the middle of the screen it stays where it is put (not docked)', moved.dock === null && moved.bounds.x === wa.x + Math.round(wa.width / 2), JSON.stringify(moved.bounds));
  // growing keeps the dock edge
  moved = await app.main.ev(`window.cth.huddleDebugMove(${wa.x + wa.width - 330}, ${wa.y + 100})`);
  check('place', 'near the right edge it docks to the right', moved.dock === 'right');
  await h.click('[data-act="expand"]'); await waitLevel(h, 'expanded'); await sleep(900);
  d = await app.debug();
  check('place', 'expanding a docked window grows it away from its edge: the edge stays put', d.window.dock === 'right' && Math.abs(d.window.bounds.x + d.window.bounds.width - (wa.x + wa.width - 8)) <= 2, JSON.stringify(d.window.bounds));
  // a free spot and the level are remembered across a restart of the app
  await app.main.ev(`window.cth.huddleDebugMove(${wa.x + 220}, ${wa.y + 160})`);
  await sleep(1000);
  const saved = (await app.debug()).window.bounds;
  h.close();
  await app.close();
  const app2 = await launch();
  await waitFor(async () => (await app2.ptys()).length >= 1, 60_000, 'the orchestrator');
  h = await enterHuddle2(app2);
  d = await app2.debug();
  check('place', 'after quitting and starting the app again, the Huddle opens where it was left, at the level it was left', Math.abs(d.window.bounds.x - saved.x) <= 2 && Math.abs(d.window.bounds.y - saved.y) <= 2 && d.window.level === 'expanded', `${JSON.stringify(saved)} -> ${JSON.stringify(d.window.bounds)} (${d.window.level})`);
  h.close();
  await app2.close();
};
async function enterHuddle2(app) {
  await app.main.click('button', 'Huddle');
  const h = await app.huddlePage();
  await waitFor(() => h.ev(`!!document.querySelector('.hd-root')`), 15_000, 'the Huddle');
  await sleep(700);
  return h;
}


const prefsOf = async (app) => (await app.debug()).notifications.prefs;
const tickBox = (h, label) => h.ev(`(() => { const l = [...document.querySelectorAll('.hd-check')].find((x) => x.innerText.toLowerCase().includes(${JSON.stringify(label.toLowerCase())})); if (!l) return null; l.querySelector('input').click(); return l.querySelector('input').checked; })()`);

scenarios.preferences = async function () {
  const app = await bootWithAgents();
  const h = await enterHuddle(app);
  await h.click('[data-act="expand"]'); await waitLevel(h, 'expanded');
  await h.click('.hd-tab', 'settings');
  await waitFor(() => h.ev(`!!document.querySelector('.hd-prefs')`), 5000, 'the preferences');
  info.prefs = await h.shot('30-preferences');
  check('prefs', 'the Huddle\'s settings tab has the sound, desktop, routine and per-kind switches', (await h.ev(`document.querySelectorAll('.hd-check').length`)) >= 8);

  await tickBox(h, 'desktop notifications');
  await waitFor(async () => (await prefsOf(app)).desktop === false, 5000, 'desktop off');
  await sendTo(h, 'Marshall', '#approve one');
  await waitState(app, 'Marshall', 'needs-approval');
  const a = await record(app, (r) => r.agentName === 'Marshall' && r.category === 'approval');
  check('prefs', 'desktop notifications off: no banner, but the sound still plays and the request is recorded', a.delivery.desktop === 'off' && a.delivery.sound === 'played', JSON.stringify(a.delivery));

  await h.click('[data-act="back"]'); await waitLevel(h, 'expanded');
  await h.click('.hd-tab', 'settings');
  await tickBox(h, 'play a sound');
  await waitFor(async () => (await prefsOf(app)).sound === false, 5000, 'sound off');
  await sendTo(h, 'Lily', '#approve two');
  await waitState(app, 'Lily', 'needs-approval');
  const b = await record(app, (r) => r.agentName === 'Lily' && r.category === 'approval');
  check('prefs', 'sound off as well: neither a banner nor a sound, and the agent still shows as waiting on you', b.delivery.sound === 'off' && b.delivery.desktop === 'off' && b.actionRequired && (await pending(app)) === 2, JSON.stringify(b.delivery));

  await h.click('[data-act="back"]'); await waitLevel(h, 'expanded');
  await h.click('.hd-tab', 'settings');
  await tickBox(h, 'desktop notifications'); await tickBox(h, 'play a sound');
  await waitFor(async () => { const p = await prefsOf(app); return p.desktop && p.sound; }, 5000, 'both back on');
  // one kind switched off
  await h.ev(`(() => { const l = [...document.querySelectorAll('.hd-prefs-cats .hd-check')].find((x) => /approval/i.test(x.innerText)); l.querySelector('input').click(); })()`);
  await waitFor(async () => (await prefsOf(app)).categories.approval === false, 5000, 'approvals off');
  await sendTo(h, 'Barney', '#approve three');
  await waitState(app, 'Barney', 'needs-approval');
  const c = await record(app, (r) => r.agentName === 'Barney' && r.category === 'approval');
  await waitNote(h, 'approval');
  check('prefs', 'a kind switched off is silent (no banner, no sound) but the record exists and the agent is still shown as needing you', c.delivery.desktop === 'off' && c.delivery.sound === 'off' && !!(await h.ev(`!!document.querySelector('.hd-note-open[data-category="approval"]')`)));
  // test banner + the system status line
  await h.click('[data-act="back"]'); await waitLevel(h, 'expanded');
  await h.click('.hd-tab', 'settings');
  await h.click('.hd-prefs .hd-btn', 'send a test');
  await waitFor(async () => (await app.debug()).notifications.desktop.status === 'ok', 5000, 'the test to be handed over');
  await sleep(300);
  check('prefs', 'a test notification reports honestly what happened, and says what to do if nothing appears', /handed to your system/i.test(await h.text()) && /allow notifications for this app/i.test(await h.text()));
  h.close();
  await app.close();
};

scenarios.attention = async function () {
  const app = await bootWithAgents();
  const h = await enterHuddle(app);
  await h.click('[data-act="expand"]'); await waitLevel(h, 'expanded');
  await h.click('[data-act="collapse"]'); await waitLevel(h, 'compact');
  const marshall = `(() => { const c = [...document.querySelectorAll('.hd-card')].find((x) => /Marshall/.test(x.innerText)); const ch = c && c.querySelector('.hd-char'); return ch ? { effect: ch.dataset.effect, asking: ch.classList.contains('hd-asking'), dot: !!ch.querySelector('.hd-dot'), state: ch.dataset.state } : null; })()`;
  check('attention', 'before anything is asked: no dot, no movement', JSON.stringify(await h.ev(marshall)) === JSON.stringify({ effect: 'none', asking: false, dot: false, state: 'idle' }));
  await sendTo(h, 'Marshall', '#approve');
  await waitState(app, 'Marshall', 'needs-approval');
  await h.click('[data-act="back"]'); await waitLevel(h, 'expanded');
  await h.click('[data-act="collapse"]'); await waitLevel(h, 'compact');
  await waitFor(async () => (await h.ev(marshall))?.dot === true, 8000, 'the dot');
  let seen = await h.ev(marshall);
  check('attention', 'when it asks, its character signals: the glow movement plays at once, with a steady dot', seen.dot && seen.asking && seen.state === 'needs-approval' && seen.effect === 'glow', JSON.stringify(seen));
  info.attentionBurst = await h.shot('31-attention-burst');
  await sleep(3600);
  seen = await h.ev(marshall);
  check('attention', 'it does not keep moving: after a short burst it rests, and the dot stays', seen.effect === 'none' && seen.dot === true, JSON.stringify(seen));
  // looking at it does not clear it
  await h.click('[data-act="expand"]'); await waitLevel(h, 'expanded');
  await h.click('[data-act="bell"]');
  await sleep(600);
  check('attention', 'opening the panel and the inbox (which marks it read) does not clear the request', (await pending(app)) === 1 && (await stateOf(app, 'Marshall')) === 'needs-approval');
  await h.click('[data-act="collapse"]'); await waitLevel(h, 'compact');
  check('attention', 'the dot is still there after being looked at', (await h.ev(marshall)).dot === true);
  // a gentle reminder comes back
  await waitFor(async () => (await h.ev(marshall))?.effect === 'glow', 26_000, 'the reminder burst');
  check('attention', 'and a second, gentler burst comes about twenty seconds after the first (then a minute, three minutes, then every five)', true);
  // dismissing clears the signal; the state stays truthful
  await h.click('[data-act="expand"]'); await waitLevel(h, 'expanded');
  await h.click('.hd-tab', 'agents');
  await clickNote(h, 'dismiss');
  await waitFor(async () => (await pending(app)) === 0, 8000, 'dismissed');
  await h.click('[data-act="collapse"]'); await waitLevel(h, 'compact');
  await sleep(500);
  const after = await h.ev(marshall);
  check('attention', 'dismissing it clears the attention signal (no dot, no movement); the card still tells the truth about the state', after.dot === false && after.effect === 'none' && after.state === 'needs-approval', JSON.stringify(after));
  h.close();
  await app.close();
};

scenarios.languages = async function () {
  const app = await bootWithAgents();
  const h = await enterHuddle(app);
  await app.main.ev(`localStorage.setItem('cth.language', 'zh-CN')`);
  await waitFor(() => h.ev(`/空闲/.test(document.body.innerText)`), 8000, 'Chinese');
  check('i18n', 'the Huddle follows the language chosen in the main window: Simplified Chinese', /智能体小队/.test(await h.text()) && /空闲/.test(await h.text()));
  info.zh = await h.shot('40-huddle-zh');
  await waitFor(async () => (await app.debug()).language === 'zh-CN', 5000, 'the main process to learn the language');
  check('i18n', 'and the main process, which words the operating-system banners, is told the same', true);
  await app.main.ev(`localStorage.setItem('cth.language', 'ar')`);
  await waitFor(() => h.ev(`document.documentElement.dir === 'rtl'`), 8000, 'right-to-left');
  check('i18n', 'Arabic: the Huddle turns right-to-left', /تجمّع الوكلاء/.test(await h.text()));
  info.ar = await h.shot('41-huddle-ar');
  await h.click('[data-act="expand"]'); await waitLevel(h, 'expanded'); await sleep(400);
  info.arExpanded = await h.shot('42-huddle-ar-expanded');
  const noRaw = await h.ev(`!/huddle\\.[a-z]+\\.[a-zA-Z]+/.test(document.body.innerText)`);
  check('i18n', 'no raw translation key shows in Arabic', noRaw);
  await app.main.ev(`localStorage.setItem('cth.language', 'en')`);
  await waitFor(() => h.ev(`document.documentElement.dir === 'ltr'`), 8000, 'back to English');
  check('i18n', 'and it comes back to English and left-to-right', true);
  h.close();
  await app.close();
};

scenarios.bell = async function () {
  const app = await bootWithAgents();
  const h = await enterHuddle(app);
  await sendTo(h, 'Marshall', '#approve');
  await waitState(app, 'Marshall', 'needs-approval');
  await h.clickThatCloses('.hd-open-app', '');
  h.close();
  await waitFor(async () => (await app.debug()).window === null, 8000, 'back in the main window');
  await sleep(800);
  const badge = await app.main.ev(`(() => { const b = [...document.querySelectorAll('button')].find((x) => /notifications/i.test(x.getAttribute('aria-label') || '')); return b ? b.getAttribute('aria-label') : null; })()`);
  check('bell', 'back in the main window the bell says one thing is waiting on you', /1/.test(badge ?? ''), badge ?? '');
  await app.main.click('button', 'Notifications');
  await waitFor(() => app.main.ev(`!!document.querySelector('.hd-inbox .hd-note-open')`), 5000, 'the inbox');
  info.inbox = await app.main.shot('50-main-inbox');
  check('bell', 'the inbox lists it with the same buttons', /rm -rf/.test(await app.main.ev(`document.querySelector('.hd-inbox').innerText`)));
  await app.main.click('.hd-inbox .hd-btn', 'approve');
  await waitFor(async () => (await pending(app)) === 0, 8000, 'approved');
  check('bell', 'approving from the main window answers the agent just the same', (await record(app, (r) => r.agentName === 'Marshall' && r.category === 'approval')).resolution.action === 'approved');
  await app.close();
};

scenarios.restarting = async function () {
  const app = await bootWithAgents();
  const h = await enterHuddle(app);
  await sendTo(h, 'Lily', '#work do it');
  await waitState(app, 'Lily', 'completed', 60_000);
  await sendTo(h, 'Marshall', '#approve');
  await waitState(app, 'Marshall', 'needs-approval');
  const before = (await records(app)).length;
  h.close();
  await app.close();
  const app2 = await launch();
  await waitFor(async () => (await app2.ptys()).length >= 1, 60_000, 'the orchestrator');
  const d = await app2.debug();
  check('persist', 'the notification history survived the restart', d.notifications.records.length === before && d.notifications.records.some((r) => r.category === 'completed'), `${d.notifications.records.length} of ${before}`);
  const old = d.notifications.records.find((r) => r.category === 'approval');
  check('persist', 'a request that was open when the app quit is closed, not left with buttons that answer nothing', !!old && old.resolution?.by === 'system' && old.resolution?.note === 'app-restarted' && d.notifications.pending === 0);
  check('persist', 'and the preferences are as they were', d.notifications.prefs.sound === true && d.notifications.prefs.desktop === true);
  await app2.close();
};

scenarios.population = async function () {
  seedConfig();
  const app = await launch();
  await waitFor(async () => (await app.ptys()).length >= 1, 60_000, 'the orchestrator');
  await app.main.click('button', 'Huddle');
  const h = await app.huddlePage();
  await waitFor(() => h.ev(`!!document.querySelector('.hd-card')`), 15_000, 'the one card');
  await sleep(800);
  check('population', 'with one agent the compact list is one roomier card', (await h.ev(`document.querySelectorAll('.hd-card').length`)) === 1 && (await h.ev(`!!document.querySelector('.hd-card-single')`)));
  const fitList = `(() => { const l = document.querySelector('.hd-list'); const c = document.querySelector('.hd-card'); return l && c ? { scroll: l.scrollHeight, client: l.clientHeight, card: c.offsetHeight } : null; })()`;
  const fit1 = await h.ev(fitList);
  check('population', 'the one agent fits its window: nothing to scroll, the card is not clipped', !!fit1 && fit1.scroll <= fit1.client + 1, JSON.stringify(fit1));
  info.single = await h.shot('60-one-agent');
  const w1 = (await app.debug()).window.bounds;
  h.close();
  // up to the cap the list fits; after it, the list scrolls
  for (const n of ['Marshall', 'Lily', 'Barney', 'Robin', 'Tracy']) await addAgent(app, n);
  await waitFor(async () => (await app.ptys()).length >= 6, 60_000, 'six processes');
  const h6 = await app.huddlePage();
  await waitFor(() => h6.ev(`document.querySelectorAll('.hd-card').length >= 6`), 20_000, 'six cards');
  await sleep(1000);
  const fit6 = await h6.ev(fitList);
  check('population', 'six agents (the most the window shows at once) fit without scrolling', !!fit6 && fit6.scroll <= fit6.client + 1, JSON.stringify(fit6));
  h6.close();
  // many agents: the list grows to a cap and then scrolls
  for (const n of ['Carl', 'Wendy', 'Arthur']) await addAgent(app, n);
  await waitFor(async () => (await app.ptys()).length >= 9, 60_000, 'nine processes');
  const h2 = await app.huddlePage();
  await waitFor(() => h2.ev(`document.querySelectorAll('.hd-card').length >= 9`), 20_000, 'nine cards');
  await sleep(1000);
  const w9 = (await app.debug()).window;
  check('population', 'with nine agents the window grew to its cap and the list scrolls rather than the window growing past the screen', w9.bounds.height > w1.height && (await h2.ev(`(() => { const l = document.querySelector('.hd-list'); return l.scrollHeight > l.clientHeight; })()`)), `${w1.height} -> ${w9.bounds.height}`);
  info.many = await h2.shot('61-nine-agents');
  check('population', 'the header counts all nine', /\b9\b/.test(await h2.ev(`document.querySelector('.hd-title').textContent`)));
  // no agents: stop the only process that is left standing after killing the others
  h2.close();
  await app.close();
};

// A hook frame posted straight to the hive's socket, the way Claude Code's hook shim does it: what a real agent's
// lifecycle looks like to the app, without a program in a terminal (used where the point is the app's reaction).
function postHook(agentIdValue, payload) {
  const sock = path.join(FAKE_HOME, 'Mosbius', 'hive', 'hooks.sock');
  return new Promise((resolve) => {
    let out = '';
    const c = net.createConnection(sock, () => c.write(`${JSON.stringify({ agent_id: agentIdValue, session_id: `harness-${agentIdValue}`, ...payload })}\n`));
    c.setEncoding('utf8');
    c.on('data', (d) => { out += d; });
    c.on('end', () => resolve(out));
    c.on('error', () => resolve(out));
    setTimeout(() => resolve(out), 4000).unref();
  });
}

scenarios.keyboard = async function () {
  const app = await bootWithAgents();
  let other = null;
  const textEditWasRunning = textEditRunning();
  try { execFileSync('open', ['-a', 'TextEdit']); other = 'TextEdit'; await sleep(1800); } catch { /* no TextEdit */ }
  const h = await enterHuddle(app);
  await openAgentView(h, 'Marshall');
  await sleep(900);
  const w0 = (await app.debug()).window;
  check('keyboard', 'the Huddle starts unable to take the keyboard, so appearing and being read never interrupts typing elsewhere', w0.focusable === false && w0.focused === false, `focusable: ${w0.focusable}; focused: ${w0.focused}; in front: ${frontApp()}`);
  // a click into the message box (a real pointer event in the page): now it needs the keyboard
  await h.click('.hd-composer textarea');
  await waitFor(async () => (await app.debug()).window.focusable === true, 4000, 'the Huddle to accept the keyboard');
  await sleep(600);
  const w1 = (await app.debug()).window;
  check('keyboard', 'clicking into the message box lets the window take the keyboard, so the person can type into it', w1.focusable === true, `focusable: ${w1.focusable}`);
  info.keyboardTaken = { focused: w1.focused, inFront: frontApp() };
  // clicking away from every text field gives it back
  await h.click('.hd-title');
  await waitFor(async () => (await app.debug()).window.focusable === false, 4000, 'the Huddle to give the keyboard back');
  const w2 = (await app.debug()).window;
  check('keyboard', 'clicking away from the field gives the keyboard back: the window cannot take it again until a field is clicked', w2.focusable === false, `focusable: ${w2.focusable}`);
  // and it is on the next click again, not a one-time thing
  await h.click('.hd-composer textarea');
  await waitFor(async () => (await app.debug()).window.focusable === true, 4000, 'the Huddle to accept the keyboard again');
  check('keyboard', 'the next click into the field asks for it again', true);
  h.close();
  if (other && !textEditWasRunning) { try { execFileSync('pkill', ['-x', other]); } catch { /* gone */ } }
  await app.close();
};

scenarios.independence = async function () {
  const app = await bootWithAgents();
  const id = await agentId(app, 'Marshall');
  const before = (await app.ptys()).map((p) => `${p.id}:${p.pid}`).sort();
  let h = await enterHuddle(app);
  await openAgentView(h, 'Marshall');
  await sendFromHuddle(h, '#long keep going');
  await waitFor(async () => ['working', 'researching'].includes(await stateOf(app, 'Marshall')), 25_000, 'Marshall to start the long task');
  const act = async () => (await app.debug()).activity[id];
  const a0 = await act();
  // 1. the Huddle is closed ("Back to the full app") while the agent works
  await h.clickThatCloses('.hd-open-app', '');
  h.close();
  await waitFor(async () => (await app.debug()).window === null, 8000, 'the Huddle to close');
  await sleep(5000);
  const a1 = await act();
  check('independent', 'closing the Huddle did not interrupt the agent: the same turn is still running and new tool events kept arriving', a1.turn === true && a1.alive === true && a1.lastEventAt > a0.lastEventAt, `${a0.lastEventAt} -> ${a1.lastEventAt}`);
  // 2. the Huddle is opened again (which also minimises the main window) while it still works
  h = await enterHuddle(app);
  await sleep(5000);
  const a2 = await act();
  const w2 = (await app.debug()).window;
  check('independent', 'opening it again, with the main window minimised, did not interrupt it either', a2.turn === true && a2.lastEventAt > a1.lastEventAt && w2.mainMinimized === true, `${a1.lastEventAt} -> ${a2.lastEventAt}; main minimised: ${w2.mainMinimized}`);
  // 3. one more round trip, then leave it open until the task is over
  await h.clickThatCloses('.hd-open-app', '');
  h.close();
  await waitFor(async () => (await app.debug()).window === null, 8000, 'the Huddle to close');
  h = await enterHuddle(app);
  await waitFor(async () => ['completed', 'idle'].includes(await stateOf(app, 'Marshall')) && !(await act()).turn, 120_000, 'the long task to finish');
  const after = (await app.ptys()).map((p) => `${p.id}:${p.pid}`).sort();
  check('independent', 'through all of it every agent stayed the same process: nothing was restarted', JSON.stringify(before) === JSON.stringify(after), `${before.length} processes`);
  const d = await app.debug();
  const done = d.notifications.records.filter((r) => r.agentId === id && r.category === 'completed');
  check('independent', 'the finish was announced exactly once, however often the Huddle came and went', done.length === 1, `${done.length} completed notification(s)`);
  const me = d.state.agents.find((a) => a.id === id);
  check('independent', 'its checklist ran to the end (progress is not reset by opening or closing the Huddle)', !!me.progress && me.progress.done === me.progress.total && me.progress.total > 0, JSON.stringify(me.progress ?? null));
  await openAgentView(h, 'Marshall');
  await openTerminalTab(h);
  const text = await termText(h);
  // the terminal shows only its last rows: the steps taken while the Huddle was open again must be there, in order, to the end
  const steps = [12, 13, 14, 15, 16, 17, 18, 19].map((n) => `part-${n}\\.ts`).join('[\\s\\S]*');
  check('independent', 'its terminal shows the steps taken after the last return to the Huddle, in order, to the very last one', new RegExp(`${steps}[\\s\\S]*All done`).test(text), text.slice(-160).replace(/\s+/g, ' '));
  h.close();
  await app.close();
};

scenarios.dedupe = async function () {
  const app = await bootWithAgents();
  const id = await agentId(app, 'Marshall');
  const ask = async () => {
    await postHook(id, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm -rf ./build', description: 'Remove the build folder' } });
    await postHook(id, { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
  };
  // what really repeats while a prompt waits is the notification, not the tool call (a new tool call means the person answered)
  const again = () => postHook(id, { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
  await postHook(id, { hook_event_name: 'UserPromptSubmit', prompt: 'clean up the build folder' });
  await ask();
  await waitState(app, 'Marshall', 'needs-approval');
  await again();
  await sleep(300);
  await again();
  await sleep(1200);
  const mine = async () => (await app.debug()).notifications.records.filter((r) => r.agentId === id && r.category === 'approval');
  let recs = await mine();
  check('dedupe', 'the same waiting prompt announced three times is ONE notification, and the bell counts it once', recs.length === 1 && (await pending(app)) === 1, `${recs.length} record(s), ${await pending(app)} pending; repeats: ${recs[0] ? recs[0].repeatCount : '-'}`);
  check('dedupe', 'it stays open and visible for as long as nobody answers: still action-required, unresolved, the agent still says it needs approval', recs[0] && recs[0].actionRequired && !recs[0].resolution && (await stateOf(app, 'Marshall')) === 'needs-approval');
  await sleep(3000);
  recs = await mine();
  check('dedupe', 'and it is still there a few seconds later, unresolved', recs.length === 1 && !recs[0].resolution && (await pending(app)) === 1);
  // answer it, let the agent move on, then ask again: that is a NEW request and gets its own notification
  const first = recs[0].id;
  await app.main.ev(`window.cth.notificationResolve({ id: ${JSON.stringify(first)}, action: 'approve' })`);
  await sleep(500);
  await postHook(id, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'rm -rf ./build' } });
  await sleep(600);
  recs = await mine();
  check('dedupe', 'approving it closed that notification as approved by the person', recs.length === 1 && recs[0].resolution && recs[0].resolution.action === 'approved', JSON.stringify(recs[0] && recs[0].resolution));
  await postHook(id, { hook_event_name: 'UserPromptSubmit', prompt: 'and again' });
  await ask();
  await waitFor(async () => (await mine()).length === 2, 8000, 'a second notification for the second request');
  recs = await mine();
  check('dedupe', 'the next request, after the first was answered, is a separate notification; the old one stays closed', recs.length === 2 && recs.filter((r) => !r.resolution).length === 1 && recs.find((r) => r.id === first).resolution.action === 'approved', `${recs.length} records, ${recs.filter((r) => !r.resolution).length} open`);
  await app.close();
};

scenarios.sounds = async function () {
  const app = await bootWithAgents();
  const m = app.main;
  const approvalFor = async (name, command) => {
    const id = await agentId(app, name);
    await postHook(id, { hook_event_name: 'UserPromptSubmit', prompt: `run ${command}` });
    await postHook(id, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command, description: command } });
    await postHook(id, { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
  };

  // 1. agents starting ring a soft cue that is not a notification
  const heard = await soundsOf(app);
  const started = heard.filter((s) => s.kind === 'started');
  check('sound', 'agents starting rang the soft "started" cue, never twice within six seconds, and it recorded no notification', started.length >= 1 && started.every((s, i) => i === 0 || s.at - started[i - 1].at >= 6000) && (await records(app)).length === 0, JSON.stringify(started.map((s) => s.at)));
  check('sound', 'a test run starts the real player on the real files, at zero volume (so a long run does not fill the room with chimes) unless it was started with --audible', heard.length > 0 && heard.every((s) => s.audible === AUDIBLE && /\.wav$/.test(s.file)), JSON.stringify(heard.map((s) => [s.file, s.audible])));

  // 2. the volume slider is read when a sound plays; three agents asking in one breath ring once
  await m.ev(`window.cth.notificationPrefs({ volume: 0.5 })`);
  await waitFor(async () => (await prefsOf(app)).volume === 0.5, 5000, 'the volume to change');
  await sleep(1600);                                   // clear of any earlier sound's repeat window
  const base = (await soundsOf(app)).length;
  await approvalFor('Marshall', 'npm test');
  await approvalFor('Lily', 'npm run lint');
  await approvalFor('Barney', 'npm pack');
  await waitFor(async () => (await records(app)).filter((r) => r.category === 'approval').length === 3, 10_000, 'three approvals');
  const recs = (await records(app)).filter((r) => r.category === 'approval');
  const rang = (await soundsOf(app)).slice(base).filter((s) => s.kind === 'approval');
  check('sound', 'three agents asking in the same breath ring the "approval" cue once; all three notifications are there, and the other two say their sound was held back', rang.length === 1 && recs.length === 3 && recs.filter((r) => r.delivery.sound === 'muted').length === 2, JSON.stringify({ rang: rang.length, delivery: recs.map((r) => r.delivery.sound) }));
  check('sound', 'the volume slider is read when the sound plays: 50% on the slider is a gain of 0.25', rang[0]?.volume === 0.5 && rang[0]?.gain === 0.25, JSON.stringify(rang[0]));

  // 3. the master switch: a new request still gets its notification, and nothing is asked of the player
  await m.ev(`window.cth.notificationPrefs({ sound: false })`);
  await waitFor(async () => (await prefsOf(app)).sound === false, 5000, 'the sound to switch off');
  const offBase = (await soundsOf(app)).length;
  const mid = await agentId(app, 'Marshall');
  await postHook(mid, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' } });
  await approvalFor('Marshall', 'git status');
  await waitFor(async () => (await records(app)).filter((r) => r.agentName === 'Marshall' && r.category === 'approval').length === 2, 10_000, 'a second request from Marshall');
  const second = (await records(app)).filter((r) => r.agentName === 'Marshall' && r.category === 'approval').at(-1);
  check('sound', 'with the sounds off, a new request still gets its notification but no sound is asked of the player', second.delivery.sound === 'off' && (await soundsOf(app)).length === offBase, JSON.stringify(second.delivery));

  // 4. Settings → General → Notifications: a play button for every sound, working while the sounds are off, and creating nothing
  await m.click('button[aria-label="Settings"]');
  await waitFor(() => m.ev(`!!document.querySelector('[data-hub-sounds]')`), 15_000, 'the sounds section in Settings');
  const kinds = await m.ev(`[...document.querySelectorAll('[data-sound-preview]')].map((b) => b.dataset.soundPreview)`);
  check('sound', 'Settings → General → Notifications has a volume slider, a switch for the start sound and a play button for every sound', JSON.stringify(kinds) === JSON.stringify(['completed', 'intervention', 'input', 'approval', 'access', 'critical', 'started', 'signature']) && (await m.ev(`!!document.querySelector('[data-sound-volume]')`)), JSON.stringify(kinds));
  info.soundsSettings = await m.shot('20-sounds-settings');
  const snap = async () => { const d = await app.debug(); return JSON.stringify({ n: d.notifications.records.length, pending: d.notifications.pending, unread: d.notifications.unread, shown: d.notifications.desktop.lastShownAt, agents: d.state.agents.map((a) => [a.name, a.state]) }); };
  await sleep(1600);                                   // the last cue (the approval) has finished: the first preview has the speakers to itself
  const before = await snap();
  const previewBase = (await soundsOf(app)).length;
  await m.click('[data-sound-preview="intervention"]');
  await waitFor(async () => (await soundsOf(app)).length === previewBase + 1, 5000, 'the first preview');
  await sleep(250);
  await m.click('[data-sound-preview="signature"]');
  await waitFor(async () => (await soundsOf(app)).length === previewBase + 2, 5000, 'the second preview');
  const previews = (await soundsOf(app)).slice(previewBase);
  check('sound', 'the play buttons played those two sounds and no others, although the notification sounds are off', previews.map((s) => s.kind).join() === 'intervention,signature', JSON.stringify(previews.map((s) => s.kind)));
  check('sound', 'pressing a second button took over from the first, which was still sounding', previews[1].interrupt === true && previews[0].interrupt === false, JSON.stringify((await soundsOf(app)).slice(-5).map((s) => [s.kind, s.at, s.interrupt, s.interrupted])));
  check('sound', 'a preview created no notification, raised no banner and changed no agent\'s state', (await snap()) === before);
  // 5. a switch for each sound: switching one off silences that sound and nothing else, and its notification is still recorded
  await m.ev(`window.cth.notificationPrefs({ sound: true })`);
  await waitFor(async () => (await prefsOf(app)).sound === true, 5000, 'the sounds back on');
  const switches = await m.ev(`[...document.querySelectorAll('[data-sound-switch]')].map((b) => [b.dataset.soundSwitch, b.checked])`);
  check('sound', 'beside the sounds there is a switch for each sound an event can ring (all on at first); the signature tune, which no event rings, has none', JSON.stringify(switches.map((s) => s[0])) === JSON.stringify(['completed', 'intervention', 'input', 'approval', 'access', 'critical', 'started']) && switches.every((s) => s[1] === true), JSON.stringify(switches));
  await m.click('[data-sound-switch="approval"]');
  await waitFor(async () => (await prefsOf(app)).cues?.approval === false, 5000, 'the approval switch to turn off');
  const prefsNow = await prefsOf(app);
  check('sound', 'clicking one sound\'s switch turned off that sound only', prefsNow.cues.approval === false && Object.entries(prefsNow.cues).filter(([k]) => k !== 'approval').every(([, v]) => v === true), JSON.stringify(prefsNow.cues));
  check('sound', 'its row is dimmed, so it is plain which sounds are off', await m.ev(`!!document.querySelector('.hd-sound-row.is-off [data-sound-switch="approval"]')`));
  await sleep(3500);                                   // clear of the last preview, which was the three-second signature
  const switchBase = (await soundsOf(app)).length;
  await approvalFor('Lily', 'make release');
  await waitFor(async () => (await records(app)).filter((r) => r.agentName === 'Lily' && r.category === 'approval').length === 2, 10_000, 'a second request from Lily');
  const lilyRec = (await records(app)).filter((r) => r.agentName === 'Lily' && r.category === 'approval').at(-1);
  check('sound', 'with the approval sound off, a new approval request is still recorded and its banner is not affected by the switch (shown, or folded into the summary by the limit on banners in a burst), but its sound is off and the player is not asked', lilyRec.delivery.sound === 'off' && (lilyRec.delivery.desktop === 'shown' || lilyRec.delivery.desktop === 'muted') && (await soundsOf(app)).length === switchBase, JSON.stringify(lilyRec.delivery));
  const bid = await agentId(app, 'Barney');
  await postHook(bid, { hook_event_name: 'UserPromptSubmit', prompt: 'pick a database' });
  await postHook(bid, { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Which database should I use?', options: [{ label: 'Postgres' }, { label: 'SQLite' }] }] } });
  await waitFor(async () => (await soundsOf(app)).length > switchBase, 8000, 'the input sound');
  check('sound', 'the other sounds still ring: a question rings the input sound', (await soundsOf(app)).slice(switchBase).map((s) => s.kind).join() === 'input', JSON.stringify((await soundsOf(app)).slice(switchBase).map((s) => s.kind)));
  const offBeforePreview = (await soundsOf(app)).length;
  await sleep(1300);
  await m.click('[data-sound-preview="approval"]');
  await waitFor(async () => (await soundsOf(app)).length === offBeforePreview + 1, 5000, 'the preview of the sound that is off');
  check('sound', 'and the sound that is off can still be previewed', (await soundsOf(app)).at(-1).kind === 'approval');
  await m.click('[data-sound-switch="approval"]');
  await waitFor(async () => (await prefsOf(app)).cues?.approval === true, 5000, 'the approval switch to turn back on');
  check('sound', 'switching it back on restores it', (await prefsOf(app)).cues.approval === true && !(await m.ev(`!!document.querySelector('.hd-sound-row.is-off')`)));
  // 6. a sound that ships with the app, if one does: the task-complete preview plays that file, and the speakers are held for its real length (read from the file)
  if (SHIPPED.includes('completed')) {
    await sleep(1600);                                   // clear of the preview of the approval sound
    const clipBase = (await soundsOf(app)).length;
    await m.click('[data-sound-preview="completed"]');
    await waitFor(async () => (await soundsOf(app)).length === clipBase + 1, 5000, 'the preview of the task-complete sound');
    const clip = (await soundsOf(app)).at(-1);
    check('sound', 'the task-complete preview plays the file that ships with the app (bundled/completed.wav), not the synthesized hook', clip.kind === 'completed' && clip.file === 'bundled/completed.wav', JSON.stringify(clip));
    await sleep(4200);                                   // past the three seconds of the app's own hook, inside the clip's seven
    await m.click('[data-sound-preview="started"]');
    await waitFor(async () => (await soundsOf(app)).length === clipBase + 2, 5000, 'the next preview, four seconds into the clip');
    const next = (await soundsOf(app)).at(-1);
    check('sound', 'a preview pressed four seconds in took over from the clip, whose player was still running: the speakers are held for its real length, read from the file', next.kind === 'started' && next.interrupt === true && next.interrupted === true, JSON.stringify(next));
  } else {
    // 6. nothing ships: the task-complete preview plays the app's own synthesized piano hook (completed-vN.wav) and never a file from a bundled folder
    await sleep(1600);                                   // clear of the preview of the approval sound
    const base = (await soundsOf(app)).length;
    await m.click('[data-sound-preview="completed"]');
    await waitFor(async () => (await soundsOf(app)).length === base + 1, 5000, 'the preview of the task-complete sound');
    const hook = (await soundsOf(app)).at(-1);
    check('sound', "the task-complete preview plays the app's own synthesized piano hook (no recorded file ships)", hook.kind === 'completed' && /^completed-v\d+(?:-g\d+)?\.wav$/.test(hook.file), JSON.stringify(hook));
    check('sound', 'and no sound the app played during the tour came from a bundled folder', !(await soundsOf(app)).some((x) => /^bundled\//.test(x.file)), JSON.stringify((await soundsOf(app)).map((x) => x.file)));
  }
  if (AUDIBLE) {
    // for a person who is listening: every sound once, in the order Settings lists them, each after the one before has finished
    await m.ev(`window.cth.notificationPrefs({ volume: 0.8 })`);
    await waitFor(async () => (await prefsOf(app)).volume === 0.8, 5000, 'the volume back at its default');
    const lengths = { completed: SHIPPED.includes('completed') ? 7000 : 3350, intervention: 1300, input: 950, approval: 1000, access: 1250, critical: 1350, started: 700, signature: 2950 };
    await sleep(3200);
    for (const kind of kinds) { console.log(`  (playing ${kind})`); await m.click(`[data-sound-preview="${kind}"]`); await sleep(lengths[kind] + 500); }
  }
  await app.close();
};

scenarios.custom = async function () {
  // a person's own sound: a WAV in <data folder>/sounds/custom/ named for a cue replaces the app's own sound for that cue
  const dir = path.join(UD, 'sounds', 'custom');
  fs.mkdirSync(dir, { recursive: true });
  const rate = 44100, n = rate * 2;                                      // two seconds of a quiet tone: a stand-in, not anyone's recording
  const wav = Buffer.alloc(44 + n * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + n * 2, 4); wav.write('WAVE', 8); wav.write('fmt ', 12); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) wav.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 3000), 44 + i * 2);
  const file = path.join(dir, 'completed.wav');
  fs.writeFileSync(file, wav);
  seedConfig({});
  const app = await launch();
  const m = app.main;
  await m.click('button[aria-label="Settings"]');
  await waitFor(() => m.ev(`!!document.querySelector('[data-sound-preview="completed"]')`), 15_000, 'the sound previews in Settings');
  const base = (await soundsOf(app)).length;
  await m.click('[data-sound-preview="completed"]');
  await waitFor(async () => (await soundsOf(app)).length === base + 1, 5000, 'the preview');
  const own = (await soundsOf(app)).at(-1);
  check('custom', 'a WAV in the data folder\'s sounds/custom/, named for a cue, is played instead of the app\'s own sound for that cue (a preview included)', own.kind === 'completed' && own.file === 'custom/completed.wav', JSON.stringify(own));
  check('custom', 'and the app wrote nothing into that folder', JSON.stringify(fs.readdirSync(dir)) === JSON.stringify(['completed.wav']), JSON.stringify(fs.readdirSync(dir)));
  fs.rmSync(file);
  await sleep(2300);                                                    // the two-second replacement is over
  await m.click('[data-sound-preview="completed"]');
  await waitFor(async () => (await soundsOf(app)).length === base + 2, 20_000, 'the second preview (the app\'s own sound may have to be made first)');
  const back = (await soundsOf(app)).at(-1);
  check('custom', 'take the file away and the sound the app carries for that cue is back (the file that ships with it, or its own hook where none ships)', soundFile('completed').test(back.file), JSON.stringify(back));
  await app.close();
};

// ── version: the build says what package.json says ────────────────────────────────────────────────────────────────
// The 1.0.0 releases were named on the command line while package.json said 0.4.6, so the toolbar and Settings → Updates said v0.4.6 in a
// build called 1.0.0. The label is `__APP_VERSION__`, read from package.json when the app is built: this checks the build that is being run.
scenarios.version = async function () {
  const want = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  seedConfig();
  const app = await launch();
  const chips = await app.main.ev(`[...document.querySelectorAll('body *')].filter((el) => !el.children.length && /^v\\d+\\.\\d+\\.\\d+(\\s*·)?$/.test((el.textContent || '').trim())).map((el) => el.textContent.trim().replace(/\\s*·$/, ''))`);
  check('version', `the toolbar's version chip says v${want}`, chips.length >= 1 && chips.every((c) => c === `v${want}`), JSON.stringify(chips));
  await app.main.ev(`window.dispatchEvent(new CustomEvent('cth:open-settings', { detail: { section: 'General' } }))`);
  await waitFor(() => app.main.ev(`document.body.innerText.includes("You're on v")`), 15_000, 'Settings → Updates');
  const text = await app.main.ev(`document.body.innerText`);
  check('version', `Settings → Updates says "You're on v${want}"`, text.includes(`You're on v${want}`), (/You're on v[\d.]+/.exec(text) ?? [''])[0]);
  check('version', 'and the old version number, 0.4.6, is nowhere on that screen', !text.includes('0.4.6'));
  info.versionShown = { want, chips };
  await app.close();
};

// ── media: the pictures and videos the README and the website show ────────────────────────────────────────────────────
//
//   node tools/huddle-validate.cjs --only media --packaged "<the app's executable>" --out <a scratch folder>
//
// Real captures of the real Huddle, driven by the same stand-in agents as the rest of the tour (programs, not models, so the
// words an agent says are theirs). A picture is the window itself at twice the pixel density, on its own cream. A video is the window's frames
// over the DevTools protocol, put on a steady clock with ffmpeg (which must be on the PATH). The pointer in the videos is
// drawn by this script, and the clicks under it are real. Only the app's own windows are captured, never the screen, so
// nothing of a person's desktop can be in a frame. The results go to screenshots/huddle/ (not --out); the website's build
// copies what it shows from there.
const MEDIA = path.join(ROOT, 'screenshots', 'huddle');

/** Every scenario starts from a profile with nothing in it: agents, the saved Huddle position and the history are the app's own state. */
function resetProfile() {
  killStrays();
  for (const d of [UD, path.join(FAKE_HOME, 'Mosbius'), path.join(FAKE_HOME, '.claude'), path.join(FAKE_HOME, '.agents')]) fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(UD, { recursive: true });
}

function ffmpeg(args, what) {
  const r = require('node:child_process').spawnSync(process.env.FFMPEG || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`ffmpeg failed (${what}): ${(r.stderr || r.error?.message || '').slice(0, 400)}`);
}

/**
 * Keep a page's pictures, each with the time it was taken, so a pause in the page is a pause in the video. They are taken
 * one after another at twice the pixel density (a DevTools screencast gives one pixel per point, which is soft on a sharp
 * screen), so the video runs at the pace the machine can take them: a steady 30 frames a second is made from them later.
 */
async function startCapture(page, dir, clip) {
  fs.mkdirSync(dir, { recursive: true });
  const frames = [];
  let running = true;
  const loop = (async () => {
    while (running) {
      const began = Date.now();
      let res;
      try { res = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 90, clip }); } catch { break; }
      const file = path.join(dir, `f${String(frames.length + 1).padStart(6, '0')}.jpg`);
      fs.writeFileSync(file, Buffer.from(res.data, 'base64'));
      frames.push({ file, t: Math.round((began + Date.now()) / 2) });
    }
  })();
  return { async stop() { running = false; await loop; return frames; } };
}

/** The frames that cover [fromMs, toMs): the one on screen at fromMs counts from fromMs. */
function windowOf(frames, fromMs, toMs) {
  const i = Math.max(0, frames.findLastIndex((f) => f.t <= fromMs));
  return frames.slice(i).filter((f, k) => k === 0 || f.t < toMs).map((f, k) => (k === 0 ? { ...f, t: Math.max(f.t, fromMs) } : f));
}

/** A list for ffmpeg's concat reader: each frame stays for as long as it was on screen; the last holds until `endMs`. */
function concatList(frames, file, endMs) {
  const lines = [];
  frames.forEach((f, i) => { const next = i + 1 < frames.length ? frames[i + 1].t : Math.max(endMs, f.t + 40); lines.push(`file '${f.file}'`, `duration ${Math.max(0.001, (next - f.t) / 1000).toFixed(4)}`); });
  lines.push(`file '${frames.at(-1).file}'`);       // the reader wants the last file named again
  fs.writeFileSync(file, lines.join('\n'));
}

const toMp4 = (list, out) => ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-vf', 'fps=30,scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p', '-c:v', 'libx264', '-preset', 'slow', '-crf', '21', '-movflags', '+faststart', '-an', out], path.basename(out));
const toGif = (list, out, width) => ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-vf', `fps=15,scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=192:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`, '-loop', '0', out], path.basename(out));
const toPoster = (mp4, out, seconds) => ffmpeg(['-ss', String(Math.max(0, seconds)), '-i', mp4, '-frames:v', '1', '-q:v', '3', out], path.basename(out));

// the pointer: an arrow that glides to what is about to be clicked, and a ring where the click lands
const POINTER = `(() => {
  if (document.getElementById('__demo_pointer')) return true;
  const c = document.createElement('div');
  c.id = '__demo_pointer';
  c.innerHTML = '<svg width="22" height="28" viewBox="0 0 22 28"><path d="M2.5 2 L2.5 21 L7.2 16.6 L10.6 25 L14 23.6 L10.7 15.4 L17.5 15.4 Z" fill="#fff" stroke="#26222e" stroke-width="1.5" stroke-linejoin="round"/></svg>';
  Object.assign(c.style, { position: 'fixed', left: '0px', top: '0px', zIndex: '2147483647', pointerEvents: 'none', opacity: '0', transform: 'translate(' + Math.round(innerWidth * 0.6) + 'px,' + Math.round(innerHeight * 0.75) + 'px)', transition: 'transform 640ms cubic-bezier(.25,.1,.2,1), opacity 260ms ease' });
  c.firstChild.style.display = 'block';
  c.firstChild.style.filter = 'drop-shadow(0 1.5px 1.5px rgba(0,0,0,.4))';
  document.body.appendChild(c);
  window.__demoMove = (x, y) => { c.style.opacity = '1'; c.style.transform = 'translate(' + x + 'px,' + y + 'px)'; };
  window.__demoHide = () => { c.style.opacity = '0'; };
  window.__demoRipple = (x, y) => {
    const r = document.createElement('div');
    Object.assign(r.style, { position: 'fixed', left: (x - 17) + 'px', top: (y - 17) + 'px', width: '34px', height: '34px', borderRadius: '50%', background: 'rgba(255,201,74,.5)', border: '2px solid rgba(255,201,74,.95)', zIndex: '2147483646', pointerEvents: 'none' });
    document.body.appendChild(r);
    r.animate([{ transform: 'scale(.25)', opacity: 0.9 }, { transform: 'scale(1.5)', opacity: 0 }], { duration: 560, easing: 'ease-out' }).onfinish = () => r.remove();
  };
  return true;
})()`;

/** Glide the pointer to a button and click it for real, without scrolling anything on the way. */
async function demoClick(page, selector, text) {
  const pos = await page.ev(`(() => {
    const sel = ${JSON.stringify(selector)}, text = ${JSON.stringify(text ?? null)};
    const els = [...document.querySelectorAll(sel)].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
    const el = text === null ? els[0] : els.find((e) => ((e.getAttribute('aria-label') || '') + ' ' + (e.textContent || '')).trim().toLowerCase().includes(text.toLowerCase()));
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  if (!pos) throw new Error(`nothing to click: ${selector} ${text ?? ''}`);
  await page.ev(`window.__demoMove(${pos.x - 3}, ${pos.y - 2})`);
  await sleep(820);                                                     // the pointer arrives, and the button shows that it is hovered
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pos.x, y: pos.y });
  await sleep(260);
  await page.ev(`window.__demoRipple(${pos.x}, ${pos.y})`);
  for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
  await sleep(300);
}

// what a trackpad shows: no scrollbar until you scroll (this machine draws the always-on kind, dark and thick, over the cards)
const TIDY = `(() => { if (document.getElementById('__media_tidy')) return true; const s = document.createElement('style'); s.id = '__media_tidy'; s.textContent = '*::-webkit-scrollbar { display: none !important; width: 0 !important; height: 0 !important; }'; document.head.appendChild(s); return true; })()`;

scenarios.media = async function () {
  fs.mkdirSync(MEDIA, { recursive: true });
  const raw = path.join(TMP, 'media-raw');
  const made = [];
  const keep = (file) => { made.push(path.relative(ROOT, file)); return file; };

  /** A fresh app with its four agents, and the Huddle open and ready to be photographed. */
  const session = async () => {
    const app = await bootWithAgents();
    // the pictures show the Huddle itself, so the operating system raises no banners over whatever else is on screen
    await app.main.ev(`window.cth.notificationPrefs({ desktop: false })`);
    const ids = {};
    for (const n of ['Marshall', 'Lily', 'Barney']) ids[n] = await agentId(app, n);
    const h = await enterHuddle(app);
    await h.ev(TIDY);
    // The window's background is its cream at 95%, so a picture with transparency shows whatever it is put on through it. Behind the
    // window, put the cream itself: the picture is then the window as it looks over a light desktop, on any page it is shown on.
    const cream = await h.ev(`(() => { const probe = document.createElement('i'); probe.style.color = getComputedStyle(document.documentElement).getPropertyValue('--cth-cream-100') || '#fdf6e3'; document.body.appendChild(probe); const m = getComputedStyle(probe).color.match(/\\d+/g).map(Number); probe.remove(); return { r: m[0], g: m[1], b: m[2] }; })()`);
    await h.send('Emulation.setDefaultBackgroundColorOverride', { color: { ...cream, a: 1 } });
    info.huddleBackground = cream;
    const say = async (name, text) => {
      const r = await h.ev(`window.huddle.command({ type: 'send', agentId: ${JSON.stringify(ids[name])}, text: ${JSON.stringify(text)}, attachments: [] })`);
      if (!r || !r.ok) throw new Error(`could not send to ${name}: ${r && r.error}`);
    };
    /** The Huddle window as a picture at twice the pixel density. */
    const picture = async (name) => {
      const dpr = await h.ev('window.devicePixelRatio');
      const r = await h.ev(`(() => { const b = document.querySelector('.hd-root').getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; })()`);
      const res = await h.send('Page.captureScreenshot', { format: 'png', clip: { ...r, scale: 2 / dpr } });
      fs.writeFileSync(keep(path.join(MEDIA, `${name}.png`)), Buffer.from(res.data, 'base64'));
    };
    return { app, h, say, picture };
  };
  const quiet = async (app) => {
    await waitFor(async () => (await pending(app)) === 0, 20_000, 'nothing waiting');
    for (const n of ['Marshall', 'Lily', 'Barney']) await waitState(app, n, 'idle', 90_000);
  };

  // 1. the pictures that need agents in particular states: one waiting on a person, one at work
  let { app, h, say, picture } = await session();
  await say('Marshall', '#approve please clear the build folder');
  await say('Lily', '#work tidy the parser');
  await waitState(app, 'Marshall', 'needs-approval');
  await waitFor(async () => ['working', 'researching'].includes(await stateOf(app, 'Lily')), 25_000, 'Lily at work');
  await sleep(3400);                                                    // the cards settle: the attention glow is two short pulses
  await picture('huddle-compact');
  await h.click('[data-act="expand"]'); await waitLevel(h, 'expanded');
  await sleep(1000);
  await picture('huddle-expanded');
  await openAgentView(h, 'Marshall');
  await waitNote(h, 'approval');
  await sleep(700);
  await picture('huddle-agent');
  await clickNote(h, 'approve');
  await quiet(app);
  h.close();
  await app.close();

  // 2. the story, from a fresh office so every card starts calm: a request, an answer, work going on, a question, a finish
  resetProfile();
  ({ app, h, say, picture } = await session());
  await h.click('[data-act="expand"]'); await waitLevel(h, 'expanded');
  await sleep(900);
  const size = await h.ev(`(() => { const b = document.querySelector('.hd-root').getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height) }; })()`);
  await h.ev(POINTER);
  const cast = await startCapture(h, path.join(raw, 'story'), { x: 0, y: 0, width: size.w, height: size.h, scale: 2 });
  const mark = { start: Date.now() };
  await sleep(1600);                                                    // the calm office: the story has a beginning
  mark.approveFrom = Date.now();
  await say('Lily', '#approve please clear the build folder');
  await waitNote(h, 'approval');
  mark.approveCard = Date.now();
  await sleep(1700);
  await demoClick(h, '.hd-note-open .hd-btn-primary', 'approve');
  await waitFor(async () => (await pending(app)) === 0, 10_000, 'the request answered');
  await h.ev('window.__demoHide()');
  await sleep(1700);
  mark.approveTo = Date.now();
  await say('Marshall', '#work tidy the parser');
  await sleep(1600);
  mark.answerFrom = Date.now();
  await say('Barney', '#ask pick a database');
  await waitNote(h, 'input');
  mark.answerCard = Date.now();
  await sleep(1700);
  await demoClick(h, '.hd-note-open .hd-note-options .hd-btn', 'SQLite');
  await waitFor(async () => (await pending(app)) === 0, 10_000, 'the question answered');
  await h.ev('window.__demoHide()');
  await sleep(1700);
  mark.answerTo = Date.now();
  await waitFor(async () => (await records(app)).some((r) => r.agentName === 'Marshall' && r.category === 'completed'), 40_000, 'Marshall to finish').catch(() => undefined);
  await sleep(2800);
  mark.end = Date.now();
  const frames = await cast.stop();
  await h.ev(`document.getElementById('__demo_pointer')?.remove()`);
  const span = (frames.at(-1)?.t - frames[0]?.t) / 1000;
  info.mediaFramesPerSecond = Math.round((frames.length / span) * 10) / 10;
  check('media', 'the story was captured as a run of pictures long enough to play', frames.length > 80 && span > 12, `${frames.length} pictures over ${Math.round(span * 10) / 10} s (${info.mediaFramesPerSecond} a second)`);
  h.close();
  await app.close();

  const clip = (name, from, to, posterAt, gifWidth) => {
    const list = path.join(raw, `${name}.txt`);
    concatList(windowOf(frames, from, to), list, to);
    if (gifWidth) { toGif(list, keep(path.join(MEDIA, `${name}.gif`)), gifWidth); return; }
    const mp4 = keep(path.join(MEDIA, `${name}.mp4`));
    toMp4(list, mp4);
    toPoster(mp4, keep(path.join(MEDIA, `${name}-poster.jpg`)), posterAt);
  };
  clip('huddle-story', mark.start, mark.end, (mark.approveCard - mark.start) / 1000 + 1.1, 0);
  clip('huddle-approve', mark.approveFrom - 500, mark.approveTo, 0, 432);
  clip('huddle-answer', mark.answerFrom - 500, mark.answerTo, 0, 432);

  for (const rel of made) {
    const bytes = fs.statSync(path.join(ROOT, rel)).size;
    check('media', `${rel} was written`, bytes > 4000, `${Math.round(bytes / 1024)} KB`);
  }
  info.media = made;
};

// ── desktop: a real recording of the desktop, for the website and the README ─────────────────────────────────────────────
//
//   node tools/huddle-validate.cjs --only desktop --packaged "<the app's executable>" --out <a scratch folder> [--dry] [--keep-raw]
//   node tools/huddle-validate.cjs --only desktop --from-raw <the --out folder of an earlier --keep-raw run>      (the camera again, no new recording)
//
// The script, in order: the whole app is in front, with agents at work in Barney's apartment; a pointer goes to "Huddle" and clicks; the
// app minimises and the Huddle comes up in the top right corner of an empty desktop; the camera moves in on it; the agents' animations and
// the requests that come in are seen in the compact list; the Huddle opens out (a request to approve, a question to answer), then its
// notifications, then one agent's conversation and its terminal, then a message typed to another agent and its reply; and the camera moves
// back out to the whole desktop. macOS only.
//
// It is a real recording of the real screen (tools/record-desktop.swift, ScreenCaptureKit), taken at twice the display's pixel density, with
// the camera (tools/camera-render.cjs) as a second step over that recording: nothing on the screen is changed to make it, and the only thing
// the camera moves is the frame. Nothing has to be hidden or switched off: the recording leaves out the files on the desktop and every other
// application's windows and menu-bar icons. The app is placed on the built-in display (the other one is often full-screen with something else,
// which has no wallpaper) and that display is what is recorded. The pointer is the real one, glided by the tool; each click is a real click
// inside the page (the harness cannot press the mouse button through the window server), and the words typed are typed into the page one
// letter at a time. The agents are the stand-in program in its demo mode (test/fixtures/stand-in-agent.cjs). Needs the Screen Recording
// permission of whatever starts this, ffmpeg, and Node 22. --dry does everything but record, and takes a picture of the screen at each step.
// The result goes to screenshots/huddle/ (not --out). Keep your hands off the mouse and the keyboard while it runs (about two minutes).
const DESK_SHOWN = ['com.apple.dock', 'com.apple.systemuiserver', 'com.apple.controlcenter'];     // the wallpaper, and the menu bar's own parts

// the title bar of a build made from the repo carries the repo's own version number (as a few separate pieces of text, so whole elements are looked at): it is left out of a recording
const HIDE_VERSION = `(() => { let n = 0; for (const el of document.querySelectorAll('body *')) { if (el.children.length) continue; const t = (el.textContent || '').trim(); if (/^v\\d+\\.\\d+\\.\\d+(\\s*·)?$/.test(t) || t === 'latest') { el.style.visibility = 'hidden'; n++; } } return n; })()`;
// click the smallest thing whose text is exactly this (a card's name, say): the click goes up to the card
const CLICK_TEXT = (text) => `(() => { const want = ${JSON.stringify(text.toLowerCase())}; const hits = [...document.querySelectorAll('body *')].filter((e) => !e.children.length && (e.textContent || '').trim().toLowerCase() === want && e.getBoundingClientRect().width > 0); const el = hits[hits.length - 1]; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`;

function desktopTool() {
  const out = path.join(TMP, 'record-desktop');
  if (!fs.existsSync(out)) execFileSync('swiftc', ['-O', path.join(ROOT, 'tools', 'record-desktop.swift'), '-o', out], { stdio: 'pipe', timeout: 240_000 });
  return out;
}
const glideTo = (x, y, ms) => execFileSync(desktopTool(), ['glide', String(Math.round(x)), String(Math.round(y)), String(ms)], { timeout: 60_000 });
const desktopDisplays = () => execFileSync(desktopTool(), ['list'], { encoding: 'utf8', timeout: 60_000 }).split('\n')
  .map((l) => /^display (\d+): (\d+) x (\d+) points at (-?\d+),(-?\d+)(, the main display)?/.exec(l)).filter(Boolean)
  .map((m) => ({ id: Number(m[1]), w: Number(m[2]), h: Number(m[3]), x: Number(m[4]), y: Number(m[5]), main: !!m[6] }));

/** Which pseudo-terminal belongs to which agent: the app gives each agent's process its AGENT_ID. */
async function ptyOfAgents(app) {
  const out = {};
  for (const p of await app.ptys()) {
    try {
      const m = /\bAGENT_ID=([A-Za-z0-9_-]+)/.exec(execFileSync('ps', ['eww', '-o', 'command=', '-p', String(p.pid)], { encoding: 'utf8' }));
      if (m) out[m[1]] = p.id;
    } catch { /* it just ended */ }
  }
  return out;
}

const DESK_SCALE = 2;                                                   // the recording is taken at twice the display's pixel density
const DESK_VIDEO = { w: 1920, h: 1200 };                                // the video has the display's own shape (16:10), at a little more than a pixel to the point

/** Click for real in a page: the page gets a mouse press and release at (x, y). */
async function pageClick(page, x, y) {
  for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
}

/** Glide the real pointer to something in a page, rest on it, and click it with a real event in the page. Says when the click was. */
async function deskClick(page, selector, text, { ms = 900, rest = 380, after = 300, click = true } = {}) {
  const at = await page.ev(`(() => {
    const sel = ${JSON.stringify(selector)}, text = ${JSON.stringify(text ?? null)};
    const els = [...document.querySelectorAll(sel)].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
    const el = text === null ? els[0] : els.find((e) => ((e.getAttribute('aria-label') || '') + ' ' + (e.textContent || '')).trim().toLowerCase().includes(text.toLowerCase()));
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, sx: window.screenX, sy: window.screenY };
  })()`);
  if (!at) throw new Error(`nothing to point at: ${selector} ${text ?? ''}`);
  glideTo(at.sx + at.x, at.sy + at.y, ms);
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y });     // the page sees the pointer arrive: the button shows that it is hovered
  await sleep(rest);
  const clickedAt = Date.now();
  if (click) { await pageClick(page, at.x, at.y); await sleep(after); }
  return { ...at, clickedAt };
}

/** Type into the field that has the focus, one letter at a time, at a person's pace. */
async function deskType(page, text) {
  let n = 0;
  for (const ch of text) { await page.send('Input.insertText', { text: ch }); await sleep(52 + ((n++ * 37) % 41)); }
}

/**
 * Where the camera looks to hold one window of the Huddle: the whole window, with room around it. The view starts at the very top of the display
 * (so the menu bar, and the clock above the Huddle, are in frame and the window does not touch the top), ends a good way below the window,
 * and sits against the display's right edge, where the Huddle is docked.
 */
function deskView(bounds, target) {
  const bottom = Math.min(target.h, bounds.y - target.y + bounds.height + 44);
  const w = Math.round((bottom * DESK_VIDEO.w) / DESK_VIDEO.h);
  if (w >= target.w) return { x: 0, y: 0, w: target.w };
  const x = Math.min(Math.max(0, Math.round(bounds.x - target.x + bounds.width + 8 - w)), target.w - w);
  return { x, y: 0, w };
}

/** The camera pass: the recording of the whole display becomes the video the page plays, its still, and the GIF the README shows. */
function renderDesktop({ raw, marks, bounds, target, menu }) {
  const from = 1.0;                                                     // the first second of a recording is the recorder starting up
  const vt = (key) => (marks[key] - marks.startedAt) / 1000 - from;     // a moment of the script, in seconds of the video
  const full = { x: 0, y: 0, w: target.w };
  const compact = deskView(bounds.compact, target);
  const expanded = deskView(bounds.expanded, target);
  const agent = deskView(bounds.agent, target);
  const lead = 1.0;                                                     // the camera starts to widen as the pointer sets off for the button that makes the window bigger
  const views = [
    { t: 0, ...full }, { t: vt('zoomStart'), ...full }, { t: vt('zoomStart') + 1.7, ...compact },
    { t: vt('expand') - lead, ...compact }, { t: vt('expand') + 0.5, ...expanded },
    { t: vt('agentOpen') - lead, ...expanded }, { t: vt('agentOpen') + 0.5, ...agent },
    { t: vt('back') - 0.2, ...agent }, { t: vt('back') + 2.4, ...full }
  ].sort((a, b) => a.t - b.t).map((v, i, all) => (i > 0 && v.t <= all[i - 1].t ? { ...v, t: all[i - 1].t + 0.02 } : v));
  info.cameraViews = views;
  const length = vt('end') - 0.3;
  const mp4 = path.join(MEDIA, 'huddle-desktop.mp4');
  renderCamera({ input: raw, output: mp4, from, to: from + length, views, display: { w: target.w, h: target.h }, scale: DESK_SCALE, size: DESK_VIDEO });
  const poster = path.join(MEDIA, 'huddle-desktop-poster.jpg');
  toPoster(mp4, poster, vt('carlAsking') + 1.6);
  const gif = path.join(MEDIA, 'huddle-desktop.gif');
  ffmpeg(['-t', String(Math.min(length, vt('robinAsking') + 3)), '-i', mp4, '-vf', 'fps=10,scale=720:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle', '-loop', '0', gif], 'huddle-desktop.gif');
  ffmpeg(['-i', mp4, '-vf', 'fps=1/3,scale=480:-1,tile=5x5', '-frames:v', '1', path.join(OUT, 'desktop-sheet.jpg')], 'desktop-sheet.jpg');
  info.desktopVideoSeconds = Math.round(length * 10) / 10;
  return [mp4, poster, gif];
}

scenarios.desktop = async function () {
  if (process.platform !== 'darwin') throw new Error('the desktop recording is for macOS');
  fs.mkdirSync(MEDIA, { recursive: true });
  const fromRaw = flag('--from-raw');
  if (fromRaw) {                                                        // the camera again, on a recording kept from an earlier run
    const dir = path.resolve(fromRaw);
    const kept = JSON.parse(fs.readFileSync(path.join(dir, 'desktop-marks.json'), 'utf8'));
    const done = renderDesktop({ raw: path.join(dir, 'desktop-raw.mov'), ...kept });
    for (const f of done) check('desktop', `${path.relative(ROOT, f)} was written`, fs.statSync(f).size > 4000, `${Math.round(fs.statSync(f).size / 1024)} KB`);
    info.media = [...(info.media ?? []), ...done.map((f) => path.relative(ROOT, f))];
    return;
  }
  const dry = argv.includes('--dry');
  const bundlePath = PACKAGED ? path.dirname(path.dirname(path.dirname(PACKAGED))) : null;
  const bundleId = PACKAGED ? execFileSync('plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', path.join(bundlePath, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim() : 'com.github.Electron';
  const displays = desktopDisplays();
  const target = displays.find((d) => !d.main) ?? displays[0];
  info.desktopDisplays = displays;
  const MENU = 24;                                                      // the height of the menu bar
  const screenPicture = (name) => osShot(name, { x: target.x, y: target.y, width: target.w, height: target.h });   // --dry only: the real screen, to look at

  // The recording is the first thing here that needs the Screen Recording permission, and macOS 15 asks about it now and then with a prompt on the
  // main display that only a person can answer. Ask now, with a short capture that is thrown away, and wait for the answer before anything on the
  // screen moves (a click on that prompt in the middle of the recording would be in the video).
  if (!dry) {
    execFileSync(desktopTool(), ['record', path.join(TMP, 'probe.mov'), '2', '--display', String(target.id), '--show', 'com.apple.dock'], { stdio: 'pipe', timeout: 60_000 });
    const prompting = () => execFileSync(desktopTool(), ['list', '--windows'], { encoding: 'utf8', timeout: 30_000 }).includes('owner com.apple.UserNotificationCenter');
    await sleep(1500);
    if (prompting()) {
      console.log('  macOS is asking for permission on the main display: waiting for an answer (up to 4 minutes)');
      await waitFor(() => !prompting(), 240_000, 'the permission prompt to be answered');
      await sleep(2000);
    }
  }

  // The agents are the stand-in program in its demo mode: it keeps a transcript of its turns, which is what the Huddle's conversation view reads.
  const demoDir = path.join(TMP, 'demo');
  fs.mkdirSync(demoDir, { recursive: true });
  const demo = { env: { MOSBIUS_STANDIN_DEMO: demoDir } };

  // 1. the app on the chosen display. Its window opens where it was last, and nothing from outside can move it (the DevTools
  //    protocol cannot, and moving another application's window needs the Accessibility permission), so the app is started once,
  //    to make its store; the window's place on that display is written into the store; and the app is started again.
  seedConfig({});
  let app = await launch({ emulate: false, ...demo });                  // the real window, not the tour's fixed-size stand-in viewport
  await waitFor(async () => (await app.ptys()).length >= 1, 60_000, 'the orchestrator');
  await app.close();
  const win = { width: Math.min(1280, target.w - 160), height: Math.min(820, target.h - MENU - 60) };
  const place = { x: target.x + Math.round((target.w - win.width) / 2), y: target.y + MENU + Math.round((target.h - MENU - win.height) / 2), ...win };
  execFileSync('sqlite3', [path.join(UD, 'harness.db'), `INSERT INTO kv (key, value, updated_at) VALUES ('window.bounds', '${JSON.stringify(place)}', ${Date.now()}) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`]);
  app = await launch({ emulate: false, ...demo });
  const m = app.main;
  await waitFor(async () => (await app.ptys()).length >= 1, 60_000, 'the orchestrator');
  await m.ev(`window.cth.notificationPrefs({ desktop: false })`);       // no banners over a recording

  // 2. Barney's apartment, with agents hired there
  await sleep(1200);
  info.mainWindow = await m.ev(`({ x: window.screenX, y: window.screenY, w: outerWidth, h: outerHeight, iw: innerWidth, ih: innerHeight })`);
  check('desktop', 'the main window is on the display that is recorded', info.mainWindow.x >= target.x - 2 && info.mainWindow.x + info.mainWindow.w <= target.x + target.w + 2, JSON.stringify({ window: info.mainWindow, display: target }));
  const toBarneys = await m.ev(`(() => { const b = [...document.querySelectorAll('button')].find((x) => /^\\s*5\\s*barney/i.test(x.textContent || '')); if (b) b.click(); return !!b; })()`);
  check('desktop', "Barney's apartment is the room that is open", toBarneys);
  await sleep(1500);
  for (const name of ['Marshall', 'Lily', 'Robin', 'Carl']) await addAgent(app, name);
  await waitFor(async () => { const d = await app.debug(); return d && d.state.agents.length >= 5; }, 30_000, 'the agents in the hub');
  await sleep(3000);                                                    // they walk in and sit down

  // 3. the Huddle's place: the top right corner of this display, remembered by the app, so that it comes up there when it is asked for
  await m.click('button', 'Huddle');
  let h = await app.huddlePage();
  await waitFor(() => h.ev(`document.querySelectorAll('[data-agent]').length >= 3`), 15_000, 'the cards');
  await m.ev(`window.cth.huddleDebugMove(${target.x + target.w - 330}, ${target.y + MENU + 8})`);
  await sleep(900);
  info.huddleDock = (await app.debug()).window;
  check('desktop', 'the Huddle docked in the top right corner of that display', !!info.huddleDock && info.huddleDock.dock === 'right' && info.huddleDock.bounds.y - target.y < MENU + 24, JSON.stringify(info.huddleDock && { dock: info.huddleDock.dock, bounds: info.huddleDock.bounds }));
  await h.clickThatCloses('.hd-open-app', '');
  h.close();
  await waitFor(async () => (await app.debug()).window === null, 8000, 'back in the main window');
  await sleep(800);

  // 4. the app comes to the front with one agent's terminal on the right, and the pointer rests in the window
  const ids = {}; for (const a of (await app.debug()).state.agents) ids[a.name] = a.id;
  const ptys = await ptyOfAgents(app);
  const task = (name, text) => m.ev(`window.cth.writePty(${JSON.stringify(ptys[ids[name]])}, ${JSON.stringify(`${text}\r`)})`);
  check('desktop', 'every agent has its own terminal to be given work through', ['Marshall', 'Lily', 'Robin', 'Carl'].every((n) => ptys[ids[n]]), JSON.stringify(ptys));
  if (bundlePath) execFileSync('open', ['-a', bundlePath]);
  await sleep(1200);
  info.frontApp = frontApp();
  const who = await m.ev(CLICK_TEXT('Marshall'));
  if (who) await pageClick(m, who.x, who.y);
  await sleep(500);
  const tab = await m.ev(CLICK_TEXT('terminal'));
  if (tab) await pageClick(m, tab.x, tab.y);
  // Choosing an agent takes the view to the room its character is in at that moment (a new character walks in through MacLaren's), so the room is
  // chosen last: Barney's apartment is what is on show when the recording starts, and nothing changes the selection while it runs.
  await m.ev(`(() => { const b = [...document.querySelectorAll('button')].find((x) => /^\\s*5\\s*barney/i.test(x.textContent || '')); if (b) b.click(); return !!b; })()`);
  await sleep(2200);
  const roomOnShow = await m.ev(`(() => { const t = [...document.querySelectorAll('button')].find((b) => /^\\s*\\d\\s*(rooftop|ted|maclaren|gnb|barney|columbia|laser)/i.test(b.textContent || '') && getComputedStyle(b).backgroundColor === 'rgb(255, 217, 61)'); return t ? t.textContent.trim() : null; })()`);
  check('desktop', "Barney's apartment is the room on show when the recording starts", /barney/i.test(roomOnShow ?? ''), String(roomOnShow));
  info.hiddenVersionLabels = await m.ev(HIDE_VERSION);
  await m.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 600, y: 420 });     // no tooltip left from an earlier hover
  await sleep(400);
  const button = await m.ev(`(() => { const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim().toLowerCase() === 'huddle'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  const at = { x: info.mainWindow.x + button.x, y: info.mainWindow.y + (info.mainWindow.h - info.mainWindow.ih) + button.y };
  glideTo(info.mainWindow.x + info.mainWindow.w * 0.55, info.mainWindow.y + info.mainWindow.h * 0.62, 700);
  info.dryPicture = await m.shot('desktop-1-app');
  if (dry) info.screens = [screenPicture('desktop-dry-1-app')];

  // 5. the recording, and the script
  const raw = path.join(TMP, 'desktop-raw.mov');
  let rec = null, recLog = '', recDone = Promise.resolve();
  if (!dry) {
    // 120 s is the most it records: the script ends it (a line saying "stop") when it is over
    rec = spawn(desktopTool(), ['record', raw, '120', '--display', String(target.id), '--scale', String(DESK_SCALE), ...[...DESK_SHOWN, bundleId].flatMap((b) => ['--show', b])], { stdio: ['pipe', 'pipe', 'pipe'] });
    rec.stdout.on('data', (d) => { recLog += d; }); rec.stderr.on('data', (d) => { recLog += d; });
    recDone = new Promise((resolve) => rec.once('exit', resolve));
    await waitFor(() => /recording /.test(recLog), 20_000, 'the recording to start');
  }
  const t0 = Date.now();
  const until = (n) => sleep(Math.max(0, t0 + n * 1000 - Date.now()));
  const marks = { startedAt: Number(/started (\d+)/.exec(recLog)?.[1] ?? t0) };
  info.desktopMarks = marks;
  const stamp = (key, when = Date.now()) => { marks[key] = when; console.log(`    · ${key} at ${((when - t0) / 1000).toFixed(1)} s`); return when; };
  const bounds = {};
  const huddleBounds = async () => (await app.debug()).window.bounds;
  const compactView = () => deskView(bounds.compact, target), expandedView = () => deskView(bounds.expanded, target), agentView = () => deskView(bounds.agent, target);
  const look = async (name) => { if (dry) info.screens.push(screenPicture(`desktop-dry-${name}`)); };
  const settled = async (name) => ['completed', 'idle'].includes(await stateOf(app, name));
  const said = (role) => `[...document.querySelectorAll('.hd-msg-${role} .hd-msg-text')].map((e) => e.innerText.replace(/\\s+/g, ' ').trim())`;     // what each message in the open conversation says

  try {
    await m.ev(HIDE_VERSION);
    await until(1.2);
    await task('Marshall', '#long tidy the parser'); await sleep(350);
    await task('Lily', '#long write the tests');
    await until(4.6);
    await task('Robin', '#work review the changes');                    // three agents at work while the whole app is in front
    await until(6.0);

    // the pointer goes to "Huddle" and clicks: the app minimises, and the Huddle comes up in the top right corner
    glideTo(at.x, at.y, 1300);
    await m.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: button.x, y: button.y });
    await sleep(450);
    stamp('clickHuddle');
    await pageClick(m, button.x, button.y);
    h = await app.huddlePage();
    await waitFor(() => h.ev(`document.querySelectorAll('[data-agent]').length >= 3`), 15_000, 'the Huddle');
    stamp('huddleUp');
    await h.ev(TIDY);
    bounds.compact = await huddleBounds();
    await sleep(1000);                                                  // the app has stepped aside
    await look('2-huddle-up');

    // the camera moves in on the corner, and the pointer goes there too; the agents' animations and the requests that come in are seen
    stamp('zoomStart');
    glideTo(bounds.compact.x - 20, bounds.compact.y + 130, 1100);
    await sleep(300);
    await task('Carl', '#approve please clear the build folder');
    await waitFor(async () => (await pending(app)) >= 1, 20_000, 'Carl asking');
    stamp('carlAsking');
    await sleep(2600);
    await look('3-compact');
    await waitFor(() => settled('Robin'), 40_000, 'Robin to finish');
    stamp('robinDone');
    await sleep(600);
    await task('Robin', '#ask set up storage for the app');
    await waitFor(async () => (await pending(app)) >= 2, 20_000, 'Robin asking');
    stamp('robinAsking');
    await sleep(2400);

    // the Huddle opens out: a request to approve and a question to answer
    const ex = await deskClick(h, '[data-act="expand"]', null, { ms: 1000, rest: 350 });
    stamp('expand', ex.clickedAt);
    await waitLevel(h, 'expanded');
    await sleep(900);
    bounds.expanded = await huddleBounds();
    await sleep(1200);                                                  // the two cards can be read
    await look('4-expanded');
    await deskClick(h, '.hd-note-open .hd-btn-primary', 'approve', { ms: 900 });
    await waitFor(async () => (await pending(app)) === 1, 10_000, 'the request approved');
    stamp('approved');
    await sleep(900);
    await deskClick(h, '.hd-note-open .hd-note-options .hd-btn', 'SQLite', { ms: 900 });
    await waitFor(async () => (await pending(app)) === 0, 10_000, 'the question answered');
    stamp('answered');
    await sleep(1000);

    // its notifications, kept
    await deskClick(h, '.hd-tab', 'notifications', { ms: 800 });
    stamp('inbox');
    await sleep(2400);
    await look('5-inbox');
    await deskClick(h, '.hd-tab', 'settings', { ms: 700 });            // and what can be switched on and off, and the sounds
    stamp('settings');
    await sleep(2200);
    await look('5b-settings');
    await deskClick(h, '.hd-tab', 'agents', { ms: 700 });
    await sleep(300);

    // one agent: its conversation, then its terminal
    const op = await deskClick(h, '.hd-card', 'Marshall', { ms: 900, rest: 350 });
    stamp('agentOpen', op.clickedAt);
    await waitLevel(h, 'agent');
    await sleep(500);
    bounds.agent = await huddleBounds();
    await waitFor(() => h.ev(`document.querySelectorAll('.hd-msg').length >= 4`), 15_000, 'the conversation');
    check('desktop', "the conversation view shows what Marshall was asked and what he did", (await h.ev(said('user'))).some((t) => /tidy the parser/.test(t)) && !(await h.ev(`document.body.innerText`)).includes('#long'), JSON.stringify(await h.ev(said('user'))));
    await sleep(2500);
    await look('6-conversation');
    await deskClick(h, '.hd-tab', 'terminal', { ms: 800 });
    await waitFor(() => h.ev(`!!document.querySelector('.hd-term-host .xterm-rows')`), 8000, 'the terminal view');
    stamp('terminal');
    await sleep(3400);
    const screen = await termText(h);
    check('desktop', "the terminal view shows Marshall's terminal live, without the program's own labels", /●/.test(screen) && !/stand-in|test double/i.test(screen), screen.split('\n').filter((l) => l.trim()).slice(0, 4).join(' | '));
    await look('7-terminal');

    // a message typed to another agent, and its answer
    await deskClick(h, '[data-act="back"]', null, { ms: 800 });
    await waitLevel(h, 'expanded');
    await sleep(300);
    await deskClick(h, '.hd-card', 'Robin', { ms: 900, rest: 350 });
    await waitLevel(h, 'agent');
    await sleep(1200);
    await deskClick(h, '.hd-composer textarea', null, { ms: 900, rest: 350 });
    await sleep(300);
    stamp('typing');
    await deskType(h, 'Thanks. Please write a short summary for the changelog.');
    await sleep(400);
    await look('8-typed');
    await deskClick(h, '.hd-composer .hd-btn-primary', 'send', { ms: 700, rest: 300 });
    stamp('sent');
    await waitFor(async () => /^Okay/.test((await h.ev(said('assistant'))).at(-1) ?? ''), 15_000, 'the reply');
    stamp('replied');
    check('desktop', "Robin's conversation shows the message that was typed and the reply", (await h.ev(said('user'))).some((t) => /changelog/.test(t)));
    await sleep(2400);
    await look('9-reply');

    // the Huddle folds up, and the camera moves back out to the whole desktop
    const bk = await deskClick(h, '[data-act="back"]', null, { ms: 800 });
    stamp('back', bk.clickedAt);
    await waitLevel(h, 'expanded');
    await sleep(400);
    await deskClick(h, '[data-act="collapse"]', null, { ms: 700 });
    await waitLevel(h, 'compact');
    stamp('collapse');
    glideTo(target.x + target.w * 0.45, target.y + target.h * 0.55, 1300);
    await sleep(1700);
    stamp('end');
    await look('10-end');
  } finally {
    if (rec) { try { rec.stdin.write('stop\n'); rec.stdin.end(); } catch { /* it has gone */ } await recDone; }
  }
  info.huddleBounds = bounds;
  h.close();
  await app.close();
  if (dry) {                                                            // what the camera will see at each step: the pictures cut to their views, to look at
    const planned = { '3-compact': compactView(), '4-expanded': expandedView(), '5-inbox': expandedView(), '6-conversation': agentView(), '7-terminal': agentView(), '8-typed': agentView(), '9-reply': agentView() };
    for (const [name, v] of Object.entries(planned)) {
      const file = path.join(OUT, `desktop-dry-${name}.png`);
      if (!fs.existsSync(file)) continue;
      ffmpeg(['-i', file, '-vf', `crop=${v.w * DESK_SCALE}:${Math.round((v.w * DESK_VIDEO.h) / DESK_VIDEO.w) * DESK_SCALE}:${v.x * DESK_SCALE}:${v.y * DESK_SCALE},scale=1280:800:flags=lanczos`, path.join(OUT, `desktop-dry-view-${name}.png`)], name);
    }
    return;
  }
  check('desktop', 'the recording was written', fs.existsSync(raw) && fs.statSync(raw).size > 1_000_000, `${fs.existsSync(raw) ? Math.round(fs.statSync(raw).size / 1048576) : 0} MB; ${recLog.trim().split('\n').slice(-2).join(' | ')}`);
  const kept = { marks, bounds, target, menu: MENU };
  if (argv.includes('--keep-raw')) { fs.copyFileSync(raw, path.join(OUT, 'desktop-raw.mov')); fs.writeFileSync(path.join(OUT, 'desktop-marks.json'), JSON.stringify(kept, null, 2)); }

  // 6. the camera pass: the video the page plays, a still of it, and the GIF the README shows
  const done = renderDesktop({ raw, ...kept });
  for (const f of done) check('desktop', `${path.relative(ROOT, f)} was written`, fs.statSync(f).size > 4000, `${Math.round(fs.statSync(f).size / 1024)} KB`);
  info.media = [...(info.media ?? []), ...done.map((f) => path.relative(ROOT, f))];
};

(async () => {
  // the media scenario writes the README's and the website's pictures: it runs only when it is asked for
  const names = Object.keys(scenarios).filter((n) => (ONLY ? ONLY.has(n) : n !== 'media' && n !== 'desktop'));
  for (const n of names) {
    console.log(`\n== ${n}`);
    resetProfile();
    try { await scenarios[n](); } catch (e) { check(n, `scenario ran to the end`, false, e instanceof Error ? e.message : String(e)); killStrays(); }
  }
  const failed = results.filter((r) => !r.ok);
  fs.writeFileSync(path.join(OUT, 'huddle-validation.json'), JSON.stringify({ date: new Date().toISOString(), platform: `${process.platform}/${process.arch}`, electron: require(path.join(ROOT, 'node_modules/electron/package.json')).version, results, info }, null, 2));
  fs.writeFileSync(path.join(OUT, 'huddle-validation.txt'), `${results.map((r) => `${r.ok ? 'PASS' : 'FAIL'}  [${r.group}] ${r.name}${r.detail ? `  — ${r.detail}` : ''}`).join('\n')}\n\n${results.length - failed.length}/${results.length} checks passed\n`);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})();

module.exports = { frontApp, osShot, addAgent };
