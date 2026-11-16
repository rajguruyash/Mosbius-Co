/**
 * Keeping an installed skill honest: where it came from, whether it is still what was installed, what an update
 * would change, and the way back. Built on the guarded installer (skills.ts, skillGuard.ts); it adds no way
 * to run anything and no way to grant anything, and it never updates by itself.
 *
 *   • PROVENANCE   every install records its source, the exact COMMIT it was read at, and the hash of every
 *                  file as downloaded and as written, in a record OUTSIDE the skill folder (an agent cannot edit it);
 *   • INTEGRITY    `verifySkill` recomputes those hashes: a skill that has changed on disk since it was installed
 *                  (by an agent, an editor or anything else) is reported, file by file;
 *   • UPDATES      only on request. The newer commit is fetched into a staging folder, passed through the same
 *                  guard, and compared with what is installed; the user sees every changed line, any tool the
 *                  new version asks for (it is removed, but shown), any new script or dependency file, and what
 *                  the guard took out. Nothing changes until they say so;
 *   • ROLLBACK     applying an update keeps the old folder and record, so the previous version can be restored.
 *
 * Paths are built from a validated folder name only, and nothing outside `<skills folder>/<name>`, the record
 * folder and its own backups is ever written or removed. The skills folder is Claude Code's own
 * (`~/.claude/skills`) or the shared `~/.agents/skills` that Codex reads; each has its own record folder.
 */
