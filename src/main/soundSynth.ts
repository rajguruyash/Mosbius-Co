/**
 * The app's sounds, composed and played here rather than shipped: a small family of original little phrases for a
 * sitcom-flavoured desk. Nothing here is sampled or borrowed; every note is built from a few oscillators and some noise.
 *
 * The palette is acoustic and warm: a nylon-string guitar pluck, a soft felt piano, a small glockenspiel-ish bell,
 * a knuckle on wood and a hand drum. The key is G major (pentatonic, with one cheeky chromatic neighbour), the pulse
 * is a brisk 150 beats a minute, and every cue is cut from the same tune: the SIGNATURE (about three seconds) is
 * made of a few short cells, and each cue is one of those cells in its own colours, so the whole set sounds like
 * one family and not like eight unrelated beeps.
 *
 *   completed     pluck, then a climb: G B D, with a bell on the top G          (the "rise" cell)
 *   intervention  knock-knock, then a short question                            (a knock and the end of "ask")
 *   input         a piano note and a bell, a fourth apart: B E                  (the "pair" cell)
 *   approval      three rising fourths that end open: E A D                     (the "ask" cell)
 *   access        a muted low pluck, then a suspended chord left hanging        (the "low" cell)
 *   critical      a gentle descent, B G E B, ending on a soft thud              (the "fall" cell)
 *   started       a tiny spark: G, D                                            (the "spark" cell)
 *   signature     all of the above in order, ending on a G chord and a bell
 *
 * The cues are rendered to 16-bit mono WAV, written once into the app's data folder and played by the operating
 * system's own player, so they sound in every window state and need no audio element in any page.
 *
 * Electron-free and deterministic (the "noise" is a seeded generator), so the sound is unit-tested: lengths, levels,
 * loudness, brightness, clicks and the family resemblance are all measured in test/sound-synth.test.cjs.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { SOUND_KINDS, type SoundKind } from '../shared/notifications';

export const SAMPLE_RATE = 44_100;
/** Bump when the music or the mastering changes, so an older file on disk is replaced. */
export const SOUND_VERSION = 3;

const SR = SAMPLE_RATE;
const TAU = Math.PI * 2;
const mtof = (m: number): number => 440 * Math.pow(2, (m - 69) / 12);

// ─── the music ───────────────────────────────────────────────────────────────

export type Voice = 'pluck' | 'muted' | 'piano' | 'grand' | 'bell';
export type PercVoice = 'knock' | 'tap' | 'shaker';
/** `release`: how long the damper (or the pedal lifting) takes to let the note go, in seconds; each voice has its own default. */
export interface NoteEvent { t: number; midi: number; dur: number; voice: Voice; vel: number; release?: number }
export interface PercEvent { t: number; voice: PercVoice; vel: number; pitch?: number }
export interface Score { notes: NoteEvent[]; perc: PercEvent[]; /** how much room: 0 none, 1 a lot */ room: number }

/** The family: the little cells the signature is made of and each cue borrows. MIDI note numbers (67 is G4). */
export const CELLS = {
  rise: [67, 71, 74],       // G B D: "da-da-DUM", the climb
  ask: [64, 69, 74],        // E A D: rising fourths, a question that ends open
  pair: [71, 76],           // B E: two friendly notes a fourth apart
  fall: [71, 67, 64, 59],   // B G E B: a gentle descent
  spark: [67, 74],          // G D: a fifth, a little spark
  low: [50, 55]             // D G: the low pair under a held breath
} as const;

const note = (t: number, midi: number, dur: number, voice: Voice, vel: number): NoteEvent => ({ t, midi, dur, voice, vel });
const perc = (t: number, voice: PercVoice, vel: number, pitch?: number): PercEvent => ({ t, voice, vel, ...(pitch ? { pitch } : {}) });

const [R1, R2, R3] = CELLS.rise;
const [A1, A2, A3] = CELLS.ask;
const [P1, P2] = CELLS.pair;
const [F1, F2, F3, F4] = CELLS.fall;
const [S1, S2] = CELLS.spark;
const [L1, L2] = CELLS.low;

/**
 * The task-complete hook: a progression in A major at about 132 beats a minute, over the bass A G# F# E D E A. Every
 * step is a chord struck by all its voices together (rolled a few milliseconds from the bass up, the way a hand lands),
 * and the upper notes bounce between the hits: steps 2 and 4 are the upper voices alone, struck again while the bass of
 * the step before still rings. MIDI numbers (45 is A2, 69 is A4); `ms` is the length of the step; `vel` is how hard the
 * chord is struck. test/sound-synth.test.cjs holds this table against the frequencies and lengths it was written from.
 */
