/**
 * What the office floor knows about an agent beyond the status the renderer's own store holds: the answer the main
 * process gives to "does this one need a person?" (the same one the Huddle shows). Kept as a small subscribable map
 * rather than a new field on the agent, because the agent record is persisted and this is a live fact about a
 * running process that must never be written down.
 *
 * The floor already had one way to say "needs you" (the red "!" and the walk to the door, for the orchestrator). This
 * extends it, compatibly, to the states it had no symbol for: a question (?), an error (x) and a pause (||); and it
 * lets any agent, not only the orchestrator, ask.
 */
import type { AgentState } from '@shared/agentActivity';

export type FloorAttention = 'input' | 'approval' | 'error' | 'paused';

/** The floor's symbol for each state, or null for the ones it already draws (working, idle, completed, …). */
export function floorAttention(state: AgentState | undefined): FloorAttention | null {
  switch (state) {
    case 'needs-input': return 'input';
    case 'needs-approval': return 'approval';
    case 'error': return 'error';
    case 'paused': return 'paused';
    default: return null;
  }
}

export type FloorGlyph = 'blocked' | 'question' | 'error' | 'paused';

/** Which of the floor's overlay glyphs says it. Approval keeps the existing red "!" — that is what "needs you" always meant here. */
export function glyphFor(att: FloorAttention): FloorGlyph {
  return att === 'input' ? 'question' : att === 'error' ? 'error' : att === 'paused' ? 'paused' : 'blocked';
}

/** Does this one walk to the door like an agent waiting on the human? Only the ones that need a person's decision do. */
export function walksToDoor(att: FloorAttention | null): boolean {
  return att === 'input' || att === 'approval';
}

const states = new Map<string, AgentState>();
const listeners = new Set<() => void>();

export function activityStateOf(agentId: string): AgentState | undefined { return states.get(agentId); }

/** Replace what is known (called with every update from the main process). Listeners run only if something changed. */
export function setActivityStates(next: ReadonlyArray<{ id: string; state: AgentState }>): void {
  let changed = next.length !== states.size;
  const seen = new Set<string>();
  for (const { id, state } of next) {
    seen.add(id);
    if (states.get(id) !== state) { states.set(id, state); changed = true; }
  }
  for (const id of [...states.keys()]) if (!seen.has(id)) { states.delete(id); changed = true; }
  if (changed) for (const fn of [...listeners]) { try { fn(); } catch { /* a listener must not break the others */ } }
}

export function onActivityStates(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
