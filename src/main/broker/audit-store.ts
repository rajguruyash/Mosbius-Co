/**
 * The durable audit trail (Stage B, F5).
 *
 * `AuditLog` (./audit.ts) is the short in-memory list the Access panel reads. This is
 * the record that survives a restart: an append-only JSON-Lines file in the app's data
 * folder that says WHO was allowed or refused WHAT, and what the user changed.
 *
 * What goes in: metadata only. A record has fixed fields (a kind, an actor, an agent id,
 * an integration id, an action such as a method or tool NAME, a decision, a short reason).
 * It never holds a request or response body, a tool argument, a header, a token, a key or
 * a file's content. Every string is stripped of control characters, cut short, and
 * scrubbed of anything shaped like a credential before it is written: a backstop, because
 * no call site passes a secret to begin with (test/audit-store.test.cjs plants sentinels
 * on every path and searches the file).
 *
 * Tamper evidence: every record carries `prev` (the previous record's tag) and `h`, a tag
 * over `prev` and the record's own text. With a key (the app keeps one in the encrypted
 * store) the tag is an HMAC-SHA256, so a person who can edit the file but cannot read the
 * key cannot produce a chain that verifies; without one it is a plain SHA-256 chain, which
 * still catches an edit, a deleted line or a reordering, but can be recomputed by anyone
 * who can write the file. Neither stops someone from deleting the whole folder, and
 * neither can show that the newest records were cut off: this is a trail you can check,
 * not a safe.
 *
 * Bounded: files of at most `maxFileBytes`, the newest `maxFiles` kept. The chain runs
 * on across a rotation (the first record of a new file carries the last tag of the old
 * one), and verification starts from whichever file is the oldest one still there.
 *
 * A chain alone cannot tell that its END was cut off, or that whole files were deleted, so the
 * store also keeps an ANCHOR: the sequence number and tag of the newest record, and the sequence
 * number of the oldest one the app still holds, sealed with the same HMAC. It is written to
 * `head.json` beside the log and, when the app supplies one, to a second place an editor of the
 * log folder cannot reach (the encrypted store). Verification then reports a log that ends
 * before its anchor ("truncated"), a record the anchor vouches for that is not what it was
 * ("anchor-mismatch"), files that were removed ("files-removed") and an anchor that was altered
 * ("anchor-invalid"). The anchor is refreshed every few records and after a short pause, so the
 * newest few records (at most ANCHOR_EVERY, for at most ANCHOR_IDLE_MS) are not yet vouched for:
 * that window is the honest limit of what can be detected. Someone who can write the folder AND
 * read the key can still rewrite everything; nothing here defends against that.
 *
 * It never throws into the caller and never blocks a request on anything slower than one
 * small synchronous append.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, writeSync
} from 'node:fs';
import { join } from 'node:path';

export type AuditKind =
  | 'mcp' | 'rest' | 'grant' | 'consent' | 'secret' | 'engine' | 'capability' | 'integration' | 'skill' | 'system';

export const AUDIT_KINDS: readonly AuditKind[] = [
  'mcp', 'rest', 'grant', 'consent', 'secret', 'engine', 'capability', 'integration', 'skill', 'system'
];

export interface AuditInput {
  kind: AuditKind;
  /** `user`, `system` or `agent:<id>`. */
  actor?: string;
  agentId?: string;
  integrationId?: string;
  /** A method, a tool name, `set`, `clear`, `on`, `off`, a preset: one short word or name. */
  action?: string;
  decision?: 'allow' | 'deny';
  reason?: string;
  /** Anything else worth a few words. Scrubbed like every other string. */
  detail?: string;
  count?: number;
}

export interface AuditRecord extends AuditInput {
  v: 1;
  seq: number;
  at: number;
}

/** A second, separately protected home for the anchor (the app uses its encrypted store). */
export interface AnchorStore {
  read(): string | undefined;
  write(value: string): boolean;
}