export const HOOK_PROGRESSION: ReadonlyArray<{ chord: string; ms: number; notes: readonly number[]; vel: number }> = [
  { chord: 'A', ms: 220, notes: [45, 64, 69, 73], vel: 0.92 },
  { chord: 'A (upper)', ms: 220, notes: [64, 69, 73], vel: 0.68 },
  { chord: 'E/G#', ms: 220, notes: [44, 64, 68, 71], vel: 0.86 },
  { chord: 'E/G# (upper)', ms: 220, notes: [64, 68, 71], vel: 0.66 },
  { chord: 'F#m7', ms: 330, notes: [42, 61, 64, 69], vel: 0.82 },
  { chord: 'E', ms: 330, notes: [40, 59, 64, 68], vel: 0.86 },
  { chord: 'Dadd9', ms: 220, notes: [50, 57, 62, 64, 66], vel: 0.74 },
  { chord: 'E6', ms: 220, notes: [40, 59, 61, 64, 68], vel: 0.82 },
  { chord: 'A (resolution)', ms: 750, notes: [45, 52, 57, 61, 64, 69], vel: 0.95 }
];

/** The hook as notes: the top voice a little firmer than the inner ones, a bass note held through the upper re-strike after it. */
function hookNotes(): NoteEvent[] {
  const out: NoteEvent[] = [];
  let t = 0;
  HOOK_PROGRESSION.forEach((step, i) => {
    const len = step.ms / 1000;
    const next = HOOK_PROGRESSION[i + 1];
    const resolution = i === HOOK_PROGRESSION.length - 1;
    const hasBass = step.notes[0] < 52;
    step.notes.forEach((midi, j) => {
      const bass = hasBass && j === 0;
      const top = j === step.notes.length - 1;
      // the others are let go a little into the next step, as a pedal would; the last chord is held for its own length and then eased off
      const held = bass && next !== undefined && next.notes[0] >= 52 ? len + next.ms / 1000 : len * 1.12;
      out.push({
        t: t + j * 0.006, midi, dur: resolution ? len : held, voice: 'grand',
        vel: step.vel * (bass ? 0.62 : top ? 1 : 0.85), ...(resolution ? { release: 0.55 } : {})
      });
    });
    t += len;
  });
  return out;
}

/** Every cue as a score. Times in seconds. */
export const SCORES: Record<SoundKind, Score> = {
  // The signature of a finished task: a bright piano hook, several voices at once (see HOOK_PROGRESSION).
  completed: { room: 0.6, notes: hookNotes(), perc: [] },
  // Knock, knock, a playful "hello?": the end of the ask, then a little fall, with a bell to keep it friendly.
  intervention: {
    room: 0.45,
    notes: [
      note(0.36, A3, 0.12, 'piano', 0.70),
      note(0.50, 76, 0.12, 'piano', 0.70),
      note(0.64, A3, 0.12, 'piano', 0.65),
      note(0.78, R2, 0.22, 'piano', 0.70),
      note(0.80, 79, 0.25, 'bell', 0.32)
    ],
    perc: [perc(0.00, 'knock', 0.90), perc(0.13, 'knock', 0.75, 1.05)]
  },
  // Two warm notes: a piano and, a moment later, a bell a fourth above.
  input: {
    room: 0.5,
    notes: [
      note(0.00, P1, 0.30, 'piano', 0.72),
      note(0.20, P2, 0.40, 'bell', 0.66)
    ],
    perc: []
  },
  // A question in three rising fourths: a staccato pluck, a piano, a held bell that ends open. A cheeky grace note.
  approval: {
    room: 0.5,
    notes: [
      note(0.00, A1, 0.10, 'pluck', 0.85),
      note(0.17, A2, 0.14, 'piano', 0.70),
      note(0.315, 73, 0.05, 'bell', 0.28),
      note(0.34, A3, 0.45, 'bell', 0.80)
    ],
    perc: []
  },
  // Two muted low plucks, then a suspended chord (G, C, D) left hanging with a faint shimmer: it asks and does not answer.
  access: {
    room: 0.6,
    notes: [
      note(0.00, L1, 0.14, 'muted', 0.85),
      note(0.15, L2, 0.14, 'muted', 0.85),
      note(0.38, 60, 0.50, 'piano', 0.50),
      note(0.38, 62, 0.50, 'piano', 0.50),
      note(0.38, 67, 0.50, 'piano', 0.50),
      note(0.52, 79, 0.40, 'bell', 0.24)
    ],
    perc: []
  },
  // A gentle descent, B G E B, ending on a low pluck and a soft thud. Noticeable, not alarming.
  critical: {
    room: 0.5,
    notes: [
      note(0.00, F1, 0.20, 'piano', 0.90),
      note(0.17, F2, 0.20, 'piano', 0.85),
      note(0.34, F3, 0.22, 'piano', 0.85),
      note(0.52, F4, 0.40, 'pluck', 0.90)
    ],
    perc: [perc(0.00, 'tap', 0.45), perc(0.52, 'tap', 0.65)]
  },
  // A tiny spark: a soft pluck and a quiet bell a fifth above.
  started: {
    room: 0.35,
    notes: [
      note(0.00, S1, 0.12, 'pluck', 0.65),
      note(0.12, S2, 0.22, 'bell', 0.40)
    ],
    perc: []
  },
  // The tune itself: the rise, the ask (with its grace note), the fall, and a G chord with a bell on top.
  signature: {
    room: 0.8,
    notes: [
      note(0.00, 55, 0.40, 'pluck', 0.85),
      note(0.20, R1, 0.22, 'pluck', 0.80),
      note(0.40, R2, 0.22, 'piano', 0.70),
      note(0.60, R3, 0.50, 'bell', 0.75),
      note(1.00, A1, 0.20, 'pluck', 0.70),
      note(1.20, A2, 0.20, 'piano', 0.65),
      note(1.365, 73, 0.06, 'bell', 0.30),
      note(1.40, A3, 0.60, 'bell', 0.80),
      note(1.80, F1, 0.20, 'piano', 0.60),
      note(2.00, F2, 0.45, 'pluck', 0.85),
      note(2.00, 55, 0.45, 'pluck', 0.50),
      note(2.014, 59, 0.45, 'pluck', 0.50),
      note(2.028, 62, 0.45, 'pluck', 0.50),
      note(2.22, 79, 0.30, 'bell', 0.45)
    ],
    perc: [perc(0.60, 'tap', 0.50), perc(1.00, 'shaker', 0.35), perc(1.20, 'shaker', 0.30), perc(2.00, 'tap', 0.45)]
  }
};

