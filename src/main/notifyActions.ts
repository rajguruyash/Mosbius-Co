/**
 * Doing something about a notification: every button on one is wired to a real control here, and nothing else.
 *
 *  - approve / reject / alternative / option are answered in the agent's own terminal, with the keys in
 *    src/shared/promptKeys.ts, and only while the notification is still open (so a prompt that has already
 *    gone cannot receive a stray Enter);
 *  - answer writes the person's answer onto the hive task the question came from and tells the orchestrator,
 *    exactly as the ASK ME tab does;
 *  - open / settings / restart send the person to the agent, to Integrations & Skills (never a place to type a
 *    secret into a chat), or run Restart & Continue.
 *
 * Electron-free; the controls arrive as ports.
 */
import type { CommandResult } from '../shared/huddle';
import { KEY_APPROVE, KEY_GAP_MS, KEY_REJECT, optionKeySteps } from '../shared/promptKeys';
import type { NotificationAction } from '../shared/notifications';
import type { NotificationService } from './notifyService';

export type ResolveRequest =
  | { id: string; action: 'approve' }
  | { id: string; action: 'reject' }
  | { id: string; action: 'alternative'; text: string }
  | { id: string; action: 'option'; index: number }
  | { id: string; action: 'answer'; text: string }
  | { id: string; action: 'dismiss' }
  | { id: string; action: 'open' }
  | { id: string; action: 'settings' }
  | { id: string; action: 'restart' };

/** Check an untrusted payload (it came over IPC) and return a request, or null. */
export function validateResolve(raw: unknown): ResolveRequest | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !r.id || r.id.length > 100) return null;
  const id = r.id;
  switch (r.action) {
    case 'approve': case 'reject': case 'dismiss': case 'open': case 'settings': case 'restart':
      return { id, action: r.action };
    case 'alternative': case 'answer': {
      const text = typeof r.text === 'string' ? r.text.trim() : '';
      if (!text || text.length > 20_000) return null;
      return { id, action: r.action, text };
    }
    case 'option': {
      const index = typeof r.index === 'number' && Number.isInteger(r.index) ? r.index : -1;
      return index >= 0 && index < 20 ? { id, action: 'option', index } : null;
    }
    default: return null;
  }
}

export interface ActionPorts {
  notifications: NotificationService;
  ptyIdOf(agentId: string): string | undefined;
  ptyAlive(ptyId: string): boolean;
  ptyWrite(ptyId: string, data: string): { ok: boolean; error?: string };
  /** Wait between key presses (a port so tests need not). */
  pause?(ms: number): Promise<void>;
  /** Tell the activity tracker a person pressed these keys for this agent (so its prompt is known to be answered). */
  noteKeys?(agentId: string, keys: string): void;
  /** Queue a message for the agent (the same path as the composer). */
  sendMessage(agentId: string, text: string): Promise<CommandResult>;
  /** Write the person's answer onto a hive task's open question and tell the orchestrator. */
  answerTask(taskId: string, text: string): { ok: boolean; error?: string };
  openAgent(agentId: string): void;
  openSettings(section: string): void;
  restartAgent(agentId: string): Promise<CommandResult>;
}

const NEEDS_OPEN_RECORD: ReadonlySet<ResolveRequest['action']> = new Set(['approve', 'reject', 'alternative', 'option', 'answer']);

function allowed(actions: readonly NotificationAction[], a: ResolveRequest['action']): boolean {
  if (a === 'dismiss') return true;
  if (a === 'approve' || a === 'reject' || a === 'alternative' || a === 'option' || a === 'answer' || a === 'open' || a === 'settings' || a === 'restart') return actions.includes(a);
  return false;
}

export async function resolveNotification(ports: ActionPorts, req: ResolveRequest): Promise<CommandResult> {
  const svc = ports.notifications;
  const record = svc.get(req.id);
  if (!record) return { ok: false, error: 'unknown-notification' };
  if (!allowed(record.actions, req.action)) return { ok: false, error: 'not-offered' };
  if (NEEDS_OPEN_RECORD.has(req.action) && record.resolution) return { ok: false, error: 'already-resolved' };

  const answerInTerminal = async (keys: string | string[]): Promise<CommandResult> => {
    const ptyId = ports.ptyIdOf(record.agentId);
    if (!ptyId || !ports.ptyAlive(ptyId)) return { ok: false, error: 'not-running' };
    const steps = Array.isArray(keys) ? keys : [keys];
    for (let i = 0; i < steps.length; i++) {
      // the terminal must still be there for every press: a menu can close between keys
      if (i > 0) { await (ports.pause ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))))(KEY_GAP_MS); if (!ports.ptyAlive(ptyId)) return { ok: false, error: 'not-running' }; }
      const w = ports.ptyWrite(ptyId, steps[i]);
      if (!w.ok) return { ok: false, error: w.error ?? 'write-failed' };
    }
    return { ok: true };
  };

  switch (req.action) {
    case 'approve': {
      const r = await answerInTerminal(KEY_APPROVE);
      if (r.ok) { svc.resolve(record.id, { by: 'user', action: 'approved' }); ports.noteKeys?.(record.agentId, KEY_APPROVE); }
      return r;
    }
    case 'reject': {
      const r = await answerInTerminal(KEY_REJECT);
      if (r.ok) { svc.resolve(record.id, { by: 'user', action: 'rejected' }); ports.noteKeys?.(record.agentId, KEY_REJECT); }
      return r;
    }
    case 'alternative': {
      // Say no first, then tell it what to do instead; the message waits in the agent's queue until it is free.
      const no = await answerInTerminal(KEY_REJECT);
      if (!no.ok) return no;
      const sent = await ports.sendMessage(record.agentId, req.text);
      svc.resolve(record.id, { by: 'user', action: 'alternative', note: sent.ok ? 'sent' : sent.error });
      ports.noteKeys?.(record.agentId, KEY_REJECT);
      return sent.ok ? { ok: true, queued: true } : { ok: true, error: sent.error };
    }
    case 'option': {
      const count = record.options?.length ?? 0;
      if (req.index >= count) return { ok: false, error: 'no-such-option' };
      const keys = optionKeySteps(req.index);
      const r = await answerInTerminal(keys);
      if (r.ok) { svc.resolve(record.id, { by: 'user', action: 'option', note: record.options?.[req.index] }); ports.noteKeys?.(record.agentId, keys[keys.length - 1]); }
      return r;
    }
    case 'answer': {
      if (!record.taskId) return { ok: false, error: 'no-task' };
      const r = ports.answerTask(record.taskId, req.text);
      if (r.ok) svc.resolve(record.id, { by: 'user', action: 'answered' });
      return r;
    }
    case 'dismiss': { svc.dismiss(record.id); return { ok: true }; }
    case 'open': { svc.markRead(record.id); ports.openAgent(record.agentId); return { ok: true }; }
    case 'settings': { svc.markRead(record.id); ports.openSettings('Integrations & Skills'); return { ok: true }; }
    case 'restart': {
      const r = await ports.restartAgent(record.agentId);
      if (r.ok) svc.resolve(record.id, { by: 'user', action: 'resolved', note: 'restarted' });
      return r;
    }
  }
}