export interface AuditStoreOptions {
  dir: string;
  /** Where else the anchor is kept, out of reach of whoever can edit `dir`. */
  anchor?: AnchorStore;
  /** Keys the chain with an HMAC. Without one it is an unkeyed SHA-256 chain. */
  key?: Buffer;
  maxFileBytes?: number;
  maxFiles?: number;
  now?: () => number;
}

export type VerifyResult =
  | { ok: true; records: number; files: number; keyed: boolean; anchored: boolean }
  | { ok: false; file: string; line: number; reason: string };

/** How many records may be written before the anchor is refreshed, and how long a quiet pause may last. */
export const ANCHOR_EVERY = 10;
export const ANCHOR_IDLE_MS = 1000;
const HEAD_FILE = 'head.json';

export const AUDIT_MAX_FILE_BYTES = 2 * 1024 * 1024;
export const AUDIT_MAX_FILES = 6;
const FIELD_LIMIT = 160;
const GENESIS = '0'.repeat(32);
const FILE_RE = /^audit-(\d{6})\.jsonl$/;

/** Shapes a credential takes. A value matching one is replaced, whatever field it was in. */
const SECRET_SHAPES: RegExp[] = [
  /\b(?:gh[pousr]_|github_pat_|xox[abposr]-|sk-(?:ant-|proj-)?|AIza|ya29\.|ntn_|secret_|glpat-|AKIA)[A-Za-z0-9_\-.]{6,}/g,
  /\bBearer\s+[A-Za-z0-9._\-+/=]{6,}/gi,
  /\b[A-Za-z0-9_\-+/=]{32,}\b/g
];

/** Control characters out, credential shapes out, cut short. */
export function scrubText(v: unknown, max = FIELD_LIMIT): string | undefined {
  if (typeof v !== 'string') return undefined;
  let s = v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (!s) return undefined;
  for (const re of SECRET_SHAPES) s = s.replace(re, '[redacted]');
  return s.length > max ? s.slice(0, max) : s;
}

const tagOf = (key: Buffer | undefined, prev: string, body: string): string => {
  const data = `${prev}|${body}`;
  const mac = key ? createHmac('sha256', key).update(data, 'utf8').digest('hex') : createHash('sha256').update(data, 'utf8').digest('hex');
  return mac.slice(0, 32);
};

const sameTag = (a: string, b: string): boolean =>
  a.length === b.length && timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

/** Split a stored line into the text the tag covers and the tag. */
function splitLine(line: string): { body: string; tag: string } | null {
  const i = line.lastIndexOf(',"h":"');
  if (i < 0 || !line.endsWith('"}')) return null;
  return { body: `${line.slice(0, i)}}`, tag: line.slice(i + 6, line.length - 2) };
}

/** The sealed anchor text for the newest record and the oldest one still held. */
function anchorValue(key: Buffer | undefined, seq: number, tag: string, first: number, at: number): string {
  const mac = tagOf(key, 'anchor', `${seq}|${tag}|${first}`);
  return JSON.stringify({ v: 1, seq, tag, first, at, mac });
}

interface ParsedAnchor { seq: number; tag: string; first: number }
function parseAnchor(raw: string | undefined, key: Buffer | undefined): ParsedAnchor | 'invalid' | undefined {
  if (raw === undefined) return undefined;
  try {
    const a = JSON.parse(raw) as { seq?: unknown; tag?: unknown; first?: unknown; mac?: unknown };
    if (typeof a.seq !== 'number' || typeof a.tag !== 'string' || typeof a.first !== 'number' || typeof a.mac !== 'string') return 'invalid';
    return sameTag(tagOf(key, 'anchor', `${a.seq}|${a.tag}|${a.first}`), a.mac) ? { seq: a.seq, tag: a.tag, first: a.first } : 'invalid';
  } catch { return 'invalid'; }
}

function firstSeqOf(path: string): number | undefined {
  try {
    const line = readFileSync(path, 'utf8').split('\n').find(Boolean);
    const parts = line ? splitLine(line) : null;
    const rec = parts ? JSON.parse(parts.body) as { seq?: unknown } : null;
    return rec && typeof rec.seq === 'number' ? rec.seq : undefined;
  } catch { return undefined; }
}

