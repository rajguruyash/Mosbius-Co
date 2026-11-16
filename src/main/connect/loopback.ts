/**
 * The address the provider redirects the browser back to: 127.0.0.1 only, a port the OS picks, one valid
 * request ever. The same care as oauth/flow.ts (and tested the same way), for a sign-in whose port is not
 * known until it starts:
 *
 *   • bound to the loopback address exclusively; the Host header must be exactly 127.0.0.1:<port>;
 *   • the path is compared as the browser SENT it; a non-navigation request (a script's fetch) is refused;
 *   • duplicate or oversized parameters are refused; the state is compared in constant time;
 *   • a bad request is ANSWERED with an error page and changes nothing, so a forged request can never end
 *     the sign-in that is waiting for the real one;
 *   • the redirect may carry `iss` (RFC 9207): a wrong one ends the sign-in, a missing one does when the
 *     provider said it always sends one;
 *   • the first valid request wins, and a second is refused as replayed.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { constantTimeEqual } from '../oauth/pkce';

const MAX_URL = 4096;
const MAX_PARAM = 2048;
const CODE_RE = /^[A-Za-z0-9._~/+=-]{1,2048}$/;

export type CallbackOutcome =
  | { ok: true; code: string; refused: string[] }
  | { ok: false; error: 'denied' | 'provider-error' | 'invalid-callback' | 'timeout' | 'cancelled'; refused: string[] };

export interface Loopback {
  port: number;
  redirectUri: string;
  /** Wait for the one redirect. Resolves once, never rejects. */
  arm(a: { state: string; issuer: string; issRequired: boolean; timeoutMs: number; signal?: AbortSignal }): Promise<CallbackOutcome>;
  close(): void;
}

const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

function page(res: ServerResponse, status: number, title: string, line: string): void {
  const html = `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title>`
    + `<body style="font:16px system-ui,sans-serif;margin:3rem;max-width:34rem"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(line)}</p></body>`;
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8', 'content-length': String(Buffer.byteLength(html)), 'cache-control': 'no-store',
    'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', connection: 'close',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'"
  });
  res.end(html);
}

const isNavigation = (req: IncomingMessage): boolean => {
  const mode = req.headers['sec-fetch-mode']; const dest = req.headers['sec-fetch-dest'];
  return !((mode !== undefined && mode !== 'navigate') || (dest !== undefined && dest !== 'document'));
};

export function openLoopback(opts: { path?: string; port?: number; label: string } = { label: '' }): Promise<Loopback> {
  const path = opts.path ?? '/callback';
  return new Promise((resolve, reject) => {
    const server: Server = createServer();
    type Armed = { state: string; issuer: string; issRequired: boolean; consumed: boolean; done: boolean; refused: string[]; finish: (o: CallbackOutcome) => void };
    let armed: Armed | null = null;
    server.on('request', (req, res) => {
      const refuse = (status: number, reason: string): void => { armed?.refused.push(reason); page(res, status, 'Not a sign-in link', 'This address is not a sign-in the app is waiting for.'); };
      if (!armed || armed.done) return refuse(410, 'finished');
      if (req.method !== 'GET') return refuse(405, 'method');
      const port = (server.address() as { port: number }).port;
      if (req.headers.host !== `127.0.0.1:${port}`) return refuse(400, 'host');
      const raw = req.url ?? '';
      if (raw.length > MAX_URL) return refuse(414, 'too-long');
      if (raw.split('?', 1)[0] !== path) return refuse(404, 'path');
      if (!isNavigation(req)) return refuse(400, 'not-navigation');
      let q: URLSearchParams;
      try { q = new URL(raw, `http://127.0.0.1:${port}`).searchParams; } catch { return refuse(400, 'url'); }
      for (const k of ['state', 'code', 'error', 'iss']) if (q.getAll(k).length > 1) return refuse(400, 'duplicate-param');
      for (const v of q.values()) if (v.length > MAX_PARAM) return refuse(400, 'param-too-long');
      const state = q.get('state');
      if (!state || !constantTimeEqual(state, armed.state)) return refuse(400, 'state');
      if (armed.consumed) return refuse(400, 'replayed');
      armed.consumed = true;
      const a = armed;
      const end = (o: Omit<CallbackOutcome, 'refused'> & { ok: boolean }): void => {
        page(res, o.ok ? 200 : 400, o.ok ? 'Signed in' : 'Sign-in did not complete', o.ok ? `${opts.label} is connected. You can close this tab and go back to the app.` : 'Return to the app and try again.');
        a.finish({ ...(o as object), refused: a.refused } as CallbackOutcome);
      };
      const err = q.get('error');
      if (err !== null) return end({ ok: false, error: err === 'access_denied' ? 'denied' : 'provider-error' } as never);
      const iss = q.get('iss');
      if (iss !== null ? !constantTimeEqual(iss, a.issuer) : a.issRequired) return end({ ok: false, error: 'invalid-callback' } as never);
      const code = q.get('code');
      if (!code || !CODE_RE.test(code)) return end({ ok: false, error: 'invalid-callback' } as never);
      return end({ ok: true, code } as never);
    });
    server.on('clientError', (_e, socket) => { try { socket.destroy(); } catch { /* noop */ } });
    server.once('error', reject);
    server.listen({ port: opts.port ?? 0, host: '127.0.0.1', exclusive: true }, () => {
      const port = (server.address() as { port: number }).port;
      let timer: NodeJS.Timeout | undefined;
      const close = (): void => {
        if (timer) clearTimeout(timer);
        try { server.close(); } catch { /* noop */ }
        try { server.closeAllConnections(); } catch { /* noop */ }
      };
      resolve({
        port, redirectUri: `http://127.0.0.1:${port}${path}`, close,
        arm: (a) => new Promise<CallbackOutcome>((done) => {
          let onAbort: (() => void) | undefined;
          const finish = (o: CallbackOutcome): void => {
            if (!armed || armed.done) return;
            armed.done = true;
            if (timer) clearTimeout(timer);
            if (a.signal && onAbort) a.signal.removeEventListener('abort', onAbort);
            done(o);
          };
          armed = { state: a.state, issuer: a.issuer, issRequired: a.issRequired, consumed: false, done: false, refused: [], finish };
          timer = setTimeout(() => finish({ ok: false, error: 'timeout', refused: armed?.refused ?? [] }), a.timeoutMs);
          timer.unref?.();
          if (a.signal) {
            if (a.signal.aborted) return finish({ ok: false, error: 'cancelled', refused: [] });
            onAbort = (): void => finish({ ok: false, error: 'cancelled', refused: armed?.refused ?? [] });
            a.signal.addEventListener('abort', onAbort, { once: true });
          }
        })
      });
    });
  });
}
