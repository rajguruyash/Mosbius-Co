/**
 * Integrations registry + encrypted secret store (Phase 2 foundation, main process).
 *
 * Two responsibilities, deliberately separated from the broker:
 *   1. Registry — config-backed CRUD over IntegrationRecord metadata (NO secrets).
 *   2. Secret store — secrets ENCRYPTED AT REST via Electron `safeStorage`, kept in a
 *      file SEPARATE from config.json, decrypted only here, only in main.
 *
 * The broker (src/main/integrationBroker.ts) is electron-free and receives `getRecord`
 * + `getSecret` from here by injection, so it stays unit-testable without electron.
 *
 * SECURITY: a secret is never written unless `safeStorage.isEncryptionAvailable()`
 * (fail closed — no plaintext fallback), never returned to the renderer, never logged,
 * never placed in agent env/transcript, never echoed in any response. Records carry
 * only a `secretRef` handle.
 *
 * Contract: hive/docs/integrations-spec.md.
 */
import { app, safeStorage } from 'electron';
import { readdirSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  type IntegrationRecord,
  validateIntegrationRecord,
  authTypeNeedsSecret,
  secretRefFor
} from '../shared/integrations';
import { readConfig, writeConfig } from './config';
import { LockTimeoutError, readTextRetry, withFileLock, writeFileAtomic } from './atomicFile';

// ─── Registry (config-backed) ────────────────────────────────────────────────

/** All registered integration records (metadata only). */
export function listRecords(): IntegrationRecord[] {
  return readConfig().integrations ?? [];
}

/** Look up one record by id. */
export function getRecord(id: string): IntegrationRecord | undefined {
  return listRecords().find((r) => r.id === id);
}

/** Ids of integrations a worker may use right now (enabled, and — for secret auth —
 *  actually holding a stored secret). This is the default capability scope granted to
 *  every ephemeral worker. */
export function enabledIds(): string[] {
  return listRecords()
    .filter((r) => r.enabled && (!authTypeNeedsSecret(r.authType) || hasSecret(r.secretRef)))
    .map((r) => r.id);
}

/** Create or replace a record (validated). Stamps createdAt/updatedAt; preserves the
 *  original createdAt on update. Does NOT touch the secret store. */
export function upsertRecord(input: unknown): { ok: true; record: IntegrationRecord } | { ok: false; error: string } {
  const v = validateIntegrationRecord(input);
  if (!v.ok) return v;
  const now = Date.now();
  const existing = getRecord(v.value.id);
  const record: IntegrationRecord = {
    ...v.value,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  };
  const next = listRecords().filter((r) => r.id !== record.id);
  next.push(record);
  writeConfig({ integrations: next });
  return { ok: true, record };
}

/** Remove a record AND its stored secret. The secret goes first: if it cannot be
 *  deleted the record is kept, so the user still sees the integration, is told
 *  why, and can retry — instead of an orphaned credential nobody can find. */
export function removeRecord(id: string): { ok: boolean; error?: string } {
  const gone = deleteSecret(secretRefFor(id));
  if (!gone.ok) return { ok: false, error: gone.error ?? 'the stored credential could not be removed' };
  const next = listRecords().filter((r) => r.id !== id);
  writeConfig({ integrations: next });
  return { ok: true };
}

/** Records with the secretRef redacted to a boolean — the renderer-safe shape. */
export function listRecordsRedacted(): Array<Omit<IntegrationRecord, 'secretRef'> & { hasSecret: boolean }> {
  return listRecords().map(({ secretRef, ...rest }) => ({ ...rest, hasSecret: !!secretRef && hasSecret(secretRef) }));
}