function listFiles(dir: string): string[] {
  try {
    return readdirSync(dir).filter((n) => FILE_RE.test(n)).sort();
  } catch { return []; }
}

export class AuditStore {
  private readonly dir: string;
  private readonly key: Buffer | undefined;
  private readonly maxFileBytes: number;
  private readonly maxFiles: number;
  private readonly now: () => number;
  private fd: number | null = null;
  private fileNo = 0;
  private bytes = 0;
  private seq = 0;
  private prev = GENESIS;
  private dropped = 0;
  private started = false;
  private firstSeq = 1;
  private sinceAnchor = 0;
  private anchorTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly anchorStore: AnchorStore | undefined;

  constructor(opts: AuditStoreOptions) {
    this.anchorStore = opts.anchor;
    this.dir = opts.dir;
    this.key = opts.key && opts.key.length >= 16 ? opts.key : undefined;
    this.maxFileBytes = opts.maxFileBytes && opts.maxFileBytes > 1024 ? opts.maxFileBytes : AUDIT_MAX_FILE_BYTES;
    this.maxFiles = opts.maxFiles && opts.maxFiles >= 1 ? Math.floor(opts.maxFiles) : AUDIT_MAX_FILES;
    this.now = opts.now ?? Date.now;
  }

  /** Records that could not be written (a full disk, a read-only folder). Never silent forever. */
  droppedCount(): number { return this.dropped; }

  /** Whether the chain is keyed (HMAC) rather than a plain hash chain. */
  keyed(): boolean { return this.key !== undefined; }

  /** Append one record. Never throws. */
  append(input: AuditInput): void {
    try {
      if (!this.started) this.start();
      const kind = AUDIT_KINDS.includes(input.kind) ? input.kind : 'system';
      const rec: Record<string, unknown> = {
        v: 1,
        seq: this.seq + 1,
        at: Number.isFinite(this.now()) ? Math.floor(this.now()) : 0,
        kind
      };
      const put = (k: string, v: unknown): void => { if (v !== undefined) rec[k] = v; };
      put('actor', scrubText(input.actor, 80));
      put('agentId', scrubText(input.agentId, 128));
      put('integrationId', scrubText(input.integrationId, 64));
      put('action', scrubText(input.action, 128));
      put('decision', input.decision === 'allow' || input.decision === 'deny' ? input.decision : undefined);
      put('reason', scrubText(input.reason));
      put('detail', scrubText(input.detail));
      put('count', typeof input.count === 'number' && Number.isFinite(input.count) ? Math.trunc(input.count) : undefined);
      rec.prev = this.prev;
      const body = JSON.stringify(rec);
      const tag = tagOf(this.key, this.prev, body);
      const line = `${body.slice(0, -1)},"h":"${tag}"}\n`;
      this.write(line);
      this.seq += 1;
      this.prev = tag;
      this.sinceAnchor += 1;
      if (this.sinceAnchor >= ANCHOR_EVERY) this.flushAnchor(); else this.armAnchorTimer();
    } catch {
      this.dropped += 1;
    }
  }

  /** Write the anchor now (to `head.json` and to the second store). Never throws. */
  flushAnchor(): void {
    if (this.anchorTimer) { clearTimeout(this.anchorTimer); this.anchorTimer = null; }
    if (this.seq === 0 || !this.started) return;
    try {
      const value = anchorValue(this.key, this.seq, this.prev, this.firstSeq, this.now());
      const tmp = join(this.dir, `${HEAD_FILE}.tmp`);
      writeFileSync(tmp, value, { mode: 0o600 });
      renameSync(tmp, join(this.dir, HEAD_FILE));
      this.sinceAnchor = 0;
    } catch { this.dropped += 1; }
    try { this.anchorStore?.write(anchorValue(this.key, this.seq, this.prev, this.firstSeq, this.now())); } catch { /* the second copy is best-effort */ }
  }

  private armAnchorTimer(): void {
    if (this.anchorTimer) return;
    this.anchorTimer = setTimeout(() => { this.anchorTimer = null; this.flushAnchor(); }, ANCHOR_IDLE_MS);
    this.anchorTimer.unref?.();
  }

