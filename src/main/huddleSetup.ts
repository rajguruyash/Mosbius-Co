/**
 * Putting the Huddle and the notification system together, and giving the windows their IPC.
 *
 * index.ts hands this the things only it owns (the PTY manager, the hive, the hook server, the control registry)
 * and gets back a small runtime: calls to make when an agent starts, dies, is paused, trips the breaker, or the
 * broker refuses it; and nothing else. Everything the Huddle and notifications do lives behind this file, so
 * the rest of the main process changes by a handful of one-line calls.
 *
 * Who may call what:
 *  - the main window's page (and a floor's): enter the Huddle, report its roster, answer a command it was sent;
 *  - the Huddle's page: everything it needs to show and drive agents;
 *  - both: read and act on notifications.
 * Every handler checks the page it came from, and every payload is validated before it is used.
 */
import {
  BrowserWindow, app, clipboard, dialog, ipcMain, nativeImage, webContents as allWebContents, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents
} from 'electron';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ActivityTracker } from './activityTracker';
import { ActivityTracker as Tracker } from './activityTracker';
import { readConversation, type ConversationMessage } from './conversation';
import { HuddleHub, type HubPty, type HubTask } from './huddleHub';
import { HuddleWindow } from './huddleWindow';
import { isTrustedSender } from './ipcSender';
import { handleSignals } from './lifecycleWiring';
import { resolveNotification, validateResolve, type ActionPorts } from './notifyActions';
import { createDesktopPort, createNotifyStore, createSoundPort, openSystemNotificationSettings } from './notifyDelivery';
import { NotificationService, type NotifySnapshot } from './notifyService';
import { clip, scrubText } from '../shared/agentActivity';
import {
  validateCommand, validateRoster, isAgentId,
  type CommandResult, type HuddleLevel, type HuddleModeState, type HuddleState
} from '../shared/huddle';
import { intentFromAccessDenied, intentFromHumanAsk, isSoundKind, sanitizePrefs, type NotificationPrefsPatch, type NotificationRecord } from '../shared/notifications';
import en from '../renderer/src/i18n/locales/en.json';
import zhCN from '../renderer/src/i18n/locales/zh-CN.json';
import ar from '../renderer/src/i18n/locales/ar.json';

type Strings = Record<string, unknown>;
const NOTIFY_STRINGS: Record<string, Strings | undefined> = {
  en: (en as unknown as { notify?: Strings }).notify,
  'zh-CN': (zhCN as unknown as { notify?: Strings }).notify,
  ar: (ar as unknown as { notify?: Strings }).notify
};

export interface HuddleSetupDeps {
  isDev: boolean;
  ptyManager: {
    list(): Array<{ id: string; lastOutputAt: number; hasOutput: boolean }>;
    write(id: string, data: string): { ok: boolean; error?: string };
    redraw(id: string): { ok: boolean; error?: string };
    addTap(id: string, wc: WebContents): { ok: true; replay: string; cols: number; rows: number } | { ok: false; error: string };
    removeTap(id: string, wc: WebContents): void;
    removeTapsFor(wc: WebContents): void;
  };
  hive: {
    tasks(): unknown;
    registry(): { godId: string | null; agents: Record<string, { name?: string; isGod?: boolean; provider?: string; role?: string; archived?: boolean; cwd?: string }> };
    inbox(id: string): Array<{ id: string; from: string; to: string; subject: string; body: string; created_at: string; conversation: string }>;
    lastSession(agentId: string): string | undefined;
    patchTask(id: string, patch: Record<string, unknown>): { ok: boolean; error?: string } | unknown;
    send(partial: Record<string, unknown>, from?: string): { ok: boolean; error?: string } | unknown;
  };
  control: {
    snapshot(id: string): { paused: boolean; halted: boolean };
    pause(id: string, on: boolean): void;
    resume(id: string): void;
  };
  hookServer: { transcriptPath(agentId: string): string | undefined };
  persist: { getKv<T = unknown>(key: string): T | undefined; setKv(key: string, value: unknown): void };
  allWindows(): Iterable<BrowserWindow>;
  getMainWindow(): BrowserWindow | null;
  /** Kill an agent's process and do the usual teardown (archive, worktree, card). */
  killAgent(agentId: string, ptyId: string): { ok: boolean; error?: string };
  redact(text: string): string;
  trackMessageSent(): void;
  /** Project directory for a Claude transcript, when the hook has not told us the file yet. */
  transcriptFor(cwd: string, sessionId: string): string | null;
  /** The console, for diagnostics. */
  log(message: string): void;
}

