/**
 * The verified install store for the third-party packages the app runs (Stage B, F4).
 *
 * Before this, nine local servers ran as `npx -y <package>` / `uvx <package>`: whatever the
 * registry served at that moment, with its install scripts, from a cache the app did not own.
 * Now:
 *
 *   • every package is pinned to one exact release in the catalogue, and its whole dependency
 *     tree with a hash for every file is committed in `resources/mcp-locks/<id>/`;
 *   • the app installs from THAT lock, into its own folder under the data directory, and from
 *     nothing else: `npm ci --ignore-scripts` (npm refuses any tarball whose sha512 differs from
 *     the lock) and `uv pip install --require-hashes --no-deps --no-build` (pip-style hash
 *     checking, wheels only, nothing built);
 *   • an install that does not finish cleanly leaves nothing that looks installed: the marker
 *     `.verified.json` is written last, and a server is launched only from a folder whose marker
 *     matches the lock the app now ships and whose files are all there;
 *   • a mismatch is a refusal, reported, never a retry with checks off.
 *
 * Installation is async and happens when the user switches a server on, not when an agent starts;
 * `readyLaunch` is the cheap synchronous check the spawn path uses. Everything that touches the
 * outside (running npm/uv, resolving node) is injected, so the rules are tested without a network.
 */
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { McpPackage } from '../shared/mcpCatalog';

export type PackageState = 'ready' | 'missing' | 'installing' | 'failed';

export type EnsureResult =
  | { ok: true }
  | { ok: false; error: 'no-lock' | 'no-npm' | 'no-uv' | 'no-node' | 'install-failed' | 'timeout' | 'bin-missing' | 'version-mismatch' | 'unsafe' };

export interface RunResult { code: number | null; timedOut: boolean }
export type RunFn = (
  cmd: string, args: string[], opts: { cwd: string; env: Record<string, string>; timeoutMs: number }
) => Promise<RunResult>;

export interface PackageStoreOptions {
  /** <userData>/mcp-packages */
  root: string;
  /** resources/mcp-locks (dev) or <resources>/mcp-locks (packaged) */
  locksRoot: string;
  /** The environment installers run in: a short allow-list, never the app's whole environment. */
  env: () => Record<string, string>;
  /** Resolve a tool on the user's PATH; undefined when it is not installed. */
  which: (name: 'npm' | 'uv' | 'node') => string | undefined;
  run?: RunFn;
  platform?: NodeJS.Platform;
  installTimeoutMs?: number;
}

/** `node` when the package is a Node program run by `command` (so a launcher can run it in-process),
 *  `native` when `command` is the program itself. */
export interface Launch { command: string; args: string[]; runtime: 'node' | 'native' }

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MARKER = '.verified.json';
export const INSTALL_TIMEOUT_MS = 6 * 60_000;

/** The default runner: no shell, stdout dropped, a hard timeout. */
export const defaultRun: RunFn = (cmd, args, opts) => new Promise((done) => {
  let finished = false;
  let timedOut = false;
  const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'ignore', 'ignore'], shell: false, windowsHide: true });
  const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch { /* gone */ } }, opts.timeoutMs);
  const end = (code: number | null): void => { if (finished) return; finished = true; clearTimeout(timer); done({ code, timedOut }); };
  child.on('error', () => end(null));
  child.on('close', (code) => end(code));
});

export class PackageStore {
  private readonly run: RunFn;
  private readonly platform: NodeJS.Platform;
  private readonly timeoutMs: number;
  private readonly inflight = new Map<string, Promise<EnsureResult>>();
  private readonly failed = new Set<string>();

  constructor(private readonly opts: PackageStoreOptions) {
    this.run = opts.run ?? defaultRun;
    this.platform = opts.platform ?? process.platform;
    this.timeoutMs = opts.installTimeoutMs ?? INSTALL_TIMEOUT_MS;
  }

  // ─── the lock, and where its install lives ──────────────────────────────

  private lockDir(lockId: string): string | undefined {
    if (!SAFE_ID.test(lockId)) return undefined;
    const dir = join(this.opts.locksRoot, lockId);
    return existsSync(dir) ? dir : undefined;
  }

