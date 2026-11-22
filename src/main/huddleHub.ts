/**
 * The Huddle hub: the one answer to "what are my agents doing, and what is waiting on me", for every window.
 *
 * It owns no agent. Agents are PTYs in the main process; their names and faces are the main window's; what they
 * are doing comes from the activity tracker. The hub only MERGES those three, adds what the notification service
 * says is waiting on a person, and tells every window that is watching when the answer changes. Opening or
 * closing the Huddle therefore starts nothing and loses nothing: there is no Huddle-side copy of an agent.
 *
 * Commands from either window (send, pause, resume, interrupt, end, restart) come back here and are carried out
 * through the app's own controls, addressed by agent id, so a click can only ever reach the agent it names.
 *
 * Electron-free: every machine-touching thing is a port, and the rules are tested under plain Node.
 */
import {
  attentionRank, computeState, needsHuman, type ActivityLabel, type AgentActivity, type AgentState
} from '../shared/agentActivity';
import {
  KEY_BYTES, emptyCounts, formatOutgoing, type AttachmentRef, type CommandResult, type HuddleAgentView, type HuddleCommand, type HuddleCounts,
  type HuddleModeState, type HuddleState, type RosterAgent
} from '../shared/huddle';
import { intentFromStuckPrompt } from '../shared/notifications';
import type { ActivityTracker } from './activityTracker';
import type { NotificationService } from './notifyService';

export interface HubTask { id: string; title?: string; status?: string; assignee?: string | null }
export interface HubPty { id: string; lastOutputAt: number; hasOutput: boolean }
export interface HubRegistryAgent { name?: string; isGod?: boolean; provider?: string; role?: string; archived?: boolean }

export interface HubPorts {
  now(): number;
  livePtys(): HubPty[];
  tracker: ActivityTracker;
  notifications: NotificationService;
  tasks(): HubTask[];
  registry(): Record<string, HubRegistryAgent>;
  controlSnapshot(agentId: string): { paused: boolean; halted: boolean };
  setPaused(agentId: string, paused: boolean): void;
  ptyWrite(ptyId: string, data: string): { ok: boolean; error?: string };
  killAgent(agentId: string): { ok: boolean; error?: string };
  /** Hand a message to the window that owns the agent's roster, for its own queue to deliver. */
  toOwner(agentId: string, channel: string, payload: unknown): boolean;
  /** Ask that window to do something and wait for it to say how it went. */
  askOwner(agentId: string, command: { type: 'restart'; agentId: string }): Promise<CommandResult>;
  validateAttachment(path: string): { ok: true } | { ok: false; error: string };
  broadcast(state: HuddleState): void;
  mode(): HuddleModeState;
  countMessageSent?(): void;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (h: unknown) => void;
}

/** A card for an agent that has gone stays this long (a crash stays until someone deals with it). */
export const DEPART_LINGER_MS = 12_000;
const BROADCAST_DELAY_MS = 80;
/** How long a crashed agent's card stays once nothing is waiting on anyone about it. */
export const DEALT_WITH_LINGER_MS = 3_000;
/** The terminal parser must keep seeing a prompt for this long before it counts as a stuck agent: it flickers. */
const STUCK_AFTER_MS = 2_500;
const ESC = '\u001b';

interface RosterEntry { agent: RosterAgent; source: number; order: number }

export class HuddleHub {
  private readonly sources = new Map<number, RosterAgent[]>();
  private roster = new Map<string, RosterEntry>();
  private readonly lastState = new Map<string, { state: AgentState; since: number }>();
  private readonly shown = new Map<string, HuddleAgentView>();
  private readonly departing = new Map<string, HuddleAgentView>();
  private readonly stuck = new Map<string, { since: number; raised: boolean }>();
  /** When a crashed agent's last open notification was dealt with, so its card can leave shortly after. */
  private readonly dealtWithAt = new Map<string, number>();
  private timer: unknown = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private lastSent = '';
  private disposed = false;

  constructor(private readonly ports: HubPorts) {}

  // ─── inputs ────────────────────────────────────────────────────────────────

