import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { HarnessConfig } from '@/store/config';
import { MCP_CATALOG } from '@shared/mcpCatalog';
import { PROVIDERS, type ProviderCategory, type ProviderManifest } from '@shared/providers';
import { ConnectPanel } from './ConnectPanel';
import { btn, card, catalogEntriesOf, chip, field, note, providerState, row, type HubSnapshot } from './hubUi';

const CATEGORIES: ProviderCategory[] = ['knowledge', 'work', 'dev', 'comms', 'payments', 'search', 'crm', 'local', 'custom', 'ai'];

export interface DiscoverTabProps {
  config: HarnessConfig;
  snap: HubSnapshot;
  refresh: () => Promise<void>;
  go: (to: 'rest' | 'ai-engines') => void;
  /** Open this provider's panel straight away (a Reconnect from the Connected tab). */
  open?: string | null;
}

export function DiscoverTab({ config, snap, refresh, go, open }: DiscoverTabProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [cat, setCat] = useState<ProviderCategory | 'all'>('all');
  const [expanded, setExpanded] = useState<string | null>(open ?? null);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return PROVIDERS.filter((p) => (cat === 'all' || p.category === cat)
      && (!q || p.label.toLowerCase().includes(q) || p.id.includes(q) || t(`hub.providers.${p.id}`, { defaultValue: '' }).toLowerCase().includes(q)));
  }, [query, cat, t]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: PROVIDERS.length };
    for (const p of PROVIDERS) c[p.category] = (c[p.category] ?? 0) + 1;
    return c;
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={row}>
        <input type="search" value={query} onChange={(ev) => setQuery(ev.target.value)} placeholder={t('hub.searchPlaceholder')} aria-label={t('hub.search')} style={{ ...field, fontFamily: 'inherit', fontSize: 12, padding: '5px 8px' }} />
      </div>
      <div style={row} role="group" aria-label={t('hub.categories')}>
        {(['all', ...CATEGORIES] as const).filter((c) => c === 'all' || counts[c]).map((c) => (
          <button key={c} type="button" style={btn(cat === c)} aria-pressed={cat === c} onClick={() => setCat(c)}>
            {t(`hub.cat.${c}`)} {counts[c]}
          </button>
        ))}
      </div>
      {shown.length === 0 && <span style={note}>{t('hub.noMatch')}</span>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 8 }}>
        {shown.map((p) => <ProviderCard key={p.id} p={p} config={config} snap={snap} refresh={refresh} go={go} open={expanded === p.id} toggle={() => setExpanded(expanded === p.id ? null : p.id)} />)}
      </div>
    </div>
  );
}

function ProviderCard({ p, config, snap, refresh, go, open, toggle }: {
  p: ProviderManifest; config: HarnessConfig; snap: HubSnapshot; refresh: () => Promise<void>;
  go: (to: 'rest' | 'ai-engines') => void; open: boolean; toggle: () => void;
}) {
  const { t } = useTranslation();
  const entries = catalogEntriesOf(p, MCP_CATALOG);
  const state = providerState(entries, snap);
  const v = p.verification;
  const connected = state === 'connected';
  const actionable = p.ways.length > 0;
  return (
    <div style={{ ...card, boxShadow: `inset 0 0 0 1px ${connected ? 'var(--cth-ink-900)' : 'var(--cth-ink-300)'}` }} data-provider={p.id}>
      <div style={{ ...row, justifyContent: 'space-between', flexWrap: 'nowrap' }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--cth-ink-900)', minWidth: 0 }}>{p.label}</span>
        {v.status !== 'na' && (
          <span style={chip(v.status === 'verified' ? 'ok' : v.status === 'limited' ? 'warn' : 'quiet')} title={v.note}>{t(`hub.verify.${v.status}`)}</span>
        )}
      </div>
      <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-700)' }}>{t(`hub.providers.${p.id}`, { defaultValue: '' })}</span>
      <div style={row}>
        <span style={chip()}>{t(`hub.cat.${p.category}`)}</span>
        {p.ways.slice(0, 3).map((w) => <span key={w} style={chip()}>{t(`hub.wayShort.${w}`)}</span>)}
        {connected && <span style={chip('ok')}>{t('hub.status.connected')}</span>}
        {state === 'needs-signin' && <span style={chip('bad')}>{t('hub.status.needsSignin')}</span>}
        {state === 'unavailable' && <span style={chip('bad')}>{t('hub.status.unavailable')}</span>}
      </div>
      {v.status === 'untested' && <span style={note}>{t('hub.verify.untestedHelp')}</span>}
      {v.status === 'limited' && <span style={note}>{t('hub.verify.limitedHelp')}</span>}
      {actionable && (
        <div style={row}>
          <button type="button" style={btn(open)} aria-expanded={open} onClick={toggle}>
            {open ? t('hub.card.close') : connected ? t('hub.card.manage') : p.ways[0] === 'local' ? t('hub.card.turnOn') : t('hub.card.connect')}
          </button>
        </div>
      )}
      {!actionable && <span style={note}>{t('hub.planned')}</span>}
      {open && actionable && <div style={{ borderBlockStart: '1px solid var(--cth-ink-300)', paddingBlockStart: 8 }}><ConnectPanel provider={p} config={config} snap={snap} refresh={refresh} go={go} /></div>}
    </div>
  );
}
