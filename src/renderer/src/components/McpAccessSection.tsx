import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { McpActivityEvent, McpGrantView, McpGrantsView, McpPreset, McpToolEntry } from '@shared/mcpAccess';
import type { McpCatalogEntry } from '@shared/mcpCatalog';

/**
 * Who may use an integration, and which of its tools. Shown for an integration that signs
 * in with the in-app engine once it is signed in.
 *
 * Nothing here ever holds a token, a client secret or a capability: the main process sends
 * names, classes, descriptions and metadata, and takes back a preset, tool names and an end
 * time. The default is NO access; every change is validated in main again.
 */

const PRESETS: McpPreset[] = ['none', 'read', 'write', 'custom'];
const HOUR = 3_600_000;

const label: React.CSSProperties = {
  fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
  color: 'var(--cth-ink-500)', textTransform: 'uppercase'
};
const btn = (on: boolean): React.CSSProperties => ({
  padding: '3px 8px 1px', border: 'none', cursor: 'pointer', textTransform: 'uppercase',
  fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '14px', color: 'var(--cth-ink-900)',
  background: on ? 'var(--cth-lemon)' : 'var(--cth-cream-200)',
  boxShadow: `inset 0 0 0 1px ${on ? 'var(--cth-ink-900)' : 'var(--cth-ink-700)'}`
});
const note: React.CSSProperties = { fontSize: 11, lineHeight: '15px', color: 'var(--cth-ink-500)' };
const box: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 6, padding: '7px 10px',
  background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
};

interface EditorProps {
  grant: McpGrantView | undefined;
  tools: McpToolEntry[];
  onChange: (next: McpGrantView) => void;
}

