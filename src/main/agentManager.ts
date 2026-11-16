// Agent Manager: find the coding-agent CLIs on this machine, ask each one —
// through its own official command — whether it is signed in, and run the
// install / sign-in / update actions the user approves in the UI.
//
// Security rules this file keeps:
//  • Only commands defined HERE run. The renderer sends a provider id and an
//    action name, never a command string.
//  • Nothing secret leaves this file. Sign-in checks return a yes/no (and for
//    Claude, the auth METHOD word); emails, organisations, tokens and the
//    contents of credential files are never read into the result or the log.
//    Gemini has no status command, so for it we only test whether its login
//    file or a key variable EXISTS, and say "probably signed in".
//  • Sign-in always uses the vendor's own interactive login, in a terminal the
//    user can see. The app never asks for or stores credentials.

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, realpathSync, writeFileSync, chmodSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveCommand, userShellPath, captureFromLoginShell } from './shellEnv';

export type ProviderId = 'claude' | 'codex' | 'gemini';
export type AuthState = 'signed-in' | 'probably-signed-in' | 'signed-out' | 'unknown';
export type InstallState = 'installed' | 'not-installed' | 'broken';
export type ActionKind = 'install' | 'signin' | 'update';

export interface ProviderStatus {
  id: ProviderId;
  label: string;
  install: InstallState;
  path: string | null;
  version: string | null;
  auth: AuthState;
  /** How the sign-in state was learned, in plain words — never personal data. */
  authHow: string;
  /** How it was installed, when we can tell from the executable's location. */
  via: 'npm' | 'homebrew' | 'native' | 'unknown' | null;
  /** The exact commands each action would run here, for the approval dialog. */
  commands: Partial<Record<ActionKind, string>>;
  docsUrl: string;
  error?: string;
}

interface ProviderDef {
  id: ProviderId;
  label: string;
  bin: string;
  docsUrl: string;
  install: { posix: string; win32: string };
  login: string;
  /** Check sign-in. Must never return or log personal data. */
  checkAuth: (exe: string, env: NodeJS.ProcessEnv) => Promise<{ auth: AuthState; how: string }>;
  update: (via: ProviderStatus['via']) => string | undefined;
}

const TIMEOUT = 15_000;