/** How loud each cue is, in LUFS at full volume. Urgent ones are a little louder, routine ones a good deal softer. */
export const SOUND_TARGET_LUFS: Record<SoundKind, number> = {
  critical: -16, intervention: -17, approval: -17.5, access: -17.5, input: -18.5, completed: -19, signature: -19, started: -25
};
/** No sample is ever louder than this (about -0.9 dBFS): a sound that clips is a sound that crackles. */
export const PEAK_CEILING = 0.9;

// ─── small tools ─────────────────────────────────────────────────────────────

/** Seeded noise, so every render of a sound is the same bytes. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const raisedCos = (x: number): number => 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, Math.max(0, x)));

function fadeIn(buf: Float32Array, ms: number): void {
  const n = Math.min(buf.length, Math.max(1, Math.round((ms / 1000) * SR)));
  for (let i = 0; i < n; i++) buf[i] *= raisedCos(i / n);
}

/** Fade to silence over `ms`, starting at sample `from`. */
function fadeOut(buf: Float32Array, from: number, ms: number): void {
  const n = Math.max(1, Math.round((ms / 1000) * SR));
  for (let i = Math.max(0, from); i < buf.length; i++) {
    const x = (i - from) / n;
    buf[i] *= x >= 1 ? 0 : raisedCos(1 - x);
  }
}

interface Biquad { b0: number; b1: number; b2: number; a1: number; a2: number }

function lowpass(f: number, q = Math.SQRT1_2): Biquad {
  const w = (TAU * f) / SR, c = Math.cos(w), al = Math.sin(w) / (2 * q), a0 = 1 + al;
  return { b0: (1 - c) / 2 / a0, b1: (1 - c) / a0, b2: (1 - c) / 2 / a0, a1: (-2 * c) / a0, a2: (1 - al) / a0 };
}
function highpass(f: number, q = Math.SQRT1_2): Biquad {
  const w = (TAU * f) / SR, c = Math.cos(w), al = Math.sin(w) / (2 * q), a0 = 1 + al;
  return { b0: (1 + c) / 2 / a0, b1: -(1 + c) / a0, b2: (1 + c) / 2 / a0, a1: (-2 * c) / a0, a2: (1 - al) / a0 };
}
function bandpass(f: number, q: number): Biquad {
  const w = (TAU * f) / SR, c = Math.cos(w), al = Math.sin(w) / (2 * q), a0 = 1 + al;
  return { b0: al / a0, b1: 0, b2: -al / a0, a1: (-2 * c) / a0, a2: (1 - al) / a0 };
}

/** Run a filter over a buffer in place. */
function filter(x: Float32Array, c: Biquad): Float32Array {
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const x0 = x[i];
    const y0 = c.b0 * x0 + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    x[i] = y0;
    x2 = x1; x1 = x0; y2 = y1; y1 = y0;
  }
  return x;
}

/**
 * Add a decaying sine to a buffer: amp * exp(-i / (tau * SR)) * sin(2π f i / SR + phase).
 * Done as a rotation of a complex number, so it costs two multiplications a sample instead of a sine.
 */
function addDamped(dst: Float32Array, freq: number, amp: number, tau: number, phase = 0): void {
  const w = (TAU * freq) / SR;
  if (!(w > 0) || w >= Math.PI * 0.9 || !(tau > 0)) return;
  const r = Math.exp(-1 / (tau * SR));
  const cr = r * Math.cos(w), ci = r * Math.sin(w);
  let re = amp * Math.cos(phase), im = amp * Math.sin(phase);
  const floor = (amp * 1e-4) * (amp * 1e-4);
  for (let i = 0; i < dst.length; i++) {
    dst[i] += im;
    const nr = re * cr - im * ci;
    im = re * ci + im * cr;
    re = nr;
    if ((i & 511) === 0 && re * re + im * im < floor) break;   // inaudible from here on
  }
}

