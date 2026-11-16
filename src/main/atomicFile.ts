/**
 * Crash-safe file writes and a small cross-process lock. Electron-free, so every
 * rule here is unit-tested under plain Node.
 *
 * Why this exists: the secret store used to rewrite its file in place
 * (`writeFileSync` truncates, then writes). A crash, a power cut or a second
 * writer in that window left a half-written file, and the reader then treated
 * the unparseable file as an EMPTY store — so the next save quietly replaced
 * every stored credential with one. Two properties fix that:
 *
 *   1. `writeFileAtomic` — the file on disk is always either the whole old
 *      content or the whole new content, never a mixture, whatever happens.
 *   2. `withFileLock` — read-modify-write cycles from two processes (or two
 *      app instances) cannot interleave and lose an update.
 */
import {
  closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync,
  statSync, unlinkSync, writeSync
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

/** Temp files older than this are leftovers from a crash and are removed. */
const STALE_TEMP_MS = 60_000;

/**
 * Test seam only: lets the Windows-specific behaviour below be exercised on any
 * OS. Nothing in the app writes to it.
 */
export const atomicFileEnv: { platform: NodeJS.Platform } = { platform: process.platform };
const onWindows = (): boolean => atomicFileEnv.platform === 'win32';

/**
 * Errors Windows raises when another program — a virus scanner, the search
 * indexer, a backup tool, a second instance — has the file open for a moment
 * without allowing it to be replaced or deleted. They clear on their own within
 * milliseconds. On every other OS the same codes mean a real permission problem
 * and are never retried, so a real fault is never delayed or hidden.
 */
const WINDOWS_TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY']);
const isTransient = (e: unknown): boolean =>
  onWindows() && WINDOWS_TRANSIENT.has((e as NodeJS.ErrnoException).code ?? '');

/** Run `op`, retrying a Windows-transient failure with a short growing pause
 *  (10, 20, 40, 80, 120 … ms; about a second in all) before giving up. */
function retryTransient<T>(op: () => T, attempts = 12): T {
  for (let i = 0; ; i++) {
    try { return op(); } catch (e) {
      if (!isTransient(e) || i >= attempts - 1) throw e;
      sleepSync(Math.min(10 * 2 ** i, 120));
    }
  }
}

/** Read a small file as text, riding out the Windows-transient errors above
 *  (a reader can collide with a writer's rename). Other errors, including
 *  ENOENT, pass straight through. */
export function readTextRetry(path: string): string {
  return retryTransient(() => readFileSync(path, 'utf8'), 6);
}

function writeAll(fd: number, data: Buffer): void {
  let off = 0;
  while (off < data.length) off += writeSync(fd, data, off, data.length - off);
}

/** Best-effort: persist the directory entry so the rename itself survives a
 *  power cut. Not possible on every platform (Windows cannot open a directory). */
function fsyncDir(dir: string): void {
  let fd = -1;
  try {
    fd = openSync(dir, 'r');
    fsyncSync(fd);
  } catch { /* unsupported here — the rename is still atomic */ }
  finally { if (fd !== -1) { try { closeSync(fd); } catch { /* noop */ } } }
}

/** Remove `<path>.tmp-*` files a crashed writer left behind. */
function sweepStaleTemps(path: string): void {
  const prefix = `${basename(path)}.tmp-`;
  let names: string[] = [];
  try { names = readdirSync(dirname(path)); } catch { return; }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const full = join(dirname(path), name);
    try {
      if (Date.now() - statSync(full).mtimeMs > STALE_TEMP_MS) unlinkSync(full);
    } catch { /* raced with another cleaner — fine */ }
  }
}

/**
 * Write `data` to `path` so that a reader, or a crash at any instant, sees
 * either the old file or the new one. The data goes to a private temp file in
 * the same directory (so the rename cannot cross a filesystem), is flushed to
 * disk, and only then replaces the target.
 *
 * Throws on failure, after removing its temp file; the target is untouched.
 */
export function writeFileAtomic(path: string, data: string | Buffer, opts: { mode?: number } = {}): void {
  mkdirSync(dirname(path), { recursive: true });
  sweepStaleTemps(path);
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  let fd = -1;
  try {
    fd = openSync(tmp, 'wx', opts.mode ?? 0o600);
    writeAll(fd, buf);
    fsyncSync(fd);
    closeSync(fd);
    fd = -1;
    retryTransient(() => renameSync(tmp, path));
  } catch (e) {
    if (fd !== -1) { try { closeSync(fd); } catch { /* noop */ } }
    try { unlinkSync(tmp); } catch { /* never created, or already gone */ }
    throw e;
  }
  fsyncDir(dirname(path));
}

// ─── lock ───────────────────────────────────────────────────────────────────

