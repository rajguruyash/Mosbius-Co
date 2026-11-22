/**
 * Playing a sound without ever holding anything up. The notification service asks this port to play a cue from the
 * middle of handling an agent's event, so everything it does on that call is cheap: look for the cue's file, start the
 * operating system's player as a separate process, and return. A file that does not exist yet (the very first sound,
 * before the background warm-up reached it) is made in slices with the event loop handed back between them
 * (src/main/soundSynth.ts), and played when it is ready if it is still wanted. Nothing here renders, writes or waits on
 * the calling thread.
 *
 * A WAV that stands in for the app's own sound for a cue is looked for in this order: a file the person put in
 * `<data folder>/sounds/custom/` named for the cue (`completed.wav`), then one that ships with the app in its bundled
 * sounds folder (`bundledDir`, `<cue>.wav`: today the task-complete sound), then the app's own synthesized sound. A
 * stand-in is played as it is, at the volume slider. The person's folder is theirs: the app never writes to it or removes
 * anything from it (the Windows copy at the volume, below, is the one thing it keeps there), and nothing in it is part of
 * the app.
 *
 * Electron-free: the process spawner and the system beep come in as parts, so the behaviour is unit-tested under plain Node
 * (src/main/notifyDelivery.ts supplies the real ones).
 */
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { SOUND_KINDS, type SoundKind } from '../shared/notifications';
import { volumeToGain } from '../shared/soundPolicy';
import { ensureSoundFileAsync, playerCommand, soundFileName } from './soundSynth';

/** One sound that was asked for, as the port handled it (the real-app checks read these; nothing else does). */
export interface SoundPlay {
  kind: SoundKind;
  at: number;
  /** The slider, 0 to 1. */
  volume: number;
  /** What the slider means as amplitude. */
  gain: number;
  /** Whether it was sent to the speakers at that gain (a silent test run, or a volume of zero, sends none). */
  audible: boolean;
  file: string;
  /** The service asked it to take over from a sound that was still sounding. */
  interrupt: boolean;
  /** And a player process really was cut off to let it. */
  interrupted: boolean;
}

export interface PlayerProcess {
  kill(): boolean;
  on(event: 'error' | 'exit', fn: () => void): unknown;
  unref(): void;
}

export interface SoundPortParts {
  dataDir: string;
  /**
   * The folder of sounds that ship with the app, `<cue>.wav` each (src/main/huddleSetup.ts says where it is). A cue with a file
   * there plays it in place of the app's own synthesized sound; a file the person put in sounds/custom/ still outranks it.
   */
  bundledDir?: string;
  /** The slider, read each time a sound plays. */
  volume: () => number;
  platform?: NodeJS.Platform;
  /** A real-app test run: everything real (the file, the player, the process) except the loudness, which is zero. */
  silentRun?: boolean;
  spawn: (cmd: string, args: string[]) => PlayerProcess;
  beep: () => void;
  now?: () => number;
  /** How long a sound waits for its file to be made before it is let go (a first-ever sound on a slow machine). */
  patienceMs?: number;
  /** Passed to the sliced renderer (the tests count the slices). */
  render?: Parameters<typeof ensureSoundFileAsync>[3];
}

export interface SoundPort {
  play(kind: SoundKind, opts?: { interrupt?: boolean }): boolean;
  history(): SoundPlay[];
  /** How long the sound that would play for this cue lasts, read from its file, or undefined when there is no file yet. */
  lengthMs(kind: SoundKind): number | undefined;
  /** Make every sound's file that is missing, a slice at a time. Called once, a few seconds after the app starts. */
  warm(): Promise<void>;
  /** Resolves when nothing is being made or waited for (for tests). */
  idle(): Promise<void>;
}

/** A WAV that plays for a cue in place of the app's own sound: the file, what the history calls it, and where a Windows copy at the volume is kept. */
interface StandIn { file: string; label: string; copies: string; shipped: boolean }