// ─── Secret store (encrypted at rest) ────────────────────────────────────────
//
// One JSON file of `{ref: base64 ciphertext}`. Three rules keep it from ever
// losing a credential silently:
//
//   • WRITES ARE ATOMIC. The file on disk is always the whole old content or the
//     whole new content (temp file, fsync, rename — see atomicFile.ts). A crash
//     or a second process can no longer leave half a file behind.
//   • A FAILED READ IS NOT AN EMPTY STORE. The old code turned any read or parse
//     error into `{}`, and the next save then wrote that `{}` plus one entry over
//     every other credential. Now: a file that is merely unreadable (permissions,
//     I/O) blocks writes outright; a file that does not parse is moved aside,
//     never overwritten, and restored from the backup when there is one.
//   • READ-MODIFY-WRITE IS LOCKED, so two processes saving different secrets at
//     the same moment cannot cancel each other out.
//
// `<file>.bak` mirrors the last good state after every successful write.

/** Where the encrypted secrets are kept — exported so agents can be denied it. */
export function secretsFilePath(): string { return secretsPath(); }

function secretsPath(): string {
  return join(app.getPath('userData'), 'integration-secrets.json');
}
const backupPath = (): string => `${secretsPath()}.bak`;
const withStoreLock = <T,>(fn: () => T): T => withFileLock(`${secretsPath()}.lock`, fn);

export type SecretStoreState = 'ok' | 'recovered-from-backup' | 'corrupt-unrecovered' | 'unreadable';
export interface SecretStoreStatus {
  state: SecretStoreState;
  /** A short, secret-free explanation. */
  detail?: string;
  /** Where a damaged file was kept, when one was set aside. */
  preservedAs?: string;
  at?: number;
}
let storeStatus: SecretStoreStatus = { state: 'ok' };
let lastWarned = '';

/** The last problem the store ran into, or `{state:'ok'}`. Lets the UI say "your
 *  secret store was damaged" instead of presenting an empty one as normal. */
export function secretStoreStatus(): SecretStoreStatus { return { ...storeStatus }; }
/** Forget the recorded problem once the user has seen it. */
export function acknowledgeSecretStoreProblem(): void { storeStatus = { state: 'ok' }; lastWarned = ''; }

function noteProblem(state: SecretStoreState, detail: string, preservedAs?: string): void {
  storeStatus = { state, detail, ...(preservedAs ? { preservedAs } : {}), at: Date.now() };
  const key = `${state}|${detail}|${preservedAs ?? ''}`;
  if (key !== lastWarned) {
    lastWarned = key;
    console.warn(`[secrets] ${state}: ${detail}${preservedAs ? ` (kept as ${basename(preservedAs)})` : ''}`);
  }
}

type RawRead = { kind: 'missing' } | { kind: 'io'; code: string } | { kind: 'ok'; text: string };
function readRaw(path: string): RawRead {
  try {
    return { kind: 'ok', text: readTextRetry(path) };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? 'EIO';
    return code === 'ENOENT' ? { kind: 'missing' } : { kind: 'io', code };
  }
}

/** A well-formed store: a plain object whose every value is a string. */
function parseBlob(text: string): Record<string, string> | null {
  let v: unknown;
  try { v = JSON.parse(text); } catch { return null; }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  for (const x of Object.values(v as Record<string, unknown>)) if (typeof x !== 'string') return null;
  return v as Record<string, string>;
}

type Loaded = { ok: true; blob: Record<string, string> } | { ok: false; error: string };

/** Keep the newest few damaged files and no more. */
function pruneCorruptCopies(keep = 5): void {
  const prefix = `${basename(secretsPath())}.corrupt-`;
  try {
    const names = readdirSync(dirname(secretsPath())).filter((n) => n.startsWith(prefix)).sort();
    for (const n of names.slice(0, Math.max(0, names.length - keep))) {
      try { rmSync(join(dirname(secretsPath()), n), { force: true }); } catch { /* best-effort */ }
    }
  } catch { /* best-effort */ }
}

/** The main file does not parse. Set it aside (never overwrite it) and, if the
 *  backup is good, put the backup back. */
