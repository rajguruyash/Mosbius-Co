/**
 * The stdio host: the app runs the local MCP servers itself (Stage B, F1).
 *
 * Until now an agent's own CLI started each local server from a command written into the agent's
 * `mcp-config.json`, and for GitHub, Notion and Brave that file carried the credential (a header,
 * or an environment variable). The agent could read it. Now the file carries nothing but the
 * broker's address and a capability; this module starts the server as a child of the APP, with the
 * credential in that one process's environment, and answers the agent's requests over the broker.
 * The agent therefore never holds a command line, an environment or a file with a secret in it, and
 * the broker's grants, per-tool classes, rate limits and instant revocation apply to a local server
 * exactly as they do to a hosted one.
 *
 * Shape:
 *   • ONE child per (agent, integration): servers keep per-connection state (the `initialize`
 *     handshake), and two agents must never share one;
 *   • the broker speaks Streamable HTTP to the agent, so a POST becomes newline-delimited JSON-RPC on
 *     the child's stdin and the matching answer comes back on its stdout. Request ids are rewritten
 *     to the host's own, so an agent's ids can never collide with anything;
 *   • the server's own requests to its client are answered here and never reach the agent: `ping`,
 *     and `roots/list` (the agent's workspace, so a filesystem server stays scoped to it); anything
 *     else (sampling, elicitation) is refused with "method not found". The agent's declared
 *     capabilities are replaced with exactly what the host can serve, so well-behaved servers do
 *     not ask. Server notifications are dropped (there is no stream to put them on);
 *   • a child that exited, or was idle, is started again on the next request and the agent's own
 *     `initialize` is replayed, so a restart is invisible to it;
 *   • revoking an agent kills its children at once (the whole process group on POSIX, so a browser
 *     started by a server dies with it), and so do disabling an integration and quitting the app.
 *
 * Nothing here logs a request, a response, a line of stderr or an environment variable.
 * Electron-free: how a server is launched, and the process spawner, are injected.
 */
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

export interface StdioLaunch {
  command: string;
  args: string[];
  /** The ONLY environment the child gets: a short allow-list. It never holds a credential. */
  env: Record<string, string>;
  /**
   * The server's own credential(s), handed over on a private pipe (file descriptor 3) that is closed
   * straight away. The launcher in mcpLaunch.ts reads it and sets the variables INSIDE the server
   * process, after it has started. They are therefore in neither its argument list nor its initial
   * environment, which is what `ps eww` and /proc/<pid>/environ show to every other process the user
   * runs. (Measured on macOS: a variable in the initial environment is listed, one set afterwards is not.)
   */
  secrets?: Record<string, string>;
  cwd: string;
  /** What `roots/list` answers (absolute paths). Empty means the server is told there are none. */
  roots?: string[];
}

export interface StdioLimits {
  /** How long one request may take before the agent is told it timed out. */
  requestMs: number;
  /** A line longer than this from the child kills it. */
  maxLineBytes: number;
  /** Requests one child may have waiting at once. */
  maxPending: number;
  /** A child nobody has asked anything for this long is stopped (it restarts on demand). */
  idleMs: number;
  /** Children one agent may have, and the host as a whole. */
  maxPerAgent: number;
  maxTotal: number;
  /** Time a stopping child has before it is killed outright. */
  killGraceMs: number;
}
export const DEFAULT_STDIO_LIMITS: StdioLimits = {
  requestMs: 120_000, maxLineBytes: 10 * 1024 * 1024, maxPending: 64, idleMs: 10 * 60_000,
  maxPerAgent: 12, maxTotal: 60, killGraceMs: 1_500
};

export interface StdioHostDeps {
  /** How to start `integrationId` for `agentId`, or undefined when it cannot be (not installed, no credential). */
  launch(integrationId: string, agentId: string): StdioLaunch | undefined;
  spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  limits?: Partial<StdioLimits>;
  now?: () => number;
}

export type HostResult = { status: number; body?: string };

/** JSON-RPC error codes this host answers with. */
export const RPC_HOST_UNAVAILABLE = -32002;
export const RPC_HOST_TIMEOUT = -32001;
export const RPC_HOST_EXITED = -32000;

interface Pending {
  clientId: string | number | null;
  resolve: (msg: Record<string, unknown>) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Session {
  key: string;
  agentId: string;
  integrationId: string;
  launch: StdioLaunch;
  child: ChildProcess | null;
  buffer: string;
  pending: Map<string, Pending>;
  /** the agent's own `initialize` params (capabilities replaced), kept to replay after a restart */
  initParams: Record<string, unknown> | null;
  initialized: boolean;
  idle: ReturnType<typeof setTimeout> | null;
  lastStderr: string;
}

const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isId = (v: unknown): v is string | number => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));
const rpcError = (id: string | number | null, code: number, message: string): Record<string, unknown> =>
  ({ jsonrpc: '2.0', id, error: { code, message } });