/** One grant: a preset, how long it lasts, and the tools named on top of it (or instead of it). */
function GrantEditor({ grant, tools, onChange }: EditorProps) {
  const { t } = useTranslation();
  const preset: McpPreset = grant?.preset ?? 'none';
  const allow = grant?.allow ?? [];
  const deny = grant?.deny ?? [];
  const expiring = grant?.expiresAt !== undefined && grant.expiresAt > Date.now();

  const set = (patch: Partial<McpGrantView>) => {
    const next: McpGrantView = { preset, ...(allow.length ? { allow } : {}), ...(deny.length ? { deny } : {}),
      ...(grant?.expiresAt !== undefined ? { expiresAt: grant.expiresAt } : {}), ...patch };
    if (next.allow && next.allow.length === 0) delete next.allow;
    if (next.deny && next.deny.length === 0) delete next.deny;
    if (next.expiresAt === undefined) delete next.expiresAt;
    onChange(next);
  };

  const toggleAllow = (tool: McpToolEntry) => {
    const on = allow.includes(tool.name);
    if (!on && tool.class === 'destructive' && !window.confirm(t('mcpAccess.confirmDestructive', { tool: tool.name }))) return;
    set({
      allow: on ? allow.filter((n) => n !== tool.name) : [...allow, tool.name],
      deny: deny.filter((n) => n !== tool.name),
      // naming a tool on a preset of "none" has to turn something on
      preset: preset === 'none' && !on ? 'custom' : preset
    });
  };
  const toggleDeny = (tool: McpToolEntry) => {
    const on = deny.includes(tool.name);
    set({ deny: on ? deny.filter((n) => n !== tool.name) : [...deny, tool.name], allow: allow.filter((n) => n !== tool.name) });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
        {PRESETS.map((p) => (
          <button key={p} type="button" style={btn(preset === p)} onClick={() => set({ preset: p, ...(p === 'none' ? { allow: [], deny: [], expiresAt: undefined } : {}) })}>
            {t(`mcpAccess.presets.${p}`)}
          </button>
        ))}
        {preset !== 'none' && (
          <select
            aria-label={t('mcpAccess.expiry.label')}
            value={expiring ? 'until' : 'never'}
            onChange={(ev) => {
              const v = ev.target.value;
              set({ expiresAt: v === 'hour' ? Date.now() + HOUR : v === 'day' ? Date.now() + 24 * HOUR : undefined });
            }}
            style={{ fontSize: 11, background: 'var(--cth-cream-200)', border: 'none', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)' }}
          >
            <option value="never">{t('mcpAccess.expiry.never')}</option>
            <option value="hour">{t('mcpAccess.expiry.hour')}</option>
            <option value="day">{t('mcpAccess.expiry.day')}</option>
            {expiring && <option value="until">{t('mcpAccess.expiry.until', { time: new Date(grant!.expiresAt!).toLocaleString() })}</option>}
          </select>
        )}
      </div>
      <span style={note}>{t(`mcpAccess.presetNote.${preset}`)}</span>
      {tools.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 220, overflowY: 'auto' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '48px 48px 1fr', gap: 6, ...label }}>
            <span>{t('mcpAccess.tools.allow')}</span><span>{t('mcpAccess.tools.block')}</span><span>{t('mcpAccess.tools.title')}</span>
          </div>
          {tools.map((tool) => (
            <div key={tool.name} style={{ display: 'grid', gridTemplateColumns: '48px 48px 1fr', gap: 6, alignItems: 'start' }}>
              <input type="checkbox" checked={allow.includes(tool.name)} onChange={() => toggleAllow(tool)} aria-label={`${t('mcpAccess.tools.allow')} ${tool.name}`} />
              <input type="checkbox" checked={deny.includes(tool.name)} onChange={() => toggleDeny(tool)} aria-label={`${t('mcpAccess.tools.block')} ${tool.name}`} />
              <span style={{ fontSize: 11, lineHeight: '15px', color: 'var(--cth-ink-900)', wordBreak: 'break-word' }}>
                <code style={{ fontFamily: 'var(--cth-font-mono)' }}>{tool.name}</code>{' '}
                <span style={{ color: tool.class === 'destructive' ? '#6E1423' : 'var(--cth-ink-500)' }}>
                  [{t(`mcpAccess.class.${tool.class}`)}]
                </span>
                {tool.description && <span style={{ display: 'block', color: 'var(--cth-ink-500)' }}>{tool.description}</span>}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export interface McpAccessSectionProps { entry: McpCatalogEntry }

export function McpAccessSection({ entry }: McpAccessSectionProps) {
  const { t } = useTranslation();
  const id = entry.id;
  const [grants, setGrants] = useState<McpGrantsView>({});
  const [tools, setTools] = useState<McpToolEntry[]>([]);
  const [events, setEvents] = useState<McpActivityEvent[]>([]);
  const [agents, setAgents] = useState<Array<{ id: string; name: string }>>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const say = (text: string) => { setMsg(text); setTimeout(() => setMsg(''), 6000); };

  const errorText = (code?: string): string => t(`mcpAccess.errors.${code && ['forbidden', 'sign_in_required', 'disabled', 'unavailable', 'upstream', 'unknown'].includes(code) ? code : 'generic'}`);

  const reload = useCallback(async () => {
    try {
      const [g, tl, ac, reg] = await Promise.all([
        window.cth.mcpGrantsGet(), window.cth.mcpToolsList(id), window.cth.mcpActivity(id), window.cth.hiveRegistry().catch(() => null)
      ]);
      if (g.ok && g.grants) setGrants(g.grants);
      if (tl.ok && tl.tools) setTools(tl.tools);
      if (ac.ok && ac.events) setEvents(ac.events);
      if (reg?.agents) {
        setAgents(Object.entries(reg.agents).filter(([, a]) => !a.archived).map(([aid, a]) => ({ id: aid, name: a.name || aid })));
      }
    } catch { /* the panel still works; it just shows less */ }
  }, [id]);
  useEffect(() => { void reload(); }, [reload]);

  const send = async (agentId: string | null, grant: McpGrantView | null) => {
    const res = await window.cth.mcpGrantsSet({ id, agentId, grant });
    if (res.ok && res.grants) setGrants(res.grants); else say(errorText(res.error));
  };

  const loadTools = async () => {
    setBusy(true);
    try {
      const res = await window.cth.mcpToolsRefresh(id);
      if (res.ok && res.tools) setTools(res.tools); else say(errorText(res.error));
    } finally { setBusy(false); }
  };

  const defaultGrant = grants.defaults?.[id];
  const overrides = grants.agents ?? {};
  // every agent we know of, plus any id that has an entry of its own but is no longer on the floor
  const rows = useMemo(() => {
    const known = new Map(agents.map((a) => [a.id, a.name]));
    for (const aid of Object.keys(overrides)) if (overrides[aid]?.[id] && !known.has(aid)) known.set(aid, aid);
    return [...known.entries()].map(([aid, name]) => ({ id: aid, name }));
  }, [agents, overrides, id]);

  const summary = (g: McpGrantView | undefined): string => t(`mcpAccess.presets.${g?.preset ?? 'none'}`);

  return (
    <div style={box}>
      <span style={label}>{t('mcpAccess.title')}</span>
      <span style={note}>{t('mcpAccess.intro')}</span>
      <span style={note}>{t('mcpAccess.claudeOnly')}</span>

      <span style={{ ...label, marginTop: 4 }}>{t('mcpAccess.everyone')}</span>
      <GrantEditor grant={defaultGrant} tools={tools} onChange={(g) => { void send(null, g); }} />
      {tools.some((x) => x.class === 'destructive') && <span style={note}>{t('mcpAccess.classNote')}</span>}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <button type="button" style={btn(false)} disabled={busy} onClick={() => { void loadTools(); }}>
          {busy ? t('mcpAccess.tools.loading') : tools.length ? t('mcpAccess.tools.reload') : t('mcpAccess.tools.load')}
        </button>
        {tools.length === 0 && !busy && <span style={note}>{t('mcpAccess.tools.none')}</span>}
      </div>

      <span style={{ ...label, marginTop: 4 }}>{t('mcpAccess.agentsTitle')}</span>
      {rows.length === 0 && <span style={note}>{t('mcpAccess.agentsNone')}</span>}
      {rows.map((a) => {
        const own = overrides[a.id]?.[id];
        const expanded = open === a.id;
        return (
          <div key={a.id} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 12, color: 'var(--cth-ink-900)', flex: 1, minWidth: 80 }}>{a.name}</span>
              <span style={note}>{own ? summary(own) : t('mcpAccess.inherit')}</span>
              <button type="button" style={btn(expanded)} onClick={() => setOpen(expanded ? null : a.id)}>{t('mcpAccess.customize')}</button>
              {own && <button type="button" style={btn(false)} onClick={() => { void send(a.id, null); }}>{t('mcpAccess.useDefault')}</button>}
            </div>
            {expanded && <GrantEditor grant={own} tools={tools} onChange={(g) => { void send(a.id, g); }} />}
          </div>
        );
      })}

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
        <span style={label}>{t('mcpAccess.activity.title')}</span>
        <button type="button" style={btn(false)} onClick={() => { void reload(); }}>{t('mcpAccess.activity.refresh')}</button>
      </div>
      {events.length === 0
        ? <span style={note}>{t('mcpAccess.activity.none')}</span>
        : events.slice(0, 10).map((e, i) => (
          <span key={`${e.at}-${i}`} style={{ fontSize: 11, lineHeight: '15px', color: e.decision === 'deny' ? '#6E1423' : 'var(--cth-ink-700)' }}>
            {new Date(e.at).toLocaleTimeString()} · {e.agentId} · {e.tool ?? e.method ?? '—'} · {t(e.decision === 'allow' ? 'mcpAccess.activity.allowed' : 'mcpAccess.activity.denied')}
          </span>
        ))}
      {msg && <span style={{ fontSize: 12, color: '#6E1423' }}>{msg}</span>}
    </div>
  );
}
