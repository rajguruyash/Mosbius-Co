/**
 * Just enough JSON-RPC 2.0 to enforce a policy on MCP traffic. Pure, no I/O.
 *
 * Everything here treats its input as hostile: the body comes from an agent that
 * may have been prompt-injected. Nothing throws on bad input, nothing is
 * evaluated, and nothing from the message is ever used as a key on a shared object.
 */
export const RPC_PARSE_ERROR = -32700;
export const RPC_INVALID_REQUEST = -32600;
export const RPC_NOT_PERMITTED = -32003;
export const RPC_SIGN_IN_REQUIRED = -32001;

export interface RpcMessage {
  jsonrpc: '2.0';
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

export type ParsedBody =
  | { ok: true; messages: RpcMessage[]; batch: boolean }
  | { ok: false; code: number; message: string };

const METHOD_RE = /^[A-Za-z0-9_./-]{1,128}$/;
export const MAX_BATCH = 50;

function validMessage(v: unknown): v is RpcMessage {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const m = v as Record<string, unknown>;
  if (m.jsonrpc !== '2.0') return false;
  if (m.id !== undefined && m.id !== null && typeof m.id !== 'string' && typeof m.id !== 'number') return false;
  // 1e999999 parses to Infinity, which JSON cannot write back: an answer carrying it would silently lose its id
  if (typeof m.id === 'number' && !Number.isFinite(m.id)) return false;
  const hasMethod = m.method !== undefined;
  if (hasMethod && (typeof m.method !== 'string' || !METHOD_RE.test(m.method))) return false;
  // a message is a request/notification (method), or a response (result or error)
  return hasMethod || m.result !== undefined || m.error !== undefined;
}

/** An object with more keys than this is not an MCP message; refusing it bounds the memory a scan may use. */
const MAX_KEYS_PER_OBJECT = 100_000;

/**
 * Whether any JSON object in `text` repeats a key. `text` must already have parsed as JSON.
 *
 * Why this matters: the broker decides what to allow from what ITS parser makes of a message
 * (the last value of a repeated key wins in JavaScript) and then forwards the ORIGINAL bytes. A
 * server whose parser takes the FIRST value would then act on a different tool name than the one
 * that was checked. JSON.stringify never writes a repeated key, so no honest client sends one:
 * a body that does is refused, and no parser disagreement is possible on what is forwarded.
 * Iterative, one pass; keys are compared after their escapes are decoded (`"a"` is `"\u0061"`).
 */
export function hasDuplicateKeys(text: string): boolean {
  interface Frame { object: boolean; keys: Set<string> | null; expectKey: boolean }
  const stack: Frame[] = [];
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x7b) stack.push({ object: true, keys: new Set(), expectKey: true });                // {
    else if (c === 0x5b) stack.push({ object: false, keys: null, expectKey: false });               // [
    else if (c === 0x7d || c === 0x5d) stack.pop();                                                 // } ]
    else if (c === 0x2c) { const top = stack[stack.length - 1]; if (top?.object) top.expectKey = true; }   // ,
    else if (c === 0x22) {                                                                          // "
      let j = i + 1;
      let escaped = false;
      while (j < n) {
        const d = text.charCodeAt(j);
        if (d === 0x5c) { escaped = true; j += 2; } else if (d === 0x22) break; else j++;
      }
      const top = stack[stack.length - 1];
      if (top?.object && top.expectKey) {
        let key: string;
        if (escaped) { try { key = JSON.parse(text.slice(i, j + 1)) as string; } catch { return true; } }
        else key = text.slice(i + 1, j);
        if (top.keys!.has(key) || top.keys!.size >= MAX_KEYS_PER_OBJECT) return true;
        top.keys!.add(key);
        top.expectKey = false;
      }
      i = j;
    }
  }
  return false;
}

export function parseRpcBody(body: Buffer, maxBatch = MAX_BATCH): ParsedBody {
  let value: unknown;
  const text = body.toString('utf8');
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, code: RPC_PARSE_ERROR, message: 'Parse error' };
  }
  if (hasDuplicateKeys(text)) return { ok: false, code: RPC_INVALID_REQUEST, message: 'Invalid Request' };
  if (Array.isArray(value)) {
    if (value.length === 0 || value.length > maxBatch || !value.every(validMessage)) {
      return { ok: false, code: RPC_INVALID_REQUEST, message: 'Invalid Request' };
    }
    return { ok: true, messages: value, batch: true };
  }
  if (!validMessage(value)) return { ok: false, code: RPC_INVALID_REQUEST, message: 'Invalid Request' };
  return { ok: true, messages: [value], batch: false };
}

/** A JSON-RPC request has a method and an id; without an id it is a notification. */
export const isRequest = (m: RpcMessage): boolean => m.method !== undefined && m.id !== undefined;

export function rpcError(id: RpcMessage['id'], code: number, message: string): RpcMessage {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

/**
 * Return a copy of a `tools/list` result containing only the tools `permit`
 * accepts. Anything that is not a well-formed list is returned as an EMPTY list,
 * never passed through: a result we cannot read must not leak tools.
 */
export function filterToolsResult(
  result: unknown,
  permit: (tool: { name: string } & Record<string, unknown>) => boolean
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const r = result && typeof result === 'object' && !Array.isArray(result) ? (result as Record<string, unknown>) : {};
  if (typeof r.nextCursor === 'string') out.nextCursor = r.nextCursor;
  const tools = Array.isArray(r.tools) ? r.tools : [];
  out.tools = tools.filter((t): t is { name: string } & Record<string, unknown> =>
    !!t && typeof t === 'object' && typeof (t as { name?: unknown }).name === 'string' && permit(t as { name: string } & Record<string, unknown>));
  return out;
}