export class StdioHost {
  private readonly sessions = new Map<string, Session>();
  private readonly limits: StdioLimits;
  private readonly doSpawn: NonNullable<StdioHostDeps['spawn']>;
  private counter = 0;
  private closed = false;

  constructor(private readonly deps: StdioHostDeps) {
    this.limits = { ...DEFAULT_STDIO_LIMITS, ...deps.limits };
    this.doSpawn = deps.spawn ?? ((c, a, o) => nodeSpawn(c, a, o));
  }

  /** Children running now, for diagnostics and tests. */
  running(): Array<{ agentId: string; integrationId: string }> {
    return [...this.sessions.values()].filter((s) => s.child).map((s) => ({ agentId: s.agentId, integrationId: s.integrationId }));
  }

  /** The last few hundred bytes a child wrote to stderr. For tests only: never logged, never sent anywhere. */
  stderrOf(agentId: string, integrationId: string): string {
    return this.sessions.get(`${agentId}|${integrationId}`)?.lastStderr ?? '';
  }

  /**
   * Handle one POST body from the agent: a JSON-RPC message or a batch. Resolves with the HTTP
   * status and the body to send back (none for a body of notifications only).
   */
  async handle(integrationId: string, agentId: string, bodyText: string, signal?: AbortSignal): Promise<HostResult> {
    if (this.closed) return { status: 503 };
    let parsed: unknown;
    try { parsed = JSON.parse(bodyText); } catch { return { status: 400, body: JSON.stringify(rpcError(null, -32700, 'Parse error')) }; }
    const batch = Array.isArray(parsed);
    const messages = batch ? parsed as unknown[] : [parsed];
    if (messages.length === 0 || !messages.every(isRec)) {
      return { status: 400, body: JSON.stringify(rpcError(null, -32600, 'Invalid Request')) };
    }

    const session = this.sessionFor(integrationId, agentId);
    if (!session) {
      const answers = (messages as Record<string, unknown>[]).filter((m) => typeof m.method === 'string' && isId(m.id))
        .map((m) => rpcError(m.id as string | number, RPC_HOST_UNAVAILABLE, 'This server is not available.'));
      return answers.length ? { status: 200, body: JSON.stringify(batch ? answers : answers[0]) } : { status: 202 };
    }
    this.touch(session);

    const waits: Array<Promise<Record<string, unknown>>> = [];
    for (const m of messages as Record<string, unknown>[]) {
      if (typeof m.method !== 'string') continue;       // a client "response": the host never sends it a request, so drop it
      const isRequest = isId(m.id);
      if (m.method === 'initialize' && isRequest) {
        session.initParams = this.hostInitParams(m.params, session.launch);
        session.initialized = false;
      }
      if (!isRequest) {                                  // a notification
        if (m.method === 'notifications/initialized') session.initialized = true;
        this.ensureChild(session);
        this.write(session, { jsonrpc: '2.0', method: m.method, ...(m.params !== undefined ? { params: m.params } : {}) });
        continue;
      }
      waits.push(this.request(session, m, signal));
    }
    if (waits.length === 0) return { status: 202 };
    const answers = await Promise.all(waits);
    return { status: 200, body: JSON.stringify(batch ? answers : answers[0]) };
  }

  /** Stop one agent's server for one integration (or all of its servers). */
  close(agentId: string, integrationId?: string): void {
    for (const s of [...this.sessions.values()]) {
      if (s.agentId === agentId && (integrationId === undefined || s.integrationId === integrationId)) this.drop(s, 'closed');
    }
  }

  /** Stop every agent's server for one integration (it was disabled or disconnected). */
  closeIntegration(integrationId: string): void {
    for (const s of [...this.sessions.values()]) if (s.integrationId === integrationId) this.drop(s, 'closed');
  }

  /** Stop everything and refuse new work. */
  closeAll(): void {
    this.closed = true;
    for (const s of [...this.sessions.values()]) this.drop(s, 'closed');
  }

  // ─── sessions ────────────────────────────────────────────────────────────

