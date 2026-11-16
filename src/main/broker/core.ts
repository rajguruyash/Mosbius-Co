/**
 * The shared loopback broker: one HTTP server, one capability registry, any
 * number of routes.
 *
 * What the core owns, so no route has to get it right again:
 *   1. the loopback-only listener (127.0.0.1, never a routable interface);
 *   2. authentication: every request must present a live capability token;
 *   3. channel isolation: a token only works on routes of its own channel;
 *   4. immediate revocation: when a capability (or one integration of it) is
 *      revoked, the requests it is running are aborted in the same tick;
 *   5. containment: whatever a route does wrong, the caller sees a fixed
 *      500 and the main process does not crash.
 *
 * The order of checks is part of the contract (see broker-rest-characterization):
 *   loopback → [route preflight] → token → route found → channel → route.handle
 * so an unauthenticated caller learns nothing about which paths exist.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Capability, CapabilityRegistry, Channel } from './capabilities';
import { isLoopback, sendError, tokenFrom } from './http-util';

export interface Rejection { status: number; code: string; message: string }

export interface RouteContext<M> {
  req: IncomingMessage;
  res: ServerResponse;
  cap: Capability;
  match: M;
  /** Aborts when the client goes away, the capability (or the integration this
   *  request bound to) is revoked, or the broker stops. */
  signal: AbortSignal;
  /** Say which integration this request is for, so revoking that one cuts it off. */
  bindIntegration(id: string): void;
}

export interface BrokerRoute<M = unknown> {
  /** Only capability tokens of this channel are accepted here. */
  readonly channel: Channel;
  /** Pure: does this route own the request? Returns its parse of the URL, or null. */
  match(req: IncomingMessage): M | null;
  /** Optional checks that run BEFORE authentication (e.g. Host and Origin). */
  preflight?(req: IncomingMessage, info: { port: number }): Rejection | null;
  handle(ctx: RouteContext<M>): Promise<void> | void;
}

export interface BrokerCoreOptions {
  registry: CapabilityRegistry;
  routes: BrokerRoute[];
  /** What a request that no route owns is told (kept byte-compatible with the REST broker). */
  notFoundMessage: string;
}

interface ActiveRequest {
  ac: AbortController;
  res: ServerResponse;
  integrationId?: string;
}

const UNAUTHORIZED = 'missing or invalid capability token';

export class BrokerCore {
  private server: Server | null = null;
  private boundPort = 0;
  /** capability id → requests it is currently running */
  private readonly active = new Map<string, Set<ActiveRequest>>();
  private readonly unsubscribe: () => void;

  constructor(private readonly opts: BrokerCoreOptions) {
    this.unsubscribe = opts.registry.onRevoke((cap, reason, integrationId) => {
      const set = this.active.get(cap.id);
      if (!set) return;
      for (const a of [...set]) {
        if (reason === 'integration' && a.integrationId !== integrationId) continue;
        BrokerCore.cut(a);
      }
    });
  }

  /** Bind a loopback port (0 ⇒ OS-assigned). Resolves the bound port. Idempotent. */
  start(preferredPort = 0): Promise<{ ok: boolean; port?: number; error?: string }> {
    return new Promise((resolve) => {
      if (this.server) { resolve({ ok: true, port: this.boundPort }); return; }
      const server = createServer((req, res) => this.dispatch(req, res));
      const onError = (e: Error): void => { server.off('listening', onListening); resolve({ ok: false, error: e.message }); };
      const onListening = (): void => {
        server.off('error', onError);
        this.server = server;
        const addr = server.address();
        this.boundPort = addr && typeof addr === 'object' ? addr.port : preferredPort;
        resolve({ ok: true, port: this.boundPort });
      };
      server.once('error', onError);
      server.once('listening', onListening);
      // 127.0.0.1 ONLY — never bound to a routable interface, never tunneled.
      server.listen(preferredPort, '127.0.0.1');
    });
  }

  /** Close the listener and cut every request still running. Idempotent. */
  stop(): void {
    const server = this.server;
    this.server = null;
    this.boundPort = 0;
    for (const set of this.active.values()) for (const a of [...set]) BrokerCore.cut(a);
    this.active.clear();
    try { server?.close(); } catch { /* noop */ }
    try { (server as (Server & { closeAllConnections?: () => void }) | null)?.closeAllConnections?.(); } catch { /* noop */ }
  }

  running(): boolean { return !!this.server && this.boundPort > 0; }
  port(): number { return this.boundPort; }
  /** The base URL clients use (only valid while running). */
  url(): string { return `http://127.0.0.1:${this.boundPort}`; }
  /** Stop listening for revoke events. Only for tearing the core down for good. */
  dispose(): void { this.stop(); this.unsubscribe(); }

  private static cut(a: ActiveRequest): void {
    try { a.ac.abort(); } catch { /* noop */ }
    if (!a.res.writableEnded) { try { a.res.destroy(); } catch { /* noop */ } }
  }

  private dispatch(req: IncomingMessage, res: ServerResponse): void {
    try {
      // 1) Loopback — defense in depth even though the bind already excludes others.
      if (!isLoopback(req.socket.remoteAddress ?? '')) return sendError(res, 403, 'forbidden', 'loopback callers only');

      // 2) Which route owns this URL? Pure, side-effect free.
      let route: BrokerRoute | undefined;
      let matched: unknown = null;
      for (const r of this.opts.routes) {
        const m = r.match(req);
        if (m !== null) { route = r; matched = m; break; }
      }

      // 3) Checks a route wants made before anyone is authenticated.
      if (route?.preflight) {
        const rejection = route.preflight(req, { port: this.boundPort });
        if (rejection) return sendError(res, rejection.status, rejection.code, rejection.message);
      }

      // 4) Capability token.
      const cap = this.opts.registry.resolve(tokenFrom(req));
      if (!cap) return sendError(res, 401, 'unauthorized', UNAUTHORIZED);

      // 5) Route, then channel. A token for the wrong channel looks like a bad token.
      if (!route) return sendError(res, 404, 'not_found', this.opts.notFoundMessage);
      if (cap.channel !== route.channel) return sendError(res, 401, 'unauthorized', UNAUTHORIZED);

      // 6) Hand over, tracked so a revoke can cut the request off.
      const active: ActiveRequest = { ac: new AbortController(), res };
      let set = this.active.get(cap.id);
      if (!set) { set = new Set(); this.active.set(cap.id, set); }
      set.add(active);
      res.on('close', () => {
        active.ac.abort();
        set!.delete(active);
        if (set!.size === 0 && this.active.get(cap.id) === set) this.active.delete(cap.id);
      });
      Promise.resolve()
        .then(() => route!.handle({
          req, res, cap, match: matched, signal: active.ac.signal,
          bindIntegration: (id) => { active.integrationId = id; }
        }))
        .catch(() => BrokerCore.internalError(res));
    } catch {
      BrokerCore.internalError(res);
    }
  }

  /** Whatever went wrong, the caller learns nothing about it. */
  private static internalError(res: ServerResponse): void {
    console.error('[broker] a route failed');
    sendError(res, 500, 'internal', 'internal error');
  }
}
