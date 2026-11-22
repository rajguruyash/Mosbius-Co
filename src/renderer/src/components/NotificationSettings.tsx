import { useTranslation } from 'react-i18next';
import { PrefsPanel } from '@/huddle/PrefsPanel';
import { useNotificationSnapshot } from './NotificationBell';

/** Settings → General → Notifications: the same switches the Huddle's panel has, in the same words. */
export function NotificationSettings({ headStyle }: { headStyle: React.CSSProperties }): JSX.Element {
  const { t } = useTranslation();
  const snap = useNotificationSnapshot();
  return (
    <div>
      <div style={headStyle}>{t('settings.general.notifications')}</div>
      {snap && (
        <PrefsPanel snapshot={snap} api={{
          setPrefs: (p) => window.cth.notificationPrefs(p),
          test: () => window.cth.notificationsTest(),
          openSystemSettings: () => window.cth.notificationsOpenSystemSettings(),
          previewSound: (kind) => window.cth.notificationPreviewSound(kind)
        }} />
      )}
    </div>
  );
}