export interface HuddleRuntime {
  tracker: ActivityTracker;
  notifications: NotificationService;
  hub: HuddleHub;
  window: HuddleWindow;
  /** Hand over to the hook server as its lifecycle observer. */
  observeHook: (agentId: string | undefined, h: Parameters<ActivityTracker['hook']>[1]) => void;
  noteSpawn(agentId: string): void;
  noteExit(agentId: string, info: { exitCode?: number; signal?: number; tail?: string }): void;
  noteControl(agentId: string): void;
  noteBreaker(state: { agentId: string; level: 'healthy' | 'steering' | 'constrained' | 'stopped'; reason?: string }): void;
  noteMcpAudit(e: { agentId: string; integrationId: string; tool?: string; decision: 'allow' | 'deny'; reason?: string }): void;
  noteHiveMessage(payload: { id: string; from: string; to: string; subject: string; needsHuman?: boolean }): void;
  noteUserWrite(agentId: string, data: string): void;
  /** Called from the main window's activate/before-quit paths. */
  leaveHuddle(): void;
  /** The app was activated (the Dock was clicked). Leaves the Huddle unless a notification click caused it. */
  appActivated(): void;
  dispose(): void;
}

const ASK_POLL_MS = 4000;
const COMMAND_TIMEOUT_MS = 25_000;
const MAX_ATTACHMENT_BYTES = 200 * 1024 * 1024;
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.heic', '.tiff', '.avif']);

function alive(wc: WebContents | null | undefined): wc is WebContents {
  return !!wc && !wc.isDestroyed();
}