  /** sha256 over the lock files exactly as shipped. A different lock is a different install. */
  lockHash(lockId: string, pkg: McpPackage): string | undefined {
    const dir = this.lockDir(lockId);
    if (!dir) return undefined;
    try {
      const files = pkg.manager === 'npm' ? ['package.json', 'package-lock.json'] : ['requirements.txt'];
      const h = createHash('sha256');
      for (const f of files) h.update(readFileSync(join(dir, f)));
      return h.digest('hex');
    } catch { return undefined; }
  }

  private installDir(lockId: string, pkg: McpPackage, hash: string): string {
    return join(this.opts.root, lockId, `${pkg.version}-${hash.slice(0, 12)}`);
  }

  /** The folder an install of this exact lock lives in, whether or not it exists yet. */
  dirFor(lockId: string, pkg: McpPackage): string | undefined {
    const hash = this.lockHash(lockId, pkg);
    return hash ? this.installDir(lockId, pkg, hash) : undefined;
  }

  // ─── ready? how to launch ───────────────────────────────────────────────

  /**
   * How to start the package, or undefined unless a COMPLETE install of the lock the app now
   * ships is on disk. Synchronous and cheap: the spawn path calls it.
   */
  readyLaunch(lockId: string, pkg: McpPackage): Launch | undefined {
    const hash = this.lockHash(lockId, pkg);
    if (!hash) return undefined;
    const dir = this.installDir(lockId, pkg, hash);
    try {
      const marker = JSON.parse(readFileSync(join(dir, MARKER), 'utf8')) as { lockHash?: unknown; name?: unknown; version?: unknown };
      if (marker.lockHash !== hash || marker.name !== pkg.name || marker.version !== pkg.version) return undefined;
    } catch { return undefined; }
    if (pkg.manager !== 'npm') return this.pyLaunch(dir, pkg);
    const launch = this.npmLaunchOf(dir, pkg);
    return typeof launch === 'object' ? launch : undefined;
  }

  private pyLaunch(dir: string, pkg: McpPackage): Launch | undefined {
    const bin = this.platform === 'win32' ? join(dir, 'venv', 'Scripts', `${pkg.bin}.exe`) : join(dir, 'venv', 'bin', pkg.bin);
    return existsSync(bin) ? { command: bin, args: [], runtime: 'native' } : undefined;
  }

  state(lockId: string, pkg: McpPackage): PackageState {
    if (this.inflight.has(lockId)) return 'installing';
    if (this.readyLaunch(lockId, pkg)) return 'ready';
    return this.failed.has(lockId) ? 'failed' : 'missing';
  }

  // ─── installing ─────────────────────────────────────────────────────────

  /** Install the locked release if it is not already installed. Single-flight per package. */
  ensure(lockId: string, pkg: McpPackage): Promise<EnsureResult> {
    if (this.readyLaunch(lockId, pkg)) return Promise.resolve({ ok: true });
    const running = this.inflight.get(lockId);
    if (running) return running;
    const p = this.install(lockId, pkg)
      .catch((): EnsureResult => ({ ok: false, error: 'install-failed' }))
      .then((r) => { if (r.ok) this.failed.delete(lockId); else this.failed.add(lockId); return r; })
      .finally(() => { this.inflight.delete(lockId); });
    this.inflight.set(lockId, p);
    return p;
  }

