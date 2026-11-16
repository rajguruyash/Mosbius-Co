import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { HarnessConfig } from '@/store/config';
import { MCP_CATALOG } from '@shared/mcpCatalog';
import type { McpGrantView, McpGrantsView, McpPreset } from '@shared/mcpAccess';
import { providerOfMcp } from '@shared/providers';
import { AGENT_COMPAT, agentKeyOf, compatOf } from '@shared/agentCompat';
import { card, entryState, label, note, type HubSnapshot } from './hubUi';

/**
 * Who may use what, in one table: a row for every integration that is on and connected, a column for "all
 * agents" and one for each agent. The default everywhere is NO access. A cell can only choose a preset
 * (none, read, read and write); a hand-picked list of tools, or an end time, is set under "Tools & access"
 * on the Connected tab, and shows here as "Custom".
 */
export interface AccessTabProps { config: HarnessConfig; snap: HubSnapshot; refresh: () => Promise<void> }

const PRESETS: McpPreset[] = ['none', 'read', 'write'];
const sel: React.CSSProperties = {
  width: '100%', minWidth: 84, padding: '2px 4px', fontSize: 11, color: 'var(--cth-ink-900)',
  background: 'var(--cth-cream-200)', border: 'none', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
};

export function AccessTab({ config, snap }: AccessTabProps) {
  const { t } = useTranslation();
  const [grants, setGrants] = useState<McpGrantsView>({});
  const [err, setErr] = useState('');
  const load = useCallback(async () => {
    try { const r = await window.cth.mcpGrantsGet(); if (r.ok && r.grants) setGrants(r.grants); } catch { /* the table shows less */ }
  }, []);
  useEffect(() => { void load(); }, [load, config.mcpDefaults]);

  const rows = MCP_CATALOG.filter((e) => config.mcpDefaults?.[e.id]?.enabled === true && entryState(e, snap) === 'connected'
    && !(e.spec.transport === 'bridge' && snap.secrets[e.id]?.engine !== 'broker'));
  const agents = snap.agents;

  const set = async (id: string, agentId: string | null, value: string) => {
    const grant: McpGrantView | null = value === 'inherit' ? null : { preset: value as McpPreset };
    const r = await window.cth.mcpGrantsSet({ id, agentId, grant });
    if (r.ok && r.grants) { setGrants(r.grants); setErr(''); } else setErr(t('mcpAccess.errors.generic'));
  };
  const cell = (g: McpGrantView | undefined, agent: boolean): { value: string; custom: boolean } => {
    if (!g) return { value: agent ? 'inherit' : 'none', custom: false };
    if (g.preset === 'custom' || g.allow?.length || g.deny?.length || g.expiresAt) return { value: 'custom', custom: true };
    return { value: g.preset, custom: false };
  };

  // What each CLI can do is shown whether or not anything is connected yet: the caveats (a shell that can read its pass,
  // a CLI that loads integrations only in trusted folders) are worth knowing BEFORE a person grants anything.
  const compat = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={label}>{t('hub.compat.title')}</span>
      {AGENT_COMPAT.map((c) => (
        <span key={c.agent} style={note}>
          <b>{c.label}</b> · {t(`hub.compat.status.${c.integrations}`)} · {t(`hub.compat.delivery.${c.delivery}`)}
          {' · '}{t(`hub.compat.shell.${c.capabilityHiddenFromShell}`)}
          {c.shellProtectionNeedsSandbox && <>{', '}{t('hub.compat.shellNeedsSandbox')}</>}
          {c.folderTrustRequired && <>{' · '}{t('hub.compat.folderTrust')}</>}
        </span>
      ))}
      <span style={note}>{t('hub.compat.legend')}</span>
    </div>
  );

  if (rows.length === 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <span style={note}>{t('hub.access.nothing')}</span>
        {compat}
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <span style={note}>{t('hub.access.intro')}</span>
      {agents.length === 0 && <span style={note}>{t('mcpAccess.agentsNone')}</span>}
      {err && <span style={{ fontSize: 12, color: 'var(--cth-danger)' }} role="alert">{err}</span>}
      <div style={{ ...card, overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead>
            <tr>
              <th style={{ ...label, textAlign: 'start', padding: '4px 6px' }} scope="col">{t('hub.access.integration')}</th>
              <th style={{ ...label, textAlign: 'start', padding: '4px 6px' }} scope="col">{t('mcpAccess.everyone')}</th>
              {agents.map((a) => {
                const c = compatOf(agentKeyOf(a.provider) ?? '');
                return (
                  <th key={a.id} style={{ ...label, textAlign: 'start', padding: '4px 6px', verticalAlign: 'top' }} scope="col">
                    {a.name}
                    <div style={{ ...note, textTransform: 'none', fontFamily: 'inherit' }}>
                      {c ? `${c.label} · ${t(`hub.compat.status.${c.integrations}`)}` : t('hub.compat.otherCli')}
                    </div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => {
              const unclassified = !e.spec || !('toolClasses' in e.spec) || !e.spec.toolClasses || Object.keys(e.spec.toolClasses).length === 0;
              const everyone = cell(grants.defaults?.[e.id], false);
              return (
                <tr key={e.id} style={{ borderBlockStart: '1px solid var(--cth-ink-300)' }}>
                  <th scope="row" style={{ textAlign: 'start', padding: '5px 6px', fontWeight: 600, fontSize: 12, color: 'var(--cth-ink-900)' }}>
                    {providerOfMcp(e.id)?.label ?? e.label}
                    {unclassified && !snap.trust[e.id] && <div style={note}>{t('hub.access.unclassified')}</div>}
                  </th>
                  <td style={{ padding: '4px 6px' }}>
                    <select aria-label={`${e.label} — ${t('mcpAccess.everyone')}`} style={sel} value={everyone.value} onChange={(ev) => { void set(e.id, null, ev.target.value); }}>
                      {PRESETS.map((p) => <option key={p} value={p}>{t(`mcpAccess.presets.${p}`)}</option>)}
                      {everyone.custom && <option value="custom" disabled>{t('mcpAccess.presets.custom')}</option>}
                    </select>
                  </td>
                  {agents.map((a) => {
                    const mine = cell(grants.agents?.[a.id]?.[e.id], true);
                    // Only the three CLIs the app wires get an entry. A grant for any other agent would do nothing,
                    // so the cell says so rather than offering a choice that has no effect.
                    if (!compatOf(agentKeyOf(a.provider) ?? '')) {
                      return <td key={a.id} style={{ padding: '4px 6px' }}><span style={note}>{t('hub.compat.notOffered')}</span></td>;
                    }
                    return (
                      <td key={a.id} style={{ padding: '4px 6px' }}>
                        <select aria-label={`${e.label} — ${a.name}`} style={sel} value={mine.value} onChange={(ev) => { void set(e.id, a.id, ev.target.value); }}>
                          <option value="inherit">{t('hub.access.inherit')}</option>
                          {PRESETS.map((p) => <option key={p} value={p}>{t(`mcpAccess.presets.${p}`)}</option>)}
                          {mine.custom && <option value="custom" disabled>{t('mcpAccess.presets.custom')}</option>}
                        </select>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <span style={note}>{t('hub.access.note')}</span>
      {compat}
    </div>
  );
}
