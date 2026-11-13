import { useEffect, useRef } from 'react';
import { paintPortrait, PORTRAIT_W, PORTRAIT_H } from '@/scene/office/portraitArt';
import type { OfficeCharacterName } from '@/scene/office/cast';

// The first-launch backdrop: a wall of snapshots that develop one after another,
// like an old photo album coming to life. Original pixel art, graded the way
// old prints age — near-black shadows, golden-yellow highlights, olive mids,
// a little grain — and looping, with the group photo landing last.

const W = 384, H = 240; // drawn small, shown large and crisp

interface Shot { x: number; y: number; w: number; h: number; who: OfficeCharacterName[]; scene: 'flat' | 'pub' | 'roof' | 'umbrella' | 'suit' | 'group'; tilt: number; }
const SHOTS: Shot[] = [
  { x: 10, y: 8, w: 84, h: 58, who: ['ted', 'barney'], scene: 'flat', tilt: -1 },
  { x: 100, y: 6, w: 62, h: 76, who: ['barney'], scene: 'suit', tilt: 1 },
  { x: 168, y: 10, w: 92, h: 56, who: ['marshall', 'lily'], scene: 'flat', tilt: 0 },
  { x: 266, y: 6, w: 108, h: 70, who: ['robin', 'ted', 'lily'], scene: 'roof', tilt: -1 },
  { x: 8, y: 72, w: 86, h: 74, who: ['ted'], scene: 'umbrella', tilt: 1 },
  { x: 168, y: 72, w: 92, h: 62, who: ['robin'], scene: 'roof', tilt: 1 },
  { x: 266, y: 82, w: 108, h: 62, who: ['marshall', 'barney', 'robin'], scene: 'pub', tilt: 0 },
  { x: 100, y: 88, w: 62, h: 58, who: ['lily'], scene: 'flat', tilt: -1 },
  { x: 40, y: 150, w: 304, h: 84, who: ['marshall', 'lily', 'ted', 'robin', 'barney'], scene: 'group', tilt: 0 },
];
const STEP = 1.15, HOLD = 5.5; // seconds per photo, then the finished wall holds
const LOOP = SHOTS.length * STEP + HOLD;

function portrait(name: OfficeCharacterName): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = PORTRAIT_W; c.height = PORTRAIT_H;
  paintPortrait(c.getContext('2d')!, name, 1);
  return c;
}

