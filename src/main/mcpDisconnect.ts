/**
 * Disconnecting an account, and removing stored credentials, without ever
 * reporting a removal that did not happen.
 *
 * Why this is its own module: the secret store's `deleteSecret` reports failure
 * as a RESULT (`{ok:false}`), not an exception. Callers that were written when it
 * threw — `try { deleteSecret(x); return {ok:true} } catch {…}` — therefore
 * answered "disconnected" while the refresh token was still in the store. Every
 * credential removal now goes through `removeSecrets`, which checks the result
 * AND asks the store whether the secret is really gone.
 *
 * Electron-free: every collaborator is injected, so each failure path is
 * unit-tested with a store that refuses.
 */
import { mcpOauthRef, mcpSecretRefs, type McpCatalogEntry, type McpRevokeSpec } from '../shared/mcpCatalog';
import type { PurgeResult, StoredToken } from './mcpAuthVault';

export interface SecretRemover {
  delete(ref: string): { ok: boolean; error?: string };
  has(ref: string): boolean;
}

export interface RemovalResult {
  ok: boolean;
  /** The refs that are STILL stored. Empty when `ok`. */
  failed: string[];
  /** A short, secret-free reason, when something failed. */
  error?: string;
}

/** Keep whatever the store said short and free of control characters. */
function oneLine(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
}

/**
 * Delete each secret and CHECK that it is gone. A delete that reports success
 * but leaves the secret readable is a failure; so is one that throws.
 */
export function removeSecrets(store: SecretRemover, refs: readonly string[]): RemovalResult {
  const failed: string[] = [];
  const reasons: string[] = [];
  for (const ref of refs) {
    let res: { ok?: unknown; error?: unknown } | undefined;
    try {
      res = store.delete(ref);
    } catch (e) {
      res = { ok: false, error: e instanceof Error ? e.message : 'delete failed' };
    }
    if (!res || res.ok !== true) {
      failed.push(ref);
      reasons.push(typeof res?.error === 'string' && res.error ? oneLine(res.error) : 'the store did not confirm the delete');
      continue;
    }
    let still = true;
    try { still = store.has(ref); } catch { still = true; }
    if (still) { failed.push(ref); reasons.push('it was still stored after the delete'); }
  }
  if (failed.length === 0) return { ok: true, failed };
  const why = [...new Set(reasons)].join('; ');
  return {
    ok: false, failed,
    error: `${failed.length} stored credential${failed.length === 1 ? '' : 's'} could not be removed (${why})`
  };
}

export interface DisconnectDeps {
  /** Stop a sign-in still waiting in the user's browser (either engine's). */
  cancelSignIn(id: string): void;
  vault: {
    readTokens(id: string): StoredToken[];
    purge(id: string): PurgeResult;
  };
  /** Ask the provider to forget the BRIDGE's tokens. Best-effort. */
  revoke(spec: McpRevokeSpec | undefined, tokens: StoredToken[]): Promise<{ attempted: number; confirmed: number }>;
  secrets: SecretRemover;
  /**
   * The in-app OAuth engine's side. Disconnect always covers BOTH engines: an
   * account is not disconnected if the other engine still holds a refresh token,
   * whichever one is selected right now.
   */
  broker?: {
    hasTokens(id: string): boolean;
    /** Ask the provider to forget the in-app engine's tokens. Best-effort. */
    revoke(id: string): Promise<{ attempted: number; confirmed: number }>;
    /** Drop the in-memory copy and make any refresh still on the wire useless. */
    forget(id: string): void;
  };
  /** Runs FIRST, before any slow network call: agent access ends at once. */
  onDisconnected?(id: string): void;
}

export interface DisconnectResult { ok: boolean; revoked: boolean; error?: string }

/** The text a failed disconnect shows. Says what is still true, so a failure is
 *  never mistaken for the account being gone. */
export function notDisconnected(reason: string, revoked: boolean): string {
  return `Not fully disconnected: ${reason}. The stored credentials are still on this computer, so try again.`
    + (revoked ? ' (Access was already revoked at the provider.)' : '');
}

/**
 * Disconnect a bridged server: cut agent access, revoke at the provider where it
 * documents how, then delete the tokens (both engines'), the OAuth client and
 * every plaintext file.
 *
 * `ok` is true only when every local copy is gone. Revocation is best-effort and
 * reported separately (`revoked`); the local wipe is not best-effort.
 */
export async function disconnectBridged(deps: DisconnectDeps, entry: McpCatalogEntry): Promise<DisconnectResult> {
  if (entry.spec.transport !== 'bridge') return { ok: false, revoked: false, error: 'unknown server' };
  deps.cancelSignIn(entry.id);
  // Capabilities for this integration die NOW, before the network is touched.
  try { deps.onDisconnected?.(entry.id); } catch { /* the wipe below does not depend on it */ }

  let attempted = 0;
  let confirmed = 0;
  try {
    const tokens = deps.vault.readTokens(entry.id);
    if (tokens.length) {
      const r = await deps.revoke(entry.spec.revoke, tokens);
      attempted += r.attempted; confirmed += r.confirmed;
    }
  } catch { /* revocation is best-effort; the local wipe below is not */ }
  try {
    if (deps.broker?.hasTokens(entry.id)) {
      const r = await deps.broker.revoke(entry.id);
      attempted += r.attempted; confirmed += r.confirmed;
    }
  } catch { /* same */ }
  const revoked = attempted > 0 && confirmed === attempted;

  const problems: string[] = [];
  try {
    const purged = deps.vault.purge(entry.id);
    // success needs an explicit ok: a purge that reports nothing is not a success
    if (!purged || purged.ok !== true) problems.push(purged?.error ?? 'the stored tokens could not be removed');
  } catch (e) {
    problems.push(e instanceof Error ? oneLine(e.message) : 'the stored tokens could not be removed');
  }
  // The OAuth client halves AND the in-app engine's sealed record, each verified gone.
  const removed = removeSecrets(deps.secrets, [...mcpSecretRefs(entry), mcpOauthRef(entry.id)]);
  if (!removed.ok && removed.error) problems.push(removed.error);

  // Whatever happened to the files, nothing in memory may outlive a disconnect.
  try { deps.broker?.forget(entry.id); } catch { /* noop */ }

  if (problems.length) return { ok: false, revoked, error: notDisconnected(problems.join('; '), revoked) };
  return { ok: true, revoked };
}
