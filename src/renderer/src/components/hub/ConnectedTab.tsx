import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { HarnessConfig } from '@/store/config';
import { MCP_CATALOG, mcpNeedsOauthClient, type McpCatalogEntry } from '@shared/mcpCatalog';
import { providerOfMcp } from '@shared/providers';
import { IntegrationsRegistry } from '../IntegrationsRegistry';
import { McpAccessSection } from '../McpAccessSection';
import { btn, card, chip, entryState, label, note, row, type HubSnapshot } from './hubUi';

export interface ConnectedTabProps {
  config: HarnessConfig;
  snap: HubSnapshot;
  refresh: () => Promise<void>;
  /** Reconnect: open this provider on the Discover tab. */
  reconnect: (providerId: string) => void;
}

export function ConnectedTab({ config, snap, refresh, reconnect }: ConnectedTabProps) {
  const { t } = useTranslation();
  const [msg, setMsg] = useState<string>('');
  const [openAccess, setOpenAccess] = useState<string | null>(null);

  // every catalogue entry that is switched on, or holds a credential, or is signed in. An entry that merely COULD be
  // used (a local server that needs no account) is not "connected" until the person turns it on.
  const active = MCP_CATALOG.filter((e) => {
    if (config.mcpDefaults?.[e.id]?.enabled === true) return true;
    const st = entryState(e, snap);
    return st === 'connected' || st === 'needs-signin' || st === 'unavailable';
  });
  const flash = (text: string) => { setMsg(text); setTimeout(() => setMsg(''), 9000); };

  const setConsent = async (e: McpCatalogEntry, on: boolean) => {
    await window.cth.updateConfig({ mcpDefaults: { ...(config.mcpDefaults ?? {}), [e.id]: { enabled: on } } });
    await refresh();
  };
  const disconnect = async (e: McpCatalogEntry) => {
    const provider = providerOfMcp(e.id)?.label ?? e.label;
    if (e.spec.transport === 'http' && e.spec.connect && snap.connections[e.id] && snap.connections[e.id].status !== 'signed-out') {
      const r = await window.cth.connectDisconnect(e.id);
      if (!r.ok) flash(t('hub.connected.couldNotDisconnect', { label: provider }));
      else if (r.endAtProvider) flash(t('hub.connected.disconnectedEnd', { label: provider }));
      else flash(t('hub.connected.disconnected', { label: provider }));
    } else if (mcpNeedsOauthClient(e)) {
      const r = await window.cth.mcpDisconnect(e.id);
      flash(r.ok ? t(r.revoked ? 'mcpDefaults.disconnected' : 'mcpDefaults.disconnectedLocal', { label: provider }) : t('hub.connected.couldNotDisconnect', { label: provider }));
    } else {
      const r = await window.cth.mcpClearSecret(e.id);
      flash(r.ok ? t('mcpDefaults.forgot', { label: provider }) : t('hub.connected.couldNotDisconnect', { label: provider }));
    }
    await refresh();
  };
  const setTrust = async (e: McpCatalogEntry, trust: boolean) => {
    await window.cth.mcpTrustHintsSet({ id: e.id, trust });
    await refresh();
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {active.length === 0 && <span style={note}>{t('hub.connected.empty')}</span>}
      {msg && <span style={{ fontSize: 12, color: 'var(--cth-mint-700)' }} role="status">{msg}</span>}
      {active.map((e) => {
        const st = entryState(e, snap);
        const on = config.mcpDefaults?.[e.id]?.enabled === true;
        const c = snap.connections[e.id];
        const provider = providerOfMcp(e.id);
        const credentialed = st === 'connected' || st === 'needs-signin' || st === 'unavailable' || (e.spec.transport !== undefined && e.spec.transport !== 'stdio');
        const local = e.spec.transport === undefined || e.spec.transport === 'stdio';
        return (
          <div key={e.id} style={card} data-entry={e.id}>
            <div style={{ ...row, justifyContent: 'space-between' }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--cth-ink-900)' }}>{e.label}</span>
              <div style={row}>
                {st === 'connected' && <span style={chip('ok')}>{t('hub.status.connected')}</span>}
                {st === 'needs-signin' && <span style={chip('bad')}>{t('hub.status.needsSignin')}</span>}
                {st === 'unavailable' && <span style={chip('bad')}>{t('hub.status.unavailable')}</span>}
                {(st === 'not-connected' || st === 'ready') && <span style={chip()}>{t('hub.status.notConnected')}</span>}
                <button type="button" style={btn(on)} aria-pressed={on} onClick={() => { void setConsent(e, !on); }}>{on ? t('common.on') : t('common.off')}</button>
              </div>
            </div>
            {c?.connectedAt && <span style={note}>{t('hub.connected.since', { date: new Date(c.connectedAt).toLocaleDateString() })}{c.method ? ` · ${t(`hub.method.${c.method}`)}` : ''}</span>}
            {c?.scope && <span style={note}>{t('hub.connected.scope', { scope: c.scope })}</span>}
            {c?.expiresAt && <span style={note}>{t('hub.connected.renews')}</span>}
            {!on && st === 'connected' && <span style={note}>{t('hub.connected.offNote')}</span>}
            <div style={row}>
              {!local && (
                <button type="button" style={btn(openAccess === e.id)} aria-expanded={openAccess === e.id} onClick={() => setOpenAccess(openAccess === e.id ? null : e.id)}>
                  {t('hub.connected.tools')}
                </button>
              )}
              {st === 'needs-signin' && provider && <button type="button" style={btn()} onClick={() => reconnect(provider.id)}>{t('hub.card.reconnect')}</button>}
              {credentialed && !local && <button type="button" style={btn()} onClick={() => { void disconnect(e); }}>{t(mcpNeedsOauthClient(e) || c ? 'mcpDefaults.disconnect' : 'mcpDefaults.forget')}</button>}
              {provider && provider.label !== e.label && <span style={note}>{provider.label}</span>}
            </div>
            {!local && openAccess === e.id && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {on && st === 'connected' ? <McpAccessSection entry={e} /> : <span style={note}>{t('hub.connected.needOnAndConnected')}</span>}
                <label style={{ ...row, alignItems: 'flex-start', gap: 8, cursor: 'pointer' }}>
                  <input type="checkbox" checked={snap.trust[e.id] === true} onChange={(ev) => { void setTrust(e, ev.target.checked); }} />
                  <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                    <span style={{ fontSize: 12, color: 'var(--cth-ink-900)' }}>{t('hub.trust.title')}</span>
                    <span style={note}>{t('hub.trust.help')}</span>
                  </span>
                </label>
              </div>
            )}
          </div>
        );
      })}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }} id="hub-rest">
        <span style={label}>{t('hub.rest.title')}</span>
        <span style={note}>{t('hub.rest.intro')}</span>
        <IntegrationsRegistry />
      </div>
    </div>
  );
}