/** A short burst of noise, darkened by a one-pole low-pass, with an exponential tail. */
function noiseBurst(len: number, seed: number, cutoff: number, tau: number): Float32Array {
  const r = rng(seed);
  const out = new Float32Array(len);
  const k = 1 - Math.exp((-TAU * cutoff) / SR);
  let lp = 0;
  for (let i = 0; i < len; i++) {
    lp += k * ((r() * 2 - 1) - lp);
    out[i] = lp * Math.exp(-i / (tau * SR));
  }
  return out;
}

// ─── the voices ──────────────────────────────────────────────────────────────

/**
 * A nylon-string guitar pluck. Additive: partials of a string plucked a sixth of the way along it (which decides which
 * ones are strong), the high ones dying first and the whole thing darker when played softly, each in a pair a hair
 * apart (a string moves in two directions, and the two beat slowly). Under it a short dark burst for the pick, passed
 * through the two resonances of a guitar body, which is the "wood" in the sound. `muted` is the palm-muted version.
 */
function pluck(f0: number, dur: number, vel: number, seed: number, muted: boolean): Float32Array {
  const seconds = muted ? dur + 0.12 : dur + 0.5;
  const len = Math.round(seconds * SR);
  const buf = new Float32Array(len);
  const T = muted ? 0.09 : seconds / 4;                   // the fundamental is about 35 dB down by the end
  const pos = muted ? 0.24 : 0.16;
  const fc = (muted ? 1300 : 1900) * (0.55 + 0.45 * vel);
  const partials = Math.max(1, Math.min(14, Math.floor(5000 / f0)));
  for (let k = 1; k <= partials; k++) {
    const fk = f0 * k * Math.sqrt(1 + 0.00002 * k * k);
    const amp = (Math.abs(Math.sin(k * Math.PI * pos)) / Math.pow(k, 1.1)) / (1 + Math.pow(fk / fc, 2));
    if (amp < 0.002) continue;
    const tau = T / (1 + 0.6 * Math.pow(k - 1, 0.95));
    const beat = 0.25 + 0.09 * k;
    addDamped(buf, fk, amp * 0.62, tau, 0);
    addDamped(buf, fk + beat, amp * 0.38, tau * 0.92, 1.0);
  }
  const burst = noiseBurst(len, seed, muted ? 800 : 1500, 0.004);
  const airBody = filter(burst.slice(), bandpass(105, 6));
  const plateBody = filter(burst.slice(), bandpass(215, 7));
  const wood = muted ? 1.1 : 0.55;
  for (let i = 0; i < len; i++) buf[i] += wood * (0.9 * airBody[i] + 0.7 * plateBody[i]) + 0.35 * burst[i];
  fadeIn(buf, 2.5);
  fadeOut(buf, len - Math.round(0.08 * SR), 80);
  for (let i = 0; i < len; i++) buf[i] *= vel;
  return buf;
}

/**
 * A soft felt piano. Additive again: partials a little sharp of whole multiples (stiff strings), the high ones dying
 * faster, two strings a hair apart for the gentle chorus, a felt hammer that is darker the softer it is played, and a
 * damper that closes over a tenth of a second when the note is released.
 */
function piano(f0: number, dur: number, vel: number, seed: number): Float32Array {
  const release = 0.14;
  const len = Math.round((dur + release + 0.1) * SR);
  const buf = new Float32Array(len);
  const T = 1.5 * Math.pow(262 / f0, 0.4);
  const fc = 800 + 2400 * vel;
  const B = Math.min(0.003, 0.0002 * Math.pow(f0 / 262, 1.6));
  const partials = Math.max(1, Math.min(12, Math.floor(5200 / f0)));
  for (let k = 1; k <= partials; k++) {
    const fk = f0 * k * Math.sqrt(1 + B * k * k);
    const strike = 0.55 + 0.45 * Math.abs(Math.sin((k * Math.PI) / 7.7));
    const amp = (strike / Math.pow(k, 0.85)) / (1 + Math.pow(fk / fc, 2));
    if (amp < 0.002) continue;
    const tau = T / (1 + 0.85 * Math.pow(k - 1, 0.8));
    addDamped(buf, fk * 1.0007, amp * 0.5, tau, 0);
    addDamped(buf, fk * 0.9993, amp * 0.5, tau * 1.1, 0.5);
  }
  const thud = noiseBurst(len, seed, 1100, 0.007);
  for (let i = 0; i < len; i++) buf[i] += 0.12 * vel * thud[i];
  fadeIn(buf, 4);
  fadeOut(buf, Math.round(dur * SR), release * 1000);
  for (let i = 0; i < len; i++) buf[i] *= vel;
  return buf;
}

/**
 * A grand piano, for the chords of the task-complete hook. The same additive idea as the soft piano, with what a
 * chord needs: strings in unison (one for the lowest notes, two, then three up the keyboard) that are a hair apart and
 * die away at different rates, which is the quick drop and the long tail of a real note; stiffness that sharpens the
 * high partials; a felt hammer that is darker when it is struck softly and brighter up the keyboard; for the low notes
 * the second to fifth partials lifted, because the lowest fundamentals do not come out of a small speaker but the
 * ear supplies them from the partials above (that is the "body"); a short thud from the hammer; and a soundboard that
 * answers low and warms the notes around it. The damper (or the pedal lifting) lets the note go over `releaseSec`.
 */
