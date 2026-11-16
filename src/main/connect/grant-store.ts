/**
 * What a connection is, apart from its tokens: which client it signed in as, which endpoints it
 * talks to, how to remove the client again, and when it was made. Sealed in the same OS-encrypted store
 * as everything else (`mcp:<id>:conn`), because it can hold a client secret and a registration handle.
 * Read back strictly: anything that is not exactly a version-1 record is `malformed`, never trusted.
 */
import { connectRef } from '../../shared/connect';
import type { SecretIO } from '../oauth/token-store';

export interface GrantMeta {
  v: 1;
  method: 'dcr' | 'device';
  clientId: string;
  /** Only for a provider that issued this client a secret of its own. */
  clientSecret?: string;
  issuer: string;
  authorizationEndpoint?: string;
  tokenEndpoint: string;
  revocationEndpoint?: string;
  resource?: string;
  scope?: string;
  /** RFC 7592: how to delete the client the app registered. A credential: it never leaves the main process. */
  registration?: { uri: string; token: string };
  connectedAt: number;
  account?: string;
}

export type VaultIO = SecretIO & { delete(ref: string): boolean };

const TOKEN = /^[\x21-\x7e]{1,8192}$/;
const URL_RE = /^https?:\/\/[^\s]{1,2000}$/;
const isTime = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x > 0;

export function parseMeta(text: string): GrantMeta | null {
  let o: unknown;
  try { o = JSON.parse(text); } catch { return null; }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const r = o as Record<string, unknown>;
  if (r.v !== 1 || (r.method !== 'dcr' && r.method !== 'device')) return null;
  const url = (k: string, required: boolean): string | undefined | null => {
    const v = r[k];
    if (v === undefined) return required ? null : undefined;
    return typeof v === 'string' && URL_RE.test(v) ? v : null;
  };
  if (typeof r.clientId !== 'string' || !/^[A-Za-z0-9._-]{8,200}$/.test(r.clientId)) return null;
  if (r.clientSecret !== undefined && (typeof r.clientSecret !== 'string' || !TOKEN.test(r.clientSecret))) return null;
  const issuer = url('issuer', true); const token = url('tokenEndpoint', true);
  const auth = url('authorizationEndpoint', false); const rev = url('revocationEndpoint', false); const resource = url('resource', false);
  if (issuer === null || token === null || auth === null || rev === null || resource === null) return null;
  if (r.scope !== undefined && (typeof r.scope !== 'string' || r.scope.length > 2000)) return null;
  let registration: GrantMeta['registration'];
  if (r.registration !== undefined) {
    const g = r.registration as Record<string, unknown> | null;
    if (!g || typeof g !== 'object' || typeof g.uri !== 'string' || !URL_RE.test(g.uri) || typeof g.token !== 'string' || !TOKEN.test(g.token)) return null;
    registration = { uri: g.uri, token: g.token };
  }
  if (!isTime(r.connectedAt)) return null;
  if (r.account !== undefined && (typeof r.account !== 'string' || r.account.length > 120 || /[\u0000-\u001f\u007f]/.test(r.account))) return null;
  return {
    v: 1, method: r.method, clientId: r.clientId, ...(r.clientSecret ? { clientSecret: r.clientSecret as string } : {}),
    issuer: issuer as string, ...(auth ? { authorizationEndpoint: auth } : {}), tokenEndpoint: token as string,
    ...(rev ? { revocationEndpoint: rev } : {}), ...(resource ? { resource } : {}), ...(r.scope ? { scope: r.scope as string } : {}),
    ...(registration ? { registration } : {}), connectedAt: r.connectedAt as number, ...(r.account ? { account: r.account as string } : {})
  };
}

export type LoadMeta =
  | { kind: 'meta'; meta: GrantMeta }
  | { kind: 'missing' } | { kind: 'malformed' } | { kind: 'unavailable' };

export class GrantStore {
  constructor(private readonly secrets: VaultIO) {}

  load(id: string): LoadMeta {
    const ref = connectRef(id);
    let text: string | undefined;
    try { text = this.secrets.get(ref); } catch { text = undefined; }
    if (text !== undefined) { const meta = parseMeta(text); return meta ? { kind: 'meta', meta } : { kind: 'malformed' }; }
    let readable = false;
    try { readable = this.secrets.readable(); } catch { readable = false; }
    if (!readable) return { kind: 'unavailable' };
    let present = false;
    try { present = this.secrets.has(ref); } catch { present = false; }
    return present ? { kind: 'unavailable' } : { kind: 'missing' };
  }

  save(id: string, meta: GrantMeta): boolean {
    try { return this.secrets.set(connectRef(id), JSON.stringify(meta)).ok; } catch { return false; }
  }

  delete(id: string): boolean {
    try { this.secrets.delete(connectRef(id)); return !this.secrets.has(connectRef(id)); } catch { return false; }
  }
}
