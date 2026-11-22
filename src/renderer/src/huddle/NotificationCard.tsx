import { useState } from 'react';
import './huddle-ui.css';
import { useTranslation } from 'react-i18next';
import type { CommandResult } from '@shared/huddle';
import type { NotificationRecord } from '@shared/notifications';
import { isComposingKey } from '@shared/imeGuard';
import { agoText, errorText, noteText } from './format';
import { wantKeyboard } from './keyboard';

export type Resolver = (req: { id: string; action: string; text?: string; index?: number }) => Promise<CommandResult>;

/**
 * One notification: what happened, what the agent said, and exactly the buttons that are real for it. Every button
 * goes through `resolve`, which is the main process's own handler for that action: the card carries no logic of
 * its own about what an approval does.
 */
export function NotificationCard({ rec, resolve, now, selected }: { rec: NotificationRecord; resolve: Resolver; now: number; selected?: boolean }): JSX.Element {
  const { t, i18n } = useTranslation();
  const exists = (k: string): boolean => i18n.exists(k);
  const [mode, setMode] = useState<null | 'alternative' | 'answer'>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const open = rec.actionRequired && !rec.resolution;
  const has = (a: string): boolean => (rec.actions as string[]).includes(a);

  const act = async (req: { action: string; text?: string; index?: number }): Promise<void> => {
    setBusy(true); setErr('');
    try {
      const r = await resolve({ id: rec.id, ...req });
      if (!r.ok) setErr(errorText(t, exists, r.error)); else { setMode(null); setText(''); }
    } catch (e) { setErr(String(e)); }
    setBusy(false);
  };
  const submitText = (): void => { if (text.trim() && mode) void act({ action: mode, text: text.trim() }); };

  const outcome = rec.resolution
    ? [t(`huddle.notifications.outcome.${rec.resolution.action}`), t(`huddle.notifications.by.${rec.resolution.by}`), agoText(t, now - rec.resolution.at)].join(' · ')
    : '';

  return (
    <div className={`hd-note hd-note-${rec.category}${open ? ' hd-note-open' : ' hd-note-done'}${selected ? ' hd-note-selected' : ''}${rec.read ? '' : ' hd-note-unread'}`} data-note={rec.id} data-category={rec.category}>
      <div className="hd-note-head">
        <span className="hd-note-kind">{t(`huddle.notifications.category.${rec.category}`)}</span>
        <span className="hd-note-time">{agoText(t, now - rec.createdAt)}</span>
      </div>
      <div className="hd-note-title">{noteText(t, rec.title)}</div>
      <div className="hd-note-body">{noteText(t, rec.body)}</div>
      {rec.preview && <pre className="hd-note-preview" dir="auto">{rec.preview}</pre>}
      {rec.repeatCount > 1 && open && <div className="hd-note-repeat">{t('huddle.notifications.repeated', { count: rec.repeatCount })}</div>}

      {open && has('option') && rec.options && (
        <div className="hd-note-options">
          {rec.options.map((o, i) => (
            <button key={`${i}:${o}`} className="hd-btn" disabled={busy} onClick={() => void act({ action: 'option', index: i })} dir="auto">{o}</button>
          ))}
        </div>
      )}

      {open && mode && (
        <div className="hd-note-input">
          <textarea
            autoFocus rows={2} value={text} dir="auto"
            placeholder={mode === 'alternative' ? t('huddle.notifications.alternativePlaceholder', { agent: rec.agentName }) : t('huddle.notifications.answerPlaceholder')}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (isComposingKey(e)) return; if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitText(); } if (e.key === 'Escape') { e.stopPropagation(); setMode(null); } }}
          />
          <div className="hd-row">
            <button className="hd-btn hd-btn-primary" disabled={busy || !text.trim()} onClick={submitText}>
              {mode === 'alternative' ? t('huddle.notifications.sendAlternative') : t('huddle.notifications.sendAnswer')}
            </button>
            <button className="hd-btn hd-btn-ghost" onClick={() => setMode(null)}>{t('huddle.notifications.cancel')}</button>
          </div>
        </div>
      )}

      {open && !mode && (
        <div className="hd-note-actions">
          {has('approve') && <button className="hd-btn hd-btn-primary" disabled={busy} onClick={() => void act({ action: 'approve' })}>{t('huddle.notifications.approve')}</button>}
          {has('reject') && <button className="hd-btn hd-btn-danger" disabled={busy} onClick={() => void act({ action: 'reject' })}>{t('huddle.notifications.reject')}</button>}
          {has('alternative') && <button className="hd-btn" disabled={busy} onClick={() => { wantKeyboard(); setMode('alternative'); }}>{t('huddle.notifications.alternative')}</button>}
          {has('answer') && <button className="hd-btn hd-btn-primary" disabled={busy} onClick={() => { wantKeyboard(); setMode('answer'); }}>{t('huddle.notifications.answer')}</button>}
          {has('restart') && <button className="hd-btn hd-btn-primary" disabled={busy} onClick={() => void act({ action: 'restart' })}>{t('huddle.notifications.restart')}</button>}
          {has('settings') && <button className="hd-btn" disabled={busy} onClick={() => void act({ action: 'settings' })}>{t('huddle.notifications.settings')}</button>}
          {has('open') && <button className="hd-btn hd-btn-ghost" disabled={busy} onClick={() => void act({ action: 'open' })}>{t('huddle.notifications.openAgent')}</button>}
          <button className="hd-btn hd-btn-ghost hd-note-dismiss" disabled={busy} onClick={() => void act({ action: 'dismiss' })}>{t('huddle.notifications.dismiss')}</button>
        </div>
      )}
      {!open && rec.actionRequired && <div className="hd-note-outcome">{outcome}</div>}
      {!open && !rec.actionRequired && has('open') && (
        <div className="hd-note-actions"><button className="hd-btn hd-btn-ghost" onClick={() => void act({ action: 'open' })}>{t('huddle.notifications.openAgent')}</button></div>
      )}
      {err && <div className="hd-error" role="alert">{t('huddle.notifications.failed', { error: err })}</div>}
    </div>
  );
}