function grandPiano(f0: number, dur: number, vel: number, seed: number, releaseSec: number): Float32Array {
  const midi = 69 + 12 * Math.log2(f0 / 440);
  const pos = Math.min(1, Math.max(0, (midi - 36) / 48));           // 0 at the bottom of the keyboard, 1 near the top
  const len = Math.round((dur + releaseSec + 0.1) * SR);
  const buf = new Float32Array(len);
  const T = 3.0 * Math.pow(262 / f0, 0.5);                          // seconds for the strongest string's fundamental to fall by 1/e: the bass rings longer
  const fc = (900 + 3200 * vel) * (0.8 + 0.9 * pos);
  const B = Math.min(0.004, 0.00012 * Math.pow(f0 / 262, 1.8));
  const strings = midi < 40 ? 1 : midi < 52 ? 2 : 3;
  const detune = [0, 0.0006, -0.0009];
  const weights = strings === 1 ? [1] : strings === 2 ? [0.62, 0.38] : [0.5, 0.3, 0.2];
  const lasts = strings === 1 ? [1] : strings === 2 ? [1, 1.5] : [1, 1.35, 2.2];
  const partials = Math.max(1, Math.min(20, Math.floor(5000 / f0)));
  const body = f0 < 160 ? 1 + 0.5 * (1 - f0 / 160) : 1;
  for (let k = 1; k <= partials; k++) {
    const fk = f0 * k * Math.sqrt(1 + B * k * k);
    const strike = 0.5 + 0.5 * Math.abs(Math.sin((k * Math.PI) / 8.3));      // struck about an eighth of the way along the string
    let amp = (strike / Math.pow(k, 0.75 + 0.3 * pos)) / (1 + Math.pow(fk / fc, 2));
    if (k >= 2 && k <= 5) amp *= body;
    if (amp < 0.0015) continue;
    const tau = T / (1 + 0.7 * Math.pow(k - 1, 0.85));              // the higher partials fade first
    for (let s = 0; s < strings; s++) addDamped(buf, fk * (1 + detune[s]), amp * weights[s], tau * lasts[s], s * 0.7);
  }
  const thud = noiseBurst(len, seed, 700 + 2600 * vel * (0.4 + pos), 0.006 - 0.003 * pos);
  const hammer = (0.1 + 0.08 * (1 - pos)) * vel;
  const board = filter(buf.slice(), bandpass(190, 2.2));
  for (let i = 0; i < len; i++) buf[i] += hammer * thud[i] + 0.06 * board[i];
  fadeIn(buf, 3.5);
  fadeOut(buf, Math.round(dur * SR), releaseSec * 1000);
  for (let i = 0; i < len; i++) buf[i] *= vel;
  return buf;
}

/**
 * A small bell, between a glockenspiel and a music box: a bar's inharmonic modes (1, 2.756 and 5.404 times the
 * pitch) plus an octave, the high ones short-lived and quiet so nothing is shrill, each doubled a hair apart for the
 * shimmer, and a tiny tick where the mallet lands.
 */
function bell(f0: number, dur: number, vel: number, seed: number): Float32Array {
  const seconds = dur + 0.35;
  const len = Math.round(seconds * SR);
  const buf = new Float32Array(len);
  const hold = seconds / 4.2;
  const modes: Array<[number, number, number]> = [[1, 1, 1], [2, 0.2, 0.55], [2.756, 0.3, 0.38], [5.404, 0.07, 0.17]];
  for (const [ratio, a, scale] of modes) {
    const f = f0 * ratio;
    if (f > 5000) continue;
    addDamped(buf, f * 1.0009, a * 0.5, hold * scale, 0);
    addDamped(buf, f * 0.9991, a * 0.5, hold * scale, 1.1);
  }
  const tick = filter(noiseBurst(Math.min(len, Math.round(0.012 * SR)), seed, 3000, 0.0025), bandpass(2400, 1.5));
  for (let i = 0; i < tick.length; i++) buf[i] += 0.12 * tick[i];
  fadeIn(buf, 1.5);
  fadeOut(buf, len - Math.round(0.08 * SR), 80);
  for (let i = 0; i < len; i++) buf[i] *= vel;
  return buf;
}

/** A knuckle on a wooden door: a low tone that falls as the energy leaves the wood, wood's second mode, a small click. */
function knock(vel: number, pitch: number, seed: number): Float32Array {
  const len = Math.round(0.16 * SR);
  const buf = new Float32Array(len);
  let phase = 0;
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    phase += (TAU * (135 + 105 * Math.exp(-t / 0.012)) * pitch) / SR;
    buf[i] = Math.sin(phase) * Math.exp(-t / 0.022);
  }
  addDamped(buf, 415 * pitch, 0.32, 0.012, 0.7);
  const click = filter(noiseBurst(Math.round(0.012 * SR), seed, 3500, 0.003), bandpass(1200, 1.2));
  for (let i = 0; i < click.length; i++) buf[i] += 0.5 * click[i];
  fadeIn(buf, 0.8);
  fadeOut(buf, len - Math.round(0.04 * SR), 40);
  for (let i = 0; i < len; i++) buf[i] *= vel;
  return buf;
}

