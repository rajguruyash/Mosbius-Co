/**
 * A small, strict Server-Sent Events reader, for one job: an MCP server may answer
 * a POST (including `tools/list`) as an event stream instead of a JSON body, and the
 * broker has to find the JSON-RPC answer inside it to filter it.
 *
 * Follows the WHATWG parsing rules (CR, LF and CRLF line ends; one optional space
 * after the colon; several `data:` lines join with a newline; comments and unknown
 * fields are ignored; an event not ended by a blank line is dropped) and adds the
 * limits a hostile server needs: the caller has already capped the TEXT, and this
 * caps the number of events as well. Pure. Never throws on any input.
 */

export interface SseEvent { event?: string; data: string; id?: string }

/** Hard ceiling on events read from one response, however small each is. */
export const MAX_SSE_EVENTS = 10_000;

export function parseSse(text: string, maxEvents = MAX_SSE_EVENTS): SseEvent[] {
  const events: SseEvent[] = [];
  if (typeof text !== 'string' || text.length === 0) return events;
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let data: string[] = [];
  let event: string | undefined;
  let id: string | undefined;
  const lines = body.split(/\r\n|\n|\r/);
  // What follows the LAST line terminator is not a line: splitting "data: x\n" leaves a ''
  // that would read as the blank line ending the event. Only a terminator that is
  // followed by another one (or by the start of the stream) is a blank line.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  for (const line of lines) {
    if (line === '') {
      // a blank line ends the event; an event with no data lines is not dispatched
      if (data.length > 0) {
        events.push({ data: data.join('\n'), ...(event !== undefined ? { event } : {}), ...(id !== undefined ? { id } : {}) });
        if (events.length >= maxEvents) return events;
      }
      data = []; event = undefined; id = undefined;
      continue;
    }
    if (line.charCodeAt(0) === 0x3a) continue;                      // ':' comment
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.charCodeAt(0) === 0x20) value = value.slice(1);
    if (field === 'data') data.push(value);
    else if (field === 'event') event = value;
    else if (field === 'id' && !value.includes('\0')) id = value;
    // `retry` and anything else: ignored
  }
  // whatever is left is an event the server never finished: dropped, as a browser would
  return events;
}

/**
 * The JSON-RPC answer to request `requestId` in a stream: the first event whose data
 * is a single JSON object carrying that exact id and a `result` or an `error`.
 * Anything else in the stream (progress notes, requests the server makes of the
 * client, an answer to some other id, a batch, text that is not JSON) is not the answer.
 */
export function findRpcResponse(events: readonly SseEvent[], requestId: string | number): Record<string, unknown> | undefined {
  for (const e of events) {
    let v: unknown;
    try { v = JSON.parse(e.data); } catch { continue; }
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    const o = v as Record<string, unknown>;
    if (o.id !== requestId) continue;
    if (!('result' in o) && !('error' in o)) continue;
    if ('method' in o) continue;                                      // a request that happens to share the id
    return o;
  }
  return undefined;
}

/** One event, written the way the broker re-emits it. The JSON text has no raw newline. */
export function sseMessage(value: unknown): string {
  return `event: message\ndata: ${JSON.stringify(value)}\n\n`;
}
