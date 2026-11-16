/**
 * Limits on how fast one agent may drive one integration, so a runaway or
 * prompt-injected agent cannot turn the broker into a flood against a provider.
 *
 * A token bucket per key: it holds up to `burst` tokens, refills at `perSecond`,
 * and a request that finds none is refused (the caller answers 429 with the wait).
 * The clock is injected, so tests run on a fake one. Idle buckets are forgotten,
 * and the table has a hard size cap, so a stream of made-up keys cannot grow it.
 */
export interface Bucket { tokens: number; at: number }

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly perSecond: number,
    private readonly burst: number,
    private readonly now: () => number,
    private readonly maxKeys = 4096
  ) {}

  /** Take one token for `key`. `retryAfterMs` says how long until one is free. */
  take(key: string): { ok: true } | { ok: false; retryAfterMs: number } {
    if (!(this.perSecond > 0) || !(this.burst >= 1)) return { ok: true };   // not configured: no limit
    const t = this.now();
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size >= this.maxKeys) this.prune(t);
      if (this.buckets.size >= this.maxKeys) {
        const oldest = this.buckets.keys().next().value;
        if (oldest !== undefined) this.buckets.delete(oldest);
      }
      b = { tokens: this.burst, at: t };
      this.buckets.set(key, b);
    } else {
      const elapsed = Math.max(0, t - b.at);
      b.tokens = Math.min(this.burst, b.tokens + (elapsed / 1000) * this.perSecond);
      b.at = t;
    }
    if (b.tokens >= 1) { b.tokens -= 1; return { ok: true }; }
    return { ok: false, retryAfterMs: Math.max(1, Math.ceil(((1 - b.tokens) / this.perSecond) * 1000)) };
  }

  /** Forget a key (its capability was revoked). */
  forget(key: string): void { this.buckets.delete(key); }

  /** Forget every key that starts with `prefix` (all the integrations of one capability). */
  forgetPrefix(prefix: string): void {
    for (const k of [...this.buckets.keys()]) if (k.startsWith(prefix)) this.buckets.delete(k);
  }

  /** Drop every bucket that has been idle long enough to be full again. */
  private prune(t: number): void {
    const fullAfterMs = (this.burst / this.perSecond) * 1000;
    for (const [k, b] of this.buckets) if (t - b.at >= fullAfterMs) this.buckets.delete(k);
  }

  size(): number { return this.buckets.size; }
}
