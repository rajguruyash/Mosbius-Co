import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '@/store/store';
import { CLONE_NODE_BLURB, type OrgTriggerConfig, type TriggerMode } from '@shared/triggers';
import { getOrgTrigger, setOrgTrigger as persistOrgTrigger } from './api';
import { Callout, Field, Hint, MiniButton, ModePicker, SecretField, Toggle } from './ui';

/**
 * ORGANISATION — peer messaging between teammates' clone nodes.
 *
 * Configuration only. There is no transport service yet, so a key saved here
 * starts nothing; it is the setting the service will read once it exists. The
 * copy says exactly that rather than implying a connection.
 *
 * Renders off the store mirror that Settings → Connections also renders off, and
 * follows the same mirror-then-persist rule: typing the key updates the mirror
 * (so Settings stays live) and commits on blur; the toggle and the trust mode
 * persist on the spot.
 */
export function OrgSection({ onSummary }: { onSummary?: (s: string) => void }) {
  const { t } = useTranslation();
  const cfg = useStore((s) => s.orgTrigger);
  const mirror = useStore((s) => s.setOrgTrigger);
  const [revealed, setRevealed] = useState(false);
  // What the user is typing. The stored key is never sent here (only `hasKey`), so this field
  // starts empty; typing a new one and leaving the field replaces the stored key.
  const [draft, setDraft] = useState('');

  useEffect(() => {
    // Only when the mirror looks unseeded.
    if (useStore.getState().orgTrigger.hasKey !== undefined) return;
    void getOrgTrigger().then((c) => { if (c) mirror(c); });
  }, [mirror]);

  const hasKey = cfg.hasKey === true;

  useEffect(() => {
    onSummary?.(!hasKey ? t('orgSection.noKey') : cfg.enabled ? t('common.on') : t('common.off'));
  }, [cfg, hasKey, onSummary, t]);

  /** Toggle / trust mode: persisted on the spot. The key is not part of this. */
  const apply = (next: OrgTriggerConfig) => {
    mirror(next);
    void persistOrgTrigger(next).then((saved) => { if (saved) mirror(saved); });
  };
  /** Set (a string) or remove (null) the key. Write-only: the reply says only `hasKey`. */
  const saveKey = (key: string | null) => {
    void persistOrgTrigger(cfg, key).then((saved) => { if (saved) mirror(saved); });
  };

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ flex: 1, fontSize: 12, color: 'var(--cth-ink-700)' }}>
          {t('orgSection.acceptMessages')}
        </span>
        <Toggle on={cfg.enabled} onClick={() => apply({ ...cfg, enabled: !cfg.enabled })} />
      </div>

      <Field label={t('orgSection.key')}>
        <SecretField
          value={draft}
          revealed={revealed}
          onReveal={() => setRevealed((r) => !r)}
          placeholder={hasKey ? t('mcpDefaults.stored') : t('orgSection.keyPlaceholder')}
          onChange={setDraft}
          onBlur={() => { if (draft.trim()) { saveKey(draft.trim()); setDraft(''); setRevealed(false); } }}
        />
        {hasKey && <div style={{ marginTop: 4 }}><MiniButton onClick={() => saveKey(null)}>{t('common.remove')}</MiniButton></div>}
        <Hint>{CLONE_NODE_BLURB}</Hint>
      </Field>

      <Field label={t('orgSection.trust')}>
        <ModePicker value={cfg.mode} onChange={(mode: TriggerMode) => apply({ ...cfg, mode })} />
      </Field>

      <Callout tone="note">
        {t('orgSection.settingsOnly')}
      </Callout>

      {cfg.enabled && !hasKey && (
        <Callout>{t('orgSection.noKeyWarning')}</Callout>
      )}
    </>
  );
}
