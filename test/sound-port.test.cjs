'use strict';

/**
 * The sound port (src/main/soundPort.ts) is what the notification service calls from the middle of handling an agent's event,
 * so it must never render, write or wait on that call. It is tested here with the real port and real files in a temporary folder,
 * and a stand-in for the operating system's player (the one part that cannot be run in a test).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const loadTs = require('./load-ts.cjs');

const { createSoundPortCore } = loadTs('src/main/soundPort.ts');
const S = loadTs('src/main/soundSynth.ts');
const N = loadTs('src/shared/notifications.ts');

const cpuMs = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; };
/**
 * What it costs to render the piano hook in one go, on this machine, right now. It is the yardstick for "does not hold anything up":
 * a fixed number of milliseconds would fail on a busy machine (the suite runs its files in parallel), while a comparison with what a
 * blocking render costs on the same busy machine does not.
 */
const blockingMs = (() => { const t = performance.now(); S.renderCueFresh('completed'); return performance.now() - t; })();

function rig(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-port-'));
  const spawned = [];
  const kills = [];
  let beeps = 0;
  let volume = opts.volume ?? 0.8;
  const port = createSoundPortCore({
    dataDir: dir,
    bundledDir: opts.bundledDir,
    volume: () => volume,
    platform: opts.platform ?? 'darwin',
    silentRun: opts.silentRun ?? false,
    spawn: (cmd, args) => {
      if (opts.spawnThrows) throw new Error('no such player');
      const child = { cmd, args, on: () => child, unref: () => undefined, kill: () => { kills.push(args.at(-1)); return true; } };
      spawned.push(child);
      return child;
    },
    beep: () => { beeps += 1; },
    render: opts.render
  });
  return { port, dir, spawned, kills, beeps: () => beeps, setVolume: (v) => { volume = v; }, soundsDir: path.join(dir, 'sounds'), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('playing a sound on a cold cache returns at once and renders nothing on the caller\'s turn: the file is made in the background, then played', async () => {
  S.forgetRenderedCues();
  const r = rig();
  const t0 = performance.now();
  const ok = r.port.play('completed');
  const took = performance.now() - t0;
  assert.equal(ok, true);
  assert.ok(took < blockingMs / 5, `play() took ${took.toFixed(1)} ms on a cold cache (rendering the hook in one go takes ${blockingMs.toFixed(0)} ms here)`);
  assert.equal(fs.existsSync(path.join(r.soundsDir, S.soundFileName('completed'))), false, 'nothing was rendered or written on that call');
  assert.equal(r.spawned.length, 0, 'and no player yet');
  await r.port.idle();
  assert.equal(r.spawned.length, 1, 'once the file is ready the player is started, once');
  assert.equal(r.spawned[0].cmd, 'afplay');
  assert.deepEqual(r.spawned[0].args.slice(0, 2), ['-v', String(0.8 * 0.8)], 'at the slider\'s volume, as a gain');
  assert.equal(path.basename(r.spawned[0].args[2]), S.soundFileName('completed'));
  assert.ok(fs.existsSync(r.spawned[0].args[2]));
  r.cleanup();
});

test('while a sound is made for the first time, the event loop is handed back in small pieces: nothing else the app does is held up', async () => {
  S.forgetRenderedCues();
  const slices = [];                                     // the CPU time each piece took: the work that holds the loop, whatever else the machine is doing
  let mark = cpuMs();
  const r = rig({ render: { yieldNow: () => { const n = cpuMs(); slices.push(n - mark); return new Promise((resolve) => setImmediate(() => { mark = cpuMs(); resolve(); })); } } });
  // something else running on the same loop, as an agent's hooks would be
  let ticks = 0, worst = 0, last = performance.now();
  const probe = setInterval(() => { const n = performance.now(); worst = Math.max(worst, n - last); last = n; ticks += 1; }, 1);
  mark = cpuMs();
  r.port.play('completed');
  await r.port.idle();
  clearInterval(probe);
  assert.ok(slices.length >= 10, `the loop was handed back ${slices.length} times`);
  assert.ok(Math.max(...slices) < 60, `the longest piece of work between two hand-backs was ${Math.max(...slices).toFixed(1)} ms of CPU`);
  assert.ok(ticks >= 8, `the probe on the same loop ran ${ticks} times while the hook was being made (once a piece, as the loop turns)`);
  assert.ok(worst < blockingMs / 2, `and was never kept waiting more than ${worst.toFixed(1)} ms (a blocking render would hold it for ${blockingMs.toFixed(0)} ms)`);
  r.cleanup();
});

test('once the sounds are made, playing one is a single process start: no rendering, no writing', async () => {
  const r = rig();
  await r.port.warm();
  for (const kind of N.SOUND_KINDS) assert.ok(fs.existsSync(path.join(r.soundsDir, S.soundFileName(kind))), `${kind} was made in the background`);
  const before = fs.statSync(path.join(r.soundsDir, S.soundFileName('approval'))).mtimeMs;
  const t0 = performance.now();
  for (let i = 0; i < 20; i++) r.port.play('approval');
  assert.ok(performance.now() - t0 < 100, 'twenty plays in under a tenth of a second');
  assert.equal(r.spawned.length, 20);
  await r.port.warm();
  assert.equal(fs.statSync(path.join(r.soundsDir, S.soundFileName('approval'))).mtimeMs, before, 'a second warm-up writes nothing');
  r.cleanup();
});

test('a sound that takes over from one still sounding stops that one\'s player, and the history says so', async () => {
  const r = rig();
  await r.port.warm();
  r.port.play('input');
  r.port.play('critical', { interrupt: true });
  assert.equal(r.kills.length, 1, 'the first player was stopped');
  assert.match(r.kills[0], /input-v\d+\.wav$/);
  const [first, second] = r.port.history();
  assert.equal(first.interrupt, false);
  assert.equal(second.interrupt, true);
  assert.equal(second.interrupted, true);
  r.port.play('approval');                              // not asked to take over: nothing is stopped
  assert.equal(r.kills.length, 1);
  r.cleanup();
});

test('the volume: a gain for the player, nothing at all at zero, and zero for a test run', async () => {
  const r = rig({ volume: 0.5 });
  await r.port.warm();
  r.port.play('input');
  assert.equal(r.spawned[0].args[1], '0.25', '50% on the slider is a gain of 0.25');
  r.setVolume(1);
  r.port.play('input');
  assert.equal(r.spawned[1].args[1], '1');
  r.setVolume(0);
  r.port.play('input');
  assert.equal(r.spawned.length, 2, 'a volume of zero starts no player');
  assert.equal(r.port.history().at(-1).file, '(volume is zero)');
  r.cleanup();

  const quiet = rig({ silentRun: true });
  await quiet.port.warm();
  quiet.port.play('approval');
  assert.equal(quiet.spawned.length, 1, 'a test run still starts the real player on the real file');
  assert.equal(quiet.spawned[0].args[1], '0', 'at zero volume');
  assert.equal(quiet.port.history()[0].audible, false);
  quiet.cleanup();
});

test('on Windows, whose player has no volume, the file itself is written at the gain', async () => {
  const r = rig({ platform: 'win32', volume: 0.5 });
  r.port.play('input');
  await r.port.idle();
  assert.equal(r.spawned[0].cmd, 'powershell.exe');
  assert.match(r.spawned[0].args.join(' '), /input-v\d+-g5\.wav/, 'a file at a gain of 0.25: five twentieths');
  r.cleanup();
});

test('a machine with no player falls back to the system beep, and playing still never throws or waits', async () => {
  const r = rig({ spawnThrows: true });
  await r.port.warm();
  assert.equal(r.port.play('approval'), true);
  assert.equal(r.beeps(), 1);
  assert.equal(r.port.play('approval'), true);
  assert.equal(r.beeps(), 2, 'and from then on it beeps without trying the player again');
  r.cleanup();
});

test('a sound that is not wanted any more by the time its file is ready is let go, not played late', async () => {
  S.forgetRenderedCues();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-port-'));
  const spawned = [];
  let clock = 1_000;
  const port = createSoundPortCore({
    dataDir: dir, volume: () => 0.8, platform: 'darwin', patienceMs: 5000, now: () => clock,
    spawn: (cmd, args) => { const c = { cmd, args, on: () => c, unref: () => undefined, kill: () => true }; spawned.push(c); return c; }, beep: () => undefined,
    render: { yieldNow: () => { clock += 3000; return new Promise((resolve) => setImmediate(resolve)); } }   // a very slow machine: every slice costs three seconds
  });
  port.play('completed');
  await port.idle();
  assert.equal(spawned.length, 0, 'a hook that would start a long time after the event is dropped');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the port never waits on the thread that calls it: no synchronous rendering, writing or process waiting in play()', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/main/soundPort.ts'), 'utf8');
  const play = src.slice(src.indexOf('play(kind: SoundKind, opts?: { interrupt?: boolean }): boolean {'), src.indexOf('async warm()'));
  assert.ok(play.length > 500, 'found the implementation of play()');
  assert.doesNotMatch(play, /renderCue\(|renderCueFresh\(|ensureSoundFile\(|writeFileSync|spawnSync|execSync|readFileSync|mkdirSync/, 'the call stays cheap');
  assert.match(play, /ensureSoundFileAsync\(/);
  assert.match(src, /existsSync\(file\)/, 'it only looks for the file');
});

// ─── a person's own sound ────────────────────────────────────────────────────

/** A 16-bit PCM WAV of a constant level, mono, for testing what the port does with a file a person put in. */
function pcmWav(seconds, { rate = 44100, level = 10000, bits = 16 } = {}) {
  const n = Math.round(seconds * rate);
  const bytes = bits / 8;
  const out = Buffer.alloc(44 + n * bytes);
  out.write('RIFF', 0); out.writeUInt32LE(36 + n * bytes, 4); out.write('WAVE', 8); out.write('fmt ', 12);
  out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22); out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * bytes, 28); out.writeUInt16LE(bytes, 32); out.writeUInt16LE(bits, 34); out.write('data', 36); out.writeUInt32LE(n * bytes, 40);
  for (let i = 0; i < n; i++) { if (bits === 16) out.writeInt16LE(level, 44 + i * 2); else out.writeUInt8(128 + (level >> 8), 44 + i); }
  return out;
}

test('a sound a person puts in sounds/custom/ is played instead of the app\'s own, as it is and at the slider; the app writes nothing there, and taking it away brings the app\'s own back', async () => {
  S.forgetRenderedCues();
  const r = rig({ volume: 0.5 });
  const custom = path.join(r.soundsDir, 'custom');
  fs.mkdirSync(custom, { recursive: true });
  const own = path.join(custom, 'completed.wav');
  fs.writeFileSync(own, pcmWav(7));
  const before = fs.readdirSync(custom);
  assert.equal(r.port.play('completed'), true);
  assert.equal(r.spawned.length, 1, 'started at once: nothing had to be made');
  assert.equal(r.spawned[0].args[2], own, 'their file');
  assert.equal(r.spawned[0].args[1], '0.25', 'at the slider\'s volume');
  assert.equal(r.port.history()[0].file, 'custom/completed.wav');
  await r.port.warm();
  assert.equal(fs.existsSync(path.join(r.soundsDir, S.soundFileName('completed'))), false, 'the app did not make its own sound for that cue');
  assert.ok(fs.existsSync(path.join(r.soundsDir, S.soundFileName('input'))), 'but made all the others');
  assert.deepEqual(fs.readdirSync(custom), before, 'and wrote nothing into the person\'s folder');
  r.port.play('input');
  assert.match(r.spawned.at(-1).args[2], /input-v\d+\.wav$/, 'the other cues are the app\'s own');
  fs.rmSync(own);
  r.port.play('completed');
  await r.port.idle();
  assert.match(r.spawned.at(-1).args[2], /completed-v\d+\.wav$/, 'the app\'s own sound is back when theirs is taken away');
  r.cleanup();
});

test('how long a sound lasts is read from its file, the app\'s own or the person\'s, and is unknown for a file that is not there or not a WAV', async () => {
  const r = rig();
  assert.equal(r.port.lengthMs('input'), undefined, 'nothing made yet');
  await r.port.warm();
  const mine = r.port.lengthMs('approval');
  assert.ok(Math.abs(mine - S.renderCue('approval').ms) < 2, `${mine} ms against the rendered ${S.renderCue('approval').ms.toFixed(0)} ms`);
  const custom = path.join(r.soundsDir, 'custom');
  fs.mkdirSync(custom, { recursive: true });
  fs.writeFileSync(path.join(custom, 'completed.wav'), pcmWav(7));
  assert.equal(r.port.lengthMs('completed'), 7000, 'their seven seconds, not the app\'s three');
  fs.writeFileSync(path.join(custom, 'input.wav'), 'this is not a wav file at all');
  assert.equal(r.port.lengthMs('input'), undefined);
  assert.equal(S.soundFileName('input').length > 0, true);
  assert.equal(loadTs('src/main/soundPort.ts').wavLengthMs(path.join(custom, 'nothing-here.wav')), undefined);
  r.cleanup();
});

test('on Windows, a person\'s own sound is played from a copy written at the volume (made off the call, kept for next time); a file that is not 16-bit PCM is played as it is', async () => {
  const r = rig({ platform: 'win32', volume: 0.5 });
  const custom = path.join(r.soundsDir, 'custom');
  fs.mkdirSync(custom, { recursive: true });
  fs.writeFileSync(path.join(custom, 'completed.wav'), pcmWav(1, { level: 10000 }));
  r.port.play('completed');
  assert.equal(r.spawned.length, 0, 'the copy is made first, off this call');
  await r.port.idle();
  assert.equal(r.spawned.length, 1);
  const copy = /'([^']*custom[\\/]\.scaled[\\/]completed-\d+-g5\.wav)'/.exec(r.spawned[0].args.join(' '));
  assert.ok(copy, `played from a copy at a gain of 0.25: ${r.spawned[0].args.join(' ').slice(-120)}`);
  assert.equal(fs.readFileSync(copy[1]).readInt16LE(44), 2500, '10000 at a gain of 0.25');
  assert.equal(fs.readFileSync(path.join(custom, 'completed.wav')).readInt16LE(44), 10000, 'theirs is untouched');
  r.port.play('completed');
  assert.equal(r.spawned.length, 2, 'the second time the copy is there and plays at once');
  fs.writeFileSync(path.join(custom, 'input.wav'), pcmWav(1, { bits: 8, level: 3000 }));
  r.port.play('input');
  await r.port.idle();
  assert.match(r.spawned.at(-1).args.join(' '), /custom[\\/]input\.wav/, 'an 8-bit file cannot be scaled here, so it is played as it is');
  r.cleanup();
});