  private sessionFor(integrationId: string, agentId: string): Session | undefined {
    const key = `${agentId}|${integrationId}`;
    const existing = this.sessions.get(key);
    if (existing) return existing;
    const launch = this.deps.launch(integrationId, agentId);
    if (!launch) return undefined;
    const mine = [...this.sessions.values()].filter((s) => s.agentId === agentId).length;
    if (mine >= this.limits.maxPerAgent || this.sessions.size >= this.limits.maxTotal) return undefined;
    const s: Session = {
      key, agentId, integrationId, launch, child: null, buffer: '', pending: new Map(),
      initParams: null, initialized: false, idle: null, lastStderr: ''
    };
    this.sessions.set(key, s);
    return s;
  }

  /** What the child is told about its client: only what this host can actually serve. */
  private hostInitParams(raw: unknown, launch: StdioLaunch): Record<string, unknown> {
    const p = isRec(raw) ? raw : {};
    return {
      protocolVersion: typeof p.protocolVersion === 'string' ? p.protocolVersion : '2025-06-18',
      capabilities: launch.roots && launch.roots.length > 0 ? { roots: { listChanged: false } } : {},
      clientInfo: isRec(p.clientInfo) ? { name: String(p.clientInfo.name ?? 'agent').slice(0, 64), version: String(p.clientInfo.version ?? '0').slice(0, 32) } : { name: 'agent', version: '0' }
    };
  }

  private touch(s: Session): void {
    if (s.idle) clearTimeout(s.idle);
    s.idle = setTimeout(() => {
      // Idle means quiet AND nothing waiting: a request that is still being answered keeps its server,
      // so a slow start or a slow tool can never be cut off by a timer that began before it finished.
      if (s.pending.size > 0) this.touch(s);
      else this.stopChild(s);
    }, this.limits.idleMs);
    s.idle.unref?.();
  }