/** The length of a PCM WAV file in milliseconds, read from its header; undefined for anything else. */
export function wavLengthMs(file: string): number | undefined {
  let fd: number | null = null;
  try {
    fd = openSync(file, 'r');
    const head = Buffer.alloc(8192);
    const got = readSync(fd, head, 0, head.length, 0);
    if (got < 44 || head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') return undefined;
    let pos = 12;
    let byteRate = 0;
    while (pos + 8 <= got) {
      const id = head.toString('ascii', pos, pos + 4);
      const size = head.readUInt32LE(pos + 4);
      if (id === 'fmt ' && pos + 20 <= got) byteRate = head.readUInt32LE(pos + 16);
      if (id === 'data') {
        const real = Math.min(size, statSync(file).size - (pos + 8));
        return byteRate > 0 && real > 0 ? Math.round((real / byteRate) * 1000) : undefined;
      }
      pos += 8 + size + (size & 1);
    }
    return undefined;
  } catch { return undefined; } finally { if (fd !== null) { try { closeSync(fd); } catch { /* closed */ } } }
}

/**
 * A copy of a 16-bit PCM WAV at a gain, for a player that has no volume option (Windows'). Resolves false, and writes nothing,
 * for anything that is not 16-bit PCM: such a file is then played as it is.
 */
export async function writeScaledWav(src: string, dest: string, gain: number): Promise<boolean> {
  const buf = await readFile(src);
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return false;
  let pos = 12;
  let pcm16 = false;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === 'fmt ') pcm16 = buf.readUInt16LE(pos + 8) === 1 && buf.readUInt16LE(pos + 22) === 16;
    if (id === 'data') {
      if (!pcm16) return false;
      const end = Math.min(buf.length, pos + 8 + size);
      const out = Buffer.from(buf);
      for (let i = pos + 8; i + 1 < end; i += 2) out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(buf.readInt16LE(i) * gain))), i);
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, out);
      return true;
    }
    pos += 8 + size + (size & 1);
  }
  return false;
}

/**
 * Remove the app's own Windows copies of a shipped sound that were made for an older build of it (the stamp is the file's
 * modified time, which changes with each install), so they do not pile up. Only ever called for the app's own folder.
 */
async function dropStaleCopies(copies: string, kind: SoundKind, keepStamp: number): Promise<void> {
  try {
    for (const name of await readdir(copies)) {
      const m = /^([a-z]+)-(\d+)-g\d+\.wav$/.exec(name);
      if (m && m[1] === kind && Number(m[2]) !== keepStamp) await rm(join(copies, name), { force: true });
    }
  } catch { /* no folder yet, or a copy that is still playing: next time */ }
}

