'use strict';

/**
 * The notification sounds are composed in code (src/main/soundSynth.ts), so this measures what comes out of it:
 * the file format, the length, the level, the loudness, clicks, brightness, tuning, that a render is the same every
 * time, that the cues are distinct and yet one family, and that each one is what the brief asked for. Nothing here is
 * a listening test (nobody listens to a unit test); it is the part of "warm, pleasant, not shrill" that can be measured.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const S = loadTs('src/main/soundSynth.ts');
const N = loadTs('src/shared/notifications.ts');
const P = loadTs('src/shared/soundPolicy.ts');

const SR = S.SAMPLE_RATE;
const KINDS = N.SOUND_KINDS;
const CUES = KINDS.filter((k) => k !== 'signature');
const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = i + k + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}
/** Power spectrum of x[from, to), Hann-windowed and zero-padded. */
function spectrum(x, from = 0, to = x.length) {
  let n = 1;
  while (n < to - from) n <<= 1;
  n <<= 1;
  const re = new Float64Array(n), im = new Float64Array(n);
  const len = to - from;
  for (let i = 0; i < len; i++) re[i] = x[from + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (len - 1)));
  fft(re, im);
  const mag = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) mag[i] = re[i] * re[i] + im[i] * im[i];
  return { mag, binHz: SR / n };
}
const bandPower = (sp, lo, hi) => {
  let e = 0;
  for (let i = Math.floor(lo / sp.binHz); i < Math.min(sp.mag.length, Math.ceil(hi / sp.binHz)); i++) e += sp.mag[i];
  return e;
};
/** The strongest frequency between 150 Hz and 3 kHz in a stretch of samples. */
function dominantHz(x, fromSec, toSec) {
  const sp = spectrum(x, Math.round(fromSec * SR), Math.round(toSec * SR));
  let best = 0, at = 0;
  for (let i = Math.floor(150 / sp.binHz); i < Math.floor(3000 / sp.binHz); i++) if (sp.mag[i] > best) { best = sp.mag[i]; at = i; }
  return at * sp.binHz;
}
const cents = (heard, wanted) => 1200 * Math.log2(heard / wanted);

/** The tune's notes: the ones that carry the melody (not the grace notes and shimmer), by time, the higher first when together. */
const melody = (kind) => [...S.SCORES[kind].notes].filter((n) => n.vel >= 0.4).sort((a, b) => a.t - b.t || b.midi - a.midi);
const midis = (kind) => melody(kind).map((n) => n.midi);
const contains = (haystack, needle) => haystack.some((_, i) => needle.every((m, j) => haystack[i + j] === m));

test('every sound is a well-formed 16-bit mono WAV at 44.1 kHz, the length of what was rendered', () => {
  for (const kind of KINDS) {
    const wav = S.cueWav(kind);
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF', kind);
    assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
    assert.equal(wav.readUInt16LE(20), 1, 'PCM');
    assert.equal(wav.readUInt16LE(22), 1, 'mono');
    assert.equal(wav.readUInt32LE(24), 44_100);
    assert.equal(wav.readUInt16LE(34), 16, '16-bit');
    const dataLen = wav.readUInt32LE(40);
    assert.equal(wav.length, 44 + dataLen);
    assert.equal(wav.readUInt32LE(4), 36 + dataLen);
    assert.equal(dataLen / 2, S.renderCue(kind).samples.length);
  }
});

test('lengths: a cue is short, the signature is about three seconds, and the gate holds the speakers for as long as each one sounds', () => {
  for (const kind of CUES.filter((k) => k !== 'completed')) {
    const { ms } = S.renderCue(kind);
    assert.ok(ms >= 300 && ms <= 1500, `${kind} is ${Math.round(ms)} ms`);
  }
  const hook = S.renderCue('completed').ms;
  assert.ok(hook >= 2700 && hook <= 3600, `the task-complete piano hook is ${Math.round(hook)} ms (the progression alone is 2.73 s, and the last chord rings out)`);
  const sig = S.renderCue('signature').ms;
  assert.ok(sig >= 2000 && sig <= 3000, `the signature is ${Math.round(sig)} ms`);
  for (const kind of KINDS) {
    const { ms } = S.renderCue(kind);
    const held = P.SOUND_META[kind].ms;
    assert.ok(held >= ms && held <= ms + 150, `${kind}: rendered ${Math.round(ms)} ms, the gate holds ${held} ms (update SOUND_META in src/shared/soundPolicy.ts)`);
  }
});

