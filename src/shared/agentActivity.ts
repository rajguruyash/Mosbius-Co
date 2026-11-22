/**
 * Agent activity: what an agent is doing right now, derived from the lifecycle
 * events the app really receives (hook events, PTY start/exit, operator controls,
 * the circuit breaker) and nothing else.
 *
 * Pure and Electron-free, so every rule is unit-tested under plain Node. The main
 * process feeds it (src/main/activityTracker.ts); the Huddle window, the
 * notification service and the office floor all read the same answer.
 *
 * Nothing in here invents a state. A state is only ever the consequence of an
 * event that happened, and every rule below says which.
 */
import { isInboxNudge } from './hiveNudge';

/** The nine things the Huddle can say about an agent, plus "stopped" for one that is not running. */
export type AgentState =
  | 'idle'
  | 'working'
  | 'researching'
  | 'waiting'
  | 'completed'
  | 'needs-input'
  | 'needs-approval'
  | 'error'
  | 'paused'
  | 'stopped';

export const AGENT_STATES: readonly AgentState[] = [
  'idle', 'working', 'researching', 'waiting', 'completed',
  'needs-input', 'needs-approval', 'error', 'paused', 'stopped'
];

/** How long a finished agent keeps showing "completed" before it settles to idle. */
export const COMPLETED_LINGER_MS = 20_000;
/** A turn shorter than this, using fewer tools than MIN_COMPLETION_TOOLS, is routine, not a "completed" event
 *  (an inbox nudge or a one-line answer should not ring a bell). */
export const MIN_COMPLETION_TURN_MS = 15_000;
export const MIN_COMPLETION_TOOLS = 3;
/** A turn with no hook event and no terminal output for this long is over (an interrupted turn fires no Stop hook).
 *  Same figure the renderer's own quiescence fallback uses, so the two agree. */
export const QUIESCE_MS = 12_000;

const PREVIEW_MAX = 240;
const SUBJECT_MAX = 80;

// ─── text hygiene ────────────────────────────────────────────────────────────

