/**
 * The sealed record of an in-app sign-in: what is kept, where, and how it is read
 * back without trusting it.
 *
 * It lives in the same OS-encrypted store as every other secret (Electron
 * `safeStorage`, injected here as `SecretIO`), under `mcp:<id>:oauth`. Nothing is
 * ever written to disk in the clear: unlike the bridge, this engine has no
 * plaintext token file at all.
 */
import { createHash } from 'node:crypto';
import { mcpOauthRef } from '../../shared/mcpCatalog';

export interface SecretIO {
  get(ref: string): string | undefined;
  set(ref: string, plaintext: string): { ok: boolean; error?: string };
  has(ref: string): boolean;
  /** Whether the store can be read at all right now. Tells "nothing is stored"
   *  apart from "the store could not be looked at". */
  readable(): boolean;
}

export interface TokenRecord {
  v: 1;
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms; absent when the provider gave no lifetime. */
  expiresAt?: number;
  scope?: string;
  obtainedAt: number;
  /** Which OAuth client these tokens belong to (a hash of the client id only). A
   *  changed client means they are no use, and the old refresh token is not sent to
   *  a provider alongside a different client's credentials. */
  clientFingerprint: string;
  /** Set when the provider said the grant is over. Kept (not deleted) so the
   *  Settings panel can say "sign in again" without calling the provider again. */
  dead?: { at: number; reason: string };
}

export type LoadResult =
  | { kind: 'record'; record: TokenRecord }
  | { kind: 'missing' }
  | { kind: 'malformed' }
  | { kind: 'unavailable'; why: 'store-unreadable' | 'undecryptable' };

const TOKEN_RE = /^[\x21-\x7e]{1,8192}$/;
const FP_RE = /^[0-9a-f]{16}$/;
const REASON_RE = /^[a-z][a-z0-9_-]{0,39}$/;

/** A short, one-way fingerprint of the client id. Not of the secret: a rotated
 *  secret under the same id must not invalidate a good sign-in. */
export function clientFingerprint(clientId: string): string {
  return createHash('sha256').update(`mosbius-oauth-client\0${clientId}`, 'utf8').digest('hex').slice(0, 16);
}

const isTime = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x > 0;

/** Parse what the store returned. Anything that is not exactly a version-1 record is `malformed`. */
export function parseRecord(text: string): TokenRecord | null {
  let o: unknown;
  try { o = JSON.parse(text); } catch { return null; }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const r = o as Record<string, unknown>;
  if (r.v !== 1) return null;
  if (typeof r.accessToken !== 'string' || !TOKEN_RE.test(r.accessToken)) return null;
  if (r.refreshToken !== undefined && (typeof r.refreshToken !== 'string' || !TOKEN_RE.test(r.refreshToken))) return null;
  if (r.expiresAt !== undefined && !isTime(r.expiresAt)) return null;
  if (r.scope !== undefined && (typeof r.scope !== 'string' || r.scope.length > 2000)) return null;
  if (!isTime(r.obtainedAt)) return null;
  if (typeof r.clientFingerprint !== 'string' || !FP_RE.test(r.clientFingerprint)) return null;
  let dead: TokenRecord['dead'];
  if (r.dead !== undefined) {
    const d = r.dead as Record<string, unknown> | null;
    if (!d || typeof d !== 'object' || !isTime(d.at) || typeof d.reason !== 'string' || !REASON_RE.test(d.reason)) return null;
    dead = { at: d.at, reason: d.reason };
  }
  return {
    v: 1,
    accessToken: r.accessToken,
    ...(r.refreshToken !== undefined ? { refreshToken: r.refreshToken as string } : {}),
    ...(r.expiresAt !== undefined ? { expiresAt: r.expiresAt as number } : {}),
    ...(r.scope !== undefined ? { scope: r.scope as string } : {}),
    obtainedAt: r.obtainedAt as number,
    clientFingerprint: r.clientFingerprint as string,
    ...(dead ? { dead } : {})
  };
}

/** Only the known fields, in a fixed shape — a record never carries anything it was not given on purpose. */
export function serializeRecord(r: TokenRecord): string {
  return JSON.stringify({
    v: 1, accessToken: r.accessToken, refreshToken: r.refreshToken, expiresAt: r.expiresAt, scope: r.scope,
    obtainedAt: r.obtainedAt, clientFingerprint: r.clientFingerprint, dead: r.dead
  });
}

export class TokenStore {
  constructor(private readonly secrets: SecretIO) {}

  load(id: string): LoadResult {
    const ref = mcpOauthRef(id);
    let text: string | undefined;
    try { text = this.secrets.get(ref); } catch { text = undefined; }
    if (text !== undefined) {
      const record = parseRecord(text);
      return record ? { kind: 'record', record } : { kind: 'malformed' };
    }
    // Nothing came back: either nothing is stored, or it could not be read or decrypted.
    let readable = false;
    try { readable = this.secrets.readable(); } catch { readable = false; }
    if (!readable) return { kind: 'unavailable', why: 'store-unreadable' };
    let present = false;
    try { present = this.secrets.has(ref); } catch { present = false; }
    return present ? { kind: 'unavailable', why: 'undecryptable' } : { kind: 'missing' };
  }

  save(id: string, record: TokenRecord): { ok: boolean; error?: string } {
    try { return this.secrets.set(mcpOauthRef(id), serializeRecord(record)); }
    catch { return { ok: false, error: 'the secret store refused the tokens' }; }
  }
}
