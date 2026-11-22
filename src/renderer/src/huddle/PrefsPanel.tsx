import { useEffect, useRef, useState } from 'react';
import './huddle-ui.css';
import { useTranslation } from 'react-i18next';
import { NOTIFICATION_CATEGORIES, SOUND_KINDS, type NotificationCategory, type NotificationPrefsPatch, type SoundKind } from '@shared/notifications';
import { SOUND_META } from '@shared/soundPolicy';
import type { NotifySnapshot } from '../../../main/notifyService';

export interface PrefsApi {
  /** Send only what changed. */
  setPrefs(patch: NotificationPrefsPatch): Promise<unknown>;
  test(): Promise<{ ok: boolean; status?: string }>;
  openSystemSettings(): Promise<unknown>;
  /** Play one of the app's sounds and nothing else: no notification, no change to any agent. */
  previewSound(kind: SoundKind): Promise<{ ok: boolean; error?: string }>;
}

/**
 * What the person can switch off, how loud the app's sounds are, a button to hear each of them, and an honest line
 * about whether the operating system is showing banners. Used by the Huddle's expanded panel and by Settings in the
 * main window, so the two can never disagree.
 */
export function PrefsPanel({ snapshot, api }: { snapshot: NotifySnapshot; api: PrefsApi }): JSX.Element {
  const { t } = useTranslation();
  const p = snapshot.prefs;
  const [tested, setTested] = useState(false);
  const set = (patch: NotificationPrefsPatch): void => { void api.setPrefs(patch); };
  const setCategory = (c: NotificationCategory, on: boolean): void => { void api.setPrefs({ categories: { [c]: on } }); };
  const status = snapshot.desktop.status;

  // The slider keeps its own value while it is being dragged: the echo of an earlier value must not jerk it back.
  const [volume, setVolume] = useState(p.volume);
  const dragging = useRef(false);
  useEffect(() => { if (!dragging.current) setVolume(p.volume); }, [p.volume]);
  const pct = Math.round(volume * 100);

  // Which preview is sounding, for as long as it sounds. Pressing another one plays that one: it takes over.
  const [playing, setPlaying] = useState<SoundKind | null>(null);
  const playTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (playTimer.current) clearTimeout(playTimer.current); }, []);
  const preview = (kind: SoundKind): void => {
    void api.previewSound(kind);
    setPlaying(kind);
    if (playTimer.current) clearTimeout(playTimer.current);
    playTimer.current = setTimeout(() => setPlaying((cur) => (cur === kind ? null : cur)), SOUND_META[kind].ms);
  };

  return (
    <div className="hd-prefs" data-hub-prefs>
      <label className="hd-check"><input type="checkbox" checked={p.sound} onChange={(e) => set({ sound: e.target.checked })} /> <span>{t('huddle.prefs.sound')}</span></label>
      <label className="hd-check"><input type="checkbox" checked={p.desktop} onChange={(e) => set({ desktop: e.target.checked })} /> <span>{t('huddle.prefs.desktop')}</span></label>
      <label className="hd-check"><input type="checkbox" checked={p.showRoutine} onChange={(e) => set({ showRoutine: e.target.checked, categories: { info: e.target.checked } })} /> <span>{t('huddle.prefs.routine')}</span></label>
      <div className="hd-prefs-cats" role="group" aria-label={t('huddle.prefs.categories')}>
        <div className="hd-muted">{t('huddle.prefs.categories')}</div>
        {NOTIFICATION_CATEGORIES.filter((c) => c !== 'info').map((c) => (
          <label className="hd-check" key={c}>
            <input type="checkbox" checked={p.categories[c] !== false} onChange={(e) => setCategory(c, e.target.checked)} />
            <span>{t(`huddle.notifications.category.${c}`)}</span>
          </label>
        ))}
      </div>

      <div className="hd-sounds" role="group" aria-label={t('huddle.prefs.sounds.title')} data-hub-sounds>
        <div className="hd-muted">{t('huddle.prefs.sounds.title')}</div>
        <label className="hd-volume">
          <span>{t('huddle.prefs.sounds.volume')}</span>
          <input
            type="range" min={0} max={100} step={5} value={pct} data-sound-volume
            aria-valuetext={`${pct}%`}
            onPointerDown={() => { dragging.current = true; }}
            onPointerUp={() => { dragging.current = false; }}
            onBlur={() => { dragging.current = false; }}
            onChange={(e) => { const v = Number(e.target.value) / 100; setVolume(v); set({ volume: v }); }}
          />
          <output>{pct}%</output>
        </label>
        <div className="hd-sound-list" role="list" aria-label={t('huddle.prefs.sounds.previews')}>
          {SOUND_KINDS.map((kind) => {
            const name = t(`huddle.prefs.sounds.cue.${kind}.name`);
            const hint = t(`huddle.prefs.sounds.cue.${kind}.hint`);
            const on = p.cues[kind] !== false;
            return (
              <div className={`hd-sound-row${on ? '' : ' is-off'}`} role="listitem" key={kind}>
                {kind === 'signature'
                  // the signature is the app's own tune, rung by no event: only previews and the test notification play it
                  ? <span className="hd-sound-switch-gap" aria-hidden="true" />
                  : (
                    <input
                      type="checkbox" className="hd-sound-switch" data-sound-switch={kind} checked={on}
                      aria-label={t('huddle.prefs.sounds.switch', { name })} title={t('huddle.prefs.sounds.switch', { name })}
                      onChange={(e) => set({ cues: { [kind]: e.target.checked } })}
                    />
                  )}
                <button
                  className={`hd-btn hd-sound-play${playing === kind ? ' is-playing' : ''}`}
                  data-sound-preview={kind}
                  aria-label={t('huddle.prefs.sounds.play', { name })}
                  onClick={() => preview(kind)}
                >{name}</button>
                <span className="hd-muted hd-sound-hint" title={hint}>{hint}</span>
              </div>
            );
          })}
        </div>
        <div className="hd-muted">{p.sound ? t('huddle.prefs.sounds.previewHint') : t('huddle.prefs.sounds.previewHintOff')}</div>
      </div>

      <div className={`hd-desktop-status hd-desktop-${status}`} role="status">{t(`huddle.prefs.desktopStatus.${status}`)}</div>
      {snapshot.desktop.lastError && <div className="hd-muted" dir="auto">{snapshot.desktop.lastError}</div>}
      <div className="hd-row">
        <button className="hd-btn" onClick={() => { setTested(true); void api.test(); }}>{t('huddle.prefs.test')}</button>
        <button className="hd-btn hd-btn-ghost" onClick={() => void api.openSystemSettings()}>{t('huddle.prefs.systemSettings')}</button>
      </div>
      {tested && <div className="hd-muted">{t('huddle.prefs.tested')}</div>}
      <div className="hd-muted">{t('huddle.prefs.systemHint')}</div>
    </div>
  );
}
