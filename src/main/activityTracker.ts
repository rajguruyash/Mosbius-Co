/**
 * The activity tracker: one AgentActivity per agent, advanced only by events the main process really sees
 * (hook payloads, the PTY starting and dying, operator pause/halt, the circuit breaker, a keystroke typed
 * into the terminal) and by the passage of quiet.
 *
 * It is a thin shell around the pure reducer in src/shared/agentActivity.ts, which holds every rule. Nothing
 * here knows about Electron, windows or notifications; it hands out signals and lets others decide what they
 * mean. Whoever needs "what is agent X doing" asks the hub, which merges this with the roster.
 */
import { newActivity, reduceActivity, scrubText, type ActivityEvent, type ActivitySignal, type AgentActivity } from '../shared/agentActivity';

export interface HookObservation {
  event: string;
  tool?: string;
  /** The CLI's id for the tool call this hook is about, when it sends one. */
  toolUseId?: string;
  toolInput?: unknown;
  message?: string;
  notificationType?: string;
  prompt?: string;
  source?: string;
  stopHookActive?: boolean;
  blocked?: boolean;
}

export interface TrackerOptions {
  now?: () => number;
  /** The app's own credential scrubber; the shared one is the fallback. */
  redact?: (s: string) => string;
  /** Told after an event, with the signals it produced (possibly none). */
  onSignals?: (agentId: string, signals: ActivitySignal[], activity: AgentActivity) => void;
  /** Told whenever an agent's activity may have changed. */
  onChange?: (agentId: string) => void;
}

export class ActivityTracker {
  private readonly map = new Map<string, AgentActivity>();
  private readonly now: () => number;

  constructor(private readonly opts: TrackerOptions = {}) {
    this.now = opts.now ?? Date.now;
  }

  get(agentId: string): AgentActivity | undefined { return this.map.get(agentId); }

  ids(): string[] { return [...this.map.keys()]; }

  private apply(agentId: string, ev: ActivityEvent): AgentActivity {
    const prev = this.map.get(agentId) ?? newActivity(agentId, ev.at);
    const redact = this.opts.redact ?? scrubText;
    const { next, signals } = reduceActivity(prev, ev, { redact });
    this.map.set(agentId, next);
    if (signals.length) {
      try { this.opts.onSignals?.(agentId, signals, next); } catch (e) { console.error('[activity] a signal handler threw:', e); }
    }
    try { this.opts.onChange?.(agentId); } catch { /* a listener must not break the tracker */ }
    return next;
  }

  /** A hook payload arrived for this agent. */
  hook(agentId: string, h: HookObservation): void {
    this.apply(agentId, {
      type: 'hook', at: this.now(), event: h.event, tool: h.tool, toolUseId: h.toolUseId, toolInput: h.toolInput, message: h.message,
      notificationType: h.notificationType, prompt: h.prompt, blocked: h.blocked, stopHookActive: h.stopHookActive, source: h.source
    });
  }

  spawn(agentId: string): void { this.apply(agentId, { type: 'spawn', at: this.now() }); }

  /** The process ended. Reported twice (once by the exit handler with the real code, once by teardown) it counts once. */
  exit(agentId: string, info: { exitCode?: number; signal?: number; tail?: string } = {}): void {
    const cur = this.map.get(agentId);
    if (cur && !cur.alive) return;
    if (!cur) this.map.set(agentId, newActivity(agentId, this.now()));
    this.apply(agentId, { type: 'exit', at: this.now(), ...info });
  }

  control(agentId: string, s: { paused: boolean; halted: boolean }): void {
    const cur = this.map.get(agentId);
    if (!cur && !s.paused && !s.halted) return; // nothing to record for an agent we have never heard of
    this.apply(agentId, { type: 'control', at: this.now(), paused: s.paused, halted: s.halted });
  }

  breaker(agentId: string, level: 'healthy' | 'steering' | 'constrained' | 'stopped', reason?: string): void {
    if (!this.map.has(agentId) && (level === 'healthy' || level === 'steering')) return;
    this.apply(agentId, { type: 'breaker', at: this.now(), level, reason });
  }

  /** Something was typed into this agent's terminal. */
  userInput(agentId: string, data: string): void {
    const cur = this.map.get(agentId);
    if (!cur?.pending) return; // only matters while a prompt is open
    this.apply(agentId, { type: 'user-input', at: this.now(), data });
  }

  /** Called on a timer with how long each terminal has been silent; ends turns that never announced their end. */
  quiet(agentId: string, quietMs: number): void {
    const cur = this.map.get(agentId);
    if (!cur?.turn.active || cur.pending) return;
    this.apply(agentId, { type: 'quiet', at: this.now(), quietMs });
  }

  /** The agent is gone for good (archived/killed and forgotten). */
  forget(agentId: string): void { this.map.delete(agentId); }
}