test('levels: nothing clips, nothing is above the ceiling, nothing is a whisper, and there is no offset', () => {
  for (const kind of KINDS) {
    const wav = S.cueWav(kind);
    let max = 0, clipped = 0, sum = 0, n = 0;
    for (let i = 44; i < wav.length; i += 2) {
      const v = wav.readInt16LE(i);
      max = Math.max(max, Math.abs(v));
      if (Math.abs(v) >= 32767) clipped++;
      sum += v; n++;
    }
    assert.equal(clipped, 0, `${kind} clips`);
    assert.ok(max / 32767 <= S.PEAK_CEILING + 1e-3, `${kind} peaks at ${(max / 32767).toFixed(3)}`);
    assert.ok(max / 32767 >= 0.2, `${kind} is nearly silent (${(max / 32767).toFixed(3)})`);
    assert.ok(Math.abs(sum / n) / 32767 < 0.001, `${kind} has a DC offset`);
  }
});

test('loudness is consistent: each cue lands on its own target, urgent ones are a little louder, the routine one is much softer', () => {
  for (const kind of KINDS) {
    const lufs = S.measureLufs(S.renderCue(kind).samples);
    assert.ok(Math.abs(lufs - S.SOUND_TARGET_LUFS[kind]) <= 0.5, `${kind}: ${lufs.toFixed(2)} LUFS, wanted ${S.SOUND_TARGET_LUFS[kind]}`);
  }
  const t = S.SOUND_TARGET_LUFS;
  assert.ok(t.critical >= t.intervention && t.intervention >= t.approval && t.approval >= t.input && t.input >= t.completed, 'the more urgent, the louder');
  assert.ok(t.started <= t.completed - 4, 'the routine cue is well below the rest');
  const everyday = CUES.filter((k) => k !== 'started').map((k) => t[k]);
  assert.ok(Math.max(...everyday) - Math.min(...everyday) <= 4, 'the cues that need a person are within 4 LU of each other');
});

test('no clicks: every sound starts and ends at silence, and nothing jumps from one sample to the next', () => {
  for (const kind of KINDS) {
    const x = S.renderCue(kind).samples;
    assert.ok(Math.abs(x[0]) < 1e-4, `${kind} starts at ${x[0]}`);
    assert.ok(Math.abs(x[x.length - 1]) < 1e-4, `${kind} ends at ${x[x.length - 1]}`);
    let peak = 0, step = 0;
    for (let i = 0; i < x.length; i++) { peak = Math.max(peak, Math.abs(x[i])); if (i) step = Math.max(step, Math.abs(x[i] - x[i - 1])); }
    assert.ok(step / peak < 0.4, `${kind}: a jump of ${(step / peak).toFixed(2)} of the peak between two samples`);
  }
});

test('not shrill: almost nothing above 4.5 kHz, and little between 2.5 and 4.5 kHz', () => {
  for (const kind of KINDS) {
    const sp = spectrum(S.renderCue(kind).samples);
    const total = bandPower(sp, 0, SR / 2);
    const top = 10 * Math.log10(bandPower(sp, 4500, SR / 2) / total + 1e-12);
    assert.ok(top < -30, `${kind}: ${top.toFixed(1)} dB of the energy is above 4.5 kHz`);
    const upperMid = bandPower(sp, 2500, 4500) / total;
    assert.ok(upperMid < 0.03, `${kind}: ${(upperMid * 100).toFixed(1)}% of the energy is between 2.5 and 4.5 kHz`);
  }
});

