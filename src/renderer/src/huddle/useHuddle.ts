import { useEffect, useState } from 'react';
import type { HuddleState } from '@shared/huddle';
import type { NotifySnapshot } from '../../../main/notifyService';

/** The agents, as the main process sees them. Subscribes on mount and unsubscribes on unmount: nothing here outlives the window. */
export function useHuddleState(): HuddleState | null {
  const [state, setState] = useState<HuddleState | null>(null);
  useEffect(() => {
    let live = true;
    const off = window.huddle.onState((s) => { if (live) setState(s); });
    void window.huddle.state().then((s) => { if (live && s) setState((cur) => cur ?? s); });
    return () => { live = false; off(); };
  }, []);
  return state;
}

/** Every notification, with what is open, the person's preferences, and whether the system is showing banners. */
export function useNotifications(): NotifySnapshot | null {
  const [snap, setSnap] = useState<NotifySnapshot | null>(null);
  useEffect(() => {
    let live = true;
    const off = window.huddle.onNotifications((s) => { if (live) setSnap(s); });
    void window.huddle.notifications().then((s) => { if (live && s) setSnap((cur) => cur ?? s); });
    return () => { live = false; off(); };
  }, []);
  return snap;
}

/** The current time, refreshed every `ms`, for "2m ago" labels. One interval per caller, cleared on unmount. */
export function useNow(ms = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
