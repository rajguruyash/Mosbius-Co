/**
 * The one way the sign-in, the refresh and the revocation talk to a provider.
 *
 * Properties every caller gets for free:
 *   • a redirect is an error, never followed (a code, a refresh token or a client
 *     secret is never re-sent to wherever a response pointed);
 *   • a hard timeout and a cap on how much of the answer is read;
 *   • it never throws, and what it returns carries no request data: a failed call
 *     is `{kind:'network'}`, never an error message (which can name URLs).
 */

export interface FetchInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
  redirect: 'error';
  signal?: AbortSignal;
}
export interface FetchResponse {
  status: number;
  body?: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
}
export type FetchLike = (url: string, init: FetchInit) => Promise<FetchResponse>;

export const MAX_RESPONSE_BYTES = 256 * 1024;

export type HttpResult =
  | { kind: 'response'; status: number; text: string }
  | { kind: 'network' };

/** Read at most `max` bytes of a response body; false when it was longer. */
async function readCapped(res: FetchResponse, max: number): Promise<string | null> {
  const stream = res.body;
  if (stream && typeof stream.getReader === 'function') {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) { try { await reader.cancel(); } catch { /* noop */ } return null; }
      chunks.push(value);
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength))).toString('utf8');
  }
  const text = await res.text();
  return Buffer.byteLength(text) > max ? null : text;
}

export async function send(
  fetchFn: FetchLike,
  url: string,
  init: Omit<FetchInit, 'redirect' | 'signal'>,
  opts: { timeoutMs: number; maxBytes?: number; signal?: AbortSignal }
): Promise<HttpResult> {
  const ac = new AbortController();
  const onAbort = (): void => ac.abort();
  if (opts.signal) {
    if (opts.signal.aborted) return { kind: 'network' };
    opts.signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs);
  try {
    const res = await fetchFn(url, { ...init, redirect: 'error', signal: ac.signal });
    const text = await readCapped(res, opts.maxBytes ?? MAX_RESPONSE_BYTES);
    if (text === null) return { kind: 'network' };            // oversized: treated as a failed call
    return { kind: 'response', status: res.status, text };
  } catch {
    return { kind: 'network' };                                 // offline, timed out, redirected, aborted
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

/** A form body. Values are percent-encoded; nothing is logged. */
export function formBody(fields: Record<string, string>): string {
  return Object.entries(fields).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
}

export function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch { return null; }
}
