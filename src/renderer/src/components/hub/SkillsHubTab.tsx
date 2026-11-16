import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MCP_CATALOG, type McpCatalogEntry } from '@shared/mcpCatalog';
import { AGENT_COMPAT, agentsForTarget, type SkillTarget } from '@shared/agentCompat';
import { providerOfMcp } from '@shared/providers';
import type { CatalogSkill, FileDiff, LocalSkill, ManagedSkill, UpdatePreview } from '../../../../preload';
import { btn, card, chip, entryState, field, label, note, row, type HubSnapshot } from './hubUi';

/**
 * Skills, managed. What this app installed (where each came from, down to the commit; whether it still matches
 * what was installed; what an update would change before anything changes; the way back), a catalogue to install
 * from, and which agent CLI each skill is for.
 *
 * Installing a skill grants nothing and connects nothing: the installer takes grants and run-on-load syntax out of
 * the copy, and the integrations a skill mentions are shown as dependencies with a Connect button, never connected.
 */
export interface SkillsHubTabProps {
  snap: HubSnapshot;
  /** Open this provider on the Discover tab (a dependency's Connect button). */
  openProvider: (providerId: string) => void;
}

type Result =
  | { kind: 'installed'; name: string; path: string; commit: string | null; stripped: number; notes: string[]; integrations: string[]; suggested: string[] }
  | { kind: 'error'; name: string; text: string };

const TARGETS: SkillTarget[] = ['claude', 'agents'];
const short = (sha: string | null): string => (sha ? sha.slice(0, 7) : '—');

function Mono({ children }: { children: React.ReactNode }) {
  return <span dir="ltr" style={{ fontFamily: 'var(--cth-font-mono)', fontSize: 11, overflowWrap: 'anywhere' }}>{children}</span>;
}