// ─── a sound that ships with the app ─────────────────────────────────────────

test('a sound that ships with the app (bundledDir/<cue>.wav) plays in place of the app\'s own for that cue, below a person\'s own: theirs, then the one that ships, then the app\'s own', async () => {
  S.forgetRenderedCues();
  const shippedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-shipped-'));
  const shipped = path.join(shippedDir, 'completed.wav');
  fs.writeFileSync(shipped, pcmWav(7));
  const r = rig({ volume: 0.5, bundledDir: shippedDir });
  assert.equal(r.port.play('completed'), true);
  assert.equal(r.spawned.length, 1, 'started at once: nothing had to be made');
  assert.equal(r.spawned[0].args[2], shipped, 'the file that ships');
  assert.equal(r.spawned[0].args[1], '0.25', 'at the slider\'s volume');
  assert.equal(r.port.history()[0].file, 'bundled/completed.wav');
  assert.equal(r.port.lengthMs('completed'), 7000, 'its real length is read from it');
  await r.port.warm();
  assert.equal(fs.existsSync(path.join(r.soundsDir, S.soundFileName('completed'))), false, 'the app did not make its own hook for that cue');
  assert.ok(fs.existsSync(path.join(r.soundsDir, S.soundFileName('input'))), 'but made all the others');
  r.port.play('input');
  assert.match(r.spawned.at(-1).args[2], /input-v\d+\.wav$/, 'a cue with no file that ships is the app\'s own');
  // a person's own file outranks the one that ships
  const custom = path.join(r.soundsDir, 'custom');
  fs.mkdirSync(custom, { recursive: true });
  const own = path.join(custom, 'completed.wav');
  fs.writeFileSync(own, pcmWav(2));
  r.port.play('completed');
  assert.equal(r.spawned.at(-1).args[2], own);
  assert.equal(r.port.history().at(-1).file, 'custom/completed.wav');
  assert.equal(r.port.lengthMs('completed'), 2000);
  fs.rmSync(own);
  r.port.play('completed');
  assert.equal(r.spawned.at(-1).args[2], shipped, 'when theirs is taken away, the one that ships is back');
  assert.equal(r.port.history().at(-1).file, 'bundled/completed.wav');
  // and when that is missing too (a build that left it out), the app's own hook still sounds
  fs.rmSync(shipped);
  r.port.play('completed');
  await r.port.idle();
  assert.match(r.spawned.at(-1).args[2], /completed-v\d+\.wav$/);
  fs.rmSync(shippedDir, { recursive: true, force: true });
  r.cleanup();
});

