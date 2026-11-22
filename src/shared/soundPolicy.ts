/**
 * How the app's sounds share one pair of speakers: which cue outranks which, how long each one holds the speakers,
 * and when a second sound is dropped so two never play over each other. Pure and Electron-free; the notification
 * service owns one gate and asks it before it plays anything, and the delivery code does what the verdict says.
 *
 * The rules, in short:
 *   - one sound at a time. A cue that arrives while another is sounding is dropped, unless it outranks it, in which
 *     case it takes over at once (an urgent sound is never made to wait behind a chime);
 *   - the same cue twice inside its cooldown is one cue (five agents finishing in the same second ring once);
 *   - routine cues (an agent starting) never take over and never follow close behind another sound.
 * A dropped sound is not a lost notification: the record, the banner and the Huddle still tell the person.
 */
import type { SoundKind } from './notifications';

export interface SoundMeta {
  /** Higher outranks lower. */
  priority: number;
  /** How long the cue sounds (its rendered length, rounded up): the gate holds the speakers that long. */
  ms: number;
  /** The same cue again inside this is the same cue. */
  cooldownMs: number;
  /** A routine cue gives way to everything and never takes over. */
  routine: boolean;
}

/** Calibrated against the rendered cues: test/sound-synth.test.cjs fails if a length drifts from its entry here. */
export const SOUND_META: Record<SoundKind, SoundMeta> = {
  critical:     { priority: 7, ms: 1350, cooldownMs: 1500, routine: false },
  intervention: { priority: 6, ms: 1300, cooldownMs: 1500, routine: false },
  access:       { priority: 5, ms: 1250, cooldownMs: 1500, routine: false },
  approval:     { priority: 4, ms: 1000, cooldownMs: 1500, routine: false },
  input:        { priority: 3, ms: 950,  cooldownMs: 1500, routine: false },
  // the piano hook is long, and a second finish while it sounds (or just after) is the same news: one hook per six seconds
  // (the seven-second clip that ships in its place pushes that out by how much longer it is: about ten seconds)
  completed:    { priority: 2, ms: 3350, cooldownMs: 6000, routine: false },
  started:      { priority: 1, ms: 700,  cooldownMs: 6000, routine: true },
  signature:    { priority: 0, ms: 2950, cooldownMs: 0,    routine: false }
};

export type GateVerdict =
  | { verdict: 'play'; /** a sound is still sounding and this one takes over from it */ interrupt: boolean }
  | { verdict: 'dropped'; why: 'repeat' | 'busy' | 'routine' };

/** A routine cue also stays out of the way for this long after any sound has ended. */
const ROUTINE_QUIET_MS = 1500;

export class SoundGate {
  private current: { kind: SoundKind; endsAt: number } | null = null;
  private lastEnd = Number.NEGATIVE_INFINITY;
  private readonly lastStart = new Map<SoundKind, { at: number; cooldownMs: number }>();

  private settle(now: number): void {
    if (this.current && now >= this.current.endsAt) { this.lastEnd = this.current.endsAt; this.current = null; }
  }

  /**
   * What to do with a cue an event rang. `ms` is how long it really sounds, when that is not the cue's own length (a
   * stand-in for the app's own sound: one a person put in, or the one that ships with the app).
   */
  request(kind: SoundKind, now: number, ms: number = SOUND_META[kind].ms): GateVerdict {
    this.settle(now);
    const meta = SOUND_META[kind];
    const last = this.lastStart.get(kind);
    if (last !== undefined && now - last.at < last.cooldownMs) return { verdict: 'dropped', why: 'repeat' };
    let interrupt = false;
    if (this.current) {
      if (meta.routine) return { verdict: 'dropped', why: 'routine' };
      if (meta.priority <= SOUND_META[this.current.kind].priority) return { verdict: 'dropped', why: 'busy' };
      interrupt = true;
    } else if (meta.routine && now - this.lastEnd < ROUTINE_QUIET_MS) {
      return { verdict: 'dropped', why: 'routine' };
    }
    this.begin(kind, now, ms);
    return { verdict: 'play', interrupt };
  }

  /** A person pressed "play" on a preview: it always sounds, and takes over from whatever is sounding. */
  preview(kind: SoundKind, now: number, ms: number = SOUND_META[kind].ms): { interrupt: boolean } {
    this.settle(now);
    const interrupt = this.current !== null;
    this.begin(kind, now, ms);
    return { interrupt };
  }

  /** The sound could not be played after all (no player, a refused spawn): do not hold the speakers for it. */
  abort(kind: SoundKind): void {
    if (this.current?.kind === kind) this.current = null;
    this.lastStart.delete(kind);
  }

  private begin(kind: SoundKind, now: number, ms: number): void {
    const meta = SOUND_META[kind];
    this.current = { kind, endsAt: now + ms };
    // a stand-in longer than the cue's own keeps the same pause after it: the cooldown grows by how much longer it is, so a
    // seven-second clip is not followed straight away by the same clip again
    this.lastStart.set(kind, { at: now, cooldownMs: meta.cooldownMs + Math.max(0, ms - meta.ms) });
  }
}

/**
 * Loudness is heard roughly logarithmically, so a slider that set the amplitude directly would crowd most of the
 * audible change into its bottom end. Squaring it spreads the change more evenly along the slider.
 */
export function volumeToGain(volume: number): number {
  const v = Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 0;
  return v * v;
}
