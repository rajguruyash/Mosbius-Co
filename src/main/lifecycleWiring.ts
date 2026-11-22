/**
 * Where the activity tracker's signals become notifications.
 *
 * One function, so the mapping from "what the agent just did" to "what the person is told" is in one readable
 * place and can be tested without a window or a process. It adds nothing of its own: a signal either becomes
 * the notification the shared rules name for it, or closes the notification it resolves.
 */
import type { ActivitySignal, AgentActivity } from '../shared/agentActivity';
import { intentFromSignal, type AgentRef } from '../shared/notifications';
import type { NotificationService } from './notifyService';

export interface LifecyclePorts {
  notifications: NotificationService;
  /** Who this agent is (name, whether it is the orchestrator). */
  agentRef(agentId: string): AgentRef;
  now(): number;
}

export function handleSignals(ports: LifecyclePorts, agentId: string, signals: ActivitySignal[], _activity: AgentActivity): void {
  const agent = ports.agentRef(agentId);
  for (const s of signals) {
    if (s.kind === 'request-resolved') {
      ports.notifications.resolveByKey(`${agentId}|${s.requestId}`, {
        by: s.how === 'agent-exited' ? 'system' : 'agent', action: 'resolved', note: s.how
      });
      continue;
    }
    const intent = intentFromSignal(agent, s, ports.now());
    if (intent) ports.notifications.ingest(intent, agent.name);
    if (s.kind === 'breaker-cleared') {
      ports.notifications.resolveByKey(`${agentId}|breaker`, { by: 'system', action: 'resolved', note: 'breaker-cleared' });
    }
    if (s.kind === 'resumed') {
      // Pausing is the person's own act, so there is nothing to resolve, but an open "stopped" or "stuck" prompt
      // for an agent that is running again is no longer true.
      ports.notifications.resolveWhere((r) => r.agentId === agentId && r.category === 'intervention' && r.requestKey.includes('|stuck|'), { by: 'system', action: 'resolved', note: 'resumed' });
    }
    if (s.kind === 'started') {
      // A process that starts is a new life: whatever the old one was waiting on, or crashed with, is over.
      ports.notifications.resolveAgent(agentId, { by: 'system', action: 'resolved', note: 'restarted' });
      // and a soft pluck to say so. Not a notification (nothing is recorded); the service keeps it quiet, rare and below everything else.
      ports.notifications.cue('started');
    }
    if (s.kind === 'stopped' || s.kind === 'crashed') {
      // The prompts died with the process.
      ports.notifications.resolveAgent(agentId, { by: 'system', action: 'resolved', note: 'agent-exited' }, ['approval', 'input', 'access']);
    }
  }
}