function recoverDamagedStore(): Loaded {
  try {
    return withStoreLock((): Loaded => {
      // Someone else may have repaired it while we waited for the lock.
      const again = readRaw(secretsPath());
      if (again.kind === 'missing') return { ok: true, blob: {} };
      if (again.kind === 'io') return { ok: false, error: `secret store unreadable (${again.code})` };
      const parsed = parseBlob(again.text);
      if (parsed) return { ok: true, blob: parsed };

      const preserved = `${secretsPath()}.corrupt-${Date.now()}`;
      renameSync(secretsPath(), preserved);
      pruneCorruptCopies();
      const bak = readRaw(backupPath());
      const restored = bak.kind === 'ok' ? parseBlob(bak.text) : null;
      if (restored) {
        writeFileAtomic(secretsPath(), JSON.stringify(restored, null, 2), { mode: 0o600 });
        noteProblem('recovered-from-backup', 'the secret store was damaged and was restored from its backup', preserved);
        return { ok: true, blob: restored };
      }
      noteProblem('corrupt-unrecovered', 'the secret store was damaged and there was no usable backup; stored credentials must be entered again', preserved);
      return { ok: true, blob: {} };
    });
  } catch (e) {
    const why = e instanceof LockTimeoutError ? 'secret store busy' : `secret store unreadable (${(e as NodeJS.ErrnoException).code ?? 'error'})`;
    return { ok: false, error: why };
  }
}

function loadBlob(): Loaded {
  const first = readRaw(secretsPath());
  if (first.kind === 'missing') return { ok: true, blob: {} };
  if (first.kind === 'io') {
    noteProblem('unreadable', `the secret store could not be read (${first.code})`);
    return { ok: false, error: `secret store unreadable (${first.code})` };
  }
  const parsed = parseBlob(first.text);
  return parsed ? { ok: true, blob: parsed } : recoverDamagedStore();
}

/** Writes the main file, then its backup mirror. The main write throws on failure;
 *  a backup that could not be refreshed is reported, not thrown, so a caller that
 *  only adds a secret can carry on while one that DELETES a secret can refuse to
 *  call it done (the stale backup would still hold what was deleted). */
function persistBlob(blob: Record<string, string>): { backupOk: boolean } {
  const text = JSON.stringify(blob, null, 2);
  writeFileAtomic(secretsPath(), text, { mode: 0o600 });
  try {
    writeFileAtomic(backupPath(), text, { mode: 0o600 });
    return { backupOk: true };
  } catch {
    console.warn('[secrets] could not refresh the secret store backup');
    return { backupOk: false };
  }
}

/**
 * Whether safeStorage is backed by a real OS credential store.
 *
 * On Linux with no keyring Electron falls back to a backend called
 * `basic_text`, which "encrypts" with a key hard-coded in Chromium and still
 * reports encryption as available. That is plaintext in all but name, so it is
 * treated as unavailable. (`getSelectedStorageBackend` only exists on Linux.)
 */
export function encryptionIsReal(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false;
  const backend = (safeStorage as { getSelectedStorageBackend?: () => string }).getSelectedStorageBackend;
  if (typeof backend === 'function' && backend.call(safeStorage) === 'basic_text') return false;
  return true;
}

/** Store a secret ENCRYPTED. Fail closed if OS encryption is unavailable (never
 *  writes plaintext). The plaintext is used only to encrypt and is not retained.
 *  Refuses to write when the existing store cannot be read, so a read error can
 *  never be turned into a store that has lost every other secret. */
