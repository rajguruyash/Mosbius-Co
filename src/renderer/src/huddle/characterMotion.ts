/**
 * How each agent state looks on a character: which of the character's own poses to cycle through, how fast, what
 * small symbol floats over its head, and how it moves when it wants a person.
 *
 * The poses are the ones the app's art already has (idle, blink, work, wave, talk, cheer, walk, back: see
 * scene/office/portraitArt.ts), drawn from the same recipes as the character on the office floor, so an agent looks
 * like itself here. Nothing is invented per state beyond choosing among them.
 *
 * Pure data and functions: every state is covered, and the tests check it.
 */
import { AGENT_STATES, type AgentState } from '@shared/agentActivity';
import type { ExportPose } from '@/scene/office/portraitArt';

export type Glyph = 'dots' | 'magnifier' | 'check' | 'question' | 'exclaim' | 'cross' | 'pause' | 'zzz' | 'gear';

/** How a character moves to ask for a person. 'none' is the resting state of everything that is not asking. */
export type Effect = 'none' | 'bounce' | 'shake' | 'glow';

export interface Motion {
  /** The poses to cycle through, in order. */
  frames: readonly ExportPose[];
  /** Frames per second. */
  fps: number;
  glyph: Glyph | null;
  /** How the character moves when it is asking for a person (only while it has something open). */
  attention: Effect;
  /** 1 = full colour; lower fades a character that is not running. */
  opacity: number;
}

export const MOTION: Record<AgentState, Motion> = {
  idle: { frames: ['idle', 'idle', 'idle', 'blink'], fps: 1.2, glyph: null, attention: 'none', opacity: 1 },
  working: { frames: ['work', 'idle'], fps: 4, glyph: 'gear', attention: 'none', opacity: 1 },
  researching: { frames: ['walk-a', 'idle', 'walk-b', 'idle'], fps: 3.5, glyph: 'magnifier', attention: 'none', opacity: 1 },
  waiting: { frames: ['idle', 'blink'], fps: 0.9, glyph: 'dots', attention: 'none', opacity: 1 },
  completed: { frames: ['cheer', 'cheer', 'idle'], fps: 2.5, glyph: 'check', attention: 'none', opacity: 1 },
  'needs-input': { frames: ['wave', 'idle'], fps: 2.4, glyph: 'question', attention: 'bounce', opacity: 1 },
  'needs-approval': { frames: ['wave', 'talk'], fps: 2.4, glyph: 'exclaim', attention: 'glow', opacity: 1 },
  error: { frames: ['talk', 'idle'], fps: 3, glyph: 'cross', attention: 'shake', opacity: 1 },
  paused: { frames: ['idle'], fps: 1, glyph: 'pause', attention: 'none', opacity: 0.8 },
  stopped: { frames: ['back'], fps: 1, glyph: 'zzz', attention: 'none', opacity: 0.55 }
};

/** What the character does for this state. `reduced` (the person asked for less motion) freezes the pose cycle on its first frame. */
export function motionFor(state: AgentState, reduced = false): Motion {
  const m = MOTION[state] ?? MOTION.idle;
  return reduced ? { ...m, frames: [m.frames[0]], fps: 1 } : m;
}

export function allStatesCovered(): boolean {
  return AGENT_STATES.every((s) => !!MOTION[s] && MOTION[s].frames.length > 0);
}

/** The pixel art of each glyph, 7 wide. '#' is ink. Drawn straight onto a canvas, like the characters. */
export const GLYPH_ART: Record<Glyph, readonly string[]> = {
  question: ['.#####.', '#.....#', '......#', '....##.', '...#...', '.......', '...#...'],
  exclaim: ['...#...', '...#...', '...#...', '...#...', '...#...', '.......', '...#...'],
  check: ['.......', '......#', '.....#.', '#...#..', '.#.#...', '..#....', '.......'],
  cross: ['#.....#', '.#...#.', '..#.#..', '...#...', '..#.#..', '.#...#.', '#.....#'],
  pause: ['.......', '.##.##.', '.##.##.', '.##.##.', '.##.##.', '.##.##.', '.......'],
  dots: ['.......', '.......', '.......', '#.#.#..', '.......', '.......', '.......'],
  magnifier: ['.###...', '#...#..', '#...#..', '#...#..', '.###...', '.....#.', '......#'],
  zzz: ['####...', '..#....', '.#.....', '####.##', '....#..', '...#...', '....###'],
  gear: ['..#.#..', '.#####.', '##...##', '#.....#', '##...##', '.#####.', '..#.#..']
};

/** The colour a glyph is drawn in: the same hues the office floor uses for the same meanings. */
export const GLYPH_COLOR: Record<Glyph, string> = {
  question: '#9482d3', exclaim: '#d96a62', check: '#5ca97a', cross: '#d96a62', pause: '#6d87d6',
  dots: '#6d87d6', magnifier: '#4f9faf', zzz: '#a199ab', gear: '#dcab3c'
};