  /** Newest first. Reads the files on demand, so the cost is paid by whoever asks. */
  recent(filter: { integrationId?: string; kind?: AuditKind; limit?: number } = {}): AuditRecord[] {
    const limit = Math.max(1, Math.min(filter.limit ?? 100, 1000));
    const out: AuditRecord[] = [];
    try {
      const files = listFiles(this.dir).reverse();
      for (const f of files) {
        const lines = readFileSync(join(this.dir, f), 'utf8').split('\n').filter(Boolean);
        for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
          const parts = splitLine(lines[i]);
          if (!parts) continue;
          let rec: Record<string, unknown>;
          try { rec = JSON.parse(parts.body) as Record<string, unknown>; } catch { continue; }
          if (filter.integrationId !== undefined && rec.integrationId !== filter.integrationId) continue;
          if (filter.kind !== undefined && rec.kind !== filter.kind) continue;
          delete rec.prev;
          out.push(rec as unknown as AuditRecord);
        }
        if (out.length >= limit) break;
      }
    } catch { /* an unreadable trail shows as an empty one */ }
    return out;
  }

  /** Check every record still on disk. */
  verify(): VerifyResult {
    this.flushAnchor();
    return verifyAuditDir(this.dir, this.key, this.anchorStore ? [this.anchorStore] : []);
  }

  close(): void {
    this.flushAnchor();
    if (this.fd !== null) { try { closeSync(this.fd); } catch { /* noop */ } this.fd = null; }
  }

  // ─── internals ───────────────────────────────────────────────────────────

  private start(): void {
    this.started = true;
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    try { chmodSync(this.dir, 0o700); } catch { /* Windows has no mode */ }
    const files = listFiles(this.dir);
    if (files.length === 0) { this.fileNo = 1; return this.openFile(); }
    this.firstSeq = firstSeqOf(join(this.dir, files[0])) ?? 1;
    const newest = files[files.length - 1];
    this.fileNo = Number(FILE_RE.exec(newest)![1]);
    const tail = this.readTail(join(this.dir, newest));
    if (tail) {
      this.seq = tail.seq;
      this.prev = tail.tag;
      this.bytes = statSync(join(this.dir, newest)).size;
      this.fd = openSync(join(this.dir, newest), 'a', 0o600);
      return;
    }
    // The tail could not be read (a torn write, a hand-edited file). Say so in a fresh
    // file rather than carrying on as if nothing happened or refusing to log at all.
    this.fileNo += 1;
    this.seq = 0;
    this.prev = GENESIS;
    this.firstSeq = 1;
    this.openFile();
    this.append({ kind: 'system', actor: 'system', action: 'chain-reset', reason: 'unreadable-tail' });
    // the old anchor describes a history this store can no longer continue: replace it now
    this.flushAnchor();
  }

  private readTail(path: string): { seq: number; tag: string } | null {
    try {
      const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
      if (lines.length === 0) return { seq: 0, tag: GENESIS };
      const parts = splitLine(lines[lines.length - 1]);
      if (!parts) return null;
      const rec = JSON.parse(parts.body) as { seq?: unknown };
      return typeof rec.seq === 'number' ? { seq: rec.seq, tag: parts.tag } : null;
    } catch { return null; }
  }

  private openFile(): void {
    const name = `audit-${String(this.fileNo).padStart(6, '0')}.jsonl`;
    this.fd = openSync(join(this.dir, name), 'a', 0o600);
    try { chmodSync(join(this.dir, name), 0o600); } catch { /* Windows */ }
    this.bytes = 0;
    this.prune();
  }

  private write(line: string): void {
    if (this.fd === null) this.openFile();
    if (this.bytes + Buffer.byteLength(line) > this.maxFileBytes && this.bytes > 0) {
      this.close();
      this.fileNo += 1;
      this.openFile();
    }
    writeSync(this.fd as number, line);
    this.bytes += Buffer.byteLength(line);
  }

  private prune(): void {
    const files = listFiles(this.dir);
    const doomed = files.slice(0, Math.max(0, files.length - this.maxFiles));
    for (const f of doomed) {
      try { rmSync(join(this.dir, f), { force: true }); } catch { /* best-effort */ }
    }
    if (doomed.length > 0) {
      // the oldest record the app still holds moved on, and the anchor must say so, or a pruned
      // log would look like one somebody had cut the front off
      const left = listFiles(this.dir);
      this.firstSeq = left.length ? (firstSeqOf(join(this.dir, left[0])) ?? this.firstSeq) : this.seq + 1;
      this.flushAnchor();
    }
  }
}