test('the notes are in tune: the first note of several cues is the pitch the score names', () => {
  const x = (k) => S.renderCue(k).samples;
  const first = (kind, toSec) => dominantHz(x(kind), 0, toSec);
  assert.ok(Math.abs(cents(first('input', 0.17), midiHz(71))) < 15, 'input starts on B4');
  assert.ok(Math.abs(cents(first('started', 0.1), midiHz(67))) < 15, 'started starts on G4');
  assert.ok(Math.abs(cents(first('approval', 0.15), midiHz(64))) < 15, 'approval starts on E4');
});

test('a render is the same every time, and rendering them all is quick enough to do on demand', () => {
  const t0 = Date.now();
  for (const kind of KINDS) {
    const fresh = S.renderCueFresh(kind).samples;
    const kept = S.renderCue(kind).samples;
    assert.equal(fresh.length, kept.length, kind);
    for (let i = 0; i < fresh.length; i++) if (fresh[i] !== kept[i]) assert.fail(`${kind} differs at sample ${i}`);
  }
  assert.ok(Date.now() - t0 < 6000, `rendering every sound twice took ${Date.now() - t0} ms`);
});

test('the cues are distinct: no two have the same notes, and no two are much alike as sound', () => {
  const prints = new Set(KINDS.map((k) => JSON.stringify([S.SCORES[k].notes.map((n) => [n.voice, n.midi, n.t]), S.SCORES[k].perc.map((p) => [p.voice, p.t])])));
  assert.equal(prints.size, KINDS.length);
  const ncc = (a, b) => {
    const n = Math.min(a.length, b.length, SR * 2);
    let best = 0;
    for (let lag = -1300; lag <= 1300; lag += 4) {
      let ab = 0, aa = 0, bb = 0;
      for (let i = Math.max(0, -lag); i < Math.min(n, n - lag); i++) { const u = a[i + lag], v = b[i]; ab += u * v; aa += u * u; bb += v * v; }
      best = Math.max(best, Math.abs(ab / Math.sqrt(aa * bb + 1e-20)));
    }
    return best;
  };
  for (let i = 0; i < KINDS.length; i++) {
    for (let j = i + 1; j < KINDS.length; j++) {
      // two cues that open on the same piano note (input and critical, by design: they are cut from one tune) still part ways at once
      const c = ncc(S.renderCue(KINDS[i]).samples, S.renderCue(KINDS[j]).samples);
      assert.ok(c < 0.6, `${KINDS[i]} and ${KINDS[j]} are too alike (${c.toFixed(2)})`);
    }
  }
});

test('one family: every cue but the piano hook is a cell of the signature tune, in G major, and the signature is those cells in order', () => {
  const G_MAJOR_AND_THE_WINK = new Set([7, 9, 11, 0, 2, 4, 6, 1]);   // G A B C D E F#, and C# for the cheeky grace note
  for (const kind of KINDS.filter((k) => k !== 'completed')) {
    for (const n of S.SCORES[kind].notes) assert.ok(G_MAJOR_AND_THE_WINK.has(n.midi % 12), `${kind} plays a note outside the key (${n.midi})`);
  }
  const { CELLS } = S;
  assert.ok(contains(midis('approval'), CELLS.ask), 'approval is the ask');
  assert.ok(contains(midis('input'), CELLS.pair), 'input is the pair');
  assert.ok(contains(midis('critical'), CELLS.fall), 'critical is the fall');
  assert.ok(contains(midis('started'), CELLS.spark), 'started is the spark');
  assert.ok(contains(midis('access'), CELLS.low), 'access opens on the low pair');
  const sig = midis('signature');
  assert.ok(contains(sig, CELLS.rise) && contains(sig, CELLS.ask) && contains(sig, CELLS.fall.slice(0, 2)), 'the signature has the rise, the ask and the start of the fall');
  assert.ok(sig.indexOf(CELLS.rise[2]) < sig.indexOf(CELLS.ask[0]) && sig.indexOf(CELLS.ask[0]) < sig.lastIndexOf(CELLS.fall[0]), 'in that order');
  // and the key is the same one: the signature ends on a G
  const last = S.SCORES.signature.notes.reduce((a, b) => (b.t > a.t ? b : a));
  assert.equal(last.midi % 12, 7, 'the signature ends on G');
});

