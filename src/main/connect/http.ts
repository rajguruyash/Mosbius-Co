/**
 * The one way the connection layer talks to a provider. A twin of oauth/http.ts that also hands back the
 * response HEADERS (discovery needs `WWW-Authenticate`), with the same guarantees:
 *
 *   • a redirect is an error, never followed;
 *   • a hard timeout and a cap on how much of the answer is read;
 *   • it never throws, and what it returns carries no request data.
 */
export interface RawFetchResponse {
  status: number;
  headers: { get(name: string): string | null };
  body?: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
}
export interface RawFetchInit { method: string; headers: Record<string, string>; body?: string; redirect: 'error'; signal?: AbortSignal }
export type RawFetch = (url: string, init: RawFetchInit) => Promise<RawFetchResponse>;

export const MAX_BODY_BYTES = 1024 * 1024;

export interface Raw {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text: string;
  error?: 'timeout' | 'network' | 'too-large';
}

const NO_HEADERS = { get: (): string | null => null };

export async function rawRequest(
  fetchFn: RawFetch,
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
  opts: { timeoutMs?: number; maxBytes?: number; signal?: AbortSignal } = {}
): Promise<Raw> {
  const ac = new AbortController();
  const onAbort = (): void => ac.abort();
  if (opts.signal) {
    if (opts.signal.aborted) return { ok: false, status: 0, headers: NO_HEADERS, text: '', error: 'network' };
    opts.signal.addEventListener('abort', onAbort, { once: true });
  }
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ac.abort(); }, opts.timeoutMs ?? 20_000);
  const max = opts.maxBytes ?? MAX_BODY_BYTES;
  try {
    const res = await fetchFn(url, { ...init, redirect: 'error', signal: ac.signal });
    let text = '';
    const reader = res.body && typeof res.body.getReader === 'function' ? res.body.getReader() : null;
    if (reader) {
      const chunks: Buffer[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > max) { try { await reader.cancel(); } catch { /* noop */ } return { ok: false, status: res.status, headers: res.headers, text: '', error: 'too-large' }; }
        chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
      }
      text = Buffer.concat(chunks).toString('utf8');
    } else {
      text = await res.text();
      if (Buffer.byteLength(text) > max) return { ok: false, status: res.status, headers: res.headers, text: '', error: 'too-large' };
    }
    return { ok: true, status: res.status, headers: res.headers, text };
  } catch {
    return { ok: false, status: 0, headers: NO_HEADERS, text: '', error: timedOut ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

export function parseJson(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch { return null; }
}
