import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { HarnessConfig } from '@/store/config';
import { MCP_CATALOG } from '@shared/mcpCatalog';
import { useRtl } from '@/i18n/useDirection';
import { useHubData } from './useHubData';
import { DiscoverTab } from './DiscoverTab';
import { ConnectedTab } from './ConnectedTab';
import { SkillsHubTab } from './SkillsHubTab';
import { AccessTab } from './AccessTab';
import { ActivityTab } from './ActivityTab';
import { btn, entryState, label, note } from './hubUi';

/**
 * Settings → Integrations & Skills.
 *
 *   Discover      every service the app can reach, how each is connected, and a Connect button
 *   Connected     what is connected, on or off, which tools each may use, and Disconnect
 *   Skills        what is installed for which agent, where it came from, updates, the way back
 *   Agent access  who may use what: one table, "no access" by default
 *   Activity      what was done, to what, by whom, and whether it was allowed
 *
 * Everything here is opt-in: nothing is on, connected, installed or reachable by an agent until a person turns
 * it on. The page holds statuses and names only; it is never handed a credential.
 */
const TABS = ['discover', 'connected', 'skills', 'access', 'activity'] as const;
type Tab = (typeof TABS)[number];

export interface IntegrationsHubProps {
  config: HarnessConfig;
  /** Leave the hub for another part of Settings (the AI engines, or the REST connections). */
  goSection: (to: 'Connections' | 'Agents & Models') => void;
}

export function IntegrationsHub({ config, goSection }: IntegrationsHubProps) {
  const { t } = useTranslation();
  const rtl = useRtl();
  const { snap, refresh, loaded } = useHubData(config);
  const [tab, setTab] = useState<Tab>('discover');
  const [open, setOpen] = useState<string | null>(null);
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [scrollTo, setScrollTo] = useState<string | null>(null);

  const choose = useCallback((next: Tab, provider: string | null = null) => { setOpen(provider); setTab(next); }, []);

  // arrow keys move between tabs the way the reading direction goes; Home and End go to the ends
  const onKey = (ev: React.KeyboardEvent, i: number) => {
    const forward = rtl ? 'ArrowLeft' : 'ArrowRight';
    const back = rtl ? 'ArrowRight' : 'ArrowLeft';
    let next = i;
    if (ev.key === forward) next = (i + 1) % TABS.length;
    else if (ev.key === back) next = (i + TABS.length - 1) % TABS.length;
    else if (ev.key === 'Home') next = 0;
    else if (ev.key === 'End') next = TABS.length - 1;
    else return;
    ev.preventDefault();
    choose(TABS[next]);
    refs.current[TABS[next]]?.focus();
  };

  const go = useCallback((to: 'rest' | 'ai-engines') => {
    if (to === 'ai-engines') { goSection('Agents & Models'); return; }
    choose('connected');
    setScrollTo('hub-rest');
  }, [choose, goSection]);
  useEffect(() => {
    if (!scrollTo || tab !== 'connected') return;
    const timer = setTimeout(() => { document.getElementById(scrollTo)?.scrollIntoView({ block: 'start' }); setScrollTo(null); }, 60);
    return () => clearTimeout(timer);
  }, [scrollTo, tab]);

  const connectedCount = MCP_CATALOG.filter((e) => entryState(e, snap) === 'connected').length;
  const attention = MCP_CATALOG.filter((e) => entryState(e, snap) === 'needs-signin').length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }} data-hub>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={label} role="heading" aria-level={2}>{t('hub.title')}</span>
        <span style={note}>{t('hub.intro')}</span>
        <span style={note}>{t('hub.flow')}</span>
        {attention > 0 && <span style={{ fontSize: 12, color: 'var(--cth-danger)' }} role="status">{t('hub.attention', { count: attention })}</span>}
      </div>

      <div role="tablist" aria-label={t('hub.title')} style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {TABS.map((id, i) => (
          <button
            key={id} type="button" role="tab" id={`hub-tab-${id}`} aria-selected={tab === id} aria-controls={`hub-panel-${id}`}
            tabIndex={tab === id ? 0 : -1} ref={(el) => { refs.current[id] = el; }}
            style={btn(tab === id)} onClick={() => choose(id)} onKeyDown={(ev) => onKey(ev, i)}
          >
            {t(`hub.tabs.${id}`)}{id === 'connected' && connectedCount > 0 ? ` ${connectedCount}` : ''}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`hub-panel-${tab}`} aria-labelledby={`hub-tab-${tab}`} tabIndex={0} style={{ outline: 'none' }}>
        {!loaded && tab !== 'activity' && tab !== 'skills' && <span style={note}>{t('hub.loading')}</span>}
        {tab === 'discover' && <DiscoverTab config={config} snap={snap} refresh={refresh} go={go} open={open} />}
        {tab === 'connected' && <ConnectedTab config={config} snap={snap} refresh={refresh} reconnect={(id) => choose('discover', id)} />}
        {tab === 'skills' && <SkillsHubTab snap={snap} openProvider={(id) => choose('discover', id)} />}
        {tab === 'access' && <AccessTab config={config} snap={snap} refresh={refresh} />}
        {tab === 'activity' && <ActivityTab />}
      </div>
    </div>
  );
}