/** A hand drum tap: a rounder, longer thud than the knock. */
function tap(vel: number, seed: number): Float32Array {
  const len = Math.round(0.24 * SR);
  const buf = new Float32Array(len);
  let phase = 0;
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    phase += (TAU * (105 + 70 * Math.exp(-t / 0.03))) / SR;
    buf[i] = Math.sin(phase) * Math.exp(-t / 0.07);
  }
  const slap = filter(noiseBurst(Math.round(0.02 * SR), seed, 3000, 0.008), bandpass(1600, 1.1));
  for (let i = 0; i < slap.length; i++) buf[i] += 0.3 * slap[i];
  fadeIn(buf, 1);
  fadeOut(buf, len - Math.round(0.06 * SR), 60);
  for (let i = 0; i < len; i++) buf[i] *= vel;
  return buf;
}

/** A shaker: a soft swell of band-limited noise. Kept low and dark so it ticks the beat without hissing. */
function shaker(vel: number, seed: number): Float32Array {
  const len = Math.round(0.14 * SR);
  const r = rng(seed);
  const buf = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    buf[i] = (r() * 2 - 1) * raisedCos(t / 0.012) * Math.exp(-t / 0.035);
  }
  filter(buf, bandpass(2600, 0.9));
  fadeOut(buf, len - Math.round(0.04 * SR), 40);
  for (let i = 0; i < len; i++) buf[i] *= vel;
  return buf;
}

const LEVEL = { pluck: 0.9, muted: 0.8, piano: 0.75, grand: 0.8, bell: 0.55, knock: 0.9, tap: 0.6, shaker: 0.22 } as const;

// ─── the room and the mastering ──────────────────────────────────────────────

/** A small warm room: four damped combs and two all-passes (Schroeder), a short pre-delay, mixed in at `wet`. */
function room(x: Float32Array, wet: number): Float32Array {
  const n = x.length;
  const pre = Math.round(0.012 * SR);
  const acc = new Float32Array(n);
  const damp = 0.35;
  for (const [d, g] of [[1101, 0.66], [1367, 0.64], [1559, 0.62], [1747, 0.6]] as const) {
    const line = new Float32Array(d);
    let idx = 0, lp = 0;
    for (let i = 0; i < n; i++) {
      const y = line[idx];
      lp = y * (1 - damp) + lp * damp;
      line[idx] = (i >= pre ? x[i - pre] : 0) + lp * g;
      idx = (idx + 1) % d;
      acc[i] += y * 0.25;
    }
  }
  let sig = acc;
  for (const [d, g] of [[225, 0.5], [556, 0.5]] as const) {
    const line = new Float32Array(d);
    const out = new Float32Array(n);
    let idx = 0;
    for (let i = 0; i < n; i++) {
      const delayed = line[idx];
      const w = sig[i] + g * delayed;
      out[i] = -g * w + delayed;
      line[idx] = w;
      idx = (idx + 1) % d;
    }
    sig = out;
  }
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = x[i] + wet * sig[i];
  return out;
}

/** BS.1770 "K" weighting (a gentle shelf up above 1.5 kHz and a high-pass at 38 Hz), the ear's rough idea of loudness. */
function kWeighted(x: Float32Array): Float32Array {
  const y = x.slice();
  const f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
  const K = Math.tan((Math.PI * f0) / SR);
  const Vh = Math.pow(10, G / 20), Vb = Math.pow(Vh, 0.4996667741545416);
  const a0 = 1 + K / Q + K * K;
  filter(y, { b0: (Vh + (Vb * K) / Q + K * K) / a0, b1: (2 * (K * K - Vh)) / a0, b2: (Vh - (Vb * K) / Q + K * K) / a0, a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q + K * K) / a0 });
  const f1 = 38.13547087602444, Q1 = 0.5003270373238773;
  const K1 = Math.tan((Math.PI * f1) / SR);
  const a01 = 1 + K1 / Q1 + K1 * K1;
  filter(y, { b0: 1, b1: -2, b2: 1, a1: (2 * (K1 * K1 - 1)) / a01, a2: (1 - K1 / Q1 + K1 * K1) / a01 });
  return y;
}

/** Loudness of the sounding part of a buffer (from the first to the last sample within 50 dB of its loudest), in LUFS. */
export function measureLufs(x: Float32Array): number {
  const y = kWeighted(x);
  let peak = 0;
  for (let i = 0; i < y.length; i++) peak = Math.max(peak, Math.abs(y[i]));
  if (peak === 0) return Number.NEGATIVE_INFINITY;
  const gate = peak * 0.00316;
  let first = 0, last = y.length - 1;
  while (first < last && Math.abs(y[first]) < gate) first++;
  while (last > first && Math.abs(y[last]) < gate) last--;
  let ms = 0;
  for (let i = first; i <= last; i++) ms += y[i] * y[i];
  return -0.691 + 10 * Math.log10(ms / (last - first + 1));
}

