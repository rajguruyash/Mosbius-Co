'use strict';

/**
 * The Huddle's wiring, as contracts on the source: every channel a window calls has a handler, every handler checks which
 * page is calling, the floating window has the flags that make it a floating window that does not steal the keyboard,
 * the two bridges expose only what they should, and index.ts calls the runtime at each real lifecycle point.
 * (The behaviour behind these is exercised by the unit tests and by tools/huddle-validate.cjs against the real app.)
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const setup = read('src/main/huddleSetup.ts');
const windowSrc = read('src/main/huddleWindow.ts');
const indexSrc = read('src/main/index.ts');
const preloadMain = read('src/preload/index.ts');
const preloadHuddle = read('src/preload/huddle.ts');

const handled = new Set([...setup.matchAll(/ipcMain\.(?:handle|on)\('([^']+)'/g)].map((m) => m[1]));
const called = (src) => [...src.matchAll(/ipcRenderer\.(?:invoke|send)\(\s*'([^']+)'/g)].map((m) => m[1]);

test('every channel the Huddle window calls has a handler in the main process', () => {
  for (const ch of called(preloadHuddle)) assert.ok(handled.has(ch), `no handler for ${ch}`);
});

test('every Huddle and notification channel the main window calls has a handler', () => {
  const mine = called(preloadMain).filter((c) => /^(huddle:|notify:|app:reportLanguage)/.test(c));
  assert.ok(mine.length >= 10, `${mine.length} found`);
  for (const ch of mine) assert.ok(handled.has(ch), `no handler for ${ch}`);
});

test('every handler checks which page is calling before it does anything', () => {
  const blocks = [...setup.matchAll(/ipcMain\.(handle|on)\('([^']+)'/g)];
  assert.ok(blocks.length >= 20);
  for (const m of blocks) {
    const body = setup.slice(m.index, m.index + 700);
    assert.match(body, /from(Main|Huddle|Either)Page\(evt\)|fromEither\(evt\)/, `${m[2]} does not check its sender`);
  }
});

test('what only the Huddle window may do, only the Huddle window can; what only the main window may do, likewise', () => {
  const only = (chan, fn) => { const i = setup.search(new RegExp(`ipcMain\\.(?:handle|on)\\('${chan}'`)); assert.ok(i > 0, chan); assert.match(setup.slice(i, i + 400), new RegExp(fn), `${chan} should use ${fn}`); };
  for (const c of ['huddle:setLevel', 'huddle:command', 'huddle:terminalAttach', 'huddle:terminalDetach', 'huddle:conversation', 'huddle:pickFiles', 'huddle:previewFile', 'huddle:pasteImage', 'huddle:keyboard']) only(c, 'fromHuddlePage');
  for (const c of ['huddle:publishRoster', 'huddle:commandDone', 'huddle:enter']) only(c, 'fromMainPage');
});

test('the Huddle window is a frameless, transparent, always-on-top window that is not in the taskbar and cannot take the keyboard', () => {
  for (const flag of ['frame: false', 'transparent: true', 'alwaysOnTop: true', 'skipTaskbar: true', 'focusable: false', 'acceptFirstMouse: true', 'resizable: false', 'show: false']) {
    assert.ok(windowSrc.includes(flag), flag);
  }
  assert.match(windowSrc, /sandbox: true/);
  assert.match(windowSrc, /contextIsolation: true/);
  assert.match(windowSrc, /nodeIntegration: false/);
  assert.match(windowSrc, /showInactive\(\)/, 'it appears without taking focus');
  assert.match(windowSrc, /setVisibleOnAllWorkspaces/, 'and stays with the person across Spaces and over full-screen apps');
  assert.doesNotMatch(windowSrc, /type: 'panel' as const/, 'the panel type is rejected by macOS on this window class');
  // the only places that give it focus are the ones the person asked for
  const focusCalls = [...windowSrc.matchAll(/\.focus\(\)/g)].length;
  assert.ok(focusCalls <= 2, `${focusCalls} focus() calls`);
  assert.match(windowSrc, /setKeyboard\(on: boolean\)/);
});

test('it is not added to the main process\'s own window list, so global events never go to it by accident', () => {
  assert.doesNotMatch(windowSrc, /allWindows/);
  assert.match(setup, /allWindows: \(\) => allWindows|allWindows\(\)/);
});

test('the build produces both preloads and both pages', () => {
  const cfg = read('electron.vite.config.ts');
  assert.match(cfg, /huddle: resolve\(__dirname, 'src\/preload\/huddle\.ts'\)/);
  assert.match(cfg, /huddle: resolve\(__dirname, 'src\/renderer\/huddle\.html'\)/);
  assert.match(windowSrc + setup, /preload\/huddle\.js/);
  assert.match(setup, /renderer\/huddle\.html/);
});

test('the Huddle page loads nothing from the network and runs no inline script', () => {
  const html = read('src/renderer/huddle.html');
  assert.match(html, /default-src 'self'/);
  assert.match(html, /script-src 'self'/);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/);
  assert.doesNotMatch(html, /https?:\/\//);
});

test('the Huddle bridge exposes only the named surface: it cannot read files, change settings or reach integrations', () => {
  const body = preloadHuddle.slice(preloadHuddle.indexOf('const api = {'), preloadHuddle.indexOf('contextBridge.exposeInMainWorld'));
  const keys = [...body.matchAll(/^  (\w+):/gm)].map((m) => m[1]).sort();
  assert.deepEqual(keys, [
    'clearNotifications', 'command', 'conversation', 'debug', 'debugMove', 'exit', 'keyboard', 'markAllRead', 'markRead', 'notifications', 'onNotifications',
    'onOpenAgent', 'onState', 'onTerminalData', 'onTerminalExit', 'onTerminalGeometry', 'openSystemNotificationSettings', 'pasteImage', 'pathForFile', 'pickFiles',
    'platform', 'previewFile', 'previewNotificationSound', 'reportLanguage', 'resolve', 'setLevel', 'setNotificationPrefs', 'state', 'terminalAttach', 'terminalDetach', 'testNotification'
  ].sort());
  assert.doesNotMatch(body, /readFile|writeFile|integrations|getConfig|updateConfig|spawnPty|writePty|killPty|openExternal/);
});

test('the sounds are wired to real events only: a preview is its own validated channel, a start rings the soft cue, the volume is read when a sound plays', () => {
  assert.match(setup, /ipcMain\.handle\('notify:previewSound'[\s\S]{0,260}isSoundKind\(kind\)[\s\S]{0,160}notifications\.previewSound\(kind\)/, 'a preview is checked and plays only the sound');
  assert.match(preloadMain, /notificationPreviewSound:[^\n]*'notify:previewSound'/);
  assert.match(preloadHuddle, /previewNotificationSound:[^\n]*'notify:previewSound'/);
  assert.match(setup, /createSoundPort\(userData, \(\) => notifications\.volume\(\), bundledSounds\)/, 'the slider is read each time a sound plays');
  assert.match(setup, /const bundledSounds = app\.isPackaged \? join\(process\.resourcesPath, 'sounds'\) : join\(app\.getAppPath\(\), 'resources', 'sounds'\)/, 'the sounds that ship are looked for where electron-builder puts them, and in the repo in a development run');
  assert.match(setup, /cues: \{ \.\.\.cur\.cues, \.\.\.\(patch\.cues \?\? \{\}\) \}/, 'a patch that names one sound\'s switch does not change the others');
  assert.match(setup, /playSound: \(k, o\) => sound\.play\(k, o\)/, 'the service decides when one sound takes over from another, the port does it');
  assert.match(setup, /sounds: sound\.history\(\)/, 'the real-app tour can read which sounds the port was asked for');
  const lifecycle = read('src/main/lifecycleWiring.ts');
  assert.match(lifecycle, /s\.kind === 'started'[\s\S]{0,500}notifications\.cue\('started'\)/, 'a real start rings the soft cue');
  const delivery = read('src/main/notifyDelivery.ts');
  assert.match(delivery, /MOSBIUS_UI_TEST === '1' && process\.env\.MOSBIUS_SOUND_AUDIBLE !== '1'/, 'a test run plays at zero unless it was asked to be heard');
  assert.doesNotMatch(setup.slice(setup.indexOf("'notify:previewSound'"), setup.indexOf("'notify:previewSound'") + 400), /ingest\(|showDesktop|notifications\.snapshot/, 'a preview raises nothing');
});

test('the test-only seams exist only when the real-app tour started the app', () => {
  assert.match(setup, /process\.env\.MOSBIUS_UI_TEST === '1'/);
  const i = setup.indexOf("'huddle:debug'");
  assert.ok(i > setup.indexOf("MOSBIUS_UI_TEST === '1'"), 'the debug handlers sit inside the gate');
  assert.match(setup, /MOSBIUS_TEST_PICK/);
});

test('index.ts calls the runtime at every real lifecycle point', () => {
  for (const call of ['huddle?.noteSpawn(', 'huddle?.noteExit(', 'huddle?.noteControl(', 'huddle?.noteBreaker(', 'huddle?.noteMcpAudit(', 'huddle?.noteHiveMessage(', 'huddle?.noteUserWrite(', 'huddle?.appActivated()', 'huddle?.leaveHuddle()', 'huddle?.window.mainWindowReturned()', 'hookServer.setObserver(']) {
    assert.ok(indexSrc.includes(call), call);
  }
  assert.ok((indexSrc.match(/huddle\?\.noteControl\(/g) ?? []).length >= 3, 'pause, resume and halt all report');
  assert.ok((indexSrc.match(/huddle\?\.noteExit\(/g) ?? []).length >= 2, 'a natural exit and every teardown report');
  assert.match(indexSrc, /huddle\?\.noteMcpAudit\([^)]*decision: e\.decision/g);
});

test('a REST request an agent was refused for lack of access reaches the notification service through the one audit function', () => {
  const fn = /function recordAudit\([\s\S]*?\n\}/.exec(indexSrc);
  assert.ok(fn, 'recordAudit not found');
  assert.match(fn[0], /e\.kind === 'rest'[\s\S]*huddle\?\.noteMcpAudit\(\{ agentId: e\.agentId, integrationId: e\.integrationId, decision: e\.decision, reason: e\.reason \}\)/);
  // and the REST block of the broker stays what it was: it records, and the funnel does the rest
  const rest = /rest: \{\s*grants: currentRestGrants,\s*audit: \(e\) => recordAudit\(\{\s*kind: 'rest'/.exec(indexSrc);
  assert.ok(rest, 'the REST audit callback records through recordAudit');
});

test('the legacy toasts stand down for events the service now owns, and the service is the only new place that shows a banner', () => {
  assert.match(indexSrc, /if \(lifecycle && huddle\) return;/);
  for (const f of ['huddleSetup.ts', 'huddleHub.ts', 'huddleWindow.ts', 'notifyService.ts', 'notifyActions.ts', 'activityTracker.ts', 'lifecycleWiring.ts']) {
    assert.doesNotMatch(read(`src/main/${f}`), /new Notification\(/, f);
  }
  assert.match(read('src/main/notifyDelivery.ts'), /new Notification\(/);
});

test('Restart in the Huddle runs the same steps as the Command Center\'s button: one function, two callers', () => {
  const helper = read('src/renderer/src/agents/restartAgent.ts');
  assert.match(helper, /export async function restartAgentSession/);
  assert.match(read('src/renderer/src/components/CommandCenterPanel.tsx'), /restartAgentSession\(/);
  assert.match(read('src/renderer/src/huddle/useHuddleBridge.ts'), /restartAgentSession\(/);
});

test('a message sent from the Huddle goes into the main window\'s own queue, never straight into a terminal', () => {
  const hub = read('src/main/huddleHub.ts');
  assert.match(hub, /'hive:enqueueToAgent'/);
  const send = hub.slice(hub.indexOf("case 'send'"), hub.indexOf("case 'pause'"));
  assert.doesNotMatch(send, /ptyWrite/, 'send must not type into a terminal');
});

test('closing the app while the Huddle is up brings the main window back first, so the quit question can be seen', () => {
  const i = indexSrc.indexOf("app.on('before-quit'");
  const block = indexSrc.slice(i, i + 900);
  assert.match(block, /huddle\?\.leaveHuddle\(\)/);
  assert.match(block, /isMinimized\(\)\) mainWindow\.restore\(\)/);
});

test('disposal: closing the Huddle window removes every terminal tap and every display listener it made', () => {
  assert.match(setup, /onClosed: \(wc\) => \{ deps\.ptyManager\.removeTapsFor\(wc\); \}/);
  assert.match(windowSrc, /stopWatchingDisplays/);
  assert.match(windowSrc, /screen\.removeListener\('display-added'/);
  assert.match(setup, /clearInterval\(askTimer\)/);
});