  private async install(lockId: string, pkg: McpPackage): Promise<EnsureResult> {
    const lock = this.lockDir(lockId);
    const hash = this.lockHash(lockId, pkg);
    if (!lock || !hash || !SAFE_ID.test(lockId)) return { ok: false, error: lock ? 'unsafe' : 'no-lock' };
    if (pkg.manager === 'npm' && !this.opts.which('node')) return { ok: false, error: 'no-node' };
    const tool = pkg.manager === 'npm' ? this.opts.which('npm') : this.opts.which('uv');
    if (!tool) return { ok: false, error: pkg.manager === 'npm' ? 'no-npm' : 'no-uv' };

    const dir = this.installDir(lockId, pkg, hash);
    // a half-finished earlier attempt is thrown away, never trusted
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const env = { ...this.opts.env() };
    const cacheRoot = join(this.opts.root, '.cache');
    mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });

    let ran: RunResult;
    if (pkg.manager === 'npm') {
      for (const f of ['package.json', 'package-lock.json']) writeFileSync(join(dir, f), readFileSync(join(lock, f)));
      ran = await this.run(tool, [
        'ci', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', '--no-update-notifier', '--loglevel=error',
        '--cache', join(cacheRoot, 'npm')
      ], { cwd: dir, env: { ...env, npm_config_ignore_scripts: 'true' }, timeoutMs: this.timeoutMs });
    } else {
      const venv = join(dir, 'venv');
      const first = await this.run(tool, ['venv', '--no-config', '--seed', venv], { cwd: dir, env, timeoutMs: this.timeoutMs });
      if (first.timedOut) { rmSync(dir, { recursive: true, force: true }); return { ok: false, error: 'timeout' }; }
      if (first.code !== 0) { rmSync(dir, { recursive: true, force: true }); return { ok: false, error: 'install-failed' }; }
      const python = this.platform === 'win32' ? join(venv, 'Scripts', 'python.exe') : join(venv, 'bin', 'python');
      ran = await this.run(tool, [
        'pip', 'install', '--no-config', '--python', python, '--require-hashes', '--no-deps', '--no-build',
        '-r', join(lock, 'requirements.txt')
      ], { cwd: dir, env: { ...env, UV_CACHE_DIR: join(cacheRoot, 'uv') }, timeoutMs: this.timeoutMs });
    }
    if (ran.timedOut) { rmSync(dir, { recursive: true, force: true }); return { ok: false, error: 'timeout' }; }
    if (ran.code !== 0) { rmSync(dir, { recursive: true, force: true }); return { ok: false, error: 'install-failed' }; }

    // The marker goes in LAST, and only if what was installed is the release the catalogue names
    // and has the executable it should. Anything else is a refusal.
    const launch = pkg.manager === 'npm' ? this.npmLaunchOf(dir, pkg) : this.pyLaunch(dir, pkg);
    if (launch === 'version-mismatch' || launch === undefined) {
      rmSync(dir, { recursive: true, force: true });
      return { ok: false, error: launch === 'version-mismatch' ? 'version-mismatch' : 'bin-missing' };
    }
    writeFileSync(join(dir, MARKER), JSON.stringify({ lockHash: hash, name: pkg.name, version: pkg.version, at: Date.now() }), { mode: 0o600 });
    this.pruneOthers(lockId, dir);
    return { ok: true };
  }

  /** How to run an installed npm package, or why it cannot be: used both to check a finished
   *  install (before its marker exists) and to launch one that has a marker. */
  private npmLaunchOf(dir: string, pkg: McpPackage): Launch | 'version-mismatch' | undefined {
    const pkgDir = join(dir, 'node_modules', ...pkg.name.split('/'));
    let manifest: { version?: unknown; bin?: unknown };
    try { manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as typeof manifest; } catch { return undefined; }
    if (manifest.version !== pkg.version) return 'version-mismatch';
    const node = this.opts.which('node');
    if (!node) return undefined;
    const rel = typeof manifest.bin === 'string' ? manifest.bin
      : manifest.bin && typeof manifest.bin === 'object' ? (manifest.bin as Record<string, unknown>)[pkg.bin] : undefined;
    if (typeof rel !== 'string' || !rel) return undefined;
    const abs = resolve(pkgDir, rel);
    // the executable must sit inside the package it came from
    if (abs !== pkgDir && !abs.startsWith(pkgDir + sep)) return undefined;
    return existsSync(abs) ? { command: node, args: [abs], runtime: 'node' } : undefined;
  }

  /** Older installs of the same package (an app update shipped a new lock) are removed. */
  private pruneOthers(lockId: string, keep: string): void {
    try {
      const base = join(this.opts.root, lockId);
      for (const name of readdirSync(base)) {
        const p = join(base, name);
        if (p !== keep) rmSync(p, { recursive: true, force: true });
      }
    } catch { /* best-effort */ }
  }

  /** Remove everything installed for one package. */
  uninstall(lockId: string): void {
    if (!SAFE_ID.test(lockId)) return;
    this.failed.delete(lockId);
    try { rmSync(join(this.opts.root, lockId), { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}