/** Pull the loudest peaks down smoothly (no clipping, no crackle) so nothing is above `ceiling`. */
function limit(x: Float32Array, ceiling: number): void {
  const n = x.length;
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(x[i]));
  if (peak <= ceiling) return;
  const look = Math.round(0.003 * SR);
  const held = new Float32Array(n).fill(1);
  for (let i = 0; i < n; i++) {
    const a = Math.abs(x[i]);
    if (a <= ceiling) continue;
    const need = ceiling / a;
    for (let j = Math.max(0, i - look); j <= Math.min(n - 1, i + look); j++) if (need < held[j]) held[j] = need;
  }
  // ease into and out of the reduction: a moving average as wide as the hold keeps every peak under the ceiling
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + held[i];
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - look), hi = Math.min(n - 1, i + look);
    x[i] *= (prefix[hi + 1] - prefix[lo]) / (hi - lo + 1);
  }
}

export interface RenderedCue {
  samples: Float32Array;
  /** Length of the sound in milliseconds. */
  ms: number;
  lufs: number;
  peak: number;
}

const rendered = new Map<SoundKind, RenderedCue>();

/** Forget every cue that was rendered (for tests, which render the same cue in more than one way). */
export function forgetRenderedCues(): void {
  rendered.clear();
}

/** A cue, rendered once and kept. */
export function renderCue(kind: SoundKind): RenderedCue {
  const cached = rendered.get(kind);
  if (cached) return cached;
  const out = renderCueFresh(kind);
  rendered.set(kind, out);
  return out;
}

/** Run a step-by-step render to its end in one go. */
function runToEnd<T>(steps: Generator<void, T, void>): T {
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
  }
}

/** Render a cue from its score: voices, room, filtering, loudness, peaks, fades. The same every time (the tests prove it against the cached one). */
export function renderCueFresh(kind: SoundKind): RenderedCue {
  return runToEnd(renderSteps(kind));
}

const rendering = new Map<SoundKind, Promise<RenderedCue>>();

/**
 * The same render, taken in slices of a few milliseconds with the event loop handed back between them, so that making a
 * sound for the first time never holds up anything else the app is doing (an agent's hooks, a window's messages). One
 * render per cue at a time: a second caller waits for the first. `yieldNow` is how the loop is handed back (the tests
 * count it).
 */
export function renderCueAsync(kind: SoundKind, opts: { budgetMs?: number; yieldNow?: () => Promise<void> } = {}): Promise<RenderedCue> {
  const cached = rendered.get(kind);
  if (cached) return Promise.resolve(cached);
  const running = rendering.get(kind);
  if (running) return running;
  const budget = opts.budgetMs ?? 8;
  const yieldNow = opts.yieldNow ?? (() => new Promise<void>((resolve) => { setImmediate(resolve); }));
  const job = (async (): Promise<RenderedCue> => {
    const steps = renderSteps(kind);
    let sliceStart = performance.now();
    for (;;) {
      const r = steps.next();
      if (r.done) { rendered.set(kind, r.value); return r.value; }
      if (performance.now() - sliceStart >= budget) { await yieldNow(); sliceStart = performance.now(); }
    }
  })();
  rendering.set(kind, job);
  const forget = (): void => { rendering.delete(kind); };
  job.then(forget, forget);
  return job;
}

/** The render itself, as a generator that yields after every voice so that a caller can take it in slices. */
function* renderSteps(kind: SoundKind): Generator<void, RenderedCue, void> {
  const score = SCORES[kind];
  const seed = 1000 + SOUND_KINDS.indexOf(kind) * 7919;
  const parts: Array<{ at: number; buf: Float32Array; gain: number }> = [];
  let index = 0;
  for (const n of score.notes) {
    const i = index++;
    const r = rng(seed + i * 977);
    const at = Math.max(0, Math.round((n.t + (r() - 0.5) * 0.008) * SR));    // a few milliseconds of human timing
    const vel = Math.min(1, Math.max(0.05, n.vel * (1 + (r() - 0.5) * 0.1)));
    const f = mtof(n.midi);
    const buf = n.voice === 'pluck' ? pluck(f, n.dur, vel, seed + i, false)
      : n.voice === 'muted' ? pluck(f, n.dur, vel, seed + i, true)
        : n.voice === 'piano' ? piano(f, n.dur, vel, seed + i)
          : n.voice === 'grand' ? grandPiano(f, n.dur, vel, seed + i, n.release ?? 0.14)
            : bell(f, n.dur, vel, seed + i);
    parts.push({ at, buf, gain: LEVEL[n.voice] });
    yield;
  }
  index = 0;
  for (const p of score.perc) {
    const i = index++;
    const at = Math.round(p.t * SR);
    const buf = p.voice === 'knock' ? knock(p.vel, p.pitch ?? 1, seed + 500 + i) : p.voice === 'tap' ? tap(p.vel, seed + 500 + i) : shaker(p.vel, seed + 500 + i);
    parts.push({ at, buf, gain: LEVEL[p.voice] });
    yield;
  }
  let end = 0;
  for (const p of parts) end = Math.max(end, p.at + p.buf.length);
  let mix: Float32Array = new Float32Array(end + Math.round(0.45 * SR));
  for (const p of parts) for (let i = 0; i < p.buf.length; i++) mix[p.at + i] += p.buf[i] * p.gain;
  yield;
  mix = room(mix, 0.55 * score.room);
  yield;

  // keep the low rumble and the shrill top out of small speakers
  filter(mix, highpass(60));
  filter(mix, lowpass(4800));

  // drop the inaudible tail (more than 48 dB under the loudest sample), then a soft fade so the end can never click
  let mixPeak = 0;
  for (let i = 0; i < mix.length; i++) mixPeak = Math.max(mixPeak, Math.abs(mix[i]));
  const tailFloor = Math.max(1e-6, mixPeak * 0.004);
  let last = mix.length - 1;
  while (last > 0 && Math.abs(mix[last]) < tailFloor) last--;
  let samples: Float32Array = mix.slice(0, Math.min(mix.length, last + 1 + Math.round(0.01 * SR)));
  fadeIn(samples, 3);
  fadeOut(samples, samples.length - Math.round(0.09 * SR), 90);
  yield;

  // every cue to its own loudness, then the peaks
  const gain = Math.pow(10, (SOUND_TARGET_LUFS[kind] - measureLufs(samples)) / 20);
  for (let i = 0; i < samples.length; i++) samples[i] *= gain;
  limit(samples, PEAK_CEILING);

  let peak = 0;
  for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
  samples = Float32Array.from(samples);
  return { samples, ms: (samples.length / SR) * 1000, lufs: measureLufs(samples), peak };
}