/**
 * Recompute the chain over every file in `dir`, oldest first. The first record is taken
 * on trust for its `prev` (older files may have been pruned); everything after it must
 * chain from the one before, and every tag must match its record.
 */
export function verifyAuditDir(dir: string, key?: Buffer, anchors: Array<{ read(): string | undefined }> = []): VerifyResult {
  const k = key && key.length >= 16 ? key : undefined;
  const files = listFiles(dir);
  let expectPrev: string | null = null;
  let expectSeq: number | null = null;
  let records = 0;
  let firstSeq: number | null = null;
  let lastSeq = 0;
  const tagAtSeq = new Map<number, string>();
  for (const f of files) {
    let text: string;
    try { text = readFileSync(join(dir, f), 'utf8'); } catch { return { ok: false, file: f, line: 0, reason: 'unreadable' }; }
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    for (let i = 0; i < lines.length; i++) {
      const parts = splitLine(lines[i]);
      if (!parts) return { ok: false, file: f, line: i + 1, reason: 'malformed' };
      let rec: { seq?: unknown; prev?: unknown };
      try { rec = JSON.parse(parts.body) as { seq?: unknown; prev?: unknown }; } catch { return { ok: false, file: f, line: i + 1, reason: 'malformed' }; }
      if (typeof rec.prev !== 'string' || typeof rec.seq !== 'number') return { ok: false, file: f, line: i + 1, reason: 'malformed' };
      if (expectPrev !== null && rec.prev !== expectPrev && rec.prev !== GENESIS) return { ok: false, file: f, line: i + 1, reason: 'chain-broken' };
      if (expectSeq !== null && rec.seq !== expectSeq && rec.prev !== GENESIS) return { ok: false, file: f, line: i + 1, reason: 'sequence-gap' };
      const want = tagOf(k, rec.prev, parts.body);
      if (!sameTag(want, parts.tag)) return { ok: false, file: f, line: i + 1, reason: 'tag-mismatch' };
      expectPrev = parts.tag;
      expectSeq = rec.seq + 1;
      records += 1;
      if (firstSeq === null) firstSeq = rec.seq;
      lastSeq = rec.seq;
      tagAtSeq.set(rec.seq, parts.tag);
    }
  }

  // The anchors: what the app last vouched for. Every one that exists must be intact, and the log
  // must still contain what it vouches for.
  let anchored = false;
  const sources: Array<string | undefined> = [];
  try { sources.push(existsSync(join(dir, HEAD_FILE)) ? readFileSync(join(dir, HEAD_FILE), 'utf8') : undefined); } catch { sources.push('unreadable'); }
  for (const a of anchors) { try { sources.push(a.read()); } catch { sources.push(undefined); } }
  for (const raw of sources) {
    const a = parseAnchor(raw, k);
    if (a === undefined) continue;
    if (a === 'invalid') return { ok: false, file: HEAD_FILE, line: 0, reason: 'anchor-invalid' };
    anchored = true;
    if (records === 0 || lastSeq < a.seq) return { ok: false, file: HEAD_FILE, line: 0, reason: 'truncated' };
    if (firstSeq !== null && firstSeq > a.first) return { ok: false, file: HEAD_FILE, line: 0, reason: 'files-removed' };
    const there = tagAtSeq.get(a.seq);
    if (there !== undefined && !sameTag(there, a.tag)) return { ok: false, file: HEAD_FILE, line: 0, reason: 'anchor-mismatch' };
  }
  return { ok: true, records, files: files.length, keyed: k !== undefined, anchored };
}

export const auditDirExists = (dir: string): boolean => existsSync(dir);