  private ensureChild(s: Session): boolean {
    if (s.child) return true;
    let child: ChildProcess;
    const secrets = s.launch.secrets && Object.keys(s.launch.secrets).length > 0 ? s.launch.secrets : undefined;
    try {
      child = this.doSpawn(s.launch.command, s.launch.args, {
        cwd: s.launch.cwd, env: s.launch.env, stdio: secrets ? ['pipe', 'pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'], shell: false,
        windowsHide: true, detached: process.platform !== 'win32'
      });
    } catch { return false; }
    if (secrets) {
      // the credential goes down fd 3 and the pipe is closed: nothing keeps it open, nothing logs it
      const pipe = child.stdio?.[3] as NodeJS.WritableStream | null | undefined;
      if (!pipe || typeof pipe.end !== 'function') { try { child.kill('SIGKILL'); } catch { /* gone */ } return false; }
      pipe.on?.('error', () => { /* the child went away before reading it */ });
      pipe.end(JSON.stringify(secrets));
    }
    s.child = child;
    s.buffer = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => this.onData(s, child, chunk));
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => { s.lastStderr = (s.lastStderr + chunk).slice(-400); });
    child.stdin?.on('error', () => { /* the child went away; 'close' handles it */ });
    child.on('error', () => this.onExit(s, child));
    child.on('close', () => this.onExit(s, child));
    // a restarted child has not been introduced to its client yet: replay the agent's own handshake
    if (s.initParams && s.initialized) this.replayHandshake(s);
    return true;
  }

  private replayHandshake(s: Session): void {
    const id = `h${++this.counter}`;
    this.write(s, { jsonrpc: '2.0', id, method: 'initialize', params: s.initParams });
    this.write(s, { jsonrpc: '2.0', method: 'notifications/initialized' });
    // its answer is read and thrown away (nothing is waiting for it)
    s.pending.set(id, { clientId: null, resolve: () => undefined, timer: setTimeout(() => s.pending.delete(id), this.limits.requestMs) });
  }

  // ─── requests ────────────────────────────────────────────────────────────

  private request(s: Session, m: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const clientId = m.id as string | number;
    return new Promise((resolve) => {
      if (s.pending.size >= this.limits.maxPending) return resolve(rpcError(clientId, RPC_HOST_UNAVAILABLE, 'Too many requests are waiting on this server.'));
      if (!this.ensureChild(s)) return resolve(rpcError(clientId, RPC_HOST_UNAVAILABLE, 'This server could not be started.'));
      const id = `h${++this.counter}`;
      let settled = false;
      // Every way a request can end goes through here once: an answer, the child stopping, a
      // timeout, a cancel. It always answers the agent, under the agent's own id.
      const settle = (msg: Record<string, unknown>): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        s.pending.delete(id);
        signal?.removeEventListener('abort', onAbort);
        resolve({ ...msg, jsonrpc: '2.0', id: clientId });
      };
      const onAbort = (): void => settle(rpcError(clientId, RPC_HOST_EXITED, 'The request was cancelled.'));
      const timer = setTimeout(() => settle(rpcError(clientId, RPC_HOST_TIMEOUT, 'The server took too long to answer.')), this.limits.requestMs);
      timer.unref?.();
      s.pending.set(id, { clientId, resolve: settle, timer });
      if (signal?.aborted) return onAbort();
      signal?.addEventListener('abort', onAbort, { once: true });
      const params = m.method === 'initialize' ? s.initParams : m.params;
      this.write(s, { jsonrpc: '2.0', id, method: m.method, ...(params !== undefined ? { params } : {}) });
    });
  }

  private write(s: Session, msg: Record<string, unknown>): void {
    try { s.child?.stdin?.write(`${JSON.stringify(msg)}\n`); } catch { /* handled by 'close' */ }
  }

  // ─── what the child says ─────────────────────────────────────────────────

  private onData(s: Session, from: ChildProcess, chunk: string): void {
    if (s.child !== from) return;
    s.buffer += chunk;
    if (s.buffer.length > this.limits.maxLineBytes && !s.buffer.includes('\n')) {
      // a "line" that never ends: a misbehaving server. Stop it rather than buffer without bound.
      this.stopChild(s);
      return;
    }
    let nl: number;
    while ((nl = s.buffer.indexOf('\n')) >= 0) {
      const line = s.buffer.slice(0, nl).trim();
      s.buffer = s.buffer.slice(nl + 1);
      if (line) this.onLine(s, line);
    }
  }

  private onLine(s: Session, line: string): void {
    let msg: unknown;
    try { msg = JSON.parse(line); } catch { return; }            // a log line printed on stdout: not ours to forward
    if (!isRec(msg)) return;
    if (typeof msg.method === 'string') {
      if (isId(msg.id)) this.answerServerRequest(s, msg as Record<string, unknown> & { id: string | number; method: string });
      return;                                                     // a notification: dropped
    }
    if (typeof msg.id === 'string') {
      const p = s.pending.get(msg.id);
      p?.resolve(msg);
      // a replayed handshake has nobody waiting on it: forget it as soon as it is answered
      if (p && s.pending.get(msg.id) === p) { clearTimeout(p.timer); s.pending.delete(msg.id); }
    }
  }

  private answerServerRequest(s: Session, m: { id: string | number; method: string }): void {
    if (m.method === 'ping') return this.write(s, { jsonrpc: '2.0', id: m.id, result: {} });
    if (m.method === 'roots/list') {
      const roots = (s.launch.roots ?? []).map((p) => ({ uri: pathToFileUri(p), name: 'workspace' }));
      return this.write(s, { jsonrpc: '2.0', id: m.id, result: { roots } });
    }
    this.write(s, { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } });
  }

  // ─── ending ──────────────────────────────────────────────────────────────

  private onExit(s: Session, child: ChildProcess): void {
    if (s.child !== child) return;
    s.child = null;
    for (const [id, p] of [...s.pending]) {
      p.resolve({ jsonrpc: '2.0', id, error: { code: RPC_HOST_EXITED, message: 'The server stopped.' } });
      clearTimeout(p.timer);
      s.pending.delete(id);
    }
  }

  /** Stop the process but keep what is needed to start it again. */
  private stopChild(s: Session): void {
    const child = s.child;
    if (!child) return;
    this.kill(child);
    this.onExit(s, child);
  }

  private drop(s: Session, _why: 'closed'): void {
    if (s.idle) clearTimeout(s.idle);
    this.stopChild(s);
    this.sessions.delete(s.key);
  }

  private kill(child: ChildProcess): void {
    const signal = (sig: NodeJS.Signals): void => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, sig);   // the whole group: a browser a server started dies with it
        else child.kill(sig);
      } catch { try { child.kill(sig); } catch { /* already gone */ } }
    };
    try { child.stdin?.end(); } catch { /* noop */ }
    signal('SIGTERM');
    const t = setTimeout(() => signal('SIGKILL'), this.limits.killGraceMs);
    t.unref?.();
    child.once('close', () => clearTimeout(t));
  }
}

/** file:// URI for an absolute path, on either platform. */
export function pathToFileUri(p: string): string {
  const normalized = p.replace(/\\/g, '/');
  return `file://${normalized.startsWith('/') ? '' : '/'}${encodeURI(normalized).replace(/#/g, '%23').replace(/\?/g, '%3F')}`;
}