// ─── files and players ───────────────────────────────────────────────────────

/** A 16-bit mono WAV of a cue at `gain` (1 = the cue's own loudness). */
export function cueWav(kind: SoundKind, gain = 1): Buffer {
  const { samples } = renderCue(kind);
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * gain * 32767))), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SR, 24); header.writeUInt32LE(SR * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** A gain is applied in twentieths (5% steps), in the file's name as well as in its samples. */
const quantise = (gain: number): number => (gain >= 0.995 ? 1 : Math.max(0, Math.min(19, Math.round(gain * 20))) / 20);

export function soundFileName(kind: SoundKind, gain = 1): string {
  const g = quantise(gain);
  return `${kind}-v${SOUND_VERSION}${g === 1 ? '' : `-g${Math.round(g * 20)}`}.wav`;
}

/** The file for a cue at a gain, written if it is not there yet. Older versions of the sound files are removed. */
export function ensureSoundFile(dir: string, kind: SoundKind, gain = 1): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, soundFileName(kind, gain));
  if (!existsSync(file)) {
    writeFileSync(file, cueWav(kind, quantise(gain)));
    pruneOldSoundFiles(dir);
  }
  return file;
}

/**
 * The same, without holding anything up: the render is taken in slices (renderCueAsync) and the file is written
 * asynchronously. This is what the app uses while it runs; the synchronous one above is for tools and tests.
 */
export async function ensureSoundFileAsync(dir: string, kind: SoundKind, gain = 1, opts?: Parameters<typeof renderCueAsync>[1]): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file = join(dir, soundFileName(kind, gain));
  if (!existsSync(file)) {
    await renderCueAsync(kind, opts);
    await writeFile(file, cueWav(kind, quantise(gain)));
    pruneOldSoundFiles(dir);
  }
  return file;
}

/** Write the full-volume file of every cue that is missing; returns where each one is. */
export function ensureSoundFiles(dir: string): Record<SoundKind, string> {
  const out = {} as Record<SoundKind, string>;
  for (const kind of SOUND_KINDS) out[kind] = ensureSoundFile(dir, kind, 1);
  return out;
}

/** Remove sound files this app wrote for an older version of the sounds (and nothing else). */
export function pruneOldSoundFiles(dir: string): number {
  let removed = 0;
  try {
    for (const name of readdirSync(dir)) {
      const m = /^[a-z]+-v(\d+)(?:-g\d+)?\.wav$/.exec(name);
      if (m && Number(m[1]) !== SOUND_VERSION) { try { rmSync(join(dir, name)); removed += 1; } catch { /* in use: next time */ } }
    }
  } catch { /* no folder yet */ }
  return removed;
}

/**
 * The command that plays a WAV file on this platform, or null when there is none to try. `volume` is a gain (0 to 1):
 * macOS and Linux players take it as an option; Windows' has none, so there the file itself is written at that gain.
 */
export function playerCommand(platform: NodeJS.Platform, file: string, volume = 0.7): { cmd: string; args: string[] } | null {
  const v = Math.max(0, Math.min(1, volume));
  if (platform === 'darwin') return { cmd: 'afplay', args: ['-v', String(v), file] };
  if (platform === 'win32') {
    const quoted = file.replace(/'/g, "''");
    return { cmd: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', `(New-Object System.Media.SoundPlayer '${quoted}').PlaySync()`] };
  }
  if (platform === 'linux') return { cmd: 'paplay', args: v < 1 ? [`--volume=${Math.round(v * 65536)}`, file] : [file] };
  return null;
}
