'use strict';

/**
 * The Huddle's words and motion: every string the UI asks for exists in English, Simplified Chinese and Arabic with its
 * placeholders intact; every state has a character motion built from poses the art really has; the attention schedule is
 * gentle and finite; the notification text the main process sends exists in all three languages.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const LOCALES = { en: JSON.parse(read('src/renderer/src/i18n/locales/en.json')), 'zh-CN': JSON.parse(read('src/renderer/src/i18n/locales/zh-CN.json')), ar: JSON.parse(read('src/renderer/src/i18n/locales/ar.json')) };
const get = (tree, key) => key.split('.').reduce((o, p) => (o && typeof o === 'object' ? o[p] : undefined), tree);
const leaves = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? leaves(v, `${p}${k}.`) : [`${p}${k}`]));
const placeholders = (s) => [...new Set([...String(s).matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]))].sort();

const { AGENT_STATES } = loadTs('src/shared/agentActivity.ts');
const N = loadTs('src/shared/notifications.ts');
const M = loadTs('src/renderer/src/huddle/characterMotion.ts');
const A = loadTs('src/renderer/src/huddle/attention.ts');

const UI_FILES = ['AgentPanel.tsx', 'HuddleApp.tsx', 'NotificationCard.tsx', 'PrefsPanel.tsx', 'format.ts', 'HuddleCharacter.tsx'].map((f) => `src/renderer/src/huddle/${f}`)
  .concat(['src/renderer/src/components/NotificationBell.tsx', 'src/renderer/src/components/NotificationSettings.tsx', 'src/renderer/src/App.tsx']);

/** Every `huddle.` / `notify.` key the UI asks for as a literal, plus each family built at run time. */
function wanted() {
  const keys = new Set();
  for (const f of UI_FILES) for (const m of read(f).matchAll(/['"`]((?:huddle|notify)\.[A-Za-z0-9_.-]+)['"`]/g)) if (!m[1].endsWith('.')) keys.add(m[1]);
  for (const s of AGENT_STATES) keys.add(`huddle.state.${s}`);
  const verbs = ['starting', 'thinking', 'running', 'reading', 'editing', 'searching', 'finding', 'fetching', 'searchingWeb', 'delegating', 'planning', 'usingTool', 'compacting', 'idle', 'finished', 'askingApproval', 'askingQuestion', 'paused', 'stopping', 'stopped', 'failed', 'looping', 'waiting'];
  for (const v of verbs) keys.add(`huddle.activity.${v}`);
  for (const v of ['running', 'reading', 'editing', 'searching', 'finding', 'fetching', 'searchingWeb', 'delegating', 'usingTool', 'askingApproval', 'failed', 'looping']) keys.add(`huddle.activity.${v}Bare`);
  for (const a of ['approved', 'rejected', 'alternative', 'option', 'answered', 'dismissed', 'opened', 'resolved']) keys.add(`huddle.notifications.outcome.${a}`);
  for (const b of ['user', 'agent', 'system']) keys.add(`huddle.notifications.by.${b}`);
  for (const c of N.NOTIFICATION_CATEGORIES) keys.add(`huddle.notifications.category.${c}`);
  for (const s of ['unknown', 'ok', 'unsupported', 'blocked']) keys.add(`huddle.prefs.desktopStatus.${s}`);
  for (const k of N.SOUND_KINDS) for (const part of ['name', 'hint']) keys.add(`huddle.prefs.sounds.cue.${k}.${part}`);
  for (const e of ['unknown-agent', 'no-terminal', 'not-running', 'main-window-unavailable', 'not-for-orchestrator', 'invalid-command', 'forbidden', 'timed-out']) keys.add(`huddle.errors.${e}`);
  return [...keys].filter((k) => !/\$\{/.test(k)).sort();
}

test('the three languages have exactly the same Huddle and notification keys', () => {
  for (const group of ['huddle', 'notify']) {
    const en = leaves(LOCALES.en[group], `${group}.`).sort();
    assert.ok(en.length > (group === 'huddle' ? 120 : 25), `${group}: ${en.length} keys`);
    for (const lang of ['zh-CN', 'ar']) assert.deepEqual(leaves(LOCALES[lang][group], `${group}.`).sort(), en, `${group} in ${lang}`);
  }
});

test('every string the UI asks for exists in all three languages and is not empty', () => {
  const keys = wanted();
  assert.ok(keys.length > 100, `${keys.length} keys`);
  for (const [lang, tree] of Object.entries(LOCALES)) {
    for (const k of keys) {
      const v = get(tree, k);
      assert.ok(typeof v === 'string' && v.trim().length > 0, `${lang} is missing ${k}`);
    }
  }
});

test('placeholders survive translation', () => {
  for (const group of ['huddle', 'notify']) {
    for (const k of leaves(LOCALES.en[group], `${group}.`)) {
      const en = placeholders(get(LOCALES.en, k));
      for (const lang of ['zh-CN', 'ar']) {
        assert.deepEqual(placeholders(get(LOCALES[lang], k)), en, `${lang} ${k}`);
      }
    }
  }
});

test('every notification the main process can build has text in all three languages', () => {
  const agent = { id: 'a', name: 'Ada' };
  const intents = [
    N.intentFromAccessDenied(agent, { integrationId: 'github' }), N.intentFromAccessDenied(agent, { integrationId: 'github', tool: 't' }),
    N.intentFromHumanAsk(agent, { subject: 's', question: 'q', key: 'k', taskId: 't' }), N.intentFromStuckPrompt(agent, 1)
  ];
  const req = { id: 'x', kind: 'approval', source: 'permission', preview: 'p', tool: 'Bash', automatable: true, since: 1 };
  const signals = [
    { kind: 'approval-requested', request: req }, { kind: 'approval-requested', request: { ...req, tool: undefined } },
    { kind: 'input-requested', request: { ...req, kind: 'input', options: ['a'] } }, { kind: 'input-requested', request: { ...req, kind: 'input' } },
    { kind: 'turn-completed', ms: 1, tools: 3, substantial: true, userInitiated: true }, { kind: 'turn-completed', ms: 1, tools: 0, substantial: true, userInitiated: true },
    { kind: 'crashed', message: 'm', exitCode: 1 }, { kind: 'crashed', message: '', exitCode: 1 }, { kind: 'breaker', level: 'constrained', reason: 'r' }, { kind: 'breaker', level: 'stopped', reason: 'r' },
    { kind: 'idle-waiting' }, { kind: 'stopped' }, { kind: 'paused' }, { kind: 'resumed' }
  ];
  for (const s of signals) { const i = N.intentFromSignal(agent, s, 1); assert.ok(i, s.kind); intents.push(i); }
  const keys = new Set(['notify.more', 'notify.moreTitle', 'notify.test.title', 'notify.test.body']);
  for (const i of intents) { keys.add(i.title.key); keys.add(i.body.key); }
  for (const lang of Object.keys(LOCALES)) {
    for (const k of keys) assert.ok(typeof get(LOCALES[lang], k) === 'string', `${lang} is missing ${k}`);
    // and each renders without a stray placeholder left over
    for (const i of intents) {
      for (const t of [i.title, i.body]) assert.ok(!/\{\{/.test(N.renderText(LOCALES[lang], t)), `${lang} ${t.key}`);
    }
  }
});

test('every state has a motion, built only from poses the character art really has', () => {
  assert.ok(M.allStatesCovered());
  const poses = [...read('src/renderer/src/scene/office/portraitArt.ts').match(/export type ExportPose =([^;]*);/)[1].matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);
  assert.ok(poses.length >= 9);
  for (const s of AGENT_STATES) {
    const m = M.MOTION[s];
    assert.ok(m.frames.length >= 1 && m.frames.every((f) => poses.includes(f)), `${s}: ${m.frames}`);
    assert.ok(m.fps > 0 && m.fps <= 8, `${s} fps ${m.fps}`);
    assert.ok(m.opacity > 0 && m.opacity <= 1);
    if (m.glyph) assert.ok(M.GLYPH_ART[m.glyph] && M.GLYPH_COLOR[m.glyph], `${s} glyph ${m.glyph}`);
  }
});

test('states that ask for a person move to ask; the resting states do not; and each of the three asking states moves differently', () => {
  const asking = AGENT_STATES.filter((s) => M.MOTION[s].attention !== 'none').sort();
  assert.deepEqual(asking, ['error', 'needs-approval', 'needs-input']);
  assert.equal(new Set(asking.map((s) => M.MOTION[s].attention)).size, 3, 'bounce, glow and shake are all different');
  const glyphs = AGENT_STATES.map((s) => M.MOTION[s].glyph).filter(Boolean);
  assert.equal(new Set(glyphs).size, glyphs.length, 'each state has its own symbol');
});

test('a person who asked for less motion gets a still character', () => {
  for (const s of AGENT_STATES) {
    const r = M.motionFor(s, true);
    assert.equal(r.frames.length, 1);
    assert.equal(r.frames[0], M.MOTION[s].frames[0]);
  }
  assert.ok(M.motionFor('working', false).frames.length > 1);
});

test('the glyph art is seven wide, and every glyph has ink', () => {
  for (const [g, rows] of Object.entries(M.GLYPH_ART)) {
    assert.ok(rows.length >= 7, g);
    assert.ok(rows.every((r) => r.length === 7), `${g} rows are 7 wide`);
    assert.ok(rows.some((r) => r.includes('#')), g);
    assert.match(M.GLYPH_COLOR[g], /^#[0-9a-f]{6}$/);
  }
});

test('the attention schedule: at once, then 20s, 1min, 3min, then every 5min; a burst is short; the reminders never get closer', () => {
  assert.equal(A.nextBurstDelay(0), 0);
  assert.deepEqual(A.burstStarts(6), [0, 20_000, 60_000, 180_000, 480_000, 780_000]);
  assert.ok(A.BURST_MS < 4000);
  for (let n = 1; n < 12; n++) assert.ok(A.nextBurstDelay(n + 1) >= A.nextBurstDelay(n), `burst ${n}`);
  assert.ok(A.BURST_MS < A.nextBurstDelay(1), 'a burst has finished before the next one');
});

test('the Huddle asks for less motion when the system does', () => {
  const css = read('src/renderer/src/huddle/huddle-ui.css');
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(read('src/renderer/src/huddle/HuddleCharacter.tsx'), /prefers-reduced-motion/);
});

test('the Huddle follows the language and theme chosen in the main window, and right-to-left', () => {
  const main = read('src/renderer/src/huddle/main.tsx');
  assert.match(main, /e\.key === 'cth\.language'/);
  assert.match(main, /e\.key === 'cth\.theme'/);
  assert.match(read('src/renderer/src/huddle/HuddleApp.tsx'), /useDirectionSync\(\)/);
});

test('a confirmation under the composer clears itself, and no toast is raised beside the inbox that already lists it', () => {
  const panel = read('src/renderer/src/huddle/AgentPanel.tsx');
  assert.match(panel, /setTimeout\(\(\) => setNote\(null\)/, 'the "queued" confirmation times out');
  assert.match(panel, /setNote\(\(n\) => \(n && n\.kind === 'ok' \? null : n\)\)/, 'and goes as soon as a new draft is begun');
  const bell = read('src/renderer/src/components/NotificationBell.tsx');
  assert.match(bell, /document\.hasFocus\(\) \|\| openRef\.current/, 'an open inbox is not duplicated by a toast');
});

test('the compact list spaces its cards once, so the height the window is given is the height the cards need', () => {
  const css = read('src/renderer/src/huddle/huddle-ui.css');
  assert.match(css, /\.hd-list > \.hd-card \{ margin: 0; \}/, 'no margin on top of the list gap (that made every card cost 8px and clipped the last)');
  assert.match(css, /\.hd-list \{[^}]*gap: 4px/);
  const H = loadTs('src/shared/huddle.ts');
  // measured in the real window by tools/huddle-validate.cjs: a 76px card plus the 4px gap
  assert.equal(H.COMPACT.card, 80);
  assert.equal(H.levelSize('compact', 4, { x: 0, y: 0, width: 1920, height: 1080 }).height, H.COMPACT.header + 4 * 80 + H.COMPACT.footer);
});

test('the Huddle header drags the window, and the buttons inside it still click', () => {
  const css = read('src/renderer/src/huddle/huddle-ui.css');
  assert.match(css, /\.hd-header\s*\{[^}]*-webkit-app-region:\s*drag/);
  assert.match(css, /\.hd-header button\s*\{[^}]*-webkit-app-region:\s*no-drag/);
});

test('Settings and the Huddle both offer the sounds: a volume slider, the start-sound switch, and a play button for every sound', () => {
  const panel = read('src/renderer/src/huddle/PrefsPanel.tsx');
  assert.match(panel, /SOUND_KINDS\.map/, 'a button for every sound the app makes');
  assert.match(panel, /data-sound-preview=\{kind\}/);
  assert.match(panel, /type="range"[\s\S]{0,120}min=\{0\}[\s\S]{0,40}max=\{100\}/);
  assert.match(panel, /data-sound-switch=\{kind\}/, 'a switch beside each sound\'s play button');
  assert.match(panel, /set\(\{ cues: \{ \[kind\]: e\.target\.checked \} \}\)/, 'it changes that one sound and no other');
  assert.match(panel, /kind === 'signature'[\s\S]{0,260}hd-sound-switch-gap/, 'the signature tune, which no event rings, has none');
  assert.doesNotMatch(panel, /startSound/, 'the start sound is one of the switches now, not a switch of its own');
  assert.match(panel, /void api\.previewSound\(kind\)/, 'a button plays the sound and does nothing else');
  assert.doesNotMatch(panel, /notificationResolve|notificationsTest|ingest/, 'a preview is not a notification');
  assert.match(read('src/renderer/src/components/NotificationSettings.tsx'), /previewSound: \(kind\) => window\.cth\.notificationPreviewSound\(kind\)/, 'Settings → General → Notifications');
  assert.match(read('src/renderer/src/huddle/HuddleApp.tsx'), /previewSound: \(kind\) => window\.huddle\.previewNotificationSound\(kind\)/, 'the Huddle\'s own panel');
});

test('the sounds section reads in all three languages: every label, every sound\'s name and hint, and the {{name}} of the play button', () => {
  for (const [lng, tree] of Object.entries(LOCALES)) {
    const s = get(tree, 'huddle.prefs.sounds');
    for (const k of ['title', 'volume', 'switch', 'previews', 'play', 'previewHint', 'previewHintOff']) assert.equal(typeof s[k], 'string', `${lng}: ${k}`);
    assert.deepEqual(placeholders(s.play), ['name'], `${lng}: the play label carries the sound's name`);
    assert.deepEqual(placeholders(s.switch), ['name'], `${lng}: and so does the switch's`);
    for (const kind of N.SOUND_KINDS) {
      assert.ok(s.cue[kind] && s.cue[kind].name && s.cue[kind].hint, `${lng}: ${kind}`);
      assert.deepEqual(placeholders(s.cue[kind].name), [], `${lng}: ${kind}`);
    }
    assert.deepEqual(Object.keys(s.cue).sort(), [...N.SOUND_KINDS].sort(), `${lng}: no sound is missing or left over`);
  }
});

test('the slider and the play buttons are laid out for both reading directions and for the narrow Huddle', () => {
  const css = read('src/renderer/src/huddle/huddle-ui.css');
  assert.match(css, /\.hd-sound-play:dir\(rtl\)::before \{ transform: scaleX\(-1\); \}/, 'the arrow points the way the text reads');
  assert.match(css, /\.hd-sound-hint \{[^}]*text-overflow: ellipsis/, 'a long hint is cut, not wrapped over the button');
  assert.match(css, /\.hd-volume \{ display: grid; grid-template-columns: auto 1fr auto;/);
});
