'use strict';
/**
 * A virtual camera over a recording of a whole screen, for the README's and the website's videos.
 *
 * The recording is the entire display, taken at twice its pixel density. The camera holds on a view, then glides (eased, so it starts
 * and stops gently) to the next one: wide on the whole desktop, then in on one corner of it. Every frame is cut out of the recording at
 * its real size and scaled to the video's, in a single ffmpeg pass (the zoompan filter), so a view that is half the screen wide still has
 * a pixel of recording for every pixel of video, and nothing here is a second encode of an encode.
 *
 * A view is where the camera looks, in the display's own units (points): the left edge, the top edge and the width of what is in
 * frame. Its height follows from the video's shape. `t` is the second of the OUTPUT at which the camera has arrived there: between two
 * views the camera moves, and a run of the same view is a hold. Before the first view and after the last it holds.
 *
 *   const { renderCamera } = require('./camera-render.cjs');
 *   renderCamera({ input: 'desktop.mov', output: 'out.mp4', from: 0.9, to: 58, display: { w: 1440, h: 900 }, scale: 2,
 *                  size: { w: 1920, h: 1200 }, views: [{ t: 0, x: 0, y: 0, w: 1440 }, { t: 6, x: 0, y: 0, w: 1440 }, { t: 7.5, x: 640, y: 24, w: 800 }] });
 */
const { spawnSync } = require('node:child_process');

const num = (n) => Number(n.toFixed(4));

/** The smoothstep of p (0 to 1), as an ffmpeg expression. */
const ease = (p) => `(${p}*${p}*(3-2*${p}))`;

/** An ffmpeg expression for a value that follows `keys` ([{ t, v }], by time), easing between neighbours. `T` is the time in seconds. */
function track(keys, fps) {
  let e = String(num(keys[keys.length - 1].v));
  for (let i = keys.length - 2; i >= 0; i -= 1) {
    const a = keys[i];
    const b = keys[i + 1];
    if (a.v === b.v) { e = `if(lt(T,${num(b.t)}),${num(a.v)},${e})`; continue; }
    const p = `((T-${num(a.t)})/${num(Math.max(0.001, b.t - a.t))})`;
    e = `if(lt(T,${num(b.t)}),${num(a.v)}+${num(b.v - a.v)}*${ease(p)},${e})`;
  }
  return e.replace(/T/g, `(on/${fps})`);
}

/**
 * The filter chain that makes the video: a steady clock first (the recording only has frames where the screen changed), then the camera.
 * The camera eases the view's own edges (left, top and width), not its centre and zoom: a corner that is in frame at both ends of a move
 * (the Huddle against the display's right edge, say) is then in frame at every moment of it, instead of being swept past.
 */
function cameraFilter({ views, display, scale, size, fps = 30 }) {
  if (!views || views.length === 0) throw new Error('the camera needs at least one view');
  const sorted = [...views].sort((a, b) => a.t - b.t);
  const edge = (field) => track(sorted.map((v) => ({ t: v.t, v: v[field] * scale })), fps);
  // the window's width in the recording sets the zoom; its left and top edge are kept inside the recording
  const z = `iw/(${edge('w')})`;
  const x = `max(0,min(iw-iw/zoom,${edge('x')}))`;
  const y = `max(0,min(ih-ih/zoom,${edge('y')}))`;
  return `fps=${fps},zoompan=z='${z}':x='${x}':y='${y}':d=1:s=${size.w}x${size.h}:fps=${fps},format=yuv420p`;
}

function renderCamera({ input, output, from = 0, to, views, display, scale, size, fps = 30, crf = 24, ffmpeg = process.env.FFMPEG || 'ffmpeg' }) {
  const filter = cameraFilter({ views, display, scale, size, fps });
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(from), ...(to ? ['-t', String(to - from)] : []), '-i', input,
    '-vf', filter, '-c:v', 'libx264', '-preset', 'slow', '-crf', String(crf), '-movflags', '+faststart', '-an', output];
  const r = spawnSync(ffmpeg, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`the camera pass failed: ${(r.stderr || r.error?.message || '').slice(0, 600)}`);
  return { filter };
}

module.exports = { renderCamera, cameraFilter, track };