test('each cue is what the brief asked for', () => {
  const voices = (kind) => melody(kind).map((n) => n.voice);
  const sc = S.SCORES;

  // completed: the piano hook, tested on its own below

  // intervention: a double knock, then a short phrase
  const knocks = sc.intervention.perc.filter((p) => p.voice === 'knock');
  assert.equal(knocks.length, 2);
  assert.ok(knocks[1].t - knocks[0].t < 0.25, 'knock-knock');
  assert.ok(Math.min(...sc.intervention.notes.map((n) => n.t)) > knocks[1].t, 'the phrase follows the knocks');
  assert.ok(melody('intervention').length >= 3, 'a short phrase');

  // input: two notes, a piano and a bell
  assert.deepEqual(voices('input'), ['piano', 'bell']);

  // approval: three notes rising, the last held, and it ends on a note that is not home (an open question)
  const ask = melody('approval');
  assert.equal(ask.length, 3);
  assert.ok(ask.every((n, i) => i === 0 || n.midi > ask[i - 1].midi), 'rising');
  assert.ok(ask[2].dur >= 0.3, 'the last note is held');
  assert.notEqual(ask[2].midi % 12, 7, 'it does not land on G, the tune\'s home');

  // access: plucked low and muted, then a chord of three or more left hanging
  assert.equal(sc.access.notes[0].voice, 'muted');
  const hanging = sc.access.notes.filter((n) => n.voice === 'piano');
  assert.ok(hanging.length >= 3 && new Set(hanging.map((n) => n.t)).size === 1, 'a chord struck together');

  // critical: a descending line, with a thud on the end
  const fall = melody('critical');
  assert.ok(fall.every((n, i) => i === 0 || n.midi < fall[i - 1].midi), 'descending');
  assert.ok(sc.critical.perc.some((p) => p.voice === 'tap'));

  // started: a pluck and a bell, and the quietest of all
  assert.deepEqual(voices('started'), ['pluck', 'bell']);
  for (const k of CUES.filter((c) => c !== 'started')) assert.ok(S.SOUND_TARGET_LUFS.started < S.SOUND_TARGET_LUFS[k], `started is quieter than ${k}`);

  // signature: acoustic and with hand percussion
  const used = new Set(sc.signature.notes.map((n) => n.voice));
  assert.ok(['pluck', 'piano', 'bell'].every((v) => used.has(v)));
  assert.ok(sc.signature.perc.length >= 2, 'hand percussion');
});

