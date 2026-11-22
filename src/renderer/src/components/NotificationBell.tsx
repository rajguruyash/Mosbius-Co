import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { NotifySnapshot } from '../../../main/notifyService';
import { NotificationCard } from '@/huddle/NotificationCard';
import { noteText } from '@/huddle/format';
import '@/huddle/huddle-ui.css';

/** Every notification, live: the same snapshot the Huddle shows, read through the main window's own bridge. */
export function useNotificationSnapshot(): NotifySnapshot | null {
  const [snap, setSnap] = useState<NotifySnapshot | null>(null);
  useEffect(() => {
    let live = true;
    const off = window.cth.onNotifications((s) => { if (live) setSnap(s); });
    void window.cth.notifications().then((s) => { if (live && s) setSnap((cur) => cur ?? s); });
    return () => { live = false; off(); };
  }, []);
  return snap;
}

const resolve = (req: { id: string; action: string; text?: string; index?: number }): ReturnType<typeof window.cth.notificationResolve> => window.cth.notificationResolve(req);

/**
 * The bell in the title bar: how many things are waiting on you, the inbox they are listed in, and (while you are
 * looking at this window) a small toast when a new one arrives, so a system that is not showing banners is not the
 * only way to find out.
 */
export function NotificationBell(): JSX.Element {
  const { t } = useTranslation();
  const snap = useNotificationSnapshot();
  const [open, setOpen] = useState(false);
  const [toasts, setToasts] = useState<Array<{ id: string; title: string; body: string; agentId: string }>>([]);
  const seen = useRef<Set<string> | null>(null);
  const openRef = useRef(false);
  openRef.current = open;
  const [now, setNow] = useState(() => Date.now());

  // new things that need a person, seen while this window is in front
  useEffect(() => {
    if (!snap) return;
    if (seen.current === null) { seen.current = new Set(snap.records.map((r) => r.id)); return; }
    const fresh = snap.records.filter((r) => !seen.current?.has(r.id));
    for (const r of snap.records) seen.current.add(r.id);
    // while the inbox is open it already lists the new one: a toast of the same thing beside it would be a duplicate
    if (!document.hasFocus() || openRef.current) return;
    const wanted = fresh.filter((r) => r.actionRequired && !r.resolution && snap.prefs.categories[r.category] !== false);
    if (wanted.length === 0) return;
    setToasts((cur) => [...cur, ...wanted.map((r) => ({ id: r.id, title: noteText(t, r.title), body: noteText(t, r.body), agentId: r.agentId }))].slice(-3));
  }, [snap, t]);
  useEffect(() => {
    if (toasts.length === 0) return undefined;
    const timer = setTimeout(() => setToasts((cur) => cur.slice(1)), 9000);
    return () => clearTimeout(timer);
  }, [toasts]);
  useEffect(() => {
    if (!open) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => { clearInterval(timer); window.removeEventListener('keydown', onKey); };
  }, [open]);

  const pending = snap?.pending ?? 0;
  const unread = snap?.unread ?? 0;
  const toggle = useCallback(() => { setOpen((o) => !o); setToasts([]); void window.cth.notificationsReadAll(); }, []);
  const records = snap ? [...snap.records].reverse() : [];

  return (
    <>
      <button
        className="cth-titlebar-nodrag cth-tip"
        onClick={toggle}
        data-tip={t('huddle.notifications.bell')}
        aria-label={`${t('huddle.notifications.bell')}${pending ? `: ${t('huddle.notifications.pending', { count: pending })}` : unread ? `: ${t('huddle.notifications.unread', { count: unread })}` : ''}`}
        aria-expanded={open}
        style={{
          position: 'relative', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, padding: 0,
          background: 'var(--cth-paper-100)', boxShadow: pending ? 'inset 0 0 0 1px var(--cth-coral)' : 'inset 0 0 0 1px var(--cth-ink-300)',
          border: 'none', borderRadius: 2, cursor: 'pointer', color: 'var(--cth-ink-900)', fontSize: 13
        }}
      >
        <span aria-hidden="true">🔔</span>
        {(pending > 0 || unread > 0) && (
          <span style={{
            position: 'absolute', top: -5, right: -5, minWidth: 15, height: 15, padding: '0 3px', borderRadius: 8, fontSize: 10, lineHeight: '15px', textAlign: 'center',
            background: pending > 0 ? 'var(--cth-coral)' : 'var(--cth-ink-500)', color: pending > 0 ? '#fff' : 'var(--cth-cream-50)'
          }}>{pending > 0 ? pending : unread}</span>
        )}
      </button>

      {open && (
        <div role="dialog" aria-label={t('huddle.notifications.bell')} className="hd-inbox" style={{
          position: 'fixed', top: 40, right: 12, width: 380, maxHeight: '72vh', zIndex: 480, display: 'flex', flexDirection: 'column',
          background: 'var(--cth-cream-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-500), 4px 4px 0 rgba(26,19,32,0.22)'
        }}>
          <div className="hd-row hd-row-between" style={{ padding: '8px 10px', margin: 0, borderBottom: '1px solid var(--cth-ink-100)' }}>
            <strong style={{ fontFamily: 'var(--cth-font-display)', fontSize: 9, fontWeight: 'normal' }}>{t('huddle.notifications.bell')}</strong>
            <span className="hd-row">
              <button className="hd-btn hd-btn-ghost" disabled={records.length === 0} onClick={() => void window.cth.notificationsClear()}>{t('huddle.notifications.clear')}</button>
              <button className="hd-btn" onClick={() => setOpen(false)}>{t('huddle.close')}</button>
            </span>
          </div>
          <div style={{ overflowY: 'auto', padding: '8px 10px 10px' }}>
            {records.length === 0 && <div className="hd-muted">{t('huddle.notifications.noneHistory')}</div>}
            {records.map((r) => <NotificationCard key={r.id} rec={r} resolve={resolve} now={now} />)}
          </div>
        </div>
      )}

      {toasts.length > 0 && (
        <div style={{ position: 'fixed', right: 16, bottom: 64, zIndex: 9998, display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 360 }}>
          {toasts.map((x) => (
            <div key={x.id} role="status" style={{ background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1.5px var(--cth-coral), 4px 4px 0 0 var(--cth-ink-900)', padding: 10, display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div style={{ fontWeight: 600 }}>{x.title}</div>
              <div style={{ fontSize: 12, color: 'var(--cth-ink-700)' }}>{x.body}</div>
              <div className="hd-row">
                <button className="hd-btn hd-btn-primary" onClick={() => { void window.cth.notificationResolve({ id: x.id, action: 'open' }); setToasts((cur) => cur.filter((y) => y.id !== x.id)); }}>{t('huddle.notifications.openAgent')}</button>
                <button className="hd-btn hd-btn-ghost" onClick={() => setToasts((cur) => cur.filter((y) => y.id !== x.id))}>{t('huddle.close')}</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
