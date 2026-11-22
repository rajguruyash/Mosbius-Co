/**
 * Turning the main process's structured answers into words in the person's language.
 * The main process sends verbs and codes, never sentences; these are the only places they become text.
 */
import type { TFunction } from 'i18next';
import type { ActivityLabel } from '@shared/agentActivity';
import type { NotifText } from '@shared/notifications';

type Exists = (key: string) => boolean;

/** "Running npm test", or "Running a command" when the agent gave no detail. */
export function activityText(t: TFunction, exists: Exists, label: ActivityLabel): string {
  const base = `huddle.activity.${label.verb}`;
  if (label.arg) return exists(base) ? t(base, { arg: label.arg }) : label.arg;
  return exists(`${base}Bare`) ? t(`${base}Bare`) : t(base, { arg: '' }).replace(/\s*[:：]\s*$/, '').trim();
}

/** How long ago, in the shortest honest words: "just now", "40s", "5m", "2h". */
export function agoText(t: TFunction, ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 5) return t('huddle.since.now');
  if (s < 60) return t('huddle.since.seconds', { count: s });
  const m = Math.floor(s / 60);
  if (m < 60) return t('huddle.since.minutes', { count: m });
  return t('huddle.since.hours', { count: Math.floor(m / 60) });
}

/** A refusal from the main process, in words. Unknown codes are shown as they are rather than hidden. */
export function errorText(t: TFunction, exists: Exists, code: string | undefined): string {
  if (!code) return '';
  const k = `huddle.errors.${code}`;
  return exists(k) ? t(k) : exists(`huddle.notifications.${code}`) ? t(`huddle.notifications.${code}`) : code;
}

export function noteText(t: TFunction, text: NotifText): string {
  return t(text.key, text.args as Record<string, string | number> | undefined);
}

/** The words for a count of waiting messages. */
export function queuedText(t: TFunction, n: number): string {
  return n === 1 ? t('huddle.progress.queuedOne', { count: n }) : t('huddle.progress.queuedMany', { count: n });
}