test('the files are written once into the data folder, reused, and replaced when the sound changes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-snd-'));
  const sounds = path.join(dir, 'sounds');
  fs.mkdirSync(sounds);
  // what an older version left behind, and something that is not ours
  for (const name of ['attention-v1.wav', 'done-v1.wav', 'completed-v1.wav', 'completed-v1-g10.wav', 'notes.txt']) fs.writeFileSync(path.join(sounds, name), 'x');
  const files = S.ensureSoundFiles(sounds);
  assert.deepEqual(Object.keys(files).sort(), [...KINDS].sort());
  for (const kind of KINDS) {
    assert.ok(fs.existsSync(files[kind]), kind);
    assert.equal(path.basename(files[kind]), `${kind}-v${S.SOUND_VERSION}.wav`);
  }
  const left = fs.readdirSync(sounds);
  assert.ok(!left.includes('attention-v1.wav') && !left.includes('done-v1.wav') && !left.includes('completed-v1.wav') && !left.includes('completed-v1-g10.wav'), 'older versions are removed');
  assert.ok(left.includes('notes.txt'), 'and nothing else is touched');
  const before = fs.statSync(files.completed).mtimeMs;
  assert.equal(fs.statSync(S.ensureSoundFiles(sounds).completed).mtimeMs, before, 'not rewritten');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a volume is a file at that gain (in twentieths), and zero is silence', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-snd-'));
  const peakOf = (file) => { const w = fs.readFileSync(file); let m = 0; for (let i = 44; i < w.length; i += 2) m = Math.max(m, Math.abs(w.readInt16LE(i))); return m; };
  const full = peakOf(S.ensureSoundFile(dir, 'input', 1));
  assert.equal(path.basename(S.ensureSoundFile(dir, 'input', 1)), `input-v${S.SOUND_VERSION}.wav`);
  const half = S.ensureSoundFile(dir, 'input', 0.5);
  assert.equal(path.basename(half), `input-v${S.SOUND_VERSION}-g10.wav`);
  assert.ok(Math.abs(peakOf(half) / full - 0.5) < 0.01, 'half the gain, half the peak');
  assert.equal(path.basename(S.ensureSoundFile(dir, 'input', 0.52)), `input-v${S.SOUND_VERSION}-g10.wav`, 'quantised to a twentieth');
  assert.equal(peakOf(S.ensureSoundFile(dir, 'input', 0)), 0, 'zero is silence');
  assert.equal(path.basename(S.ensureSoundFile(dir, 'input', 0.999)), `input-v${S.SOUND_VERSION}.wav`, 'a gain of almost one is one');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('each platform has its own player, takes the volume the way it can, and an unknown one has none', () => {
  assert.deepEqual(S.playerCommand('darwin', '/a/b.wav', 0.5), { cmd: 'afplay', args: ['-v', '0.5', '/a/b.wav'] });
  assert.equal(S.playerCommand('darwin', '/a.wav', 9).args[1], '1', 'volume is clamped');
  assert.equal(S.playerCommand('darwin', '/a.wav', 0).args[1], '0');
  assert.equal(S.playerCommand('win32', 'C:\\x\\it\'s.wav').cmd, 'powershell.exe');
  assert.match(S.playerCommand('win32', 'C:\\x\\it\'s.wav').args.join(' '), /it''s\.wav/, 'a quote in the path cannot break out of the command');
  assert.equal(S.playerCommand('linux', '/a.wav').cmd, 'paplay');
  assert.deepEqual(S.playerCommand('linux', '/a.wav', 1).args, ['/a.wav']);
  assert.deepEqual(S.playerCommand('linux', '/a.wav', 0.5).args, ['--volume=32768', '/a.wav']);
  assert.equal(S.playerCommand('freebsd', '/a.wav'), null);
});

// ─── the task-complete piano hook ────────────────────────────────────────────

/** The progression exactly as it was specified: how long each step lasts and the frequencies sounding together. */
const SPECIFIED = [
  { ms: 220, hz: [110.00, 329.63, 440.00, 554.37] },                       // A major
  { ms: 220, hz: [329.63, 440.00, 554.37] },                               // A major, upper voices
  { ms: 220, hz: [103.83, 329.63, 415.30, 493.88] },                       // E/G#
  { ms: 220, hz: [329.63, 415.30, 493.88] },                               // E/G#, upper voices
  { ms: 330, hz: [92.50, 277.18, 329.63, 440.00] },                        // F#m7
  { ms: 330, hz: [82.41, 246.94, 329.63, 415.30] },                        // E major
  { ms: 220, hz: [146.83, 220.00, 293.66, 329.63, 369.99] },               // Dadd9
  { ms: 220, hz: [82.41, 246.94, 277.18, 329.63, 415.30] },                // E6
  { ms: 750, hz: [110.00, 164.81, 220.00, 277.18, 329.63, 440.00] }        // A major, resolution
];

