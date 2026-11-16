import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MCP_CATALOG } from '@shared/mcpCatalog';
import type { AuditEventView } from '@shared/mcpAccess';
import { btn, card, chip, note, row } from './hubUi';

/** What was done, to what, by whom and whether it was allowed: the durable trail, newest first. Metadata only. */
const KINDS = ['mcp', 'rest', 'grant', 'consent', 'secret', 'engine', 'capability', 'integration', 'skill', 'system'];
const sel: React.CSSProperties = { padding: '2px 4px', fontSize: 11, color: 'var(--cth-ink-900)', background: 'var(--cth-cream-200)', border: 'none', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)' };

export function ActivityTab() {
  const { t } = useTranslation();
  const [events, setEvents] = useState<AuditEventView[]>([]);
  const [integration, setIntegration] = useState('');
  const [kind, setKind] = useState('');
  const [verdict, setVerdict] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const load = useCallback(async () => {
    try {
      const r = await window.cth.auditRecent({ limit: 200, ...(integration ? { integrationId: integration } : {}), ...(kind ? { kind } : {}) });
      if (r.ok && r.events) setEvents(r.events);
    } catch { /* shows less */ }
  }, [integration, kind]);
  useEffect(() => { void load(); }, [load]);

  const verify = async () => {
    const r = await window.cth.auditVerify();
    if (r.ok && r.result?.ok) setVerdict({ tone: 'ok', text: t('hub.activity.intact', { records: r.result.records, files: r.result.files }) });
    else if (r.ok && r.result && !r.result.ok) setVerdict({ tone: 'bad', text: t('hub.activity.broken', { file: r.result.file, line: r.result.line }) });
    else setVerdict({ tone: 'bad', text: t('hub.activity.cannotCheck') });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <span style={note}>{t('hub.activity.intro')}</span>
      <div style={row}>
        <select aria-label={t('hub.activity.integration')} style={sel} value={integration} onChange={(ev) => setIntegration(ev.target.value)}>
          <option value="">{t('hub.activity.all')}</option>
          {MCP_CATALOG.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}
        </select>
        <select aria-label={t('hub.activity.kind')} style={sel} value={kind} onChange={(ev) => setKind(ev.target.value)}>
          <option value="">{t('hub.activity.allKinds')}</option>
          {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
        <button type="button" style={btn()} onClick={() => { void load(); }}>{t('mcpAccess.activity.refresh')}</button>
        <button type="button" style={btn()} onClick={() => { void verify(); }}>{t('hub.activity.verify')}</button>
      </div>
      {verdict && <span style={{ fontSize: 12, color: verdict.tone === 'ok' ? 'var(--cth-mint-700)' : 'var(--cth-danger)' }} role="status">{verdict.text}</span>}
      {events.length === 0 && <span style={note}>{t('mcpAccess.activity.none')}</span>}
      <div style={{ ...card, maxHeight: 420, overflowY: 'auto', gap: 3 }}>
        {events.map((e) => (
          <div key={e.seq} style={{ ...row, flexWrap: 'nowrap', fontSize: 11, lineHeight: '16px', color: 'var(--cth-ink-700)' }}>
            <span style={{ flexShrink: 0, fontFamily: 'var(--cth-font-mono)' }} dir="ltr">{new Date(e.at).toLocaleString()}</span>
            <span style={{ flexShrink: 0 }}>{e.kind}</span>
            <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {[e.actor, e.integrationId, e.action].filter(Boolean).join(' · ')}{e.reason ? ` — ${e.reason}` : ''}
            </span>
            {e.decision && <span style={chip(e.decision === 'deny' ? 'bad' : 'ok')}>{t(e.decision === 'allow' ? 'mcpAccess.activity.allowed' : 'mcpAccess.activity.denied')}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}