function drawShot(ctx: CanvasRenderingContext2D, s: Shot, faces: Map<string, HTMLCanvasElement>, seed: number): void {
  const { w, h } = s;
  // the place
  const bg = s.scene === 'pub' ? ['#3a3418', '#6a5222'] : s.scene === 'roof' ? ['#2a2e18', '#565a26'] : s.scene === 'suit' ? ['#34301c', '#5e5428'] : ['#3c341a', '#74622a'];
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, bg[0]); g.addColorStop(1, bg[1]);
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  if (s.scene === 'pub' || s.scene === 'group') {
    ctx.fillStyle = '#5a2418'; ctx.fillRect(0, h - 20, w, 20);              // the booth
    ctx.fillStyle = '#7a3420'; ctx.fillRect(0, h - 20, w, 3);
    ctx.fillStyle = '#c89a3a'; for (let i = 6; i < w; i += 22) ctx.fillRect(i, 6 + (i % 3), 2, 2);   // bar lights
  }
  if (s.scene === 'roof') {
    ctx.fillStyle = '#0a0b08';
    for (let i = 0; i < w; i += 9) { const bh = 8 + ((i * 7 + seed) % 16); ctx.fillRect(i, h * 0.55 - bh, 8, bh + 4); }
    ctx.fillStyle = '#d6aa3c'; for (let i = 2; i < w; i += 5) if ((i * 13 + seed) % 4 === 0) ctx.fillRect(i, h * 0.55 - 6 - ((i * 3) % 8), 1, 1);
  }
  if (s.scene === 'flat') { ctx.fillStyle = '#4a2a16'; for (let y = 4; y < h * 0.5; y += 4) for (let x = (y % 8 ? 0 : 4); x < w; x += 8) ctx.fillRect(x, y, 7, 3); }
  // the people
  const scale = s.scene === 'group' ? 2 : h > 70 ? 2 : 1.5;
  const fw = PORTRAIT_W * scale, fh = PORTRAIT_H * scale;
  const gap = Math.min((w - fw) / Math.max(s.who.length - 1, 1), fw + 6);
  const x0 = (w - (fw + gap * (s.who.length - 1))) / 2;
  s.who.forEach((n, i) => {
    const f = faces.get(n)!;
    // Marshall stands a head taller than everyone
    const lift = n === 'marshall' ? Math.round(fh * 0.14) : (s.scene === 'group' && i % 2 ? -3 : 0);
    ctx.drawImage(f, Math.round(x0 + i * gap), Math.round(h - fh - lift), fw, fh);
  });
  if (s.scene === 'umbrella') {
    const cx = w / 2 + 2, top = h - fh - 16;
    ctx.fillStyle = '#ffd92e'; for (let r = 0; r < 9; r++) ctx.fillRect(cx - 6 - r * 2, top + r, 12 + r * 4, 1);
    ctx.fillStyle = '#b08a1a'; ctx.fillRect(cx - 24, top + 9, 48, 1);
    ctx.fillStyle = '#d8d0c0'; ctx.fillRect(cx, top + 9, 1, 14);
  }
  if (s.scene === 'suit') { ctx.fillStyle = '#d6aa3c'; ctx.fillRect(4, 4, 1, 1); ctx.fillRect(w - 6, 9, 1, 1); ctx.fillRect(9, 13, 1, 1); }
  // the print: amber wash, olive shadows, burnt edges, grain
  ctx.globalCompositeOperation = 'multiply'; ctx.fillStyle = '#f2dc9a'; ctx.fillRect(0, 0, w, h);
  ctx.globalCompositeOperation = 'screen'; ctx.fillStyle = 'rgba(96, 98, 30, 0.42)'; ctx.fillRect(0, 0, w, h);
  ctx.globalCompositeOperation = 'source-over';
  const v = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.max(w, h) * 0.75);
  v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,0.38)');
  ctx.fillStyle = v; ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < (w * h) / 26; i++) {
    const k = (i * 7919 + seed * 104729) % (w * h);
    ctx.fillStyle = i % 3 ? 'rgba(0,0,0,0.12)' : 'rgba(255,220,130,0.10)';
    ctx.fillRect(k % w, Math.floor(k / w), 1, 1);
  }
  ctx.strokeStyle = '#e6d6a4'; ctx.lineWidth = 2; ctx.strokeRect(1, 1, w - 2, h - 2);
  ctx.strokeStyle = '#0a0a06'; ctx.lineWidth = 1; ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
}

export function AlbumBackdrop(): JSX.Element {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    const faces = new Map<string, HTMLCanvasElement>();
    for (const s of SHOTS) for (const n of s.who) if (!faces.has(n)) faces.set(n, portrait(n));
    const prints = SHOTS.map((s, i) => {
      const c = document.createElement('canvas');
      c.width = s.w; c.height = s.h;
      const p = c.getContext('2d')!; p.imageSmoothingEnabled = false;
      drawShot(p, s, faces, i + 3);
      return c;
    });
    let raf = 0;
    const t0 = performance.now();
    const frame = (now: number): void => {
      const t = ((now - t0) / 1000) % LOOP;
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#0b0b08'; ctx.fillRect(0, 0, W, H);
      SHOTS.forEach((s, i) => {
        const age = t - i * STEP;
        if (age <= 0) return;
        const k = Math.min(age / 0.55, 1), e = 1 - Math.pow(1 - k, 3);
        const fadeOut = t > LOOP - 0.8 ? (LOOP - t) / 0.8 : 1;
        const zoom = 1.18 - 0.18 * e + 0.02 * Math.sin((t + i) * 0.5);
        ctx.save();
        ctx.globalAlpha = e * fadeOut;
        ctx.translate(s.x + s.w / 2 + (1 - e) * (i % 2 ? 14 : -14), s.y + s.h / 2 + (1 - e) * 6);
        ctx.rotate((s.tilt * Math.PI) / 180);
        ctx.scale(zoom, zoom);
        ctx.drawImage(prints[i], -s.w / 2, -s.h / 2);
        if (age < 0.16) { ctx.globalAlpha = (1 - age / 0.16) * 0.8; ctx.fillStyle = '#fff4c8'; ctx.fillRect(-s.w / 2, -s.h / 2, s.w, s.h); }   // the flash
        ctx.restore();
      });
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <canvas
      ref={ref} width={W} height={H}
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', imageRendering: 'pixelated', zIndex: -1 }}
    />
  );
}