function run(exe: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(exe, args, { env, timeout: TIMEOUT, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : -1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

const PROVIDERS: ProviderDef[] = [
  {
    id: 'claude', label: 'Claude Code', bin: 'claude',
    docsUrl: 'https://docs.claude.com/en/docs/claude-code',
    install: { posix: 'npm install -g @anthropic-ai/claude-code', win32: 'npm install -g @anthropic-ai/claude-code' },
    login: 'claude auth login',
    async checkAuth(exe, env) {
      const r = await run(exe, ['auth', 'status', '--json'], env);
      try {
        const j = JSON.parse(r.stdout) as { loggedIn?: unknown; authMethod?: unknown };
        if (j.loggedIn === true) {
          const method = typeof j.authMethod === 'string' && /^[a-z_-]{1,24}$/i.test(j.authMethod) ? j.authMethod : 'account';
          return { auth: 'signed-in', how: `confirmed by "claude auth status" (${method})` };
        }
        if (j.loggedIn === false) return { auth: 'signed-out', how: 'confirmed by "claude auth status"' };
      } catch { /* fall through */ }
      return { auth: 'unknown', how: '"claude auth status" gave no answer' };
    },
    update: () => 'claude update',
  },
  {
    id: 'codex', label: 'Codex', bin: 'codex',
    docsUrl: 'https://github.com/openai/codex',
    install: { posix: 'npm install -g @openai/codex', win32: 'npm install -g @openai/codex' },
    login: 'codex login',
    async checkAuth(exe, env) {
      const r = await run(exe, ['login', 'status'], env);
      if (r.code === 0) return { auth: 'signed-in', how: 'confirmed by "codex login status"' };
      if (r.code === 1) return { auth: 'signed-out', how: 'confirmed by "codex login status"' };
      return { auth: 'unknown', how: '"codex login status" did not run' };
    },
    update: (via) => via === 'homebrew' ? 'brew upgrade codex' : via === 'npm' ? 'npm install -g @openai/codex@latest' : undefined,
  },
  {
    id: 'gemini', label: 'Gemini CLI', bin: 'gemini',
    docsUrl: 'https://github.com/google-gemini/gemini-cli',
    install: { posix: 'npm install -g @google/gemini-cli', win32: 'npm install -g @google/gemini-cli' },
    login: 'gemini',
    async checkAuth(_exe, env) {
      // Gemini CLI has no status command. Existence checks only — never open the files.
      const dir = join(homedir(), '.gemini');
      if (existsSync(join(dir, 'oauth_creds.json'))) return { auth: 'probably-signed-in', how: 'a Google login file exists (Gemini CLI has no status check)' };
      if (env.GEMINI_API_KEY || env.GOOGLE_API_KEY || env.GOOGLE_GENAI_USE_VERTEXAI) return { auth: 'probably-signed-in', how: 'a key is set in your shell (Gemini CLI has no status check)' };
      return { auth: 'signed-out', how: 'no Google login or key found (Gemini CLI has no status check)' };
    },
    update: (via) => via === 'homebrew' ? 'brew upgrade gemini-cli' : via === 'npm' ? 'npm install -g @google/gemini-cli@latest' : undefined,
  },
];

let shellEnvCache: NodeJS.ProcessEnv | null = null;
/** The environment a terminal would have: the login-shell PATH, plus presence of
 *  the few key variables Gemini can use (copied only so the existence test works). */
function agentEnv(): NodeJS.ProcessEnv {
  if (shellEnvCache) return shellEnvCache;
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: userShellPath() };
  if (process.platform !== 'win32') {
    for (const k of ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENAI_USE_VERTEXAI']) {
      if (!env[k]) {
        const has = captureFromLoginShell(`[ -n "\${${k}:-}" ] && printf yes || printf no`)?.trim();
        if (has === 'yes') env[k] = '1'; // presence marker only; the value is never copied
      }
    }
  }
  shellEnvCache = env;
  return env;
}

function installedVia(exe: string): ProviderStatus['via'] {
  try {
    const real = realpathSync(exe);
    if (/node_modules/.test(real)) return 'npm';
    if (/Cellar|Caskroom/.test(real)) return 'homebrew';
    return 'native';
  } catch { return 'unknown'; }
}

async function statusOf(p: ProviderDef): Promise<ProviderStatus> {
  const env = agentEnv();
  const base: ProviderStatus = {
    id: p.id, label: p.label, install: 'not-installed', path: null, version: null,
    auth: 'unknown', authHow: '', via: null, docsUrl: p.docsUrl,
    commands: { install: process.platform === 'win32' ? p.install.win32 : p.install.posix, signin: p.login },
  };
  const exe = resolveCommand(p.bin);
  if (!exe || exe === p.bin || !existsSync(exe)) return base;
  const v = await run(exe, ['--version'], env);
  if (v.code !== 0) return { ...base, install: 'broken', path: exe, error: `"${p.bin} --version" failed` };
  const version = (v.stdout.match(/\d+\.\d+\.\d+[\w.-]*/) ?? [v.stdout.trim().split('\n')[0]])[0]?.slice(0, 40) ?? null;
  const via = installedVia(exe);
  const a = await p.checkAuth(exe, env);
  const update = p.update(via);
  return {
    ...base, install: 'installed', path: exe, version, via, auth: a.auth, authHow: a.how,
    commands: { signin: p.login, ...(update ? { update } : {}) },
  };
}

export async function agentStatuses(): Promise<ProviderStatus[]> {
  return Promise.all(PROVIDERS.map(statusOf));
}

/** Run an approved install or update, streaming its output. Commands come only
 *  from the table above. */
export function runAgentAction(
  id: ProviderId, kind: 'install' | 'update', onLine: (line: string) => void,
): Promise<{ ok: boolean; code: number }> {
  return new Promise((resolve) => {
    const p = PROVIDERS.find((x) => x.id === id);
    if (!p) { resolve({ ok: false, code: -1 }); return; }
    void statusOf(p).then((st) => {
      const cmd = st.commands[kind];
      if (!cmd) { onLine(`No ${kind} command is known for ${p.label} here.`); resolve({ ok: false, code: -1 }); return; }
      onLine(`$ ${cmd}`);
      const win = process.platform === 'win32';
      const child = spawn(win ? 'cmd.exe' : '/bin/sh', win ? ['/d', '/s', '/c', cmd] : ['-c', cmd], { env: agentEnv(), windowsHide: true });
      const pipe = (b: Buffer) => String(b).split(/\r?\n/).filter(Boolean).forEach((l) => onLine(l.slice(0, 400)));
      child.stdout.on('data', pipe);
      child.stderr.on('data', pipe);
      child.on('error', (e) => { onLine(`Could not start: ${e.message}`); resolve({ ok: false, code: -1 }); });
      child.on('close', (code) => { shellEnvCache = null; resolve({ ok: code === 0, code: code ?? -1 }); });
    });
  });
}

/** Open the provider's own login in a terminal window the user can see. */
export function openAgentSignIn(id: ProviderId): { ok: boolean; how: string } {
  const p = PROVIDERS.find((x) => x.id === id);
  if (!p) return { ok: false, how: 'unknown provider' };
  const exe = resolveCommand(p.bin);
  const cmd = exe && exe !== p.bin ? `"${exe}"${p.login.slice(p.bin.length)}` : p.login;
  try {
    if (process.platform === 'darwin') {
      const dir = mkdtempSync(join(tmpdir(), 'mosbius-signin-'));
      const file = join(dir, `${p.id}-sign-in.command`);
      writeFileSync(file, `#!/bin/zsh -l\necho "Signing in to ${p.label}. Follow the steps below; close this window when it says you're signed in."\n${cmd}\n`);
      chmodSync(file, 0o755);
      spawn('open', ['-a', 'Terminal', file], { detached: true, stdio: 'ignore' }).unref();
      return { ok: true, how: 'Terminal' };
    }
    if (process.platform === 'win32') {
      spawn('cmd.exe', ['/c', 'start', 'cmd.exe', '/k', cmd], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
      return { ok: true, how: 'Command Prompt' };
    }
    spawn('x-terminal-emulator', ['-e', `sh -c '${cmd}; exec sh'`], { detached: true, stdio: 'ignore' }).unref();
    return { ok: true, how: 'terminal' };
  } catch (e) {
    return { ok: false, how: e instanceof Error ? e.message : String(e) };
  }
}

/** Is this loopback port free to listen on right now? */
export function loopbackPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

export type McpSignInError = 'in-progress' | 'port-busy' | 'no-npx' | 'timeout' | 'failed';

/** Sign-ins in flight, by integration id — one at a time each. */
const mcpSignIns = new Map<string, ChildProcess>();

/** Stop a sign-in that is still waiting (Disconnect, quit). */
export function cancelMcpSignIn(id?: string): void {
  for (const [key, child] of [...mcpSignIns]) {
    if (id && key !== id) continue;
    mcpSignIns.delete(key);
    try { child.kill(); } catch { /* already gone */ }
  }
}

/**
 * Run the one-time browser sign-in for a bridged MCP server, as a child of the
 * app rather than in a terminal window.
 *
 * mcp-remote opens the vendor's own consent page in the user's browser, waits
 * on a loopback port for the redirect, and writes the tokens into the vault
 * directory. The app watches for that file, then stops the child — so nothing
 * is left holding the port, and the caller can seal the tokens straight away.
 *
 * What it keeps to itself: the child's output is read only to tell "port in
 * use" from other failures and is never logged, stored or returned (it carries
 * the authorisation URL). The result is a fixed code, never text from the child.
 */
export async function runMcpSignIn(opts: {
  id: string;
  args: string[];
  configDir: string;
  port: number;
  /** True once the vault holds a token file for this integration. */
  hasTokens: () => boolean;
  timeoutMs?: number;
}): Promise<{ ok: true } | { ok: false; error: McpSignInError }> {
  if (mcpSignIns.has(opts.id)) return { ok: false, error: 'in-progress' };
  if (!(await loopbackPortFree(opts.port))) return { ok: false, error: 'port-busy' };
  const npx = resolveCommand('npx');
  const win = process.platform === 'win32';
  // resolveCommand hands the bare name back when it found nothing.
  if (!win && npx === 'npx') return { ok: false, error: 'no-npx' };
  // Windows can only start npx.cmd through a shell, and the vault path there
  // contains spaces and an ampersand, so every word is quoted. Never run on a
  // real Windows machine.
  const command = win ? `"${npx}"` : npx;
  const args = win ? opts.args.map((a) => `"${a}"`) : opts.args;
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        env: { ...agentEnv(), MCP_REMOTE_CONFIG_DIR: opts.configDir },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell: win
      });
    } catch { resolve({ ok: false, error: 'failed' }); return; }
    mcpSignIns.set(opts.id, child);
    let portBusy = false;
    let settled = false;
    const finish = (r: { ok: true } | { ok: false; error: McpSignInError }): void => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(timer);
      if (mcpSignIns.get(opts.id) === child) mcpSignIns.delete(opts.id);
      try { child.kill(); } catch { /* already gone */ }
      resolve(r);
    };
    const watch = (b: Buffer): void => { if (/EADDRINUSE/.test(String(b))) portBusy = true; };
    child.stderr?.on('data', watch);
    child.stdout?.on('data', () => { /* drained, never kept */ });
    child.on('error', () => finish({ ok: false, error: 'failed' }));
    child.on('exit', () => finish(opts.hasTokens() ? { ok: true } : { ok: false, error: portBusy ? 'port-busy' : 'failed' }));
    const poll = setInterval(() => { if (opts.hasTokens()) finish({ ok: true }); }, 400);
    const timer = setTimeout(() => finish({ ok: false, error: 'timeout' }), opts.timeoutMs ?? 5 * 60_000);
  });
}