  /** The main window reports its roster. Later reports from the same window replace earlier ones. */
  setRoster(source: number, agents: RosterAgent[]): void {
    this.sources.set(source, agents);
    this.rebuildRoster();
    this.refresh();
  }

  /** A window that owned a roster has closed. Its agents went with it, so their cards go at once. */
  dropSource(source: number): void {
    const gone = this.sources.get(source);
    if (!this.sources.delete(source)) return;
    for (const a of gone ?? []) {
      if (this.roster.get(a.id)?.source !== source) continue; // another window lists the same agent
      this.shown.delete(a.id); this.departing.delete(a.id); this.lastState.delete(a.id); this.stuck.delete(a.id); this.dealtWithAt.delete(a.id);
    }
    this.rebuildRoster();
    this.refresh();
  }

  private rebuildRoster(): void {
    const next = new Map<string, RosterEntry>();
    let order = 0;
    for (const [source, agents] of this.sources) {
      for (const agent of agents) next.set(agent.id, { agent, source, order: order++ });
    }
    this.roster = next;
  }

  start(intervalMs = 1000): void {
    if (this.tickTimer || this.disposed) return;
    this.tickTimer = setInterval(() => this.tick(), intervalMs);
    this.tickTimer.unref?.();
  }

  dispose(): void {
    this.disposed = true;
    if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = null; }
    const clear = this.ports.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    if (this.timer !== null) { clear(this.timer); this.timer = null; }
  }

  // ─── lookups ───────────────────────────────────────────────────────────────

  rosterOf(agentId: string): RosterAgent | undefined { return this.roster.get(agentId)?.agent; }
  sourceOf(agentId: string): number | undefined { return this.roster.get(agentId)?.source; }
  ptyIdOf(agentId: string): string | undefined { return this.roster.get(agentId)?.agent.ptyId; }
  hasRoster(): boolean { return this.roster.size > 0; }

  agentName(agentId: string): string {
    return this.roster.get(agentId)?.agent.name ?? this.ports.registry()[agentId]?.name ?? agentId;
  }

  isGod(agentId: string): boolean {
    return this.roster.get(agentId)?.agent.isGod === true || this.ports.registry()[agentId]?.isGod === true;
  }

  // ─── building the answer ───────────────────────────────────────────────────

  private labelFor(a: AgentActivity | undefined, state: AgentState): ActivityLabel {
    switch (state) {
      case 'paused': return { verb: 'paused' };
      case 'completed': return { verb: 'finished' };
      case 'needs-approval': return { verb: 'askingApproval', arg: a?.pending?.tool };
      case 'needs-input': return { verb: 'askingQuestion' };
      case 'error': return { verb: a?.error?.kind === 'breaker' ? 'looping' : 'failed', arg: a?.error?.message || undefined };
      case 'stopped': return { verb: 'stopped' };
      case 'waiting': return { verb: 'waiting' };
      case 'working': case 'researching': return a?.turn.active ? a.activity : { verb: 'thinking' };
      default: return { verb: 'idle' };
    }
  }

  private progressFor(agentId: string, a: AgentActivity | undefined, tasks: HubTask[]): HuddleAgentView['progress'] {
    if (a?.todos && a.todos.total > 0) return { ...a.todos, source: 'todos' };
    const mine = tasks.filter((t) => t.assignee === agentId && t.status !== 'archived');
    if (mine.length >= 2) {
      const done = mine.filter((t) => t.status === 'done').length;
      const doing = mine.find((t) => t.status === 'doing');
      return { done, total: mine.length, ...(doing?.title ? { current: doing.title } : {}), source: 'tasks' };
    }
    return undefined;
  }

  private viewOf(entry: RosterAgent, now: number, ptys: Map<string, HubPty>, tasks: HubTask[], mainAvailable: boolean): HuddleAgentView {
    const id = entry.id;
    const activity = this.ports.tracker.get(id);
    const alive = !!entry.ptyId && ptys.has(entry.ptyId);
    const control = this.ports.controlSnapshot(id);
    // The tracker learns of a pause when the control changes; the control registry is the truth if they ever differ.
    const paused = control.paused || control.halted;
    const state = computeState(
      activity && (activity.paused !== control.paused || activity.halted !== control.halted)
        ? { ...activity, paused: control.paused, halted: control.halted } : activity,
      { now, alive, rosterStatus: entry.status }
    );
    const last = this.lastState.get(id);
    const since = last && last.state === state ? last.since : now;
    this.lastState.set(id, { state, since });

    const open = this.ports.notifications.openFor(id).sort((x, y) => y.createdAt - x.createdAt);
    const attention = open.length
      ? { ids: open.map((r) => r.id), since: Math.min(...open.map((r) => r.createdAt)), critical: open.some((r) => r.priority === 'critical' || r.priority === 'high') }
      : null;
    const ctx = entry.contextTokens !== undefined && entry.contextLimit && entry.contextLimit > 0
      ? Math.max(0, Math.min(100, Math.round((entry.contextTokens / entry.contextLimit) * 100))) : undefined;
    const busy = state === 'working' || state === 'researching';
    const progress = this.progressFor(id, activity, tasks);
    const mine = tasks.filter((t) => t.assignee === id && t.status && t.status !== 'done' && t.status !== 'archived')
      .sort((a, b) => (a.status === 'doing' ? 0 : 1) - (b.status === 'doing' ? 0 : 1)).slice(0, 4)
      .map((t) => ({ id: t.id, title: String(t.title ?? t.id).slice(0, 120), status: String(t.status) }));
    return {
      id, name: entry.name, character: entry.character, accent: entry.accent,
      isGod: entry.isGod === true,
      ...(entry.provider ? { provider: entry.provider } : {}),
      ...(entry.model ? { model: entry.model } : {}),
      ...(entry.description ? { description: entry.description } : {}),
      ...(entry.project ? { project: entry.project } : {}),
      alive, state, stateSince: since,
      activity: this.labelFor(activity, state),
      ...(busy && activity?.tool ? { tool: activity.tool } : {}),
      ...(progress ? { progress } : {}),
      ...(mine.length ? { tasks: mine } : {}),
      ...(ctx !== undefined ? { contextPct: ctx } : {}),
      queued: entry.queued ?? 0,
      paused,
      attention,
      ...(activity?.error?.message ? { error: activity.error.message } : {}),
      controls: {
        send: alive && mainAvailable,
        pause: alive && !paused && !entry.isAssistant,
        resume: alive && paused,
        interrupt: alive && busy,
        end: alive && !entry.isGod,
        restart: !!entry.ptyId && mainAvailable
      }
    };
  }

  /** The state every window shows. Cheap enough to rebuild on each change. */
  build(): HuddleState {
    const now = this.ports.now();
    const ptys = new Map(this.ports.livePtys().map((p) => [p.id, p]));
    const tasks = this.ports.tasks();
    const mainAvailable = this.roster.size > 0;
    const views: HuddleAgentView[] = [];
    const present = new Set<string>();

    const entries = [...this.roster.values()].filter((e) => !e.agent.archived && !!e.agent.ptyId && !e.agent.isAssistant).sort((a, b) => a.order - b.order);
    for (const { agent } of entries) {
      const v = this.viewOf(agent, now, ptys, tasks, mainAvailable);
      if (!v.alive) {
        // A process that is gone is a departure, whatever the roster still says. An agent that lived and died
        // between two looks (it crashed at start) still gets its card, so the crash is not invisible.
        if (!this.shown.has(agent.id) && this.ports.tracker.get(agent.id)) this.shown.set(agent.id, v);
        continue;
      }
      present.add(agent.id);
      this.departing.delete(agent.id);
      this.shown.set(agent.id, v);
      views.push(v);
    }

    // Agents that were here a moment ago and are not now stay for a short while, so the finish is seen.
    for (const [id, last] of [...this.shown]) {
      if (present.has(id)) continue;
      let gone = this.departing.get(id);
      if (!gone) {
        const act = this.ports.tracker.get(id);
        const cleanFinish = !act?.error && !!act?.completed && now - act.completed.at < 120_000;
        const state: AgentState = act?.error?.kind === 'crash' ? 'error' : cleanFinish ? 'completed' : 'stopped';
        gone = {
          ...last, alive: false, state, stateSince: now,
          activity: state === 'completed' ? { verb: 'finished' } : state === 'error' ? { verb: 'failed', arg: act?.error?.message || undefined } : { verb: 'stopped' },
          controls: { send: false, pause: false, resume: false, interrupt: false, end: false, restart: mainAvailable },
          paused: false, queued: 0, attention: null,
          // a crash waits for a person; anything else leaves quietly
          lingerUntil: state === 'error' ? now + 10 * 60_000 : now + DEPART_LINGER_MS
        };
        this.departing.set(id, gone);
      }
      const open = this.ports.notifications.openFor(id).sort((x, y) => y.createdAt - x.createdAt);
      // a crashed agent waits for a person; a moment after the last thing waiting on one is dealt with, it goes
      let until = gone.lingerUntil ?? 0;
      if (gone.state === 'error') {
        if (open.length === 0) {
          if (!this.dealtWithAt.has(id)) this.dealtWithAt.set(id, now);
          until = Math.min(until, (this.dealtWithAt.get(id) as number) + DEALT_WITH_LINGER_MS);
        } else this.dealtWithAt.delete(id);
      }
      if (until <= now) { this.shown.delete(id); this.departing.delete(id); this.lastState.delete(id); this.dealtWithAt.delete(id); continue; }
      views.push({
        ...gone, lingerUntil: until,
        attention: open.length ? { ids: open.map((r) => r.id), since: Math.min(...open.map((r) => r.createdAt)), critical: open.some((r) => r.priority === 'critical' || r.priority === 'high') } : null
      });
    }

    // Anyone who needs a person comes first; otherwise the order the floor keeps. A stable sort, so a card does
    // not shuffle every time a status changes.
    const indexed = views.map((v, i) => ({ v, i }));
    indexed.sort((a, b) => {
      const ra = a.v.attention ? 10 + attentionRank(a.v.state) : 0;
      const rb = b.v.attention ? 10 + attentionRank(b.v.state) : 0;
      return rb - ra || a.i - b.i;
    });
    const ordered = indexed.map((x) => x.v);

    const counts: HuddleCounts = emptyCounts();
    for (const v of ordered) {
      counts.total += 1;
      if (v.attention || needsHuman(v.state)) counts.attention += 1;
      if (v.state === 'working' || v.state === 'researching') counts.working += 1;
      if (v.state === 'completed') counts.completed += 1;
      if (v.state === 'error') counts.error += 1;
      if (v.state === 'paused') counts.paused += 1;
    }
    return { v: 1, at: now, agents: ordered, counts, mode: this.ports.mode(), mainAvailable };
  }

  state(): HuddleState { return this.build(); }

  // ─── telling the windows ───────────────────────────────────────────────────

  /** Something may have changed: tell the windows, once, shortly. */
  refresh(): void {
    if (this.disposed || this.timer !== null) return;
    const set = this.ports.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.timer = set(() => { this.timer = null; this.flush(); }, BROADCAST_DELAY_MS);
  }

  flush(): void {
    if (this.disposed) return;
    const state = this.build();
    // `at` changes every time; the rest decides whether anyone needs telling
    const key = JSON.stringify({ ...state, at: 0 });
    if (key === this.lastSent) return;
    this.lastSent = key;
    this.ports.broadcast(state);
  }

  /** Once a second: silence ends turns that never said they ended, a prompt the parser keeps seeing is a stuck
   *  agent, and a card that has lingered long enough goes. */
  tick(): void {
    if (this.disposed) return;
    const now = this.ports.now();
    const ptys = new Map(this.ports.livePtys().map((p) => [p.id, p]));
    for (const { agent } of this.roster.values()) {
      const pty = agent.ptyId ? ptys.get(agent.ptyId) : undefined;
      const act = this.ports.tracker.get(agent.id);
      if (pty && act?.turn.active && pty.lastOutputAt > 0) this.ports.tracker.quiet(agent.id, now - pty.lastOutputAt);

      // An engine without hooks still shows a prompt on its screen, which the main window's parser recognises.
      const blockedNow = agent.status === 'blocked' && !!pty && !act?.pending && !act?.error;
      const s = this.stuck.get(agent.id);
      if (blockedNow) {
        if (!s) this.stuck.set(agent.id, { since: now, raised: false });
        else if (!s.raised && now - s.since >= STUCK_AFTER_MS) {
          s.raised = true;
          this.ports.notifications.ingest(intentFromStuckPrompt({ id: agent.id, name: agent.name, isGod: agent.isGod }, s.since), agent.name);
        }
      } else if (s) {
        if (s.raised) this.ports.notifications.resolveByKey(`${agent.id}|stuck|${s.since}`, { by: 'agent', action: 'resolved', note: 'prompt-gone' });
        this.stuck.delete(agent.id);
      }
    }
    for (const id of [...this.stuck.keys()]) if (!this.roster.has(id)) this.stuck.delete(id);
    this.refresh();
  }

  // ─── commands ──────────────────────────────────────────────────────────────

  private liveAgent(agentId: string): { entry: RosterAgent; ptyId: string } | { error: string } {
    const entry = this.roster.get(agentId)?.agent;
    if (!entry) return { error: 'unknown-agent' };
    if (!entry.ptyId) return { error: 'no-terminal' };
    if (!this.ports.livePtys().some((p) => p.id === entry.ptyId)) return { error: 'not-running' };
    return { entry, ptyId: entry.ptyId };
  }

  /** Carry out one command from a window. Everything is addressed by agent id and checked against the roster. */
  async command(cmd: HuddleCommand): Promise<CommandResult> {
    let result: CommandResult;
    try { result = await this.run(cmd); }
    catch (e) { result = { ok: false, error: e instanceof Error ? e.message : String(e) }; }
    this.refresh();
    return result;
  }

  private async run(cmd: HuddleCommand): Promise<CommandResult> {
    switch (cmd.type) {
      case 'send': {
        const t = this.liveAgent(cmd.agentId);
        if ('error' in t) return { ok: false, error: t.error };
        for (const a of cmd.attachments) {
          const v = this.ports.validateAttachment(a.path);
          if (!v.ok) return { ok: false, error: `attachment: ${v.error}` };
        }
        const body = formatOutgoing(cmd.text, cmd.attachments as readonly AttachmentRef[]).trim();
        // The owning window's own queue delivers it, with the same idle, draft and picker guards as a message
        // typed in the main window.
        const sent = this.ports.toOwner(cmd.agentId, 'hive:enqueueToAgent', { targetId: cmd.agentId, text: body });
        if (!sent) return { ok: false, error: 'main-window-unavailable' };
        this.ports.countMessageSent?.();
        return { ok: true, queued: true };
      }
      case 'pause': {
        const t = this.liveAgent(cmd.agentId);
        if ('error' in t) return { ok: false, error: t.error };
        this.ports.setPaused(cmd.agentId, true);
        return { ok: true };
      }
      case 'resume': {
        if (!this.roster.has(cmd.agentId)) return { ok: false, error: 'unknown-agent' };
        this.ports.setPaused(cmd.agentId, false);
        return { ok: true };
      }
      case 'interrupt': {
        const t = this.liveAgent(cmd.agentId);
        if ('error' in t) return { ok: false, error: t.error };
        const w = this.ports.ptyWrite(t.ptyId, ESC);
        if (w.ok) this.ports.tracker.userInput(cmd.agentId, ESC);
        return w;
      }
      case 'keys': {
        const t = this.liveAgent(cmd.agentId);
        if ('error' in t) return { ok: false, error: t.error };
        const bytes = KEY_BYTES[cmd.key];
        const w = this.ports.ptyWrite(t.ptyId, bytes);
        // a person pressing the key that answers a prompt is answering it
        if (w.ok) this.ports.tracker.userInput(cmd.agentId, bytes);
        return w;
      }
      case 'end': {
        const t = this.liveAgent(cmd.agentId);
        if ('error' in t) return { ok: false, error: t.error };
        if (t.entry.isGod) return { ok: false, error: 'not-for-orchestrator' };
        return this.ports.killAgent(cmd.agentId);
      }
      case 'restart': {
        if (!this.roster.has(cmd.agentId)) return { ok: false, error: 'unknown-agent' };
        return this.ports.askOwner(cmd.agentId, { type: 'restart', agentId: cmd.agentId });
      }
    }
  }
}
