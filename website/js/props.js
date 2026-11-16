/* Mosbius & Co — small painted props and effects.
 *
 * These are drawn in world pixels (the same 1× grid as the sprites) and scaled
 * by the scene, so they stay on the pixel grid instead of floating between it.
 */
window.M = window.M || {};

(function (M) {
  'use strict';

  const px = (ctx, x, y, w, h, s, color) => {
    ctx.fillStyle = color;
    ctx.fillRect(Math.round(x) * s, Math.round(y) * s, w * s, h * s);
  };

  /** The yellow umbrella, open. 13×14 world pixels, anchored at its top-left. */
  M.umbrella = function umbrella(ctx, x, y, s, tilt) {
    const YEL = '#FFC94A', YEL_D = '#E0A62E', DARK = '#26222e';
    const lean = tilt ? 1 : 0;
    // canopy: three scallops, widest at the bottom row
    px(ctx, x + 5 + lean, y, 3, 1, s, YEL);
    px(ctx, x + 3 + lean, y + 1, 7, 1, s, YEL);
    px(ctx, x + 1 + lean, y + 2, 11, 1, s, YEL);
    px(ctx, x + lean, y + 3, 13, 1, s, YEL);
    px(ctx, x + lean, y + 4, 13, 1, s, YEL_D);
    // scallop notches along the hem
    px(ctx, x + 3 + lean, y + 4, 1, 1, s, DARK);
    px(ctx, x + 6 + lean, y + 4, 1, 1, s, DARK);
    px(ctx, x + 9 + lean, y + 4, 1, 1, s, DARK);
    // shaft + crook handle
    px(ctx, x + 6, y + 5, 1, 7, s, DARK);
    px(ctx, x + 5, y + 12, 2, 1, s, DARK);
    px(ctx, x + 6 + lean, y - 1, 1, 1, s, DARK);
  };

  /** A lit screen: a steady glow plus a cursor line that moves like typing. */
  M.screenGlow = function screenGlow(ctx, r, s, t, hue) {
    const on = hue || '#8ad7ff';
    ctx.globalAlpha = 0.55 + 0.15 * Math.sin(t / 260);
    px(ctx, r.x, r.y, r.w, r.h, s, on);
    ctx.globalAlpha = 1;
    // code lines scrolling inside the screen
    const rows = Math.max(1, Math.floor(r.h / 2));
    for (let i = 0; i < rows; i++) {
      const seed = (i * 37 + Math.floor(t / 420)) % 11;
      const len = 2 + (seed % Math.max(2, r.w - 3));
      ctx.globalAlpha = 0.85;
      px(ctx, r.x + 1, r.y + i * 2, Math.min(len, r.w - 2), 1, s, '#13324a');
    }
    ctx.globalAlpha = 1;
  };

  /** Rain, drawn over a room. Deterministic from `t` so it never allocates. */
  M.rain = function rain(ctx, w, h, s, t, density) {
    const n = density || 46;
    ctx.globalAlpha = 0.5;
    for (let i = 0; i < n; i++) {
      const sx = (i * 97) % w;
      const sy = ((i * 53) + t * 0.22) % h;
      px(ctx, sx, sy, 1, 3, s, '#9fb6d8');
    }
    ctx.globalAlpha = 1;
  };

  /** A row of distant windows that light up and go dark at their own pace. */
  M.windowLights = function windowLights(ctx, x, y, w, s, t, seed) {
    for (let i = 0; i < w / 6; i++) {
      const k = (i * 7 + (seed || 0)) % 13;
      const phase = Math.sin((t / (900 + k * 180)) + k);
      if (phase < 0.2) continue;
      px(ctx, x + i * 6 + 2, y + (k % 3) * 5, 2, 2, s, phase > 0.8 ? '#FFC94A' : '#c9972f');
    }
  };

  /** Laser tag: beams that sweep and neon that flickers. */
  M.lasers = function lasers(ctx, w, h, s, t) {
    const beams = [
      { y: 0.30, c: '#ff3b6b', speed: 0.9 },
      { y: 0.55, c: '#2ee6a8', speed: -1.3 },
      { y: 0.78, c: '#4aa3ff', speed: 1.6 },
    ];
    for (const b of beams) {
      const x = ((t * b.speed) / 22) % (w + 60) - 30;
      ctx.globalAlpha = 0.65;
      px(ctx, x, h * b.y, 22, 1, s, b.c);
      ctx.globalAlpha = 0.25;
      px(ctx, x - 10, h * b.y, 10, 1, s, b.c);
      ctx.globalAlpha = 1;
    }
  };

  /** Warm pub light that breathes, over the whole room. */
  M.warmWash = function warmWash(ctx, w, h, s, t) {
    ctx.globalAlpha = 0.06 + 0.03 * Math.sin(t / 1400);
    px(ctx, 0, 0, w, h, s, '#FFC94A');
    ctx.globalAlpha = 1;
  };

  /** A cab sliding along the road. Returns the x it was drawn at. */
  M.cab = function cab(ctx, img, x, y, s, flip) {
    if (!img) return;
    ctx.imageSmoothingEnabled = false;
    if (flip) {
      ctx.save();
      ctx.translate(Math.round(x + img.width) * s, Math.round(y) * s);
      ctx.scale(-1, 1);
      ctx.drawImage(img, 0, 0, img.width * s, img.height * s);
      ctx.restore();
    } else {
      ctx.drawImage(img, Math.round(x) * s, Math.round(y) * s, img.width * s, img.height * s);
    }
  };
})(window.M);