test('on Windows the sound that ships is played from a copy written at the volume, kept in the app\'s own sounds folder (never the person\'s), and the copies made for an older install are cleaned away', async () => {
  const shippedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-shipped-'));
  const shipped = path.join(shippedDir, 'completed.wav');
  fs.writeFileSync(shipped, pcmWav(1, { level: 10000 }));
  const r = rig({ platform: 'win32', volume: 0.5, bundledDir: shippedDir });
  r.port.play('completed');
  assert.equal(r.spawned.length, 0, 'the copy is made first, off this call');
  await r.port.idle();
  assert.equal(r.spawned.length, 1);
  const copy = /'([^']*sounds[\\/]\.scaled[\\/]completed-\d+-g5\.wav)'/.exec(r.spawned[0].args.join(' '));
  assert.ok(copy, `played from a copy at a gain of 0.25: ${r.spawned[0].args.join(' ').slice(-120)}`);
  assert.equal(fs.readFileSync(copy[1]).readInt16LE(44), 2500, '10000 at a gain of 0.25');
  assert.equal(fs.readFileSync(shipped).readInt16LE(44), 10000, 'the file that ships is untouched');
  assert.equal(fs.existsSync(path.join(r.soundsDir, 'custom')), false, 'and nothing was written into the person\'s folder');
  r.port.play('completed');
  assert.equal(r.spawned.length, 2, 'the second time the copy is there and plays at once');
  // the app is updated: the file that ships has a new modified time, so the copies made for the old one go once a new one is made
  const stale = path.join(path.dirname(copy[1]), 'completed-1000-g7.wav');
  fs.writeFileSync(stale, 'x');
  const later = new Date(Date.now() + 60_000);
  fs.utimesSync(shipped, later, later);
  r.port.play('completed');
  await r.port.idle();
  const names = fs.readdirSync(path.dirname(copy[1])).filter((n) => /^completed-/.test(n));
  assert.deepEqual(names, [`completed-${Math.floor(fs.statSync(shipped).mtimeMs)}-g5.wav`], 'only the copy for the file as it is now is kept');
  fs.rmSync(shippedDir, { recursive: true, force: true });
  r.cleanup();
});
