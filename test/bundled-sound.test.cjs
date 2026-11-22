'use strict';

/**
 * No recorded audio ships with the app. Every sound is composed in code (src/main/soundSynth.ts), and the task-complete sound is the
 * app's own synthesized piano hook. The sound port can still play a WAV from a bundled folder (<resources>/sounds) and from a
 * person's own folder (<data folder>/sounds/custom/), and test/sound-port.test.cjs holds it to that, but nothing in the repository
 * or in the packaging puts a file in the bundled folder. These tests keep it that way, so that a recording cannot reach an installer
 * by accident: they fail if an audio file turns up in the repository, if the packaging starts to copy a sounds folder or audio files,
 * or if the licence notice stops saying what is true.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const P = loadTs('src/shared/soundPolicy.ts');

const root = path.join(__dirname, '..');
const AUDIO = /\.(wav|mp3|m4a|m4b|aac|aif|aiff|caf|flac|ogg|oga|opus|wma|mid|midi)$/i;
const SKIP = new Set(['node_modules', '.git', 'dist', 'out']);

function audioFiles(dir, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) audioFiles(full, found);
    else if (AUDIO.test(entry.name)) found.push(path.relative(root, full));
  }
  return found;
}

test('the repository holds no audio file: every sound is composed in code', () => {
  assert.deepEqual(audioFiles(root), [], 'an audio file in the repository could end up in an installer: keep recordings out of it');
});

test('the packaging copies no sounds folder and no audio file', () => {
  const yml = fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8');
  assert.doesNotMatch(yml, /resources\/sounds/, 'electron-builder.yml must not copy resources/sounds');
  assert.doesNotMatch(yml, /to:\s*sounds\b/, 'nothing may be copied to <resources>/sounds');
  assert.doesNotMatch(yml, /\*\.(wav|mp3|m4a|aac|aif|aiff|caf|flac|ogg|opus)/i, 'no glob in electron-builder.yml may pick up audio files');
  assert.equal(fs.existsSync(path.join(root, 'resources', 'sounds')), false, 'there is no resources/sounds folder to copy');
});

test('the task-complete sound is the app\'s own piano hook, and its name and hint say so', () => {
  assert.ok(P.SOUND_META.completed.ms >= 3000 && P.SOUND_META.completed.ms <= 3700, `the hook is about three seconds (${P.SOUND_META.completed.ms} ms)`);
  for (const [locale, word] of [['en', /three/i], ['ar', /ثلاث/], ['zh-CN', /三/]]) {
    const cue = JSON.parse(fs.readFileSync(path.join(root, 'src', 'renderer', 'src', 'i18n', 'locales', `${locale}.json`), 'utf8')).huddle.prefs.sounds.cue.completed;
    assert.match(cue.hint, word, `${locale}: the hint gives the real length of the sound (${cue.hint})`);
    assert.doesNotMatch(cue.hint, /seven|سبع|七/i, `${locale}: it is no longer a seven-second recording`);
  }
});

test('LICENSE-ASSETS says every sound is composed in code and that no recorded audio ships', () => {
  const notice = fs.readFileSync(path.join(root, 'LICENSE-ASSETS'), 'utf8');
  assert.match(notice, /Every notification sound is composed in code/);
  assert.match(notice, /No recorded audio/);
  assert.doesNotMatch(notice, /television series|How I Met Your Mother, cut|piano-tutorial/, 'the notice must not describe a recording that no longer ships');
});