test('the task-complete hook is the specified progression: its frequencies, its lengths and its bass line A G# F# E D E A', () => {
  assert.equal(S.HOOK_PROGRESSION.length, SPECIFIED.length);
  SPECIFIED.forEach((row, i) => {
    const step = S.HOOK_PROGRESSION[i];
    assert.equal(step.ms, row.ms, `step ${i + 1}: length`);
    assert.equal(step.notes.length, row.hz.length, `step ${i + 1}: how many notes sound together`);
    step.notes.forEach((m, j) => assert.ok(Math.abs(midiHz(m) - row.hz[j]) < 0.006, `step ${i + 1}: ${midiHz(m).toFixed(2)} Hz, specified ${row.hz[j]} Hz`));
  });
  assert.equal(S.HOOK_PROGRESSION.reduce((a, s) => a + s.ms, 0), 2730, 'the progression alone lasts 2.73 s');
  const bass = S.HOOK_PROGRESSION.filter((s) => s.notes[0] < 52).map((s) => s.notes[0] % 12);
  assert.deepEqual(bass, [9, 8, 6, 4, 2, 4, 9], 'A G# F# E D E A');
});

test('the hook is played by a piano, several voices at once, with the upper notes bouncing between the hits and a resolving chord at the end', () => {
  const notes = S.SCORES.completed.notes;
  assert.ok(notes.every((n) => n.voice === 'grand'), 'one instrument, a piano: no oscillator beeps, no pluck, no bell');
  assert.deepEqual(S.SCORES.completed.perc, [], 'and nothing else');
  let t = 0;
  S.HOOK_PROGRESSION.forEach((step, i) => {
    const struck = notes.filter((n) => n.t >= t - 1e-9 && n.t < t + 0.04);    // a chord is rolled over a few milliseconds, bass first
    assert.deepEqual(struck.map((n) => n.midi).sort((a, b) => a - b), [...step.notes].sort((a, b) => a - b), `step ${i + 1} strikes exactly its notes, together`);
    assert.ok(struck.length >= 3, `step ${i + 1} is a chord`);
    // the top voice is the firmest, the bass the softest of the voices: a hand voicing a chord
    const byVel = [...struck].sort((a, b) => a.midi - b.midi);
    assert.ok(byVel[byVel.length - 1].vel >= Math.max(...byVel.map((n) => n.vel)) - 1e-9, `step ${i + 1}: the top voice leads`);
    t += step.ms / 1000;
  });
  // the bounce: the upper-only steps strike no low note, and the bass before them is still ringing
  const second = notes.filter((n) => n.t >= 0.22 - 1e-9 && n.t < 0.25);
  assert.ok(second.every((n) => n.midi >= 52), 'step 2 is the upper voices alone');
  const firstBass = notes.find((n) => n.midi === 45 && n.t < 0.05);
  assert.ok(firstBass.dur >= 0.44, 'the bass of step 1 rings through step 2');
  // hits alternate hard and soft
  assert.ok(S.HOOK_PROGRESSION[0].vel > S.HOOK_PROGRESSION[1].vel && S.HOOK_PROGRESSION[2].vel > S.HOOK_PROGRESSION[3].vel);
  // the end: A major, all of A, C# and E, six voices, the longest chord, let go slowly
  const last = S.HOOK_PROGRESSION[S.HOOK_PROGRESSION.length - 1];
  assert.ok(last.notes.length >= 6);
  assert.deepEqual([...new Set(last.notes.map((m) => m % 12))].sort((a, b) => a - b), [1, 4, 9], 'the last chord is A major: C#, E and A');
  assert.ok(last.ms === Math.max(...S.HOOK_PROGRESSION.map((s) => s.ms)));
  const endNote = notes.find((n) => n.midi === 69 && n.t > 1.9);
  assert.ok(endNote.release >= 0.4, 'the last chord is let go slowly, like a pedal lifting');
});

