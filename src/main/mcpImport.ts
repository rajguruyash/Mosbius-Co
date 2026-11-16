/**
 * Copy an existing bridge sign-in into the in-app engine, so switching an
 * integration over does not make anyone sign in twice.
 *
 * COPY, NEVER MOVE. The bridge's sealed tokens (`mcp:<id>:tokens`) are read and
 * left exactly as they were: the way back to the bridge is a switch, and it must
 * still find its sign-in. Nothing is ever written to the bridge's store from here,
 * and an in-app record that already exists is never overwritten.
 *
 * What a bridge sign-in can and cannot give:
 *   • `mcp-remote` keeps `{access_token, refresh_token?, expires_in?, scope?}` and no
 *     absolute expiry (`expires_in` is relative to a moment it did not write down).
 *     So the age of the access token is unknown. With a refresh token the record is
 *     marked expired NOW, which makes the first use refresh: it proves the grant is
 *     alive and mints a token of known age. Without one, the access token is trusted
 *     for five minutes at most; after that the status is "sign in again".
 *   • Google only issues a refresh token when asked for `access_type=offline`, which
 *     the bridge never did, so a Google import will usually be the short-lived kind.
 *     Say so; do not pretend otherwise.
 *
 * Electron-free; the store is injected. Never logs, never returns a token.
 */
import { mcpOauthRef, mcpTokenRef, type McpCatalogEntry } from '../shared/mcpCatalog';
import { clientFingerprint, parseRecord, serializeRecord, type SecretIO, type TokenRecord, type TokenStore } from './oauth/token-store';

export type ImportOutcome =
  | { kind: 'already' }                               // the in-app engine already has a record: left alone
  | { kind: 'none' }                                  // the bridge holds nothing to copy
  | { kind: 'imported'; refreshable: boolean }
  | { kind: 'failed'; why: 'no-client' | 'unreadable' | 'malformed' | 'not-stored' };

export interface ImportDeps {
  secrets: SecretIO;
  store: TokenStore;
  now(): number;
}

const TOKEN_FILE = /^[a-f0-9]{32}_tokens\.json$/;
/** An access token with no refresh token, and so no known age, is trusted this long. */
export const UNKNOWN_AGE_GRACE_MS = 5 * 60_000;

interface Candidate { access: string; refresh?: string; scope?: string }

function candidatesIn(sealed: string): Candidate[] | null {
  let files: unknown;
  try { files = (JSON.parse(sealed) as { files?: unknown })?.files; } catch { return null; }
  if (!files || typeof files !== 'object' || Array.isArray(files)) return null;
  const out: Candidate[] = [];
  for (const [name, text] of Object.entries(files as Record<string, unknown>)) {
    if (!TOKEN_FILE.test(name) || typeof text !== 'string') continue;
    let o: unknown;
    try { o = JSON.parse(text); } catch { continue; }
    if (!o || typeof o !== 'object' || Array.isArray(o)) continue;
    const t = o as Record<string, unknown>;
    if (typeof t.access_token !== 'string' || !t.access_token) continue;
    out.push({
      access: t.access_token,
      ...(typeof t.refresh_token === 'string' && t.refresh_token ? { refresh: t.refresh_token } : {}),
      ...(typeof t.scope === 'string' && t.scope ? { scope: t.scope.slice(0, 2000) } : {})
    });
  }
  return out;
}

export function importBridgeTokens(deps: ImportDeps, entry: McpCatalogEntry): ImportOutcome {
  if (entry.spec.transport !== 'bridge' || !entry.spec.oauth) return { kind: 'none' };
  const id = entry.id;

  // An in-app record, even a dead one, is the user's current state: never overwrite it.
  let existing = false;
  try { existing = deps.secrets.has(mcpOauthRef(id)); } catch { existing = false; }
  if (existing) return { kind: 'already' };

  let sealed: string | undefined;
  try { sealed = deps.secrets.get(mcpTokenRef(id)); } catch { sealed = undefined; }
  if (sealed === undefined) {
    // nothing came back: nothing stored, or the store could not be read or decrypted
    let readable = false;
    let present = false;
    try { readable = deps.secrets.readable(); } catch { readable = false; }
    if (!readable) return { kind: 'failed', why: 'unreadable' };
    try { present = deps.secrets.has(mcpTokenRef(id)); } catch { present = false; }
    return present ? { kind: 'failed', why: 'unreadable' } : { kind: 'none' };
  }

  const found = candidatesIn(sealed);
  if (found === null) return { kind: 'failed', why: 'malformed' };
  if (found.length === 0) return { kind: 'none' };
  const chosen = found.find((c) => c.refresh) ?? found[0];

  let clientId: string | undefined;
  try { clientId = deps.secrets.get(`mcp:${id}:client_id`)?.trim(); } catch { clientId = undefined; }
  if (!clientId) return { kind: 'failed', why: 'no-client' };

  const now = deps.now();
  const record: TokenRecord = {
    v: 1,
    accessToken: chosen.access,
    ...(chosen.refresh ? { refreshToken: chosen.refresh } : {}),
    expiresAt: chosen.refresh ? now : now + UNKNOWN_AGE_GRACE_MS,
    ...(chosen.scope ? { scope: chosen.scope } : {}),
    obtainedAt: now,
    clientFingerprint: clientFingerprint(clientId)
  };
  // The same checks every stored record passes: a token that does not fit them is not copied.
  if (!parseRecord(serializeRecord(record))) return { kind: 'failed', why: 'malformed' };

  const saved = deps.store.save(id, record);
  if (!saved.ok) return { kind: 'failed', why: 'not-stored' };
  return { kind: 'imported', refreshable: !!chosen.refresh };
}