export function SkillsHubTab({ snap, openProvider }: SkillsHubTabProps) {
  const { t } = useTranslation();
  const [target, setTarget] = useState<SkillTarget>('claude');
  const [managed, setManaged] = useState<ManagedSkill[] | null>(null);
  const [local, setLocal] = useState<LocalSkill[]>([]);
  const [catalog, setCatalog] = useState<CatalogSkill[] | null>(null);
  const [catalogErr, setCatalogErr] = useState('');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [message, setMessage] = useState('');
  const [preview, setPreview] = useState<{ dirName: string; data: UpdatePreview } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const flash = (text: string) => { setMessage(text); setTimeout(() => setMessage(''), 9000); };

  const loadManaged = useCallback(async () => {
    try {
      const r = await window.cth.skillsManaged(target);
      setManaged(r.ok ? r.skills : []);
    } catch { setManaged([]); }
  }, [target]);
  const loadLocal = useCallback(async () => {
    try { setLocal(await window.cth.skillsLocal()); } catch { setLocal([]); }
  }, []);
  const loadCatalog = useCallback(async (force = false) => {
    try {
      const r = await window.cth.skillsCatalog(force);
      setCatalog(r.skills);
      setCatalogErr(r.error ?? '');
    } catch { setCatalog([]); setCatalogErr(t('hub.skills.catalogUnreachable')); }
  }, [t]);

  useEffect(() => { setPreview(null); setConfirming(null); void loadManaged(); }, [loadManaged]);
  useEffect(() => { void loadLocal(); void loadCatalog(); }, [loadLocal, loadCatalog]);

  const compat = useMemo(() => agentsForTarget(target).map((a) => AGENT_COMPAT.find((c) => c.agent === a)!).filter(Boolean), [target]);
  const folders = compat[0]?.skillFolders ?? [];

  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of catalog ?? []) counts.set(s.category, (counts.get(s.category) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 10);
  }, [catalog]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = catalog ?? [];
    if (category !== 'all') list = list.filter((s) => s.category === category);
    if (q) list = list.filter((s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q) || s.owner.toLowerCase().includes(q));
    return { total: list.length, rows: list.slice(0, 80) };
  }, [catalog, query, category]);

  const managedNames = useMemo(() => new Set((managed ?? []).map((m) => m.name.toLowerCase())), [managed]);
  const managedPaths = useMemo(() => new Set((managed ?? []).map((m) => m.path)), [managed]);
  const others = useMemo(() => local.filter((s) => s.scope !== 'bundled' && !managedPaths.has(s.path)), [local, managedPaths]);

  const install = async (c: CatalogSkill) => {
    setBusy(c.url); setResult(null);
    try {
      const r = await window.cth.skillsInstall(c.url, c.name, target);
      if (r.ok) {
        setResult({ kind: 'installed', name: c.name, path: r.path, commit: r.commit, stripped: r.stripped.length, notes: r.notes, integrations: r.deps.integrations, suggested: r.deps.suggested });
        await Promise.all([loadManaged(), loadLocal()]);
      } else {
        setResult({ kind: 'error', name: c.name, text: /^Already installed/i.test(r.error) ? t('hub.skills.alreadyInstalled') : r.unsupported ? t('hub.skills.notInstallable') : t('hub.skills.installFailed') });
      }
    } catch { setResult({ kind: 'error', name: c.name, text: t('hub.skills.installFailed') }); }
    finally { setBusy(null); }
  };

  const verify = async (m: ManagedSkill) => {
    setBusy(m.dirName);
    try {
      const r = await window.cth.skillsVerify(target, m.dirName);
      if (r.ok) flash(r.integrity.state === 'ok' ? t('hub.skills.verifiedOk', { name: m.name }) : r.integrity.state === 'changed' ? t('hub.skills.verifiedChanged', { name: m.name }) : t('hub.skills.verifiedMissing', { name: m.name }));
      await loadManaged();
    } finally { setBusy(null); }
  };

  const checkUpdate = async (m: ManagedSkill) => {
    setBusy(m.dirName); setPreview(null);
    try {
      const r = await window.cth.skillsCheckUpdate(target, m.dirName);
      if (!r.ok) flash(t('hub.skills.updateCheckFailed', { name: m.name }));
      else if (r.upToDate) flash(t('hub.skills.upToDate', { name: m.name }));
      else setPreview({ dirName: m.dirName, data: r.preview });
    } finally { setBusy(null); }
  };

  const applyUpdate = async (p: { dirName: string; data: UpdatePreview }) => {
    setBusy(p.dirName);
    try {
      const r = await window.cth.skillsApplyUpdate(target, p.dirName, p.data.token);
      flash(r.ok ? t('hub.skills.updated', { name: p.dirName }) : t('hub.skills.updateFailed', { name: p.dirName }));
      setPreview(null);
      await loadManaged();
    } finally { setBusy(null); }
  };

  const discard = async () => {
    if (preview) await window.cth.skillsDiscardUpdate(preview.data.token);
    setPreview(null);
  };

  const rollback = async (m: ManagedSkill) => {
    setBusy(m.dirName);
    try {
      const r = await window.cth.skillsRollback(target, m.dirName);
      flash(r.ok ? t('hub.skills.rolledBack', { name: m.name }) : t('hub.skills.rollbackFailed', { name: m.name }));
      await loadManaged();
    } finally { setBusy(null); }
  };

  const uninstall = async (m: ManagedSkill) => {
    setBusy(m.dirName); setConfirming(null);
    try {
      const r = await window.cth.skillsUninstall(m.path);
      flash(r.ok ? t('hub.skills.removed', { name: m.name }) : t('hub.skills.removeFailed', { name: m.name }));
      await Promise.all([loadManaged(), loadLocal()]);
    } finally { setBusy(null); }
  };

  /** One dependency chip: an integration the skill asks for, with where it stands and a way to connect it. */
  const dependency = (id: string) => {
    const entry: McpCatalogEntry | undefined = MCP_CATALOG.find((e) => e.id === id);
    const provider = providerOfMcp(id);
    const state = entry ? entryState(entry, snap) : 'not-connected';
    const ok = state === 'connected';
    return (
      <span key={id} style={{ ...row, gap: 4 }}>
        <span style={chip(ok ? 'ok' : 'warn')}>{t(ok ? 'hub.skills.needsConnected' : 'hub.skills.needsNotConnected', { label: provider?.label ?? entry?.label ?? id })}</span>
        {!ok && provider && <button type="button" style={btn()} onClick={() => openProvider(provider.id)}>{t('hub.card.connect')}</button>}
      </span>
    );
  };

  const integrityChip = (m: ManagedSkill) => {
    const s = m.integrity.state;
    return <span style={chip(s === 'ok' ? 'ok' : 'bad')}>{t(`hub.skills.integrity.${s}`)}</span>;
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <span style={note}>{t('hub.skills.intro')}</span>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={label}>{t('hub.skills.installFor')}</span>
        <div style={row} role="group" aria-label={t('hub.skills.installFor')}>
          {TARGETS.map((x) => (
            <button key={x} type="button" style={btn(target === x)} aria-pressed={target === x} onClick={() => setTarget(x)}>
              {t(`hub.skills.target.${x}`)}
            </button>
          ))}
        </div>
        <div style={{ ...row, gap: 8 }}>
          {compat.map((c) => (
            <span key={c.agent} style={{ ...row, gap: 4 }}>
              <span style={{ fontSize: 12, color: 'var(--cth-ink-900)' }}>{c.label}</span>
              <span style={chip(c.skills === 'verified' ? 'ok' : 'warn')}>{t(`hub.compat.status.${c.skills}`)}</span>
            </span>
          ))}
        </div>
        <span style={note}>{t('hub.skills.folders')} <Mono>{folders.join('   ')}</Mono></span>
        {compat.some((c) => c.skills !== 'verified') && <span style={note}>{t('hub.skills.notRunNote')}</span>}
      </div>

      {message && <span style={{ fontSize: 12, color: 'var(--cth-mint-700)' }} role="status">{message}</span>}

      {/* ── installed by this app ── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <span style={label} role="heading" aria-level={3}>{t('hub.skills.installedTitle', { count: managed?.length ?? 0 })}</span>
        {managed !== null && managed.length === 0 && <span style={note}>{t('hub.skills.installedNone')}</span>}
        {(managed ?? []).map((m) => {
          const mine = preview && preview.dirName === m.dirName ? preview.data : null;
          const working = busy === m.dirName;
          return (
            <div key={m.dirName} style={card} data-skill={m.dirName}>
              <div style={{ ...row, justifyContent: 'space-between' }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--cth-ink-900)' }}>{m.name}</span>
                <div style={row}>
                  {integrityChip(m)}
                  <span style={chip()}>{t('hub.skills.at', { commit: short(m.commit) })}</span>
                </div>
              </div>
              <span style={note}><Mono>{m.source}</Mono></span>
              <span style={note}>{t('hub.skills.installedOn', { date: new Date(m.updatedAt ?? m.installedAt).toLocaleDateString() })}</span>
              {m.integrity.state === 'changed' && (
                <span style={{ ...note, color: 'var(--cth-danger)' }}>
                  {t('hub.skills.changedDetail', { changed: m.integrity.changed.length, missing: m.integrity.missing.length, added: m.integrity.added.length })}
                </span>
              )}
              {m.strippedCount > 0 && <span style={note}>{t('hub.skills.stripped', { count: m.strippedCount })}</span>}
              {m.deps.tools.length > 0 && <span style={note}>{t('hub.skills.toolsAsked', { count: m.deps.tools.length })}</span>}
              {m.notes.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span style={{ ...note, color: 'var(--cth-danger)' }}>{t('hub.skills.scripts')}</span>
                  {m.notes.map((n) => <span key={n} style={note}><Mono>{n}</Mono></span>)}
                </div>
              )}
              {(m.deps.integrations.length > 0 || m.deps.suggested.length > 0) && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span style={label}>{t('hub.skills.dependencies')}</span>
                  <div style={{ ...row, gap: 8 }}>{m.deps.integrations.map(dependency)}</div>
                  {m.deps.suggested.length > 0 && (
                    <span style={note}>{t('hub.skills.mentions', { list: m.deps.suggested.map((id) => providerOfMcp(id)?.label ?? id).join(', ') })}</span>
                  )}
                </div>
              )}
              <div style={row}>
                {m.agents.map((a) => <span key={a} style={chip()}>{AGENT_COMPAT.find((c) => c.agent === a)?.label ?? a}</span>)}
              </div>
              <div style={row}>
                <button type="button" style={btn(false, working)} disabled={working} onClick={() => { void verify(m); }}>{t('hub.skills.verify')}</button>
                <button type="button" style={btn(false, working)} disabled={working} onClick={() => { void checkUpdate(m); }}>{t('hub.skills.checkUpdate')}</button>
                {m.canRollback && <button type="button" style={btn(false, working)} disabled={working} onClick={() => { void rollback(m); }}>{t('hub.skills.rollback')}</button>}
                <button type="button" style={btn()} onClick={() => { void window.cth.skillsReveal(m.path); }}>{t('hub.skills.reveal')}</button>
                {confirming === m.dirName
                  ? <button type="button" style={btn(true)} onClick={() => { void uninstall(m); }}>{t('hub.skills.confirmRemove')}</button>
                  : <button type="button" style={btn()} onClick={() => setConfirming(m.dirName)}>{t('hub.skills.remove')}</button>}
              </div>
              {mine && (
                <UpdateReview
                  preview={mine}
                  working={working}
                  onApply={() => { void applyUpdate({ dirName: m.dirName, data: mine }); }}
                  onDiscard={() => { void discard(); }}
                  dependency={dependency}
                />
              )}
            </div>
          );
        })}
      </div>

      {/* ── the catalogue ── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <span style={label} role="heading" aria-level={3}>{t('hub.skills.catalogTitle')}</span>
        <input type="search" value={query} onChange={(ev) => setQuery(ev.target.value)} placeholder={t('hub.skills.searchPlaceholder')} aria-label={t('hub.skills.search')} style={{ ...field, fontFamily: 'inherit', fontSize: 12, padding: '5px 8px', flex: 'none' }} />
        <div style={row} role="group" aria-label={t('hub.categories')}>
          <button type="button" style={btn(category === 'all')} aria-pressed={category === 'all'} onClick={() => setCategory('all')}>{t('hub.cat.all')} {catalog?.length ?? 0}</button>
          {categories.map(([c, n]) => (
            <button key={c} type="button" style={btn(category === c)} aria-pressed={category === c} onClick={() => setCategory(c)}>{c} {n}</button>
          ))}
        </div>
        {catalogErr && <span style={{ ...note, color: 'var(--cth-danger)' }} role="status">{catalogErr}</span>}
        {catalog === null && <span style={note}>{t('hub.skills.loading')}</span>}
        {result && (
          <div style={{ ...card, boxShadow: `inset 0 0 0 1px ${result.kind === 'error' ? 'var(--cth-danger)' : 'var(--cth-mint)'}` }} role="status">
            {result.kind === 'error' ? (
              <span style={{ fontSize: 12, color: 'var(--cth-danger)' }}>{result.name}: {result.text}</span>
            ) : (
              <>
                <span style={{ fontSize: 12, color: 'var(--cth-ink-900)' }}>{t('hub.skills.installedResult', { name: result.name, commit: short(result.commit) })}</span>
                <span style={note}><Mono>{result.path}</Mono></span>
                {result.stripped > 0 && <span style={note}>{t('hub.skills.stripped', { count: result.stripped })}</span>}
                {result.notes.length > 0 && <span style={{ ...note, color: 'var(--cth-danger)' }}>{t('hub.skills.scripts')}</span>}
                {result.integrations.length > 0 && (
                  <div style={{ ...row, gap: 8 }}>
                    <span style={note}>{t('hub.skills.dependencies')}</span>
                    {result.integrations.map(dependency)}
                  </div>
                )}
                {result.suggested.length > 0 && <span style={note}>{t('hub.skills.mentions', { list: result.suggested.map((id) => providerOfMcp(id)?.label ?? id).join(', ') })}</span>}
                <span style={note}>{t('hub.skills.nothingGranted')}</span>
              </>
            )}
          </div>
        )}
        {shown.rows.length === 0 && catalog !== null && <span style={note}>{t('hub.noMatch')}</span>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {shown.rows.map((c) => {
            const have = managedNames.has(c.name.toLowerCase());
            return (
              <div key={c.url} style={{ ...card, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--cth-ink-900)' }}>{c.name} <span style={{ ...note, fontWeight: 400 }}>· {c.owner}</span></span>
                  <span style={{ ...note, overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>{c.description}</span>
                </div>
                {have
                  ? <span style={chip('ok')}>{t('hub.skills.have')}</span>
                  : <button type="button" style={btn(false, busy === c.url)} disabled={busy === c.url} onClick={() => { void install(c); }}>{busy === c.url ? t('hub.skills.installing') : t('hub.skills.install')}</button>}
              </div>
            );
          })}
        </div>
        {shown.total > shown.rows.length && <span style={note}>{t('hub.skills.showing', { shown: shown.rows.length, total: shown.total })}</span>}
      </div>

      {/* ── everything else on this machine ── */}
      {others.length > 0 && (
        <details>
          <summary style={{ ...label, cursor: 'pointer' }}>{t('hub.skills.othersTitle', { count: others.length })}</summary>
          <span style={note}>{t('hub.skills.othersNote')}</span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginBlockStart: 6 }}>
            {others.map((s) => (
              <div key={s.id} style={{ ...row, flexWrap: 'nowrap', fontSize: 12, color: 'var(--cth-ink-900)' }}>
                <span style={{ flexShrink: 0 }}>{s.name}</span>
                <span style={chip()}>{s.provider}</span>
                <span style={chip()}>{t(`hub.skills.scope.${s.scope}`)}</span>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

/** What an update would change, line by line, before anything changes. */
function UpdateReview({ preview, working, onApply, onDiscard, dependency }: {
  preview: UpdatePreview; working: boolean; onApply: () => void; onDiscard: () => void; dependency: (id: string) => React.ReactNode;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState<string | null>(null);
  const flagged = preview.newTools.length + preview.newIntegrations.length + preview.newScripts.length + preview.locallyModified.length;
  return (
    <div style={{ ...card, boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)', marginBlockStart: 4 }} aria-label={t('hub.skills.update.title')}>
      <span style={label}>{t('hub.skills.update.title')}</span>
      <span style={{ fontSize: 12, color: 'var(--cth-ink-900)' }}>{t('hub.skills.update.from', { from: short(preview.from), to: short(preview.to) })}</span>
      {preview.files.length === 0 && <span style={note}>{t('hub.skills.update.noFileChanges')}</span>}
      {preview.files.map((f: FileDiff) => (
        <div key={f.path} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <div style={row}>
            <span style={chip(f.change === 'removed' ? 'bad' : f.change === 'added' ? 'warn' : 'quiet')}>{t(`hub.skills.update.${f.change}`)}</span>
            <Mono>{f.path}</Mono>
            {(f.additions > 0 || f.deletions > 0) && <span style={note}>+{f.additions} −{f.deletions}</span>}
            {f.diff && f.diff.length > 0 && (
              <button type="button" style={btn(open === f.path)} aria-expanded={open === f.path} onClick={() => setOpen(open === f.path ? null : f.path)}>{t('hub.skills.update.lines')}</button>
            )}
          </div>
          {open === f.path && f.diff && (
            <pre dir="ltr" style={{ margin: 0, padding: '4px 6px', maxHeight: 220, overflow: 'auto', fontSize: 11, lineHeight: '15px', background: 'var(--cth-cream-200)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)' }}>
              {f.diff.map((l, i) => (
                <div key={i} style={{ color: l.startsWith('+') ? 'var(--cth-mint-700)' : l.startsWith('-') ? 'var(--cth-danger)' : 'var(--cth-ink-700)' }}>{l}</div>
              ))}
            </pre>
          )}
        </div>
      ))}
      {preview.newTools.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ ...note, color: 'var(--cth-danger)' }}>{t('hub.skills.update.newTools', { count: preview.newTools.length })}</span>
          {preview.newTools.map((x) => <span key={x} style={note}><Mono>{x}</Mono></span>)}
        </div>
      )}
      {preview.newIntegrations.length > 0 && (
        <div style={{ ...row, gap: 8 }}>
          <span style={note}>{t('hub.skills.update.newIntegrations')}</span>
          {preview.newIntegrations.map((id) => dependency(id))}
        </div>
      )}
      {preview.newScripts.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ ...note, color: 'var(--cth-danger)' }}>{t('hub.skills.update.newScripts')}</span>
          {preview.newScripts.map((x) => <span key={x} style={note}><Mono>{x}</Mono></span>)}
        </div>
      )}
      {preview.locallyModified.length > 0 && (
        <span style={{ ...note, color: 'var(--cth-danger)' }}>{t('hub.skills.update.locallyModified', { files: preview.locallyModified.join(', ') })}</span>
      )}
      {preview.stripped.length > 0 && <span style={note}>{t('hub.skills.stripped', { count: preview.stripped.length })}</span>}
      <span style={note}>{t(flagged > 0 ? 'hub.skills.update.readFirst' : 'hub.skills.update.keepsOld')}</span>
      <div style={row}>
        <button type="button" style={btn(true, working)} disabled={working} onClick={onApply}>{t('hub.skills.update.apply')}</button>
        <button type="button" style={btn()} onClick={onDiscard}>{t('hub.skills.update.discard')}</button>
      </div>
    </div>
  );
}