export function setupHuddle(deps: HuddleSetupDeps): HuddleRuntime {
  const userData = app.getPath('userData');

  // ─── language, for the text of operating-system banners ──────────────────
  let language = (() => { try { const v = deps.persist.getKv<string>('ui.language'); return typeof v === 'string' && NOTIFY_STRINGS[v] ? v : 'en'; } catch { return 'en'; } })();
  const strings = (): Strings | undefined => ({ notify: NOTIFY_STRINGS[language] ?? NOTIFY_STRINGS.en });
  const reportLanguage = (lng: unknown): void => {
    if (typeof lng !== 'string' || !NOTIFY_STRINGS[lng] || lng === language) return;
    language = lng;
    try { deps.persist.setKv('ui.language', lng); } catch { /* best-effort */ }
  };

  // ─── who is watching ─────────────────────────────────────────────────────
  let huddleWindow!: HuddleWindow;
  const appPages = (): { devOrigin?: string; prodFileUrl?: string } =>
    deps.isDev && process.env.ELECTRON_RENDERER_URL
      ? { devOrigin: process.env.ELECTRON_RENDERER_URL }
      : { prodFileUrl: pathToFileURL(join(__dirname, '../renderer/index.html')).href };
  const huddlePages = (): { devOrigin?: string; prodFileUrl?: string } =>
    deps.isDev && process.env.ELECTRON_RENDERER_URL
      ? { devOrigin: process.env.ELECTRON_RENDERER_URL }
      : { prodFileUrl: pathToFileURL(join(__dirname, '../renderer/huddle.html')).href };
  const fromMainPage = (evt: IpcMainEvent | IpcMainInvokeEvent): boolean => {
    try { return isTrustedSender(evt.senderFrame, appPages()); } catch { return false; }
  };
  const fromHuddlePage = (evt: IpcMainEvent | IpcMainInvokeEvent): boolean => {
    try {
      const wc = huddleWindow.webContents();
      return !!wc && evt.sender.id === wc.id && isTrustedSender(evt.senderFrame, huddlePages());
    } catch { return false; }
  };
  const fromEither = (evt: IpcMainEvent | IpcMainInvokeEvent): boolean => fromMainPage(evt) || fromHuddlePage(evt);

  const watchers = (): WebContents[] => {
    const out: WebContents[] = [];
    for (const w of deps.allWindows()) if (!w.isDestroyed() && alive(w.webContents)) out.push(w.webContents);
    const h = huddleWindow?.webContents();
    if (alive(h)) out.push(h);
    return out;
  };
  const toAll = (channel: string, payload: unknown): void => {
    for (const wc of watchers()) { try { wc.send(channel, payload); } catch { /* a window going away */ } }
  };

  // ─── the pieces ──────────────────────────────────────────────────────────
  let hub!: HuddleHub;
  let notifications!: NotificationService;

  const agentRef = (id: string): { id: string; name: string; isGod: boolean } => {
    const reg = deps.hive.registry();
    return { id, name: hub.agentName(id), isGod: hub.isGod(id) || reg.godId === id };
  };

  const tracker = new Tracker({
    redact: deps.redact,
    onSignals: (agentId, signals, activity) => {
      handleSignals({ notifications, agentRef, now: Date.now }, agentId, signals, activity);
      hub.refresh();
    },
    onChange: () => hub.refresh()
  });

  const desktop = createDesktopPort({ failed: (e) => notifications.noteDesktopResult(false, e) });
  // The sounds that ship with the app: electron-builder's extraResources puts them in <resources>/sounds (a plain folder, because the
  // operating system's player cannot read inside the asar); a development run reads the repo's resources/sounds.
  const bundledSounds = app.isPackaged ? join(process.resourcesPath, 'sounds') : join(app.getAppPath(), 'resources', 'sounds');
  const sound = createSoundPort(userData, () => notifications.volume(), bundledSounds);
  // Make every sound's file in the background a few seconds after start, a slice at a time, so that the first sound a person
  // hears is never the one that had to be made while an agent waited.
  const warmUp = setTimeout(() => { void sound.warm(); }, 5_000);
  warmUp.unref();
  const store = createNotifyStore(join(userData, 'notifications.json'));

  /** When a banner was last clicked: macOS activates the app for that click too, and that is not a request to leave the Huddle. */
  let bannerClickAt = 0;
  const openAgent = (agentId: string): void => {
    bannerClickAt = Date.now();
    // Notification clicked, or "open" pressed: show that agent where the person is working.
    if (huddleWindow.isActive()) {
      huddleWindow.setLevel('agent', agentId);
      toAll('huddle:openAgent', { agentId });
    } else {
      const main = deps.getMainWindow();
      if (main && !main.isDestroyed()) {
        if (main.isMinimized()) main.restore();
        main.show(); main.focus();
        main.webContents.send('huddle:command', { corr: '', type: 'select', agentId });
      }
    }
  };
  const openSettings = (section: string): void => {
    bannerClickAt = Date.now();
    // Settings live in the main window: bring it back (which ends the Huddle) and open the page there.
    if (huddleWindow.isActive()) huddleWindow.exit({ restoreMain: true });
    const main = deps.getMainWindow();
    if (main && !main.isDestroyed()) {
      if (main.isMinimized()) main.restore();
      main.show(); main.focus();
      main.webContents.send('huddle:command', { corr: '', type: 'openSettings', section });
    }
  };

  notifications = new NotificationService({
    now: Date.now,
    load: () => store.load(),
    save: (s) => store.save(s),
    showDesktop: (n, onClick) => desktop.show(n, onClick),
    desktopSupported: () => desktop.supported(),
    playSound: (k, o) => sound.play(k, o),
    soundMs: (k) => sound.lengthMs(k),
    strings,
    changed: (snap: NotifySnapshot) => { toAll('notify:changed', snap); hub.refresh(); },
    activate: (record: NotificationRecord) => {
      if (!record.agentId || record.id === 'summary') { openAgentOrMain(); return; }
      notifications.markRead(record.id);
      if (record.category === 'access' && record.actions.includes('settings')) openSettings('Integrations & Skills');
      else openAgent(record.agentId);
    },
    agentName: (id) => hub.agentName(id)
  });
  function openAgentOrMain(): void {
    if (huddleWindow.isActive()) { huddleWindow.setLevel('expanded'); return; }
    const main = deps.getMainWindow();
    if (main && !main.isDestroyed()) { if (main.isMinimized()) main.restore(); main.show(); main.focus(); }
  }

  // commands that must run in the window that owns an agent's roster
  const pendingAsks = new Map<string, { resolve: (r: CommandResult) => void; timer: NodeJS.Timeout }>();
  let corrSeq = 0;
  const ownerOf = (agentId: string): WebContents | null => {
    const src = hub.sourceOf(agentId);
    const wc = src !== undefined ? allWebContents.fromId(src) : null;
    return alive(wc) ? wc : null;
  };

  const attachmentOk = (path: string): { ok: true } | { ok: false; error: string } => {
    try {
      if (!isAbsolute(path)) return { ok: false, error: 'not an absolute path' };
      const st = statSync(path);
      if (!st.isFile()) return { ok: false, error: 'not a file' };
      if (st.size > MAX_ATTACHMENT_BYTES) return { ok: false, error: 'too large' };
      return { ok: true };
    } catch { return { ok: false, error: 'missing' }; }
  };

  hub = new HuddleHub({
    now: Date.now,
    livePtys: (): HubPty[] => deps.ptyManager.list(),
    tracker, notifications,
    tasks: (): HubTask[] => {
      const t = deps.hive.tasks() as { tasks?: HubTask[] } | null;
      return Array.isArray(t?.tasks) ? t.tasks : [];
    },
    registry: () => { try { return deps.hive.registry().agents; } catch { return {}; } },
    controlSnapshot: (id) => deps.control.snapshot(id),
    setPaused: (id, paused) => {
      if (paused) deps.control.pause(id, true); else deps.control.resume(id);
      tracker.control(id, deps.control.snapshot(id));
    },
    ptyWrite: (ptyId, data) => {
      const r = deps.ptyManager.write(ptyId, data);
      return r;
    },
    killAgent: (agentId) => {
      const ptyId = hub.ptyIdOf(agentId);
      if (!ptyId) return { ok: false, error: 'no-terminal' };
      return deps.killAgent(agentId, ptyId);
    },
    toOwner: (agentId, channel, payload) => {
      const wc = ownerOf(agentId);
      if (!wc) return false;
      try { wc.send(channel, payload); return true; } catch { return false; }
    },
    askOwner: (agentId, command) => new Promise<CommandResult>((resolve) => {
      const wc = ownerOf(agentId);
      if (!wc) { resolve({ ok: false, error: 'main-window-unavailable' }); return; }
      const corr = `c${++corrSeq}`;
      const timer = setTimeout(() => { pendingAsks.delete(corr); resolve({ ok: false, error: 'timed-out' }); }, COMMAND_TIMEOUT_MS);
      pendingAsks.set(corr, { resolve, timer });
      try { wc.send('huddle:command', { corr, ...command }); }
      catch { clearTimeout(timer); pendingAsks.delete(corr); resolve({ ok: false, error: 'main-window-unavailable' }); }
    }),
    validateAttachment: attachmentOk,
    broadcast: (state: HuddleState) => {
      toAll('huddle:state', state);
      huddleWindow.agentCountChanged();
    },
    mode: (): HuddleModeState => huddleWindow.state(),
    countMessageSent: () => deps.trackMessageSent()
  });

  huddleWindow = new HuddleWindow({
    preload: join(__dirname, '../preload/huddle.js'),
    load: (win) => {
      if (deps.isDev && process.env.ELECTRON_RENDERER_URL) void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/huddle.html`);
      else void win.loadFile(join(__dirname, '../renderer/huddle.html'));
    },
    getMainWindow: deps.getMainWindow,
    loadPrefs: () => deps.persist.getKv('huddle.prefs'),
    savePrefs: (p) => deps.persist.setKv('huddle.prefs', p),
    agentCount: () => hub.state().agents.length,
    onMode: () => { hub.refresh(); hub.flush(); },
    onClosed: (wc) => { deps.ptyManager.removeTapsFor(wc); }
  });
  hub.start();

  // ─── actions on notifications ────────────────────────────────────────────
  const actionPorts: ActionPorts = {
    notifications,
    ptyIdOf: (id) => hub.ptyIdOf(id),
    ptyAlive: (ptyId) => deps.ptyManager.list().some((p) => p.id === ptyId),
    ptyWrite: (ptyId, data) => deps.ptyManager.write(ptyId, data),
    noteKeys: (agentId, keys) => tracker.userInput(agentId, keys),
    sendMessage: (agentId, text) => hub.command({ type: 'send', agentId, text, attachments: [] }),
    answerTask: (taskId, text) => answerTask(taskId, text),
    openAgent, openSettings,
    restartAgent: (agentId) => hub.command({ type: 'restart', agentId })
  };

  /** Write the person's answer onto the task's open question and tell the orchestrator, as the ASK ME tab does. */
  function answerTask(taskId: string, text: string): { ok: boolean; error?: string } {
    try {
      const t = deps.hive.tasks() as { tasks?: Array<{ id: string; title: string; humanQA?: Array<{ q: string; a?: string; dismissedAt?: string }> }> } | null;
      const task = t?.tasks?.find((x) => x.id === taskId);
      const open = task?.humanQA ? [...task.humanQA].reverse().find((e) => !e.a && !e.dismissedAt) : undefined;
      if (!task || !open) return { ok: false, error: 'no-open-question' };
      const qa = (task.humanQA ?? []).map((e) => (e === open ? { ...e, a: text, answeredAt: new Date().toISOString() } : e));
      const patched = deps.hive.patchTask(taskId, { humanQA: qa }) as { ok?: boolean } | undefined;
      if (patched && patched.ok === false) return { ok: false, error: 'task-changed' };
      deps.hive.send({
        to: 'god', act: 'inform', subject: `HUMAN ANSWER on task "${task.title}"`,
        body: [
          `The human answered the open question on task ${taskId} ("${task.title}"):`, `Q: ${open.q}`, `A: ${text}`,
          'The answer is also recorded in the card\'s humanQA. Act on it, unblock the card, and continue the work.'
        ].join('\n')
      }, 'human');
      deps.trackMessageSent();
      return { ok: true };
    } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
  }

  // ─── questions put to the human through the hive ─────────────────────────
  const openAskKeys = new Set<string>();
  function pollAsks(): void {
    try {
      const t = deps.hive.tasks() as { tasks?: Array<{ id: string; title: string; status: string; assignee?: string; humanQA?: Array<{ q: string; a?: string; dismissedAt?: string }> }> } | null;
      const now = new Set<string>();
      const godId = deps.hive.registry().godId ?? 'god';
      for (const task of t?.tasks ?? []) {
        if (task.status !== 'blocked' || !Array.isArray(task.humanQA)) continue;
        const open = [...task.humanQA].reverse().find((e) => e && typeof e.q === 'string' && !e.a && !e.dismissedAt);
        if (!open) continue;
        const key = `${task.id}:${scrubText(open.q).length}:${open.q.slice(0, 40)}`;
        now.add(key);
        if (!openAskKeys.has(key)) {
          const who = task.assignee && hub.rosterOf(task.assignee) ? task.assignee : godId;
          notifications.ingest(intentFromHumanAsk(agentRef(who), { taskId: task.id, subject: task.title, question: deps.redact(open.q), key }), hub.agentName(who));
        }
      }
      // answered or dismissed (in the ASK ME tab, or by an agent that moved on): close what was waiting
      for (const key of openAskKeys) if (!now.has(key)) notifications.resolveWhere((r) => r.requestKey.endsWith(`|ask|${key}`), { by: 'user', action: 'answered', note: 'answered-elsewhere' });
      openAskKeys.clear(); for (const k of now) openAskKeys.add(k);
    } catch { /* the hive is not ready; try again */ }
  }
  const askTimer = setInterval(pollAsks, ASK_POLL_MS);
  askTimer.unref();

  // ─── the windows' IPC ────────────────────────────────────────────────────
  const FORBIDDEN = { ok: false as const, error: 'forbidden' };

  // the main window reports its roster, and answers commands
  const rosterSources = new Set<number>();
  ipcMain.on('huddle:publishRoster', (evt, raw: unknown) => {
    if (!fromMainPage(evt)) return;
    const id = evt.sender.id;
    hub.setRoster(id, validateRoster(raw));
    if (!rosterSources.has(id)) {
      rosterSources.add(id);
      evt.sender.once('destroyed', () => { rosterSources.delete(id); hub.dropSource(id); });
    }
  });
  ipcMain.handle('huddle:commandDone', (evt, corr: unknown, result: unknown) => {
    if (!fromMainPage(evt)) return FORBIDDEN;
    if (typeof corr !== 'string') return { ok: false };
    const p = pendingAsks.get(corr);
    if (p) {
      clearTimeout(p.timer); pendingAsks.delete(corr);
      const r = (result && typeof result === 'object' ? result : {}) as { ok?: unknown; error?: unknown };
      p.resolve({ ok: r.ok === true, ...(typeof r.error === 'string' ? { error: clip(r.error, 200) } : {}) });
    }
    return { ok: true };
  });

  ipcMain.handle('huddle:enter', (evt) => {
    if (!fromMainPage(evt)) return FORBIDDEN;
    huddleWindow.enter();
    return { ok: true };
  });
  ipcMain.handle('huddle:exit', (evt) => {
    if (!fromEither(evt)) return FORBIDDEN;
    huddleWindow.exit({ restoreMain: true });
    return { ok: true };
  });
  ipcMain.handle('huddle:setLevel', (evt, level: unknown, agentId: unknown) => {
    if (!fromHuddlePage(evt)) return FORBIDDEN;
    if (level !== 'compact' && level !== 'expanded' && level !== 'agent') return { ok: false, error: 'bad-level' };
    if (level === 'agent' && !isAgentId(agentId)) return { ok: false, error: 'bad-agent' };
    huddleWindow.setLevel(level as HuddleLevel, level === 'agent' ? (agentId as string) : null);
    return { ok: true };
  });
  ipcMain.handle('huddle:keyboard', (evt, on: unknown) => {
    if (!fromHuddlePage(evt)) return FORBIDDEN;
    huddleWindow.setKeyboard(on === true);
    return { ok: true };
  });
  ipcMain.handle('huddle:getState', (evt) => {
    if (!fromEither(evt)) return null;
    return hub.state();
  });
  ipcMain.handle('huddle:command', async (evt, raw: unknown) => {
    if (!fromHuddlePage(evt)) return FORBIDDEN;
    const cmd = validateCommand(raw);
    if (!cmd) return { ok: false, error: 'invalid-command' };
    return hub.command(cmd);
  });

  // notifications: both windows
  ipcMain.handle('notify:get', (evt) => { if (!fromEither(evt)) return null; return notifications.snapshot(); });
  ipcMain.handle('notify:resolve', async (evt, raw: unknown) => {
    if (!fromEither(evt)) return FORBIDDEN;
    const req = validateResolve(raw);
    if (!req) return { ok: false, error: 'invalid-request' };
    const r = await resolveNotification(actionPorts, req);
    hub.refresh();
    return r;
  });
  ipcMain.handle('notify:markRead', (evt, id: unknown) => { if (!fromEither(evt)) return FORBIDDEN; if (typeof id === 'string') notifications.markRead(id); return { ok: true }; });
  ipcMain.handle('notify:markAllRead', (evt) => { if (!fromEither(evt)) return FORBIDDEN; notifications.markAllRead(); return { ok: true }; });
  ipcMain.handle('notify:clear', (evt) => { if (!fromEither(evt)) return FORBIDDEN; return { ok: true, removed: notifications.clear() }; });
  // A patch, not a whole object: two quick changes (each made from a snapshot that may be a moment stale) must not undo each other.
  ipcMain.handle('notify:setPrefs', (evt, raw: unknown) => {
    if (!fromEither(evt)) return FORBIDDEN;
    const cur = notifications.getPrefs();
    const patch = (raw && typeof raw === 'object' ? raw : {}) as NotificationPrefsPatch;
    // the kinds and the sounds are merged one by one: a patch that names one of them must not switch the others back
    return { ok: true, prefs: notifications.setPrefs(sanitizePrefs({ ...cur, ...patch, categories: { ...cur.categories, ...(patch.categories ?? {}) }, cues: { ...cur.cues, ...(patch.cues ?? {}) } })) };
  });
  ipcMain.handle('notify:testDesktop', (evt) => { if (!fromEither(evt)) return FORBIDDEN; return { ok: true, status: notifications.testDesktop() }; });
  // The Settings page's "play" buttons: the sound alone. Never a notification, never a change to an agent.
  ipcMain.handle('notify:previewSound', (evt, kind: unknown) => {
    if (!fromEither(evt)) return FORBIDDEN;
    if (!isSoundKind(kind)) return { ok: false, error: 'unknown-sound' };
    return { ok: notifications.previewSound(kind) === 'played' };
  });
  ipcMain.handle('notify:openSystemSettings', (evt) => { if (!fromEither(evt)) return FORBIDDEN; openSystemNotificationSettings(); return { ok: true }; });
  ipcMain.on('app:reportLanguage', (evt, lng: unknown) => { if (fromEither(evt)) reportLanguage(lng); });

  // the Huddle's terminal view: a read-only mirror of the agent's terminal
  ipcMain.handle('huddle:terminalAttach', (evt, agentId: unknown) => {
    if (!fromHuddlePage(evt)) return FORBIDDEN;
    if (!isAgentId(agentId)) return { ok: false, error: 'bad-agent' };
    const ptyId = hub.ptyIdOf(agentId);
    if (!ptyId) return { ok: false, error: 'no-terminal' };
    const r = deps.ptyManager.addTap(ptyId, evt.sender);
    if (!r.ok) return r;
    // ask the program to repaint what is on its screen, so the view is exact rather than a replay of a replay
    setTimeout(() => { try { deps.ptyManager.redraw(ptyId); } catch { /* it may have just ended */ } }, 60);
    return { ok: true, ptyId, replay: r.replay, cols: r.cols, rows: r.rows };
  });
  ipcMain.handle('huddle:terminalDetach', (evt, agentId: unknown) => {
    if (!fromHuddlePage(evt)) return FORBIDDEN;
    const ptyId = isAgentId(agentId) ? hub.ptyIdOf(agentId) : undefined;
    if (ptyId) deps.ptyManager.removeTap(ptyId, evt.sender);
    return { ok: true };
  });

  // the Huddle's conversation view
  ipcMain.handle('huddle:conversation', (evt, agentId: unknown) => {
    if (!fromHuddlePage(evt)) return FORBIDDEN;
    if (!isAgentId(agentId)) return { ok: false, error: 'bad-agent' };
    try {
      let file = deps.hookServer.transcriptPath(agentId);
      if (!file) {
        const sid = deps.hive.lastSession(agentId);
        const cwd = hub.rosterOf(agentId)?.cwd ?? deps.hive.registry().agents[agentId]?.cwd;
        if (sid && cwd) file = deps.transcriptFor(cwd, sid) ?? undefined;
      }
      if (file && existsSync(file)) {
        const r = readConversation(file, { redact: deps.redact });
        return { ok: true as const, source: 'transcript' as const, messages: r.messages, truncated: r.truncated };
      }
      // an engine with no transcript we can read: the hive thread is the conversation we do have
      const thread: ConversationMessage[] = deps.hive.inbox(agentId).slice(-40).map((m) => ({
        id: m.id,
        role: m.from === agentId ? 'assistant' as const : 'user' as const,
        text: clip(deps.redact(`${m.subject ? `${m.subject}\n` : ''}${m.body}`), 4000),
        at: Date.parse(m.created_at) || undefined
      }));
      return { ok: true as const, source: 'hive' as const, messages: thread, truncated: false };
    } catch (e) { return { ok: false as const, error: e instanceof Error ? e.message : String(e) }; }
  });

  // attachments
  ipcMain.handle('huddle:pickFiles', async (evt, kind: unknown) => {
    if (!fromHuddlePage(evt)) return FORBIDDEN;
    const images = kind === 'images';
    // Real-app tour only: the system's file dialog cannot be driven from outside, so the tour names the files.
    if (process.env.MOSBIUS_UI_TEST === '1' && process.env.MOSBIUS_TEST_PICK) {
      try {
        const named = (JSON.parse(process.env.MOSBIUS_TEST_PICK) as string[]).filter((p) => attachmentOk(p).ok);
        const want = images ? named.filter((p) => IMAGE_EXT.has(extname(p).toLowerCase())) : named;
        return { ok: true as const, files: want.map((p) => ({ path: p, name: basename(p), image: IMAGE_EXT.has(extname(p).toLowerCase()) })) };
      } catch { /* fall through to the real dialog */ }
    }
    const res = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      title: images ? 'Attach images' : 'Attach files',
      filters: images ? [{ name: 'Images', extensions: [...IMAGE_EXT].map((e) => e.slice(1)) }] : [{ name: 'All Files', extensions: ['*'] }]
    });
    if (res.canceled || res.filePaths.length === 0) return { ok: false as const, error: 'cancelled' };
    const files = res.filePaths.filter((p) => attachmentOk(p).ok).slice(0, 12).map((p) => ({ path: p, name: basename(p), image: IMAGE_EXT.has(extname(p).toLowerCase()) }));
    return { ok: true as const, files };
  });
  ipcMain.handle('huddle:previewFile', async (evt, path: unknown) => {
    if (!fromHuddlePage(evt)) return FORBIDDEN;
    if (typeof path !== 'string' || !attachmentOk(path).ok) return { ok: false, error: 'unreadable' };
    try {
      const size = statSync(path).size;
      if (IMAGE_EXT.has(extname(path).toLowerCase()) && size <= 25 * 1024 * 1024) {
        const img = nativeImage.createFromPath(path);
        if (!img.isEmpty()) {
          const s = img.getSize();
          const scale = Math.min(1, 320 / Math.max(s.width, s.height, 1));
          const thumb = scale < 1 ? img.resize({ width: Math.max(1, Math.round(s.width * scale)), height: Math.max(1, Math.round(s.height * scale)) }) : img;
          return { ok: true as const, kind: 'image' as const, dataUrl: thumb.toDataURL(), width: s.width, height: s.height, bytes: size };
        }
      }
      const icon = await app.getFileIcon(path, { size: 'normal' });
      return { ok: true as const, kind: 'file' as const, dataUrl: icon.isEmpty() ? undefined : icon.toDataURL(), bytes: size };
    } catch { return { ok: false, error: 'unreadable' }; }
  });
  ipcMain.handle('huddle:pasteImage', (evt) => {
    if (!fromHuddlePage(evt)) return FORBIDDEN;
    try {
      const img = clipboard.readImage();
      if (img.isEmpty()) return { ok: false as const, error: 'no image in clipboard' };
      const dir = join(app.getPath('temp'), 'cth-pastes');
      mkdirSync(dir, { recursive: true });
      const name = `paste-${Date.now()}.png`;
      const dest = join(dir, name);
      writeFileSync(dest, img.toPNG());
      return { ok: true as const, file: { path: dest, name, image: true } };
    } catch (e) { return { ok: false as const, error: e instanceof Error ? e.message : String(e) }; }
  });

  // a read-only view of the window for the real-app tour; off unless that tour started the app
  if (process.env.MOSBIUS_UI_TEST === '1') {
    ipcMain.handle('huddle:debug', (evt) => {
      if (!fromEither(evt)) return null;
      const taps: Record<string, number> = {};
      for (const a of hub.state().agents) { const id = hub.ptyIdOf(a.id); if (id) taps[a.id] = (deps.ptyManager as unknown as { tapCount(id: string): number }).tapCount(id); }
      const activity = Object.fromEntries(tracker.ids().map((id) => { const a = tracker.get(id); return [id, a ? { alive: a.alive, turn: a.turn.active, tool: a.tool, pending: a.pending?.kind, lastEventAt: a.lastEventAt } : null]; }));
      return { window: huddleWindow.describe(), state: hub.state(), notifications: notifications.snapshot(), sounds: sound.history(), language, taps, activity, roster: hub.state().agents.map((a) => [a.id, a.name]) };
    });
    ipcMain.handle('huddle:debugMove', (evt, x: unknown, y: unknown) => {
      if (!fromEither(evt) || typeof x !== 'number' || typeof y !== 'number') return null;
      huddleWindow.debugMoveAndRelease(x, y);
      return huddleWindow.describe();
    });
  }

  // ─── what index.ts calls ─────────────────────────────────────────────────
  /** An agent wrote to the human (a message the hive routes to "human"). Only the subject travels: that is what
   *  the routing event carries, and it is enough to know who is asking and about what. */
  const noteHumanMessage = (m: { id: string; from: string; subject: string }): void => {
    const agent = agentRef(m.from);
    const subject = clip(deps.redact(m.subject), 200);
    notifications.ingest({ ...intentFromHumanAsk(agent, { subject, question: subject, key: `msg:${m.id}` }), actions: ['open'] }, agent.name);
  };

  const runtime: HuddleRuntime = {
    tracker, notifications, hub, window: huddleWindow,
    observeHook: (agentId, h) => { if (agentId) tracker.hook(agentId, h); },
    noteSpawn: (agentId) => tracker.spawn(agentId),
    noteExit: (agentId, info) => tracker.exit(agentId, info),
    noteControl: (agentId) => tracker.control(agentId, deps.control.snapshot(agentId)),
    noteBreaker: (s) => { if (s && isAgentId(s.agentId)) tracker.breaker(s.agentId, s.level, s.reason); },
    noteMcpAudit: (e) => {
      if (!e.agentId) return;
      if (e.decision === 'allow') {
        // access was granted (or already there): whatever was asking for it is answered
        notifications.resolveByKey(`${e.agentId}|access|${e.integrationId}`, { by: 'system', action: 'resolved', note: 'access-granted' });
        return;
      }
      if (!/no access granted|tool not granted/.test(e.reason ?? '')) return;
      notifications.ingest(intentFromAccessDenied(agentRef(e.agentId), { integrationId: e.integrationId, tool: e.tool, reason: e.reason }), hub.agentName(e.agentId));
    },
    noteHiveMessage: (p) => { if (p.needsHuman && p.from && p.from !== 'human') noteHumanMessage(p); },
    noteUserWrite: (agentId, data) => tracker.userInput(agentId, data),
    leaveHuddle: () => { if (huddleWindow.isActive()) huddleWindow.exit({ restoreMain: true }); },
    appActivated: () => {
      if (!huddleWindow.isActive()) return;
      const at = Date.now();
      // give a banner click, which activates the app too, a moment to say it was one
      setTimeout(() => { if (huddleWindow.isActive() && bannerClickAt < at - 1500) huddleWindow.exit({ restoreMain: true }); }, 700).unref();
    },
    dispose: () => {
      clearInterval(askTimer);
      hub.dispose();
      notifications.dispose();
      huddleWindow.dispose();
      for (const p of pendingAsks.values()) clearTimeout(p.timer);
      pendingAsks.clear();
    }
  };
  return runtime;
}

