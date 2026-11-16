/**
 * PKCE (RFC 7636), S256 only, plus the single-use random values around it.
 *
 * `plain` is never offered: it protects nothing when the challenge is seen,
 * which is the whole threat PKCE exists for (another program on this machine
 * reading the authorization request or the loopback redirect).
 *
 * Electron-free, so every rule is unit-tested under plain Node.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** RFC 7636 §4.1: 43–128 characters from the unreserved set. */
const VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;

export type RandomBytes = (n: number) => Buffer;

/** 32 random bytes → a 43-character verifier (256 bits of entropy). */
export function newCodeVerifier(random: RandomBytes = randomBytes): string {
  return random(32).toString('base64url');
}

/** BASE64URL(SHA256(ASCII(verifier))), no padding (RFC 7636 §4.2). */
export function challengeS256(verifier: string): string {
  if (typeof verifier !== 'string' || !VERIFIER_RE.test(verifier)) throw new Error('invalid code_verifier');
  return createHash('sha256').update(verifier, 'ascii').digest().toString('base64url');
}

/**
 * Whether `verifier` is the one `challenge` was made from. This is the check an
 * authorization server runs at the token endpoint; the stand-in provider in the
 * tests uses it, and the sign-in uses it on its own pair before sending anything.
 * Constant-time, and false (never a throw) for anything malformed.
 */
export function verifyS256(verifier: unknown, challenge: unknown): boolean {
  if (typeof verifier !== 'string' || typeof challenge !== 'string' || !VERIFIER_RE.test(verifier)) return false;
  const expected = Buffer.from(challengeS256(verifier));
  const given = Buffer.from(challenge);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** An unguessable, single-use `state` (256 bits). */
export function newState(random: RandomBytes = randomBytes): string {
  return random(32).toString('base64url');
}

/** Constant-time string comparison that does not leak the length (compares digests). */
export function constantTimeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb);
}

/** A one-way fingerprint for remembering a value (a used code) without keeping it. */
export function fingerprint(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 32);
}