export function setSecret(secretRef: string, plaintext: string): { ok: boolean; error?: string } {
  if (!secretRef) return { ok: false, error: 'secretRef required' };
  if (typeof plaintext !== 'string' || plaintext === '') return { ok: false, error: 'secret required' };
  try {
    if (!encryptionIsReal()) {
      return { ok: false, error: 'OS secret encryption is unavailable; refusing to store a secret in plaintext' };
    }
    const cipher = safeStorage.encryptString(plaintext).toString('base64');
    const result = withStoreLock((): { ok: boolean; error?: string } => {
      const loaded = loadBlob();
      if (!loaded.ok) return { ok: false, error: `${loaded.error}; nothing was changed` };
      loaded.blob[secretRef] = cipher;
      persistBlob(loaded.blob);
      return { ok: true };
    });
    if (result.ok) notifySecretChange(secretRef, 'set');
    return result;
  } catch (e) {
    if (e instanceof LockTimeoutError) return { ok: false, error: 'the secret store is busy; try again' };
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Decrypt a secret. MAIN-INTERNAL ONLY — never expose this over IPC. Returns
 *  undefined if absent or undecryptable (the broker maps that to 503 no_secret).
 *  An unreadable store also answers undefined, and is recorded in
 *  `secretStoreStatus()` rather than passing as a normal empty one. */
export function getSecret(secretRef: string | undefined): string | undefined {
  if (!secretRef) return undefined;
  const loaded = loadBlob();
  const cipher = loaded.ok ? loaded.blob[secretRef] : undefined;
  if (!cipher) return undefined;
  try {
    if (!safeStorage.isEncryptionAvailable()) return undefined;
    return safeStorage.decryptString(Buffer.from(cipher, 'base64'));
  } catch {
    return undefined;
  }
}

/** Whether the store can be read at all right now (an empty store is readable).
 *  Lets a caller tell "nothing is stored" from "the store could not be looked at". */
export function secretStoreReadable(): boolean {
  return loadBlob().ok;
}

/** Whether a secret is stored for this ref (no decryption). */
export function hasSecret(secretRef: string | undefined): boolean {
  if (!secretRef) return false;
  const loaded = loadBlob();
  return loaded.ok && !!loaded.blob[secretRef];
}

/** Delete a stored secret. Idempotent. Reports failure instead of pretending: a
 *  caller that is disconnecting an account needs to know the secret is still
 *  there if the store could not be read or written — or if a copy of it is still
 *  sitting in the backup mirror, which recovery would put back. */
export function deleteSecret(secretRef: string | undefined): { ok: boolean; error?: string } {
  if (!secretRef) return { ok: true };
  try {
    let removed = false;
    const result = withStoreLock((): { ok: boolean; error?: string } => {
      const loaded = loadBlob();
      if (!loaded.ok) return { ok: false, error: loaded.error };
      if (!(secretRef in loaded.blob)) return { ok: true };
      removed = true;
      delete loaded.blob[secretRef];
      if (Object.keys(loaded.blob).length === 0) {
        // Nothing left to protect: remove the file and its backup, so a deleted
        // secret does not survive in either. recursive+force also retries the
        // transient EBUSY/EPERM a virus scanner causes on Windows.
        removeFile(secretsPath());
        removeFile(backupPath());
      } else {
        const { backupOk } = persistBlob(loaded.blob);
        if (!backupOk) {
          // The old backup still holds the secret we were asked to delete.
          // Losing the backup is the smaller harm; if even that fails, say so.
          try { removeFile(backupPath()); } catch {
            return { ok: false, error: 'the secret was removed, but an old backup copy of the store could not be refreshed or deleted' };
          }
        }
      }
      return { ok: true };
    });
    if (removed) notifySecretChange(secretRef, 'clear');
    return result;
  } catch (e) {
    if (e instanceof LockTimeoutError) return { ok: false, error: 'the secret store is busy; try again' };
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export type SecretChange = 'set' | 'clear';
let secretObserver: ((ref: string, change: SecretChange) => void) | undefined;
/** Told, after the fact, that a secret was written or removed. Receives the REF only (a name
 *  like `mcp:github`), never a value; the audit trail uses it so no caller can change a
 *  credential without leaving a record. One observer; a failing one never fails the write. */
export function setSecretObserver(fn: ((ref: string, change: SecretChange) => void) | undefined): void {
  secretObserver = fn;
}
function notifySecretChange(ref: string, change: SecretChange): void {
  try { secretObserver?.(ref, change); } catch { /* an observer must never fail a write */ }
}

function removeFile(path: string): void {
  rmSync(path, { force: true, recursive: true, maxRetries: 4, retryDelay: 40 });
}
