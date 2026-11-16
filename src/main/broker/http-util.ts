/**
 * Small HTTP helpers shared by every broker route. Electron-free.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** Hop-by-hop headers never forwarded in either direction. */
export const HOP_BY_HOP: ReadonlySet<string> = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade'
]);

/** True for IPv4 loopback (127.0.0.0/8) and IPv6 ::1 (incl. v4-mapped). */
export function isLoopback(addr: string): boolean {
  const a = addr.replace(/^::ffff:/, '');
  return a === '::1' || a.startsWith('127.');
}

/** Every broker-generated error has this one shape: `{ error, code }`. The message
 *  is a fixed string chosen by the caller — never an upstream or exception text,
 *  which could carry a URL or a secret. */
export function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  if (res.headersSent) { try { res.end(); } catch { /* socket gone */ } return; }
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: message, code }));
}

/** The capability token from `X-MD-Broker-Token` or `Authorization: Bearer`. */
export function tokenFrom(req: IncomingMessage): string | undefined {
  const x = req.headers['x-md-broker-token'];
  if (typeof x === 'string' && x) return x;
  const auth = req.headers['authorization'];
  if (typeof auth === 'string') {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m) return m[1].trim();
  }
  return undefined;
}

export class BodyTooLarge extends Error {
  constructor() { super('too_large'); this.name = 'BodyTooLarge'; }
}

/** How much more of an oversize upload is read and thrown away before the socket
 *  is cut. Reading on lets the client see the 413 instead of a connection reset. */
const DISCARD_LIMIT_BYTES = 64 * 1024 * 1024;

/**
 * Read a request body into a Buffer. Past `max` bytes it stops collecting and
 * rejects with `BodyTooLarge`; the rest of the upload is discarded (not
 * buffered) so the caller can still send a clean 413, and the socket is only cut
 * if the client keeps sending far beyond the limit.
 */
export function readBodyCapped(req: IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (over) {
        if (size > max + DISCARD_LIMIT_BYTES) req.destroy();
        return;
      }
      if (size > max) {
        over = true;
        chunks.length = 0;
        reject(new BodyTooLarge());
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!over) resolve(Buffer.concat(chunks)); });
    req.on('error', (e) => { if (!over) reject(e); });
  });
}

export interface StreamGuards {
  /** Cut the stream if no chunk arrives for this long. */
  idleMs?: number;
  /** Cut the stream after this long however busy it is. */
  maxMs?: number;
}

/** Pipe a web ReadableStream (a fetch body) to a ServerResponse. Resolves when the
 *  response finishes; rejects if either side fails, `signal` aborts or a guard
 *  fires. A client that disconnects tears the upstream stream down instead of
 *  leaving it open. */
export function pipeWebStream(
  web: ReadableStream<Uint8Array>,
  res: ServerResponse,
  signal?: AbortSignal,
  guards?: StreamGuards
): Promise<void> {
  const node = Readable.fromWeb(web as Parameters<typeof Readable.fromWeb>[0]);
  const opts = signal ? { signal } : {};
  if (!guards?.idleMs && !guards?.maxMs) return pipeline(node, res, opts);

  let idle: NodeJS.Timeout | undefined;
  let max: NodeJS.Timeout | undefined;
  const cut = (): void => { node.destroy(new Error('stream timeout')); };
  const arm = (): void => {
    if (!guards.idleMs) return;
    clearTimeout(idle);
    idle = setTimeout(cut, guards.idleMs);
  };
  const tap = new Transform({ transform(chunk, _enc, cb) { arm(); cb(null, chunk); } });
  arm();
  if (guards.maxMs) max = setTimeout(cut, guards.maxMs);
  return pipeline(node, tap, res, opts).finally(() => { clearTimeout(idle); clearTimeout(max); });
}
