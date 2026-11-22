import { useCallback, useEffect, useMemo, useState } from 'react';
import './huddle-ui.css';
import { useTranslation } from 'react-i18next';
import type { HuddleAgentView, HuddleState } from '@shared/huddle';
import { useDirectionSync } from '@/i18n/useDirection';
import { AgentPanel } from './AgentPanel';
import { HuddleCharacter } from './HuddleCharacter';
import { NotificationCard, type Resolver } from './NotificationCard';
import { PrefsPanel } from './PrefsPanel';
import { activityText, agoText, queuedText } from './format';
import { useHuddleState, useNotifications, useNow } from './useHuddle';
import { watchTextFields } from './keyboard';

const resolver: Resolver = (req) => window.huddle.resolve(req);

function Progress({ agent }: { agent: HuddleAgentView }): JSX.Element | null {
  const { t } = useTranslation();
  const p = agent.progress;
  if (!p) return null;
  const pct = p.total > 0 ? Math.round((p.done / p.total) * 100) : 0;
  return (
    <div className="hd-progress" title={p.current}>
      <div className="hd-bar" role="progressbar" aria-valuemin={0} aria-valuemax={p.total} aria-valuenow={p.done}><span style={{ width: `${pct}%` }} /></div>
      <span className="hd-progress-text">{t(p.source === 'todos' ? 'huddle.progress.steps' : 'huddle.progress.tasks', { done: p.done, total: p.total })}</span>
    </div>
  );
}

/** A one-line answer to "why is this one asking for me": the category and what it said. */
function AttentionLine({ agent, notes }: { agent: HuddleAgentView; notes: Map<string, import('@shared/notifications').NotificationRecord> }): JSX.Element | null {
  const { t } = useTranslation();
  const first = agent.attention ? notes.get(agent.attention.ids[0]) : undefined;
  if (!agent.attention || !first) return null;
  const more = agent.attention.ids.length - 1;
  return (
    <div className={`hd-attn-line${agent.attention.critical ? ' hd-attn-critical' : ''}`}>
      <strong>{t(`huddle.notifications.category.${first.category}`)}</strong>
      {first.preview ? <span dir="auto"> · {first.preview}</span> : null}
      {more > 0 ? <span> · +{more}</span> : null}
    </div>
  );
}

function AgentCard({ agent, notes, single, detailed, onOpen, now }: {
  agent: HuddleAgentView; notes: Map<string, import('@shared/notifications').NotificationRecord>; single?: boolean; detailed?: boolean; onOpen: () => void; now: number;
}): JSX.Element {
  const { t, i18n } = useTranslation();
  const exists = (k: string): boolean => i18n.exists(k);
  const activity = activityText(t, exists, agent.activity);
  return (
    <button className={`hd-card hd-s-${agent.state}${single ? ' hd-card-single' : ''}${agent.attention ? ' hd-card-asking' : ''}${agent.lingerUntil ? ' hd-card-leaving' : ''}`} onClick={onOpen} data-agent={agent.id} data-state={agent.state} aria-label={`${agent.name}: ${t(`huddle.state.${agent.state}`)}. ${activity}`}>
      <HuddleCharacter character={agent.character} state={agent.state} asking={!!agent.attention} askingKey={agent.attention?.since ?? 0} critical={agent.attention?.critical} scale={single ? 3 : 2} />
      <div className="hd-card-main">
        <div className="hd-card-top">
          <span className="hd-name" title={agent.name}>{agent.name}</span>
          <span className={`hd-chip-state hd-s-${agent.state}`}>{t(`huddle.state.${agent.state}`)}</span>
        </div>
        <div className="hd-sub" title={activity} dir="auto">{activity}</div>
        <Progress agent={agent} />
        <AttentionLine agent={agent} notes={notes} />
        {(single || detailed) && (
          <div className="hd-meta">
            {agent.project && <span>{agent.project}</span>}
            {agent.model && <span>{agent.model.replace(/^claude-/, '')}</span>}
            {agent.contextPct !== undefined && <span>{t('huddle.progress.context', { pct: agent.contextPct })}</span>}
            {agent.queued > 0 && <span>{queuedText(t, agent.queued)}</span>}
            {agent.lingerUntil && <span>{agoText(t, now - agent.stateSince)}</span>}
          </div>
        )}
        {detailed && agent.tasks && agent.tasks.length > 0 && (
          <ul className="hd-tasks">
            {agent.tasks.slice(0, 3).map((task) => <li key={task.id} className={`hd-task hd-task-${task.status}`} dir="auto">{task.title}</li>)}
          </ul>
        )}
      </div>
    </button>
  );
}