import { createHash, randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { getText } from './fetchText';
import { detectSkillDeps, EMPTY_DEPS, type SkillDeps } from './skillDeps';
import { noteShippedCode, type Stripped } from './skillGuard';
import { resolveSkill, safeSkillDirName, writeSkillFiles, type InstallDeps, type WrittenFile } from './skills';

export interface SkillRecord {
  v: 1 | 2;
  name: string;
  dirName: string;
  source: string;
  resolved: string;
  ref: string | null;
  repo?: { owner: string; repo: string };
  skillPath?: string;
  commit: string | null;
  installedAt: number;
  updatedAt?: number;
  files: WrittenFile[];
  stripped: Stripped[];
  skipped: string[];
  notes: string[];
  deps: SkillDeps;
  agents: string[];
  previous?: Array<{ commit: string | null; at: number; backup: string }>;
}

export interface ManagerDeps extends InstallDeps {
  recordDir: string;
  now?: () => number;
}

const KEEP_BACKUPS = 5;
const STAGING_TTL_MS = 30 * 60_000;
const HEX64 = /^[0-9a-f]{64}$/;

const sha = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex');
/** The skills folder a manager works in: Claude Code's own by default, or the one the caller named (the shared
 *  `.agents/skills` folder that Codex reads). Each folder has its own record folder, so the two never mix. */
const skillsRoot = (d: { home?: string; root?: string }): string => d.root ?? join(d.home ?? homedir(), '.claude', 'skills');

function validName(dirName: unknown): dirName is string {
  return typeof dirName === 'string' && safeSkillDirName(dirName) === dirName;
}

/** The installed folder for a name, or undefined when the name is not a plain folder name. */
function installedDir(d: { home?: string; root?: string }, dirName: string): string | undefined {
  if (!validName(dirName)) return undefined;
  const dir = resolve(skillsRoot(d), dirName);
  return dir.startsWith(resolve(skillsRoot(d)) + sep) ? dir : undefined;
}

// ─── the record ─────────────────────────────────────────────────────────────

const isStr = (x: unknown, max = 4000): x is string => typeof x === 'string' && x.length <= max;
const isTime = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x > 0;

export function parseRecord(text: string, fileDirName: string): SkillRecord | null {
  let o: unknown;
  try { o = JSON.parse(text); } catch { return null; }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const r = o as Record<string, unknown>;
  if (!isStr(r.source) || !isStr(r.resolved) || !isTime(r.installedAt) || !Array.isArray(r.files)) return null;
  const files: WrittenFile[] = [];
  for (const f of r.files.slice(0, 200)) {
    const x = f as Record<string, unknown>;
    if (!x || !isStr(x.path, 600) || typeof x.installedSha256 !== 'string' || !HEX64.test(x.installedSha256)
      || typeof x.downloadedSha256 !== 'string' || !HEX64.test(x.downloadedSha256)) return null;
    files.push({ path: x.path, installedSha256: x.installedSha256, downloadedSha256: x.downloadedSha256, bytes: typeof x.bytes === 'number' ? x.bytes : 0 });
  }
  const deps = r.deps as Partial<SkillDeps> | undefined;
  const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string').slice(0, 100) : []);
  const prev = Array.isArray(r.previous)
    ? r.previous.filter((p): p is { commit: string | null; at: number; backup: string } => !!p && typeof (p as { backup?: unknown }).backup === 'string' && isTime((p as { at?: unknown }).at)).slice(-KEEP_BACKUPS)
    : undefined;
  return {
    v: r.v === 2 ? 2 : 1,
    name: isStr(r.name, 200) ? r.name : fileDirName,
    dirName: fileDirName,
    source: r.source, resolved: r.resolved, ref: typeof r.ref === 'string' ? r.ref : null,
    ...(r.repo && typeof r.repo === 'object' ? { repo: r.repo as { owner: string; repo: string } } : {}),
    ...(typeof r.skillPath === 'string' ? { skillPath: r.skillPath } : {}),
    commit: typeof r.commit === 'string' && /^[0-9a-f]{40}$/.test(r.commit) ? r.commit : null,
    installedAt: r.installedAt, ...(isTime(r.updatedAt) ? { updatedAt: r.updatedAt } : {}),
    files, stripped: Array.isArray(r.stripped) ? (r.stripped as Stripped[]).slice(0, 200) : [], skipped: list(r.skipped), notes: list(r.notes),
    deps: deps ? { integrations: list(deps.integrations), suggested: list(deps.suggested), tools: list(deps.tools) } : EMPTY_DEPS,
    agents: list(r.agents).length ? list(r.agents) : ['claude'],
    ...(prev && prev.length ? { previous: prev } : {})
  };
}

export function readRecord(recordDir: string, dirName: string): SkillRecord | null {
  if (!validName(dirName)) return null;
  try { return parseRecord(readFileSync(join(recordDir, `${dirName}.json`), 'utf8'), dirName); } catch { return null; }
}

function writeRecord(recordDir: string, rec: SkillRecord): void {
  mkdirSync(recordDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(recordDir, `${rec.dirName}.json`), JSON.stringify(rec, null, 2), { mode: 0o600 });
}

// ─── integrity ──────────────────────────────────────────────────────────────

export type Integrity =
  | { state: 'ok' }
  | { state: 'changed'; changed: string[]; missing: string[]; added: string[] }
  | { state: 'missing' };

function walkFiles(dir: string, base = ''): string[] {
  const out: string[] = [];
  let entries: string[] = [];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    const rel = base ? `${base}/${name}` : name;
    let st;
    try { st = statSync(join(dir, name)); } catch { continue; }
    if (st.isDirectory()) out.push(...walkFiles(join(dir, name), rel)); else if (st.isFile()) out.push(rel);
  }
  return out;
}

export function verifyDir(dir: string, rec: SkillRecord): Integrity {
  if (!existsSync(dir)) return { state: 'missing' };
  const changed: string[] = []; const missing: string[] = [];
  for (const f of rec.files) {
    const p = resolve(dir, f.path);
    if (!p.startsWith(resolve(dir) + sep) || !existsSync(p)) { missing.push(f.path); continue; }
    if (sha(readFileSync(p)) !== f.installedSha256) changed.push(f.path);
  }
  const known = new Set(rec.files.map((f) => f.path));
  const added = walkFiles(dir).filter((p) => !known.has(p));
  return changed.length || missing.length || added.length ? { state: 'changed', changed, missing, added } : { state: 'ok' };
}

export function verifySkill(deps: ManagerDeps, dirName: string): Integrity | { state: 'unmanaged' } {
  const rec = readRecord(deps.recordDir, dirName);
  const dir = installedDir(deps, dirName);
  if (!rec || !dir) return { state: 'unmanaged' };
  return verifyDir(dir, rec);
}