export class LockTimeoutError extends Error {
  constructor(public readonly lockPath: string) {
    super('timed out waiting for the file lock');
    this.name = 'LockTimeoutError';
  }
}

export interface LockOptions {
  /** Give up after this long. */
  timeoutMs?: number;
  /** A lock older than this is a dead holder's and may be taken over. */
  staleMs?: number;
}

const sleeper = new Int32Array(new SharedArrayBuffer(4));
/** Block the thread for a few milliseconds without spinning. */
export function sleepSync(ms: number): void {
  Atomics.wait(sleeper, 0, 0, ms);
}

/** Locks this process already holds, so a nested call does not wait on itself. */
const heldHere = new Set<string>();

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** The text of a lock file, or undefined when it is gone or cannot be read. */
function readStamp(lockPath: string): string | undefined {
  try { return readFileSync(lockPath, 'utf8'); } catch { return undefined; }
}

/**
 * Whether the lock belongs to a holder that is gone: older than `staleMs`, or
 * stamped with the pid of a process that no longer exists. Returns the stamp it
 * judged (so a takeover can confirm the file is still that one), or undefined
 * when the lock is live or already gone.
 */
function staleStamp(lockPath: string, staleMs: number): string | undefined {
  let age: number;
  try { age = Date.now() - statSync(lockPath).mtimeMs; } catch { return undefined; } // gone already
  const stamp = readStamp(lockPath) ?? '';
  if (age > staleMs) return stamp;
  try {
    const { pid } = JSON.parse(stamp) as { pid?: unknown };
    if (typeof pid === 'number' && pid > 0 && pid !== process.pid) return pidAlive(pid) ? undefined : stamp;
  } catch { /* being written right now, or unreadable: judge by age alone */ }
  return undefined;
}

/**
 * Run `fn` while holding an exclusive lock file. Works across processes (the
 * lock is created with O_EXCL), is re-entrant inside one process, and takes
 * over a lock whose holder died. The critical sections it guards are a few
 * milliseconds, so waiting is a short sleep, not a queue.
 *
 * If two waiters take over the same dead holder's lock at the same instant, both
 * may proceed. That cannot corrupt a file written with `writeFileAtomic`; at
 * worst it loses one of two simultaneous updates, after a crash.
 */
export function withFileLock<T>(lockPath: string, fn: () => T, opts: LockOptions = {}): T {
  if (heldHere.has(lockPath)) return fn();
  const timeoutMs = opts.timeoutMs ?? 5000;
  const staleMs = opts.staleMs ?? 15_000;
  const started = Date.now();
  mkdirSync(dirname(lockPath), { recursive: true });
  let lastError: NodeJS.ErrnoException | undefined;
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx', 0o600);
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, t: Date.now() }));
      } catch (err) {
        // The lock file exists but we could not stamp it. Never leave it behind:
        // it would block every other writer until it aged out.
        try { closeSync(fd); } catch { /* noop */ }
        try { unlinkSync(lockPath); } catch { /* noop */ }
        throw err;
      }
      closeSync(fd);
      break;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      // EEXIST: somebody holds it. On Windows EPERM/EACCES/EBUSY at this point mean
      // the same thing in disguise (a file another process deleted but still has
      // open is "delete pending" and cannot be re-created yet): wait it out.
      if (code !== 'EEXIST' && !isTransient(e)) throw e;
      lastError = e as NodeJS.ErrnoException;
      const judged = code === 'EEXIST' ? staleStamp(lockPath, staleMs) : undefined;
      // Confirm the file is still the one judged dead right before removing it,
      // so a lock somebody else just took over is not deleted from under them.
      if (judged !== undefined && (readStamp(lockPath) ?? '') === judged) {
        try { unlinkSync(lockPath); continue; } catch (ue) {
          // Already removed by someone else: try again at once. Anything else
          // (still held open on Windows, no permission) falls through to the wait
          // and the timeout below — never a hot loop.
          if ((ue as NodeJS.ErrnoException).code === 'ENOENT') continue;
        }
      }
      if (Date.now() - started > timeoutMs) {
        // A genuine fault that merely looked like contention (no permission to
        // create the file) is reported as itself, not as "busy".
        if (code !== 'EEXIST') throw lastError;
        throw new LockTimeoutError(lockPath);
      }
      sleepSync(5 + Math.floor(Math.random() * 15));
    }
  }
  heldHere.add(lockPath);
  try {
    return fn();
  } finally {
    heldHere.delete(lockPath);
    // A failed release is not an error for the caller (the work is done); the
    // lock then ages out or is taken over as a dead holder's.
    try { retryTransient(() => unlinkSync(lockPath), 8); } catch { /* already taken over as stale, or still held open */ }
  }
}