type Panel = 'agents' | 'inbox' | 'prefs';

export function HuddleApp(): JSX.Element {
  useDirectionSync();
  const { t } = useTranslation();
  const state = useHuddleState();
  const snap = useNotifications();
  const now = useNow(10_000);
  const [panel, setPanel] = useState<Panel>('agents');

  const level = state?.mode.level ?? 'compact';
  const selected = state?.mode.selectedAgentId ?? null;
  const setLevel = useCallback((l: 'compact' | 'expanded' | 'agent', id?: string) => { void window.huddle.setLevel(l, id); }, []);

  // typing is the one thing that may take the keyboard; see keyboard.ts
  useEffect(() => watchTextFields(), []);

  // Escape goes up one level, as it does everywhere else in the app
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (level === 'agent') setLevel('expanded'); else if (level === 'expanded') { if (panel !== 'agents') setPanel('agents'); else setLevel('compact'); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [level, panel, setLevel]);

  const records = snap?.records ?? [];
  const byId = useMemo(() => new Map(records.map((r) => [r.id, r])), [records]);
  const open = records.filter((r) => r.actionRequired && !r.resolution).sort((a, b) => b.createdAt - a.createdAt);

  if (!state) return <div className="hd-root" />;
  const agents = state.agents;
  const sel = selected ? agents.find((a) => a.id === selected) : undefined;
  const pending = snap?.pending ?? open.length;
  const unread = snap?.unread ?? 0;

  return (
    <div className={`hd-root hd-level-${level}`} data-level={level} data-mode={state.mode.dock ?? 'free'}>
      <header className="hd-header">
        {level === 'agent' ? (
          <button className="hd-hbtn" data-act="back" onClick={() => setLevel('expanded')} aria-label={t('huddle.back')} title={t('huddle.back')}>←</button>
        ) : null}
        <h1 className="hd-title">{level === 'agent' && sel ? sel.name : t('huddle.titleCount', { count: state.counts.total })}</h1>
        <span className="hd-spacer" />
        <button className={`hd-hbtn hd-bell${pending > 0 ? ' hd-bell-pending' : ''}`} data-act="bell" onClick={() => { setPanel('inbox'); setLevel('expanded'); void window.huddle.markAllRead(); }}
          aria-label={`${t('huddle.notifications.bell')}${pending ? `: ${t('huddle.notifications.pending', { count: pending })}` : unread ? `: ${t('huddle.notifications.unread', { count: unread })}` : ''}`} title={t('huddle.notifications.bell')}>
          <span aria-hidden="true">🔔</span>
          {(pending > 0 || unread > 0) && <span className={`hd-badge${pending > 0 ? ' hd-badge-pending' : ''}`}>{pending > 0 ? pending : unread}</span>}
        </button>
        {level === 'compact'
          ? <button className="hd-hbtn" data-act="expand" onClick={() => { setPanel('agents'); setLevel('expanded'); }} aria-label={t('huddle.expand')} title={t('huddle.expand')}>⤢</button>
          : <button className="hd-hbtn" data-act="collapse" onClick={() => { setPanel('agents'); setLevel('compact'); }} aria-label={t('huddle.collapse')} title={t('huddle.collapse')}>⤡</button>}
        <button className="hd-hbtn hd-open-app" data-act="open-app" onClick={() => void window.huddle.exit()} aria-label={t('huddle.openApp')} title={t('huddle.openApp')}>
          <span aria-hidden="true">⇱</span>{level !== 'compact' && <span className="hd-open-app-text">{t('huddle.openAppShort')}</span>}
        </button>
      </header>

      {level === 'compact' && (
        <main className="hd-list" aria-label={t('huddle.title')}>
          {agents.length === 0 && (
            <div className="hd-empty">
              <div className="hd-empty-title">{t('huddle.empty.title')}</div>
              <div className="hd-muted">{t('huddle.empty.body')}</div>
              <button className="hd-btn" onClick={() => void window.huddle.exit()}>{t('huddle.empty.open')}</button>
            </div>
          )}
          {agents.map((a) => <AgentCard key={a.id} agent={a} notes={byId} single={agents.length === 1} onOpen={() => { setPanel('agents'); setLevel('expanded'); }} now={now} />)}
        </main>
      )}

      {level === 'expanded' && (
        <main className="hd-expanded">
          <div className="hd-tabs" role="tablist">
            <button role="tab" aria-selected={panel === 'agents'} className={`hd-tab${panel === 'agents' ? ' hd-tab-on' : ''}`} onClick={() => setPanel('agents')}>{t('huddle.sections.agents')}</button>
            <button role="tab" aria-selected={panel === 'inbox'} className={`hd-tab${panel === 'inbox' ? ' hd-tab-on' : ''}`} onClick={() => setPanel('inbox')}>{t('huddle.notifications.bell')}{pending > 0 ? ` (${pending})` : ''}</button>
            <button role="tab" aria-selected={panel === 'prefs'} className={`hd-tab${panel === 'prefs' ? ' hd-tab-on' : ''}`} onClick={() => setPanel('prefs')}>{t('huddle.settingsTab')}</button>
          </div>
          <div className="hd-scroll" role="tabpanel">
            {panel === 'agents' && (
              <>
                {open.length > 0 && (
                  <section aria-label={t('huddle.sections.needsYou')}>
                    <h2 className="hd-h2">{t('huddle.sections.needsYou')}</h2>
                    {open.map((n) => <NotificationCard key={n.id} rec={n} resolve={resolver} now={now} />)}
                  </section>
                )}
                <section aria-label={t('huddle.sections.agents')}>
                  <h2 className="hd-h2">{t('huddle.sections.agents')} · {agents.length}</h2>
                  {agents.length === 0 && <div className="hd-empty"><div className="hd-empty-title">{t('huddle.empty.title')}</div><div className="hd-muted">{t('huddle.empty.body')}</div></div>}
                  {agents.map((a) => <AgentCard key={a.id} agent={a} notes={byId} detailed onOpen={() => setLevel('agent', a.id)} now={now} />)}
                </section>
              </>
            )}
            {panel === 'inbox' && (
              <section>
                <div className="hd-row hd-row-between">
                  <span className="hd-muted">{records.length === 0 ? t('huddle.notifications.noneHistory') : open.length === 0 ? t('huddle.notifications.none') : t('huddle.notifications.pending', { count: open.length })}</span>
                  <span className="hd-row">
                    <button className="hd-btn hd-btn-ghost" disabled={unread === 0} onClick={() => void window.huddle.markAllRead()}>{t('huddle.notifications.markAllRead')}</button>
                    <button className="hd-btn hd-btn-ghost" disabled={records.length === 0} onClick={() => void window.huddle.clearNotifications()}>{t('huddle.notifications.clear')}</button>
                  </span>
                </div>
                {[...records].reverse().map((n) => <NotificationCard key={n.id} rec={n} resolve={resolver} now={now} />)}
              </section>
            )}
            {panel === 'prefs' && snap && (
              <PrefsPanel snapshot={snap} api={{
                setPrefs: (p) => window.huddle.setNotificationPrefs(p),
                test: () => window.huddle.testNotification(),
                openSystemSettings: () => window.huddle.openSystemNotificationSettings(),
                previewSound: (kind) => window.huddle.previewNotificationSound(kind)
              }} />
            )}
          </div>
        </main>
      )}

      {level === 'agent' && (
        sel
          ? <main className="hd-agent-wrap"><AgentPanel agent={sel} notes={records} resolve={resolver} now={now} /></main>
          : <main className="hd-expanded"><div className="hd-empty"><div className="hd-empty-title">{t('huddle.errors.unknown-agent')}</div><button className="hd-btn" onClick={() => setLevel('expanded')}>{t('huddle.back')}</button></div></main>
      )}
    </div>
  );
}

export type { HuddleState };
