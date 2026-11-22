/**
 * When a character asks for attention, and when it stops asking.
 *
 * A request that has been waiting must stay visible (a steady dot and ring, which cost nothing), but a character that
 * bounces or shakes forever is a character the person learns to ignore. So the movement comes in short bursts: at once
 * when the request appears, again after 20 seconds, then at one minute, three minutes, and every five minutes after
 * that. The schedule restarts only when a NEW request appears; it ends only when the request is resolved or dismissed:
 * never because a window was opened or looked at.
 *
 * Pure, so the schedule is tested.
 */

/** How long one burst of movement lasts. */
export const BURST_MS = 2600;

/** Milliseconds from burst `n` to burst `n + 1` (burst 0 is the first, at once). */
export function nextBurstDelay(n: number): number {
  if (n <= 0) return 0;
  if (n === 1) return 20_000;
  if (n === 2) return 40_000;   // one minute in
  if (n === 3) return 120_000;  // three minutes in
  return 300_000;
}

/** The moments (ms after the request appears) at which the first `count` bursts start. */
export function burstStarts(count: number): number[] {
  const out: number[] = [];
  let t = 0;
  for (let i = 0; i < count; i++) { t += nextBurstDelay(i); out.push(t); }
  return out;
}
