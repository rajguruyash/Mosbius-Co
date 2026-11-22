import { useEffect, useRef, useState } from 'react';
import type { AgentState } from '@shared/agentActivity';
import { poseBuf, SCENE_H, SCENE_W, type ExportPose } from '@/scene/office/portraitArt';
import type { OfficeCharacterName } from '@/scene/office/cast';
import { BURST_MS, nextBurstDelay } from './attention';
import { GLYPH_ART, GLYPH_COLOR, motionFor, type Glyph } from './characterMotion';

/** One drawn frame per character and pose, made once. The recipes are deterministic, so this never goes stale. */
const frames = new Map<string, HTMLCanvasElement>();
function frameFor(name: string, pose: ExportPose): HTMLCanvasElement {
  const key = `${name}:${pose}`;
  let c = frames.get(key);
  if (c) return c;
  c = document.createElement('canvas');
  c.width = SCENE_W; c.height = SCENE_H;
  const ctx = c.getContext('2d');
  if (ctx) ctx.putImageData(new ImageData(new Uint8ClampedArray(poseBuf(name as OfficeCharacterName, pose)), SCENE_W, SCENE_H), 0, 0);
  frames.set(key, c);
  return c;
}

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
  });
  useEffect(() => {
    let mq: MediaQueryList;
    try { mq = window.matchMedia('(prefers-reduced-motion: reduce)'); } catch { return undefined; }
    const on = (): void => setReduced(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return reduced;
}

/** True during a burst of movement; `active` is whether anything is asking, `key` restarts the schedule for a new request. */
export function useAttentionBursts(active: boolean, key: string | number, reduced: boolean): boolean {
  const [bursting, setBursting] = useState(false);
  useEffect(() => {
    if (!active || reduced) { setBursting(false); return undefined; }
    let n = 0;
    let next: ReturnType<typeof setTimeout> | undefined;
    let off: ReturnType<typeof setTimeout> | undefined;
    const fire = (): void => {
      setBursting(true);
      off = setTimeout(() => setBursting(false), BURST_MS);
      n += 1;
      next = setTimeout(fire, nextBurstDelay(n));
    };
    next = setTimeout(fire, nextBurstDelay(0));
    return () => { if (next) clearTimeout(next); if (off) clearTimeout(off); setBursting(false); };
  }, [active, key, reduced]);
  return bursting;
}

function drawGlyph(canvas: HTMLCanvasElement, glyph: Glyph, px: number): void {
  const art = GLYPH_ART[glyph];
  canvas.width = 7 * px + 2; canvas.height = art.length * px + 2;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  // a light outline first, so it reads on any card colour, then the glyph itself
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  for (let y = 0; y < art.length; y++) for (let x = 0; x < 7; x++) if (art[y][x] === '#') ctx.fillRect(x * px, y * px, px + 2, px + 2);
  ctx.fillStyle = GLYPH_COLOR[glyph];
  for (let y = 0; y < art.length; y++) for (let x = 0; x < 7; x++) if (art[y][x] === '#') ctx.fillRect(x * px + 1, y * px + 1, px, px);
}

export interface HuddleCharacterProps {
  character: string;
  state: AgentState;
  /** Something is waiting on a person: ring, dot and (in bursts) movement. */
  asking?: boolean;
  /** A key that changes when a new request appears, so the bursts start over. */
  askingKey?: string | number;
  /** Pixels per source pixel. */
  scale?: number;
  critical?: boolean;
}

/**
 * An agent's character, drawn from its own art and animated from its real state. Every timer here is cleared when
 * the character leaves the screen or its state changes, and the cycle pauses while the window is hidden.
 */
export function HuddleCharacter({ character, state, asking = false, askingKey = 0, scale = 2, critical = false }: HuddleCharacterProps): JSX.Element {
  const reduced = usePrefersReducedMotion();
  const motion = motionFor(state, reduced);
  const bursting = useAttentionBursts(asking && motion.attention !== 'none', askingKey, reduced);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const glyphCanvas = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext('2d');
    if (!el || !ctx) return undefined;
    ctx.imageSmoothingEnabled = false;
    let i = 0;
    const paint = (): void => {
      const f = frameFor(character, motion.frames[i % motion.frames.length]);
      ctx.clearRect(0, 0, el.width, el.height);
      ctx.drawImage(f, 0, 0, el.width, el.height);
    };
    paint();
    if (motion.frames.length < 2) return undefined;
    const timer = setInterval(() => { if (document.hidden) return; i += 1; paint(); }, Math.round(1000 / motion.fps));
    return () => clearInterval(timer);
  }, [character, state, reduced, motion.frames, motion.fps]);

  useEffect(() => {
    const el = glyphCanvas.current;
    if (el && motion.glyph) drawGlyph(el, motion.glyph, Math.max(1, Math.round(scale)));
  }, [motion.glyph, scale]);

  const w = SCENE_W * scale;
  const h = SCENE_H * scale;
  const effect = asking && bursting ? motion.attention : 'none';
  return (
    <div
      className={`hd-char hd-fx-${effect}${asking ? ' hd-asking' : ''}${asking && critical ? ' hd-critical' : ''}`}
      style={{ width: w + 12, height: h + 4, opacity: motion.opacity }}
      data-state={state}
      data-effect={effect}
    >
      <canvas ref={canvas} width={w} height={h} style={{ width: w, height: h, imageRendering: 'pixelated' }} />
      {motion.glyph && <canvas ref={glyphCanvas} className={`hd-glyph hd-glyph-${motion.glyph}`} aria-hidden="true" />}
      {asking && <span className="hd-dot" aria-hidden="true" />}
    </div>
  );
}
