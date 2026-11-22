/**
 * The thin Electron side of notifications: the file the history lives in, the operating system's banner, and
 * the sound. The rules live in notifyService.ts; this only does what the machine has to be asked to do.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { Notification, shell } from 'electron';
import { writeFileAtomic } from './atomicFile';
import { createSoundPortCore, type SoundPort } from './soundPort';
import type { DesktopOutcome, PersistedNotifyState } from './notifyService';

/** Read and write the notification history as one small JSON file. A file that does not parse is moved aside
 *  (not deleted) and the app starts with an empty history: losing a log must never stop a notification. */
export function createNotifyStore(file: string): { load(): unknown; save(state: PersistedNotifyState): void } {
  return {
    load(): unknown {
      if (!existsSync(file)) return undefined;
      try { return JSON.parse(readFileSync(file, 'utf8')); } catch {
        try { renameSync(file, `${file}.corrupt-${Date.now()}`); } catch { /* leave it */ }
        return undefined;
      }
    },
    save(state: PersistedNotifyState): void {
      mkdirSync(dirname(file), { recursive: true });
      writeFileAtomic(file, JSON.stringify(state));
    }
  };
}

/** Banners that have been shown and may still be clicked. Electron drops a Notification's click handler when
 *  the object is garbage collected, so the references are kept until the banner is closed or old. */
const live = new Set<Notification>();
const LIVE_MS = 10 * 60_000;

export interface DesktopHooks {
  /** The OS refused or lost a banner (reported by the platforms that tell us). */
  failed(error: string): void;
}

export function createDesktopPort(hooks: DesktopHooks): {
  supported(): boolean;
  show(n: { id: string; title: string; body: string; urgent: boolean }, onClick: () => void): DesktopOutcome;
} {
  return {
    supported(): boolean {
      try { return Notification.isSupported(); } catch { return false; }
    },
    show(n, onClick): DesktopOutcome {
      try {
        if (!Notification.isSupported()) return 'unsupported';
        // silent: the sound is the app's own (src/main/soundSynth.ts), so it follows the app's preference and still
        // plays when the operating system has banners switched off.
        const note = new Notification({
          title: n.title, body: n.body, silent: true,
          ...(process.platform === 'linux' ? { urgency: n.urgent ? 'critical' as const : 'normal' as const } : {})
        });
        const release = (): void => { live.delete(note); };
        note.on('click', () => { release(); try { onClick(); } catch { /* a click handler must not throw into Electron */ } });
        note.on('close', release);
        // Only Windows reports a banner it could not show; macOS and Linux say nothing either way.
        note.on('failed', (_e, error) => { release(); hooks.failed(String(error)); });
        live.add(note);
        const timer = setTimeout(release, LIVE_MS);
        timer.unref();
        note.show();
        return 'shown';
      } catch (e) {
        hooks.failed(e instanceof Error ? e.message : String(e));
        return 'failed';
      }
    }
  };
}

/** Where to send a person who wants to change the operating system's own notification settings. */
export function openSystemNotificationSettings(): void {
  const url = process.platform === 'darwin' ? 'x-apple.systempreferences:com.apple.Notifications-Settings.extension'
    : process.platform === 'win32' ? 'ms-settings:notifications' : null;
  if (url) void shell.openExternal(url).catch(() => undefined);
}

/**
 * The real sound port: the player is started with child_process and the fallback beep is Electron's. Everything it does
 * is in src/main/soundPort.ts, which never renders, writes or waits on the calling thread. `bundledDir` is the folder of
 * sounds that ship with the app (a `<cue>.wav` in it plays in place of the app's own synthesized sound for that cue).
 *
 * A real-app test run keeps everything real (the file, the player, the process) except the loudness: it plays at zero,
 * so a long run does not fill the room with chimes. Nothing else changes. A person who wants to LISTEN to the app while
 * a tour drives it starts the tour with --audible, which sets MOSBIUS_SOUND_AUDIBLE=1.
 */
export function createSoundPort(dataDir: string, volume: () => number, bundledDir?: string): SoundPort {
  return createSoundPortCore({
    dataDir, bundledDir, volume,
    silentRun: process.env.MOSBIUS_UI_TEST === '1' && process.env.MOSBIUS_SOUND_AUDIBLE !== '1',
    spawn: (cmd, args) => spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true }),
    beep: () => shell.beep()
  });
}
