/**
 * An agent's conversation, read from the transcript its own CLI keeps.
 *
 * Claude Code writes every session to a JSON-Lines file (one record per line: what the person said, what the
 * model said, each tool it called). That file IS the conversation, so the Huddle reads it rather than keeping a
 * copy: only the newest part of the file is read, so a long session costs a bounded read, never a parse of
 * everything. Tool results and the CLI's own bookkeeping are left out; tool CALLS appear as one short line each.
 *
 * Electron-free; the redactor is passed in.
 */
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { clip, describeTool, scrubText, type ActivityLabel } from '../shared/agentActivity';

export interface ConversationMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  text?: string;
  tool?: { name: string; label: ActivityLabel };
  at?: number;
}

export interface ConversationOptions {
  /** Newest this many bytes of the file are considered. */
  maxBytes?: number;
  /** At most this many messages are returned (the newest). */
  limit?: number;
  redact?: (s: string) => string;
}

const TEXT_MAX = 6000;
const REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
/** Command wrappers the CLI adds around slash commands: not something a person wrote or read. */
const WRAPPER_RE = /<(?:command-name|command-message|command-args|local-command-stdout|local-command-caveat)>[\s\S]*?<\/(?:command-name|command-message|command-args|local-command-stdout|local-command-caveat)>/g;

function textOf(content: unknown, redact: (s: string) => string): string {
  const parts: string[] = [];
  if (typeof content === 'string') parts.push(content);
  else if (Array.isArray(content)) {
    for (const b of content) {
      if (b && typeof b === 'object' && (b as { type?: unknown }).type === 'text' && typeof (b as { text?: unknown }).text === 'string') parts.push((b as { text: string }).text);
    }
  }
  const joined = parts.join('\n').replace(REMINDER_RE, '').replace(WRAPPER_RE, '').trim();
  return joined ? clip(redact(joined), TEXT_MAX).replace(/ {2,}/g, ' ') : '';
}

/** Turn transcript lines into messages. Lines that are not JSON, or not part of the conversation, are skipped. */
export function parseTranscript(lines: Iterable<string>, redact: (s: string) => string = scrubText): ConversationMessage[] {
  const out: ConversationMessage[] = [];
  let n = 0;
  for (const raw of lines) {
    if (!raw || raw[0] !== '{') continue;
    let rec: Record<string, unknown>;
    try { rec = JSON.parse(raw) as Record<string, unknown>; } catch { continue; }
    if (rec.isSidechain === true || rec.isMeta === true) continue;
    const type = rec.type;
    const message = rec.message as { content?: unknown } | undefined;
    if (!message || (type !== 'user' && type !== 'assistant')) continue;
    const at = typeof rec.timestamp === 'string' ? Date.parse(rec.timestamp) : NaN;
    const base = { at: Number.isFinite(at) ? at : undefined };
    const uuid = typeof rec.uuid === 'string' ? rec.uuid : `m${n}`;
    if (type === 'user') {
      // a user record whose content is only tool results is the tool's answer, not something a person said
      const text = textOf(message.content, redact);
      if (text) out.push({ id: `${uuid}:u`, role: 'user', text, ...base });
    } else {
      const content = message.content;
      if (typeof content === 'string') {
        const text = textOf(content, redact);
        if (text) out.push({ id: `${uuid}:a`, role: 'assistant', text, ...base });
      } else if (Array.isArray(content)) {
        let i = 0;
        for (const b of content) {
          if (!b || typeof b !== 'object') continue;
          const block = b as { type?: unknown; text?: unknown; name?: unknown; input?: unknown };
          if (block.type === 'text' && typeof block.text === 'string') {
            const text = textOf(block.text, redact);
            if (text) out.push({ id: `${uuid}:a${i}`, role: 'assistant', text, ...base });
          } else if (block.type === 'tool_use' && typeof block.name === 'string') {
            out.push({ id: `${uuid}:t${i}`, role: 'tool', tool: { name: block.name, label: describeTool(block.name, block.input, redact) }, ...base });
          }
          i += 1;
        }
      }
    }
    n += 1;
  }
  return out;
}

/** Read the newest part of a transcript file as lines (dropping a first line that may have been cut). */
export function tailLines(file: string, maxBytes: number): { lines: string[]; truncated: boolean } {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    let off = 0;
    while (off < buf.length) {
      const got = readSync(fd, buf, off, buf.length - off, start + off);
      if (got <= 0) break;
      off += got;
    }
    const lines = buf.subarray(0, off).toString('utf8').split('\n');
    if (start > 0) lines.shift(); // begins mid-record
    return { lines, truncated: start > 0 };
  } finally {
    closeSync(fd);
  }
}

export function readConversation(file: string, opts: ConversationOptions = {}): { messages: ConversationMessage[]; truncated: boolean } {
  const { lines, truncated } = tailLines(file, opts.maxBytes ?? 600_000);
  const all = parseTranscript(lines, opts.redact ?? scrubText);
  const limit = opts.limit ?? 80;
  return { messages: all.length > limit ? all.slice(-limit) : all, truncated: truncated || all.length > limit };
}