export interface ManagedSkill {
  dirName: string;
  name: string;
  path: string;
  source: string;
  commit: string | null;
  installedAt: number;
  updatedAt?: number;
  integrity: Integrity;
  deps: SkillDeps;
  notes: string[];
  strippedCount: number;
  canRollback: boolean;
  agents: string[];
}

/** Every skill this app installed and still has a record of, whether or not its folder is still there. */
export function listManagedSkills(deps: ManagerDeps): ManagedSkill[] {
  let names: string[] = [];
  try { names = readdirSync(deps.recordDir).filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)); } catch { return []; }
  const out: ManagedSkill[] = [];
  for (const dirName of names) {
    const rec = readRecord(deps.recordDir, dirName);
    const dir = installedDir(deps, dirName);
    if (!rec || !dir) continue;
    out.push({
      dirName, name: rec.name, path: dir, source: rec.source, commit: rec.commit, installedAt: rec.installedAt,
      ...(rec.updatedAt ? { updatedAt: rec.updatedAt } : {}), integrity: verifyDir(dir, rec), deps: rec.deps, notes: rec.notes,
      strippedCount: rec.stripped.length, canRollback: (rec.previous?.length ?? 0) > 0, agents: rec.agents
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// ─── a line diff, bounded ───────────────────────────────────────────────────

export interface FileDiff { path: string; change: 'added' | 'removed' | 'changed'; additions: number; deletions: number; diff?: string[] }
const MAX_DIFF_LINES = 160;
const MAX_FILE_LINES = 1500;

export function diffText(before: string, after: string): { additions: number; deletions: number; lines: string[] } {
  const a = before.split('\n'); const b = after.split('\n');
  if (a.length > MAX_FILE_LINES || b.length > MAX_FILE_LINES) {
    return { additions: b.length, deletions: a.length, lines: ['(too long to show line by line)'] };
  }
  const n = a.length; const m = b.length;
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops: Array<[' ' | '+' | '-', string]> = [];
  let i = 0; let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push([' ', a[i]]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push(['-', a[i]]); i++; }
    else { ops.push(['+', b[j]]); j++; }
  }
  while (i < n) ops.push(['-', a[i++]]);
  while (j < m) ops.push(['+', b[j++]]);
  let additions = 0; let deletions = 0;
  for (const [k] of ops) { if (k === '+') additions++; else if (k === '-') deletions++; }
  // keep two lines of context around each change
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach(([k], idx) => { if (k !== ' ') for (let c = Math.max(0, idx - 2); c <= Math.min(ops.length - 1, idx + 2); c++) keep[c] = true; });
  const lines: string[] = [];
  let gap = false;
  ops.forEach(([k, text], idx) => {
    if (!keep[idx]) { gap = true; return; }
    if (gap && lines.length) lines.push('…');
    gap = false;
    if (lines.length < MAX_DIFF_LINES) lines.push(`${k}${text}`);
  });
  if (lines.length >= MAX_DIFF_LINES) lines.push('… (more not shown)');
  return { additions, deletions, lines };
}

// ─── updates ────────────────────────────────────────────────────────────────

export interface UpdatePreview {
  token: string;
  dirName: string;
  from: string | null;
  to: string | null;
  files: FileDiff[];
  /** Files the user (or an agent) has changed since the install. An update replaces them; the old folder is kept. */
  locallyModified: string[];
  /** Tools the NEW version asks to pre-approve. Removed on install, shown here so the ask is visible. */
  newTools: string[];
  newIntegrations: string[];
  newScripts: string[];
  /** What the guard took out of the new version. */
  stripped: Stripped[];
  skipped: string[];
}

export type UpdateCheck =
  | { ok: true; upToDate: true; commit: string | null }
  | { ok: true; upToDate: false; preview: UpdatePreview }
  | { ok: false; error: string };

interface Pending { dirName: string; staging: string; record: SkillRecord; at: number }
const pending = new Map<string, Pending>();

function sweepStaging(recordDir: string, now: number): void {
  for (const [token, p] of [...pending]) {
    if (now - p.at > STAGING_TTL_MS) { try { rmSync(p.staging, { recursive: true, force: true }); } catch { /* best effort */ } pending.delete(token); }
  }
  void recordDir;
}

export async function checkUpdate(deps: ManagerDeps, dirName: string): Promise<UpdateCheck> {
  const now = (deps.now ?? Date.now)();
  sweepStaging(deps.recordDir, now);
  const rec = readRecord(deps.recordDir, dirName);
  const dir = installedDir(deps, dirName);
  if (!rec || !dir) return { ok: false, error: 'This app has no record of installing that skill, so it cannot update it.' };
  if (!existsSync(dir)) return { ok: false, error: 'The skill folder is gone.' };
  const fetchText = deps.getText ?? getText;
  const r = await resolveSkill(rec.source, rec.name, deps);
  if (!r.ok) return { ok: false, error: r.error };
  if (r.commit && rec.commit && r.commit === rec.commit) return { ok: true, upToDate: true, commit: rec.commit };

  const token = randomBytes(8).toString('hex');
  const staging = join(deps.recordDir, 'staging', token);
  const w = await writeSkillFiles(r.files, join(staging, 'skill'), fetchText);
  if (!w.ok) { try { rmSync(staging, { recursive: true, force: true }); } catch { /* best effort */ } return { ok: false, error: w.error }; }

  // an unpinned install has no commit to compare: identical content means there is nothing to update
  const integrity = verifyDir(dir, rec);
  const files: FileDiff[] = [];
  const nowPaths = new Set(w.record.map((f) => f.path));
  const oldHash = new Map(rec.files.map((f) => [f.path, f.installedSha256]));
  for (const f of w.record) {
    if (!oldHash.has(f.path)) files.push({ path: f.path, change: 'added', additions: 0, deletions: 0 });
    else if (oldHash.get(f.path) !== f.installedSha256) {
      const before = (() => { try { return readFileSync(resolve(dir, f.path), 'utf8'); } catch { return ''; } })();
      const after = readFileSync(resolve(staging, 'skill', f.path), 'utf8');
      const d = diffText(before, after);
      files.push({ path: f.path, change: 'changed', additions: d.additions, deletions: d.deletions, diff: d.lines });
    }
  }
  for (const f of rec.files) if (!nowPaths.has(f.path)) files.push({ path: f.path, change: 'removed', additions: 0, deletions: 0 });
  if (files.length === 0 && !(r.commit && rec.commit)) {
    try { rmSync(staging, { recursive: true, force: true }); } catch { /* best effort */ }
    return { ok: true, upToDate: true, commit: r.commit };
  }

  const found = detectSkillDeps(w.originals);
  const newNotes = noteShippedCode(r.files.map((f) => f.path));
  const newRecord: SkillRecord = {
    v: 2, name: rec.name, dirName, source: rec.source, resolved: r.source, ref: r.gh.ref || null,
    repo: { owner: r.gh.owner, repo: r.gh.repo }, skillPath: r.skillPath, commit: r.commit, installedAt: rec.installedAt,
    files: w.record, stripped: w.stripped, skipped: w.skipped, notes: newNotes, deps: found, agents: rec.agents
  };
  pending.set(token, { dirName, staging, record: newRecord, at: now });
  const preview: UpdatePreview = {
    token, dirName, from: rec.commit, to: r.commit, files,
    locallyModified: integrity.state === 'changed' ? [...integrity.changed, ...integrity.missing] : [],
    newTools: found.tools.filter((t) => !rec.deps.tools.includes(t)),
    newIntegrations: found.integrations.filter((i) => !rec.deps.integrations.includes(i)),
    newScripts: newNotes.filter((n) => !rec.notes.includes(n)),
    stripped: w.stripped, skipped: w.skipped
  };
  return { ok: true, upToDate: false, preview };
}

export function discardUpdate(token: string): void {
  const p = pending.get(token);
  if (!p) return;
  try { rmSync(p.staging, { recursive: true, force: true }); } catch { /* best effort */ }
  pending.delete(token);
}

function pruneBackups(recordDir: string, rec: SkillRecord): SkillRecord {
  const keep = (rec.previous ?? []).slice(-KEEP_BACKUPS);
  for (const old of (rec.previous ?? []).slice(0, Math.max(0, (rec.previous ?? []).length - KEEP_BACKUPS))) {
    const p = resolve(recordDir, 'backups', old.backup);
    if (p.startsWith(resolve(recordDir, 'backups') + sep)) { try { rmSync(p, { recursive: true, force: true }); } catch { /* best effort */ } }
  }
  return { ...rec, ...(keep.length ? { previous: keep } : {}) };
}

/** Install what `checkUpdate` previewed. The folder it replaces is kept for rollback. */
export function applyUpdate(deps: ManagerDeps, dirName: string, token: string): { ok: true; commit: string | null } | { ok: false; error: string } {
  const p = pending.get(token);
  const dir = installedDir(deps, dirName);
  const old = readRecord(deps.recordDir, dirName);
  if (!p || p.dirName !== dirName || !dir || !old) return { ok: false, error: 'That update is no longer pending. Check for updates again.' };
  const now = (deps.now ?? Date.now)();
  const rel = `${dirName}/${now}`;
  const backup = join(deps.recordDir, 'backups', rel);
  try {
    if (!existsSync(join(dir, 'SKILL.md'))) return { ok: false, error: 'The installed folder no longer looks like a skill; not touching it.' };
    mkdirSync(backup, { recursive: true, mode: 0o700 });
    cpSync(dir, join(backup, 'skill'), { recursive: true });
    writeFileSync(join(backup, 'record.json'), JSON.stringify(old), { mode: 0o600 });
    rmSync(dir, { recursive: true, force: true });
    cpSync(join(p.staging, 'skill'), dir, { recursive: true });
    if (!existsSync(join(dir, 'SKILL.md'))) throw new Error('the new version has no SKILL.md');
  } catch (e) {
    // put the old one back: an update that fails must leave the skill as it was
    try { rmSync(dir, { recursive: true, force: true }); cpSync(join(backup, 'skill'), dir, { recursive: true }); } catch { /* the backup is still there */ }
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const next = pruneBackups(deps.recordDir, {
    ...p.record, installedAt: old.installedAt, updatedAt: now,
    previous: [...(old.previous ?? []), { commit: old.commit, at: now, backup: rel }]
  });
  writeRecord(deps.recordDir, next);
  discardUpdate(token);
  return { ok: true, commit: next.commit };
}

/** Restore the version before the last update. */
export function rollbackSkill(deps: ManagerDeps, dirName: string): { ok: true; commit: string | null } | { ok: false; error: string } {
  const rec = readRecord(deps.recordDir, dirName);
  const dir = installedDir(deps, dirName);
  const last = rec?.previous?.at(-1);
  if (!rec || !dir || !last) return { ok: false, error: 'There is no earlier version to go back to.' };
  const backup = resolve(deps.recordDir, 'backups', last.backup);
  if (!backup.startsWith(resolve(deps.recordDir, 'backups') + sep) || !existsSync(join(backup, 'skill', 'SKILL.md'))) {
    return { ok: false, error: 'The earlier version is no longer on disk.' };
  }
  const restored = parseRecord(readFileSync(join(backup, 'record.json'), 'utf8'), dirName);
  if (!restored) return { ok: false, error: 'The earlier version\'s record is unreadable.' };
  try {
    rmSync(dir, { recursive: true, force: true });
    cpSync(join(backup, 'skill'), dir, { recursive: true });
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
  const previous = (rec.previous ?? []).slice(0, -1);
  writeRecord(deps.recordDir, { ...restored, ...(previous.length ? { previous } : {}), updatedAt: (deps.now ?? Date.now)() });
  try { rmSync(backup, { recursive: true, force: true }); } catch { /* best effort */ }
  return { ok: true, commit: restored.commit };
}

/**
 * Forget what was recorded about an installed skill (its record and its backups) once the skill itself has been
 * uninstalled. The skill folder is not touched here: removing a folder is `uninstallSkill`'s job and has its own
 * guard. Only paths built from a validated name inside the record folder are removed.
 */
export function forgetSkillRecord(deps: ManagerDeps, dirName: string): void {
  if (!validName(dirName)) return;
  try { rmSync(join(deps.recordDir, `${dirName}.json`), { force: true }); } catch { /* best effort */ }
  const backups = resolve(deps.recordDir, 'backups', dirName);
  if (backups.startsWith(resolve(deps.recordDir, 'backups') + sep)) { try { rmSync(backups, { recursive: true, force: true }); } catch { /* best effort */ } }
}