export function createSoundPortCore(parts: SoundPortParts): SoundPort {
  const platform = parts.platform ?? process.platform;
  const now = parts.now ?? Date.now;
  const patience = parts.patienceMs ?? 5000;
  const dir = join(parts.dataDir, 'sounds');
  const customDir = join(dir, 'custom');
  const plays: SoundPlay[] = [];
  const working = new Set<Promise<unknown>>();
  let broken = false;
  let player: PlayerProcess | null = null;

  const note = (p: SoundPlay): void => { plays.push(p); if (plays.length > 40) plays.shift(); };
  const track = (job: Promise<void>): void => { working.add(job); void job.finally(() => { working.delete(job); }); };

  /** Start the player on a file that exists. Cheap: one process, started and let go. */
  function launch(kind: SoundKind, file: string, label: string, vol: number, gain: number, heard: number, interrupt: boolean): void {
    let interrupted = false;
    if (interrupt && player) { try { interrupted = player.kill(); } catch { /* already finished */ } player = null; }
    const record = (name: string, audible: boolean): void => note({ kind, at: now(), volume: vol, gain, audible, file: name, interrupt, interrupted });
    if (broken) { try { parts.beep(); } catch { /* nothing to beep with */ } record('beep', true); return; }
    try {
      const cmd = playerCommand(platform, file, platform === 'win32' ? 1 : heard);
      if (!cmd) { parts.beep(); record('beep', true); return; }
      const child = parts.spawn(cmd.cmd, cmd.args);
      // no player on this machine (a Linux box without paplay): fall back to the system beep from now on
      child.on('error', () => { broken = true; });
      child.on('exit', () => { if (player === child) player = null; });
      child.unref();
      player = child;
      record(label, heard > 0);
    } catch {
      broken = true;
      try { parts.beep(); } catch { /* nothing to beep with */ }
      record('beep', true);
    }
  }

  /** The WAV that plays for this cue in place of the app's own sound: the person's own file if they put one in, else the one that ships with the app. */
  const standInFor = (kind: SoundKind): StandIn | null => {
    const own = join(customDir, `${kind}.wav`);
    if (existsSync(own)) return { file: own, label: `custom/${kind}.wav`, copies: join(customDir, '.scaled'), shipped: false };
    if (parts.bundledDir) {
      const shipped = join(parts.bundledDir, `${kind}.wav`);
      if (existsSync(shipped)) return { file: shipped, label: `bundled/${kind}.wav`, copies: join(dir, '.scaled'), shipped: true };
    }
    return null;
  };

  return {
    history: () => plays.map((p) => ({ ...p })),

    lengthMs(kind: SoundKind): number | undefined {
      const stand = standInFor(kind);
      const file = stand ? stand.file : join(dir, soundFileName(kind, 1));
      return existsSync(file) ? wavLengthMs(file) : undefined;
    },

    play(kind: SoundKind, opts?: { interrupt?: boolean }): boolean {
      const asked = parts.volume();
      const vol = Math.min(1, Math.max(0, Number.isFinite(asked) ? asked : 0));
      const gain = volumeToGain(vol);
      const heard = parts.silentRun ? 0 : gain;
      const interrupt = !!opts?.interrupt;
      // a person who turned the sound all the way down gets silence, not a player process; a test run still runs the player
      if (heard <= 0 && !parts.silentRun) {
        note({ kind, at: now(), volume: vol, gain, audible: false, file: '(volume is zero)', interrupt, interrupted: false });
        return true;
      }

      // a WAV that stands in for the app's own sound for this cue (theirs if they put one in, else the one that ships): played as it is, at the slider
      const stand = standInFor(kind);
      if (stand) {
        if (platform !== 'win32' || heard >= 0.995) { launch(kind, stand.file, stand.label, vol, gain, heard, interrupt); return true; }
        // Windows' player has no volume option: play a copy written at the gain (made off this call, kept for next time)
        const step = Math.max(0, Math.min(19, Math.round(heard * 20)));
        let stamp = 0;
        try { stamp = Math.floor(statSync(stand.file).mtimeMs); } catch { /* it just went: the copy will not be made */ }
        const scaled = join(stand.copies, `${kind}-${stamp}-g${step}.wav`);
        if (existsSync(scaled)) { launch(kind, scaled, stand.label, vol, gain, heard, interrupt); return true; }
        track((async () => {
          let made = false;
          try { made = await writeScaledWav(stand.file, scaled, step / 20); } catch { made = false; }
          launch(kind, made ? scaled : stand.file, stand.label, vol, gain, heard, interrupt);
          if (made && stand.shipped) await dropStaleCopies(stand.copies, kind, stamp);
        })());
        return true;
      }

      // Windows' player has no volume option, so there the file itself is written at the gain; elsewhere the player takes it
      const fileGain = platform === 'win32' ? heard : 1;
      const file = join(dir, soundFileName(kind, fileGain));
      if (existsSync(file)) { launch(kind, file, basename(file), vol, gain, heard, interrupt); return true; }
      // not made yet: make it without holding anything up, and play it if it is still wanted when it is ready
      const askedAt = now();
      track(ensureSoundFileAsync(dir, kind, fileGain, parts.render).then(
        (made) => { if (now() - askedAt <= patience) launch(kind, made, basename(made), vol, gain, heard, interrupt); },
        () => { broken = true; try { parts.beep(); } catch { /* nothing to beep with */ } }
      ));
      return true;
    },

    async warm(): Promise<void> {
      for (const kind of SOUND_KINDS) {
        if (standInFor(kind)) continue;                      // the person's own sound, or the one that ships, plays for this cue: the app's own has no work to do
        try { await ensureSoundFileAsync(dir, kind, 1, parts.render); } catch { /* a sound that cannot be made is made when it is asked for, or beeps */ }
      }
    },

    async idle(): Promise<void> {
      while (working.size > 0) await Promise.allSettled([...working]);
    }
  };
}