test('the hook sounds like struck strings: the first chord has all its upper tones at once, it rings and decays, and the attack is a hammer, not a swell', () => {
  const x = S.renderCue('completed').samples;
  const sp = spectrum(x, 0, Math.round(0.2 * SR));
  const inBand = (lo, hi) => { const v = []; for (let i = Math.floor(lo / sp.binHz); i < Math.ceil(hi / sp.binHz); i++) v.push(sp.mag[i]); return v.sort((a, b) => a - b); };
  const floor = inBand(300, 700)[Math.floor(inBand(300, 700).length / 2)];
  const near = (hz) => Math.max(...inBand(hz * 0.985, hz * 1.015));
  for (const hz of [329.63, 440, 554.37]) assert.ok(10 * Math.log10(near(hz) / floor) > 15, `${hz} Hz is not clearly sounding in the first chord`);
  // a hammer: the loudest moment of the first chord is within a few tens of milliseconds of its start
  let early = 0, whole = 0;
  for (let i = 0; i < SR * 0.2; i++) { const a = Math.abs(x[i]); whole = Math.max(whole, a); if (i < SR * 0.06) early = Math.max(early, a); }
  assert.ok(early >= 0.6 * whole, 'the chord arrives at once');
  // and it rings, then lets go: the loudness across the last chord only ever goes down
  const rms = (fromSec) => { let s = 0; const n = Math.round(0.1 * SR); for (let i = 0; i < n; i++) s += x[Math.round(fromSec * SR) + i] ** 2; return Math.sqrt(s / n); };
  const marks = [2.15, 2.45, 2.75, 3.05].map(rms);
  for (let i = 1; i < marks.length; i++) assert.ok(marks[i] < marks[i - 1] * 0.97, `the last chord should be dying away (${marks.map((m) => m.toFixed(3)).join(' > ')})`);
  assert.ok(marks[0] > 0.05, 'and it has been ringing, not stopped');
});

test('the hook has body without mud and brightness without shrillness: the lowest octave is a minority of the sound, and the upper register has some', () => {
  const sp = spectrum(S.renderCue('completed').samples);
  const total = bandPower(sp, 0, SR / 2);
  assert.ok(bandPower(sp, 0, 250) / total < 0.3, 'under 250 Hz (which small speakers lose, and which make the rest quieter) is under 30% of the energy');
  assert.ok(bandPower(sp, 1000, 4500) / total > 0.04, 'above 1 kHz there is at least 4%: it is not dull');
  assert.ok(10 * Math.log10(bandPower(sp, 4500, SR / 2) / total + 1e-12) < -30, 'and almost nothing above 4.5 kHz');
});

test('a first render is taken in slices that give the event loop back, and the result is the one a plain render makes', async () => {
  S.forgetRenderedCues();
  // the CPU time of each piece, not the wall-clock time: the work is what holds the loop, and a busy machine (the suite runs its files in parallel) stretches wall time
  const cpuMs = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; };
  const slices = [];
  let mark = cpuMs();
  const yieldNow = () => { const n = cpuMs(); slices.push(n - mark); return new Promise((resolve) => setImmediate(() => { mark = cpuMs(); resolve(); })); };
  mark = cpuMs();
  const asyncCue = await S.renderCueAsync('completed', { yieldNow });
  assert.ok(slices.length >= 10, `the loop was handed back ${slices.length} times: the hook is rendered in many small pieces`);
  assert.ok(Math.max(...slices) < 60, `the longest piece of work without handing the loop back was ${Math.max(...slices).toFixed(1)} ms of CPU`);
  const plain = S.renderCueFresh('completed');
  assert.equal(asyncCue.samples.length, plain.samples.length);
  for (let i = 0; i < plain.samples.length; i++) if (asyncCue.samples[i] !== plain.samples[i]) assert.fail(`the sliced render differs at sample ${i}`);
  // asked twice at once, it is made once
  S.forgetRenderedCues();
  const [a, b] = await Promise.all([S.renderCueAsync('input'), S.renderCueAsync('input')]);
  assert.equal(a, b);
});
