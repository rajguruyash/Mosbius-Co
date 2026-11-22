import { useEffect } from 'react';
import type { RosterAgent } from '@shared/huddle';
import i18n from '@/i18n';
import { restartAgentSession } from '@/agents/restartAgent';
import { setActivityStates } from '@/scene/office/activityStates';
import { useStore, type Agent } from '@/store/store';

/** The agent as the main process needs to know it: who it is and how it looks, never its output. */
export function toRosterAgent(a: Agent, queued: number): RosterAgent {
  return {
    id: a.id, name: a.name, character: a.character, accent: a.accent,
    ...(a.isGod ? { isGod: true } : {}),
    ...(a.isAssistant ? { isAssistant: true } : {}),
    ...(a.ptyId ? { ptyId: a.ptyId } : {}),
    ...(a.provider ? { provider: a.provider } : {}),
    ...(a.model ? { model: a.model } : {}),
    ...(a.description ? { description: a.description } : {}),
    ...(a.project ? { project: a.project } : {}),
    ...(a.cwd ? { cwd: a.cwd } : {}),
    status: a.status,
    ...(a.contextTokens !== undefined ? { contextTokens: a.contextTokens } : {}),
    ...(a.contextLimit !== undefined ? { contextLimit: a.contextLimit } : {}),
    queued,
    ...(a.archived ? { archived: true } : {})
  };
}

/**
 * The main window's half of the Huddle: it tells the main process who is on the floor (so the Huddle can show the same
 * names and faces), does what the main process asks of it (restart an agent, select one, open Settings), and says
 * which language the app is in (so a banner reads in it). It starts nothing and keeps no copy of any agent.
 */
export function useHuddleBridge(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let last = '';
    const publish = (): void => {
      timer = null;
      const { agents, messageQueues } = useStore.getState();
      const roster = agents.map((a) => toRosterAgent(a, messageQueues[a.id]?.length ?? 0));
      const json = JSON.stringify(roster);
      if (json === last) return; // nothing the Huddle shows has changed
      last = json;
      window.cth.huddlePublishRoster(roster);
    };
    publish();
    // the store changes on every streamed line; one report per quarter second is plenty
    const unsub = useStore.subscribe(() => { if (!timer) timer = setTimeout(publish, 250); });
    return () => { unsub(); if (timer) clearTimeout(timer); };
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return undefined;
    return window.cth.onHuddleCommand((c) => {
      const done = (result: { ok: boolean; error?: string }): void => { if (c.corr) void window.cth.huddleCommandDone(c.corr, result); };
      if (c.type === 'select' && c.agentId) {
        const { agents, select } = useStore.getState();
        if (agents.some((a) => a.id === c.agentId)) select(c.agentId);
        done({ ok: true });
      } else if (c.type === 'openSettings') {
        window.dispatchEvent(new CustomEvent('cth:open-settings', { detail: { section: c.section } }));
        done({ ok: true });
      } else if (c.type === 'restart' && c.agentId) {
        const a = useStore.getState().agents.find((x) => x.id === c.agentId);
        if (!a || !a.ptyId) { done({ ok: false, error: 'unknown-agent' }); return; }
        // The same steps as the Command Center's Restart & Continue: it picks the conversation up where it left off when it
        // has one, and starts a fresh one when it has none (a process that died at start has nothing to continue).
        void restartAgentSession(a, a.model, { resume: true, resumeOptional: true }).then(
          () => done({ ok: true }),
          (e) => done({ ok: false, error: e instanceof Error ? e.message : String(e) })
        );
      } else done({ ok: false, error: 'invalid-command' });
    });
  }, [enabled]);

  // What the main process says each agent is doing, for the floor's own symbols (see scene/office/activityStates.ts).
  useEffect(() => {
    if (!enabled) return undefined;
    const apply = (s: { agents: Array<{ id: string; state: Parameters<typeof setActivityStates>[0][number]['state'] }> }): void => setActivityStates(s.agents.map((a) => ({ id: a.id, state: a.state })));
    const off = window.cth.onHuddleState(apply);
    void window.cth.huddleState().then((s) => { if (s) apply(s); });
    return () => { off(); setActivityStates([]); };
  }, [enabled]);

  useEffect(() => {
    const report = (lng: string): void => window.cth.reportLanguage(lng);
    report(i18n.language);
    i18n.on('languageChanged', report);
    return () => { i18n.off('languageChanged', report); };
  }, []);
}