/** Strip control characters and clip. Used on every string that came from an agent. */
export function clip(text: unknown, max = PREVIEW_MAX): string {
  if (typeof text !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** A last-resort scrub for anything shaped like a credential. The main process passes the app's own,
 *  stricter redactor in; this keeps the shared code safe on its own. */
export function scrubText(text: string): string {
  return text
    .replace(/\b(?:sk|pk|rk|ghp|gho|ghs|ghu|github_pat|xox[abprs]|glpat|AKIA|ASIA|AIza)[-_A-Za-z0-9]{12,}/g, '[redacted]')
    .replace(/\b(bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, '$1[redacted]')
    .replace(/([?&](?:token|key|secret|password|passwd|api[_-]?key|access[_-]?token)=)[^&\s"']+/gi, '$1[redacted]')
    .replace(/((?:token|secret|password|passwd|api[_-]?key|authorization)\s*[=:]\s*)["']?[^\s"']{6,}/gi, '$1[redacted]');
}

/** A short, stable id for a string (FNV-1a, 32 bit). For de-duplication keys, never for security. */
export function shortHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// ─── tools ───────────────────────────────────────────────────────────────────

export type ToolClass = 'research' | 'work';

const RESEARCH_TOOLS = new Set([
  'Read', 'Grep', 'Glob', 'LS', 'NotebookRead', 'WebFetch', 'WebSearch', 'ReadMcpResourceTool', 'ListMcpResourcesTool'
]);

/** Is this tool about finding things out (reading, searching, fetching) rather than changing them?
 *  Claude's own tool names first; any other engine's names by what they say. */
export function classifyTool(tool: string | undefined): ToolClass {
  if (!tool) return 'work';
  if (RESEARCH_TOOLS.has(tool)) return 'research';
  if (['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Task', 'TodoWrite', 'KillShell'].includes(tool)) return 'work';
  const name = tool.startsWith('mcp__') ? tool.split('__').slice(2).join('_') : tool;
  const t = name.toLowerCase();
  if (/write|edit|create|patch|replace|apply|delete|remove|run_|exec|command|bash|shell|update|send|post|commit|push/.test(t)) return 'work';
  if (/read|list|view|dir|glob|grep|search|find|fetch|web|browse|get|query|lookup|describe|show|ls\b|cat\b/.test(t)) return 'research';
  return 'work';
}

export type ActivityVerb =
  | 'starting' | 'thinking' | 'running' | 'reading' | 'editing' | 'searching' | 'finding' | 'fetching'
  | 'searchingWeb' | 'delegating' | 'planning' | 'usingTool' | 'compacting' | 'idle' | 'finished'
  | 'askingApproval' | 'askingQuestion' | 'paused' | 'stopping' | 'stopped' | 'failed' | 'looping' | 'waiting';

/** What the agent is doing, as data. The UI turns the verb into the user's language. */
export interface ActivityLabel {
  verb: ActivityVerb;
  /** The thing it is doing it to: a command, a file name, a query. Agent-supplied text, never translated. */
  arg?: string;
}

function baseName(p: unknown): string {
  if (typeof p !== 'string' || !p) return '';
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

function hostOf(url: unknown): string {
  if (typeof url !== 'string') return '';
  try { return new URL(url).host; } catch { return clip(url, 40); }
}

/** A readable label for a tool call, built from its real input. */
export function describeTool(tool: string | undefined, input: unknown, redact: (s: string) => string = scrubText): ActivityLabel {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const arg = (v: unknown, max = SUBJECT_MAX): string | undefined => {
    const s = clip(typeof v === 'string' ? redact(v) : '', max);
    return s || undefined;
  };
  switch (tool) {
    case 'Bash': return { verb: 'running', arg: arg(i.description) ?? arg(String(i.command ?? '').split('\n')[0]) };
    case 'Read': case 'NotebookRead': return { verb: 'reading', arg: arg(baseName(i.file_path ?? i.notebook_path)) };
    case 'Edit': case 'MultiEdit': case 'Write': case 'NotebookEdit': return { verb: 'editing', arg: arg(baseName(i.file_path ?? i.notebook_path)) };
    case 'Grep': return { verb: 'searching', arg: arg(i.pattern) };
    case 'Glob': return { verb: 'finding', arg: arg(i.pattern) };
    case 'LS': return { verb: 'reading', arg: arg(baseName(i.path)) };
    case 'WebFetch': return { verb: 'fetching', arg: arg(hostOf(i.url)) };
    case 'WebSearch': return { verb: 'searchingWeb', arg: arg(i.query) };
    case 'Task': return { verb: 'delegating', arg: arg(i.description) };
    case 'TodoWrite': return { verb: 'planning' };
    case 'AskUserQuestion': return { verb: 'askingQuestion' };
    default: {
      if (!tool) return { verb: 'thinking' };
      const shown = tool.startsWith('mcp__') ? tool.split('__').slice(1).join(' · ') : tool;
      return { verb: 'usingTool', arg: clip(shown, 48) };
    }
  }
}

// ─── structured prompts ──────────────────────────────────────────────────────

/** The literal thing a tool call was asked to do: the command, the path, the address. A person deciding whether to
 *  allow it needs this, not a friendly description of it. */
export function toolDetail(tool: string | undefined, input: unknown, redact: (s: string) => string = scrubText): string | undefined {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const pick = (v: unknown, max = 200): string | undefined => { const s = clip(typeof v === 'string' ? redact(v) : '', max); return s || undefined; };
  switch (tool) {
    case 'Bash': return pick(i.command);
    case 'Read': case 'Edit': case 'MultiEdit': case 'Write': case 'NotebookEdit': case 'NotebookRead': return pick(i.file_path ?? i.notebook_path);
    case 'WebFetch': return pick(i.url);
    case 'WebSearch': return pick(i.query);
    case 'Grep': case 'Glob': return pick(i.pattern);
    default: return undefined;
  }
}

export interface TodoProgress { done: number; total: number; current?: string }

/** Claude's TodoWrite tool carries the agent's own checklist: the one real progress measure a run has. */
export function parseTodos(input: unknown, redact: (s: string) => string = scrubText): TodoProgress | undefined {
  const todos = (input as { todos?: unknown } | null)?.todos;
  if (!Array.isArray(todos) || todos.length === 0) return undefined;
  let done = 0;
  let current: string | undefined;
  let total = 0;
  for (const t of todos) {
    if (!t || typeof t !== 'object') continue;
    const o = t as { status?: unknown; content?: unknown; activeForm?: unknown };
    total += 1;
    if (o.status === 'completed') done += 1;
    else if (o.status === 'in_progress' && current === undefined) {
      const text = typeof o.activeForm === 'string' && o.activeForm ? o.activeForm : o.content;
      current = clip(typeof text === 'string' ? redact(text) : '', SUBJECT_MAX) || undefined;
    }
  }
  return total > 0 ? { done, total, ...(current ? { current } : {}) } : undefined;
}

export interface AskedQuestion { question: string; options: string[]; multiSelect: boolean; questions: number }

/** Claude's AskUserQuestion tool: the question, and the options it offered. */
export function parseAskUserQuestion(input: unknown, redact: (s: string) => string = scrubText): AskedQuestion | undefined {
  const qs = (input as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(qs) || qs.length === 0) return undefined;
  const first = qs[0] as { question?: unknown; options?: unknown; multiSelect?: unknown } | null;
  if (!first || typeof first.question !== 'string') return undefined;
  const options: string[] = [];
  if (Array.isArray(first.options)) {
    for (const o of first.options) {
      const label = typeof o === 'string' ? o : (o as { label?: unknown } | null)?.label;
      if (typeof label === 'string' && label.trim()) options.push(clip(redact(label), 60));
    }
  }
  return { question: clip(redact(first.question)), options: options.slice(0, 8), multiSelect: first.multiSelect === true, questions: qs.length };
}

export type NotificationHookKind = 'approval' | 'idle' | 'input' | 'other';

/** What a Notification hook means. Claude sends a type (permission_prompt, idle_prompt, elicitation_dialog) in
 *  recent versions and only a message in older ones; the message rules mirror the renderer's own. */
export function classifyNotificationHook(type: string | undefined, message: string | undefined): NotificationHookKind {
  const t = (type ?? '').toLowerCase();
  const msg = (message ?? '').toLowerCase();
  if (/idle/.test(t)) return 'idle';
  if (/permission/.test(t)) return 'approval';
  if (/elicit/.test(t)) return 'input';
  if (msg.includes('waiting for your input') || msg.includes('is idle') || msg.includes('waiting for input')) return 'idle';
  if (msg.includes('permission') || msg.includes('approve') || msg.includes('confirm') || msg.includes('needs your')) return 'approval';
  // A Notification with neither a type nor a message is the idle shape, in the renderer's rules and the watchdog's.
  if (!msg && !t) return 'idle';
  return 'other';
}

// ─── the record ──────────────────────────────────────────────────────────────

export interface PendingRequest {
  /** Stable for the same question, so a repeat of it is recognised as the same request. */
  id: string;
  kind: 'approval' | 'input';
  source: 'permission' | 'ask-question' | 'plan' | 'elicitation';
  /** What the agent is asking, redacted and clipped. */
  preview: string;
  tool?: string;
  /** The CLI's own id for the tool call the prompt is about, when it said (so a call that runs beside it is not mistaken for its answer). */
  toolUseId?: string;
  /** The options the agent offered, when it offered any. */
  options?: string[];
  /** The app knows which keys answer this prompt, so the buttons can act on it. */
  automatable: boolean;
  since: number;
}

export interface AgentActivity {
  agentId: string;
  /** A PTY is running (set by spawn and exit; the hub re-checks it against the real PTY list). */
  alive: boolean;
  since: number;
  activity: ActivityLabel;
  tool?: string;
  toolClass: ToolClass;
  turn: { active: boolean; startedAt: number; toolCount: number; userInitiated: boolean };
  /** The most recent tool call, kept so a permission prompt can say which tool it is about. */
  lastTool?: { name: string; label: ActivityLabel; detail?: string; at: number; useId?: string };
  pending?: PendingRequest;
  todos?: TodoProgress;
  error?: { kind: 'crash' | 'breaker'; message: string; at: number; exitCode?: number; signal?: number };
  paused: boolean;
  halted: boolean;
  breaker?: 'steering' | 'constrained' | 'stopped';
  /** The last substantial finish, for the "completed" linger. */
  completed?: { at: number; ms: number; tools: number };
  lastEventAt: number;
  /** When an idle notification last arrived, so the same idle period is announced once. */
  idleAnnouncedAt?: number;
}

export function newActivity(agentId: string, now: number): AgentActivity {
  return {
    agentId, alive: true, since: now, activity: { verb: 'idle' }, toolClass: 'work',
    turn: { active: false, startedAt: 0, toolCount: 0, userInitiated: false },
    paused: false, halted: false, lastEventAt: now
  };
}

export type ActivityEvent =
  | { type: 'spawn'; at: number }
  | { type: 'exit'; at: number; exitCode?: number; signal?: number; tail?: string }
  | {
      type: 'hook'; at: number; event: string; tool?: string; toolUseId?: string; toolInput?: unknown; message?: string;
      notificationType?: string; prompt?: string; blocked?: boolean; stopHookActive?: boolean; source?: string
    }
  | { type: 'control'; at: number; paused: boolean; halted: boolean }
  | { type: 'breaker'; at: number; level: 'healthy' | 'steering' | 'constrained' | 'stopped'; reason?: string }
  /** The terminal has been silent for `quietMs`: ends a turn that never announced its own end. */
  | { type: 'quiet'; at: number; quietMs: number }
  /** Someone typed into the agent's terminal. If that answers an open prompt, the prompt is resolved. */
  | { type: 'user-input'; at: number; data: string };

/** What happened that other parts of the app may want to react to. The notification service lives on these. */
export type ActivitySignal =
  | { kind: 'started' }
  | { kind: 'turn-completed'; ms: number; tools: number; substantial: boolean; userInitiated: boolean }
  | { kind: 'approval-requested'; request: PendingRequest }
  | { kind: 'input-requested'; request: PendingRequest }
  | { kind: 'request-resolved'; requestId: string; how: ResolvedHow }
  | { kind: 'idle-waiting' }
  | { kind: 'crashed'; message: string; exitCode?: number; signal?: number }
  | { kind: 'stopped' }
  | { kind: 'breaker'; level: 'constrained' | 'stopped'; reason: string }
  | { kind: 'breaker-cleared' }
  | { kind: 'paused' }
  | { kind: 'resumed' };

export type ResolvedHow = 'agent-moved-on' | 'agent-exited' | 'answered-in-terminal';

/** Would this keystroke answer a prompt that is waiting on the screen? Enter, a bare Escape, or one digit do
 *  (an arrow key, which is Escape followed by more bytes, only moves the highlight). */
export function keystrokeAnswersPrompt(data: string): boolean {
  if (data === '\u001b') return true;
  if (/[\r\n]/.test(data)) return true;
  return /^[0-9]$/.test(data);
}

export interface ReduceOptions { redact?: (s: string) => string }

/** The last non-empty line of a terminal tail: what the process said on its way out. */
export function lastLine(tail: string | undefined, redact: (s: string) => string = scrubText): string {
  if (!tail) return '';
  // eslint-disable-next-line no-control-regex
  const text = tail.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\u001b\][^\u0007]*\u0007/g, '').replace(/\r/g, '');
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  return clip(redact(lines[lines.length - 1] ?? ''), 160);
}

/** Does this tool call finishing show that the open prompt was answered? Only if it is the call the prompt was about:
 *  by the CLI's own call id when both are known, else by tool name. With nothing to tell them apart, any finish counts.
 *  (Sub-agents and parallel reads run beside a prompt that is still open; their finishing must not close it.) */
function answersPending(p: PendingRequest, ev: { tool?: string; toolUseId?: string }): boolean {
  if (p.toolUseId && ev.toolUseId) return p.toolUseId === ev.toolUseId;
  if (p.tool && ev.tool) return p.tool === ev.tool;
  return true;
}

function resolvePending(a: AgentActivity, signals: ActivitySignal[], how: ResolvedHow): void {
  if (!a.pending) return;
  signals.push({ kind: 'request-resolved', requestId: a.pending.id, how });
  a.pending = undefined;
}

function startTurnIfNeeded(a: AgentActivity, at: number, userInitiated: boolean): void {
  if (a.turn.active) return;
  a.turn = { active: true, startedAt: at, toolCount: 0, userInitiated };
  a.completed = undefined;
}

/**
 * Fold one event into an agent's activity. Never mutates `prev`.
 *
 * Why each hook is read the way it is:
 *  - UserPromptSubmit opens a turn; Stop closes it. A turn that used tools or ran long is a completion, a short
 *    one is routine (an inbox nudge answered in a second must not ring a bell).
 *  - PreToolUse names the tool in flight (and, for AskUserQuestion / ExitPlanMode, is itself the request).
 *  - A permission Notification arrives AFTER the PreToolUse of the call it is about, so the last tool is the subject.
 *  - Any later tool event, prompt or Stop proves the agent moved on, which resolves an open request.
 */
export function reduceActivity(prev: AgentActivity, ev: ActivityEvent, opts: ReduceOptions = {}): { next: AgentActivity; signals: ActivitySignal[] } {
  const redact = opts.redact ?? scrubText;
  const a: AgentActivity = { ...prev, turn: { ...prev.turn } };
  const signals: ActivitySignal[] = [];
  const touch = (at: number): void => { a.lastEventAt = Math.max(a.lastEventAt, at); };

  switch (ev.type) {
    case 'spawn': {
      const fresh = newActivity(a.agentId, ev.at);
      fresh.activity = { verb: 'starting' };
      // an operator's pause outlives the process only if the control state says so; spawn starts clean
      signals.push({ kind: 'started' });
      return { next: fresh, signals };
    }
    case 'exit': {
      a.alive = false;
      a.since = ev.at;
      touch(ev.at);
      resolvePending(a, signals, 'agent-exited');
      a.turn = { active: false, startedAt: 0, toolCount: 0, userInitiated: false };
      const abnormal = (typeof ev.exitCode === 'number' && ev.exitCode !== 0) || (typeof ev.signal === 'number' && ev.signal !== 0);
      if (abnormal) {
        const said = lastLine(ev.tail, redact);
        a.error = { kind: 'crash', message: said, at: ev.at, exitCode: ev.exitCode, signal: ev.signal };
        a.activity = { verb: 'failed', arg: said || undefined };
        signals.push({ kind: 'crashed', message: said, exitCode: ev.exitCode, signal: ev.signal });
      } else {
        a.activity = { verb: 'stopped' };
        signals.push({ kind: 'stopped' });
      }
      return { next: a, signals };
    }
    case 'control': {
      touch(ev.at);
      const wasPaused = a.paused;
      a.paused = ev.paused;
      a.halted = ev.halted;
      if (ev.paused && !wasPaused) { a.since = ev.at; signals.push({ kind: 'paused' }); }
      if (!ev.paused && wasPaused) { a.since = ev.at; signals.push({ kind: 'resumed' }); }
      if (ev.halted) a.activity = { verb: 'stopping' };
      else if (!ev.paused && a.activity.verb === 'stopping') a.activity = a.turn.active ? { verb: 'thinking' } : { verb: 'idle' };
      return { next: a, signals };
    }
    case 'breaker': {
      touch(ev.at);
      if (ev.level === 'constrained' || ev.level === 'stopped') {
        a.breaker = ev.level;
        const reason = clip(redact(ev.reason ?? ''), 160);
        a.error = { kind: 'breaker', message: reason, at: ev.at };
        a.activity = { verb: 'looping', arg: reason || undefined };
        a.since = ev.at;
        signals.push({ kind: 'breaker', level: ev.level, reason });
      } else {
        const had = a.breaker === 'constrained' || a.breaker === 'stopped';
        a.breaker = ev.level === 'steering' ? 'steering' : undefined;
        if (a.error?.kind === 'breaker') a.error = undefined;
        if (had) { a.since = ev.at; signals.push({ kind: 'breaker-cleared' }); a.activity = a.turn.active ? { verb: 'thinking' } : { verb: 'idle' }; }
      }
      return { next: a, signals };
    }
    case 'quiet': {
      // No hook and no output for a while. A turn that never fired Stop (an interrupt does not) is over; no one
      // finished anything, so there is no completion signal. An open request is NOT cleared by silence: a prompt
      // waiting for a human is exactly what silence looks like.
      if (a.turn.active && !a.pending && ev.quietMs >= QUIESCE_MS) {
        a.turn = { active: false, startedAt: 0, toolCount: 0, userInitiated: false };
        a.activity = { verb: 'idle' };
        a.tool = undefined;
        a.since = ev.at;
      }
      return { next: a, signals };
    }
    case 'user-input': {
      if (a.pending && keystrokeAnswersPrompt(ev.data)) { touch(ev.at); resolvePending(a, signals, 'answered-in-terminal'); }
      return { next: a, signals };
    }
    case 'hook': break;
  }

  // ── hook events ──
  touch(ev.at);
  a.alive = true;
  switch (ev.event) {
    case 'SessionStart': {
      if (!a.turn.active) a.activity = { verb: 'idle' };
      a.since = ev.at;
      break;
    }
    case 'UserPromptSubmit': {
      resolvePending(a, signals, 'agent-moved-on');
      a.turn = { active: true, startedAt: ev.at, toolCount: 0, userInitiated: !(ev.prompt && isInboxNudge(ev.prompt)) };
      a.completed = undefined;
      a.activity = { verb: 'thinking' };
      a.tool = undefined;
      a.toolClass = 'work';
      a.since = ev.at;
      break;
    }
    case 'PreToolUse': {
      // A new tool call usually means whatever it was waiting on was answered. Not when the CLI names the call the prompt is
      // about and this is another one: calls run side by side while a prompt for one of them is open.
      if (a.pending && !(ev.tool === 'AskUserQuestion' || ev.tool === 'ExitPlanMode') && !(a.pending.toolUseId && ev.toolUseId)) resolvePending(a, signals, 'agent-moved-on');
      startTurnIfNeeded(a, ev.at, false);
      a.turn.toolCount += 1;
      const tool = ev.tool ?? '';
      const label = describeTool(tool, ev.toolInput, redact);
      a.tool = tool || undefined;
      a.toolClass = tool === 'TodoWrite' ? a.toolClass : classifyTool(tool);
      a.activity = label;
      a.lastTool = { name: tool, label, detail: toolDetail(tool, ev.toolInput, redact), at: ev.at, useId: ev.toolUseId };
      if (tool === 'TodoWrite') a.todos = parseTodos(ev.toolInput, redact) ?? a.todos;
      if (tool === 'AskUserQuestion') {
        const q = parseAskUserQuestion(ev.toolInput, redact);
        if (q) {
          const request: PendingRequest = {
            id: `input:${shortHash(q.question)}`, kind: 'input', source: 'ask-question', preview: q.question, tool,
            options: q.options.length ? q.options : undefined,
            // one single-choice question is answerable with the keys a list menu understands
            automatable: q.questions === 1 && !q.multiSelect && q.options.length > 0,
            since: ev.at
          };
          if (a.pending?.id !== request.id) { a.pending = request; signals.push({ kind: 'input-requested', request }); }
        }
      } else if (tool === 'ExitPlanMode') {
        const plan = clip(redact(String((ev.toolInput as { plan?: unknown } | null)?.plan ?? '')), PREVIEW_MAX);
        const request: PendingRequest = {
          id: `approval:plan:${shortHash(plan)}`, kind: 'approval', source: 'plan', preview: plan, tool,
          automatable: false, since: ev.at
        };
        if (a.pending?.id !== request.id) { a.pending = request; signals.push({ kind: 'approval-requested', request }); }
      }
      break;
    }
    case 'PostToolUse': {
      // The tool ran, so any prompt about it was answered (approved).
      if (a.pending && answersPending(a.pending, ev)) resolvePending(a, signals, 'agent-moved-on');
      startTurnIfNeeded(a, ev.at, false);
      break;
    }
    case 'PostToolUseFailure': {
      if (a.pending && answersPending(a.pending, ev)) resolvePending(a, signals, 'agent-moved-on');
      break;
    }
    case 'Notification': {
      const kind = classifyNotificationHook(ev.notificationType, ev.message);
      if (kind === 'approval') {
        const subject = a.lastTool && ev.at - a.lastTool.at < 10 * 60_000 ? a.lastTool : undefined;
        const detail = clip(redact(ev.message ?? ''), PREVIEW_MAX);
        // What is being asked, in the agent's own terms: the command, the file, the address. The CLI's sentence
        // ("needs your permission to use Bash") is only the fallback when there is no tool call to point at.
        const what = subject ? `${subject.name}: ${subject.detail ?? labelText(subject.label)}`.replace(/: $/, '') : '';
        const own = subject ? labelText(subject.label) : '';
        const note = subject?.detail && own && !subject.detail.includes(own) ? ` — ${own}` : '';
        const preview = clip(what ? `${what}${note}` : detail, PREVIEW_MAX);
        const request: PendingRequest = {
          id: `approval:${shortHash(`${subject?.name ?? ''}|${preview}`)}`, kind: 'approval', source: 'permission',
          preview: preview || detail, tool: subject?.name, toolUseId: subject?.useId, automatable: true, since: ev.at
        };
        if (a.pending?.id !== request.id) { a.pending = request; signals.push({ kind: 'approval-requested', request }); }
        a.since = ev.at;
      } else if (kind === 'input') {
        const detail = clip(redact(ev.message ?? ''), PREVIEW_MAX);
        const request: PendingRequest = {
          id: `input:${shortHash(detail)}`, kind: 'input', source: 'elicitation', preview: detail, automatable: false, since: ev.at
        };
        if (a.pending?.id !== request.id) { a.pending = request; signals.push({ kind: 'input-requested', request }); }
        a.since = ev.at;
      } else if (kind === 'idle') {
        // "Claude is waiting for your input": it answered, and nothing is queued. Announce once per idle period.
        if (!a.turn.active && a.idleAnnouncedAt === undefined) {
          a.idleAnnouncedAt = ev.at;
          signals.push({ kind: 'idle-waiting' });
        }
        if (a.turn.active && !a.pending) {
          // the agent is parked at its prompt, so the turn is over even if Stop never arrived
          a.turn = { active: false, startedAt: 0, toolCount: 0, userInitiated: false };
          a.activity = { verb: 'idle' };
          a.since = ev.at;
        }
      }
      break;
    }
    case 'Stop': {
      if (ev.stopHookActive || ev.blocked) break; // re-engaged to read its inbox: still working
      resolvePending(a, signals, 'agent-moved-on');
      const ms = a.turn.active ? Math.max(0, ev.at - a.turn.startedAt) : 0;
      const tools = a.turn.toolCount;
      const userInitiated = a.turn.userInitiated;
      const substantial = a.turn.active && (ms >= MIN_COMPLETION_TURN_MS || tools >= MIN_COMPLETION_TOOLS);
      a.turn = { active: false, startedAt: 0, toolCount: 0, userInitiated: false };
      a.tool = undefined;
      a.activity = { verb: substantial ? 'finished' : 'idle' };
      a.since = ev.at;
      a.idleAnnouncedAt = undefined;
      if (substantial) a.completed = { at: ev.at, ms, tools };
      signals.push({ kind: 'turn-completed', ms, tools, substantial, userInitiated });
      break;
    }
    case 'SubagentStop': break; // a helper finished inside the agent's own turn
    case 'PreCompact': {
      startTurnIfNeeded(a, ev.at, false);
      a.activity = { verb: 'compacting' };
      break;
    }
    case 'PostCompact': {
      a.activity = { verb: 'thinking' };
      break;
    }
    default: break;
  }
  return { next: a, signals };
}

function labelText(l: ActivityLabel): string {
  return l.arg ?? '';
}

// ─── the answer the UI shows ─────────────────────────────────────────────────

/** The renderer's own StatusKind, as the office floor sets it. Used as a corroborating source only. */
export type RosterStatus =
  | 'idle' | 'thinking' | 'working' | 'waiting' | 'blocked' | 'success' | 'ghost' | 'compacting' | 'looping' | 'typing';

export interface StateContext {
  now: number;
  /** A PTY for this agent is running right now (the real PTY list, not a remembered flag). */
  alive: boolean;
  /** What the floor says, from the renderer's roster feed: where the tracker has no evidence, this is the evidence. */
  rosterStatus?: string;
}

/**
 * The one state to show. Order matters and is the whole policy:
 * not running → crashed or stopped; breaker → error; an open request → needs you;
 * paused; a turn in progress → working or researching; a fresh finish → completed;
 * otherwise what the floor reports (waiting) or idle.
 */
export function computeState(a: AgentActivity | undefined, ctx: StateContext): AgentState {
  if (!ctx.alive) return a?.error?.kind === 'crash' ? 'error' : 'stopped';
  if (a?.error) return 'error';
  if (a?.pending) return a.pending.kind === 'input' ? 'needs-input' : 'needs-approval';
  const rs = ctx.rosterStatus;
  if (a?.paused || a?.halted) return 'paused';
  if (a?.turn.active) return a.toolClass === 'research' ? 'researching' : 'working';
  if (a?.completed && ctx.now - a.completed.at < COMPLETED_LINGER_MS) return 'completed';
  // No tracker evidence: fall back on what the renderer's own parser saw.
  if (rs === 'blocked') return 'needs-approval';
  if (rs === 'looping') return 'error';
  if (rs === 'working' || rs === 'thinking' || rs === 'compacting') return 'working';
  if (rs === 'waiting') return 'waiting';
  if (rs === 'ghost') return 'stopped';
  return 'idle';
}

/** States in which the agent cannot go on without a person. */
export function needsHuman(state: AgentState): boolean {
  return state === 'needs-input' || state === 'needs-approval' || state === 'error';
}

/** How urgently the state wants a person (0 = not at all). Orders the compact list. */
export function attentionRank(state: AgentState): number {
  switch (state) {
    case 'needs-approval': return 5;
    case 'needs-input': return 5;
    case 'error': return 4;
    case 'completed': return 3;
    case 'paused': return 2;
    case 'working': case 'researching': return 1;
    default: return 0;
  }
}

/** The office floor's existing status for each state, so the two surfaces never disagree about "busy". */
export function toRosterStatus(state: AgentState): RosterStatus {
  switch (state) {
    case 'working': case 'researching': return 'working';
    case 'waiting': case 'paused': return 'waiting';
    case 'completed': return 'success';
    case 'needs-input': case 'needs-approval': return 'blocked';
    case 'error': return 'looping';
    case 'stopped': return 'ghost';
    default: return 'idle';
  }
}
