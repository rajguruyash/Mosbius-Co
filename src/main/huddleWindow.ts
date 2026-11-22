/**
 * The Huddle window: a small frameless window that floats above everything, can be dragged, docks to the left
 * or right edge of a screen, and does not take the keyboard from whatever you were typing in.
 *
 * What the platforms allow, and what is done about it:
 *  - It is created NOT focusable. A window that cannot become the key window cannot take the keyboard, whatever
 *    happens to it: it appears with showInactive(), a click on a button acts at once (acceptFirstMouse) without
 *    activating this app, and the app you were typing in keeps its cursor. It becomes focusable only while the
 *    person is typing into one of its own text fields (setKeyboard), and goes back afterwards.
 *  - macOS: above other windows at the 'screen-saver' level, and visible on full-screen Spaces (the "visible on
 *    full-screen" collection behaviour), so it can stay over a full-screen app. (Electron's `type: 'panel'` was
 *    tried first and macOS rejects its non-activating style on this window class, so it is not used.)
 *  - Windows: showInactive() and always-on-top; a non-focusable window is not activated by a click.
 *  - Linux: always-on-top is honoured by most X11 window managers and ignored on some Wayland compositors.
 *
 * It owns no agent state. Entering the Huddle minimises the main window; leaving it restores the main window.
 * The agents are untouched either way.
 */
import { BrowserWindow, app, screen, type Rectangle, type WebContents } from 'electron';
import {
  chooseDisplay, levelSize, placeFromSaved, resizeAnchored, sanitizeHuddlePrefs, snapAfterMove,
  type DisplayLite, type DockEdge, type HuddleLevel, type HuddleModeState, type HuddlePrefs, type Rect
} from '../shared/huddle';

export interface HuddleWindowDeps {
  /** Absolute path of the Huddle's preload script. */
  preload: string;
  /** Load the Huddle page into the window (the dev server's URL, or the packaged file). */
  load(win: BrowserWindow): void;
  getMainWindow(): BrowserWindow | null;
  loadPrefs(): unknown;
  savePrefs(prefs: HuddlePrefs): void;
  /** How many agents are on the list, to size the compact window. */
  agentCount(): number;
  /** The mode changed: tell the windows. */
  onMode(mode: HuddleModeState): void;
  /** The window is going away: stop mirroring terminals into it. */
  onClosed(wc: WebContents): void;
}

const SAVE_DELAY_MS = 400;
const RESIZE_DEBOUNCE_MS = 120;
/** After we move or resize the window ourselves, ignore the 'moved' events it causes for this long. */
const OWN_MOVE_QUIET_MS = 350;
/** After entering, ignore the main window's focus changes (minimising it fires some). */
const ENTER_SETTLE_MS = 900;

export function displaysNow(): DisplayLite[] {
  return screen.getAllDisplays().map((d) => ({
    id: d.id,
    bounds: { ...d.bounds },
    workArea: { ...d.workArea },
    scaleFactor: d.scaleFactor
  }));
}

export class HuddleWindow {
  private win: BrowserWindow | null = null;
  private prefs: HuddlePrefs;
  private mode: HuddleModeState = { active: false, level: 'compact', selectedAgentId: null, dock: 'right' };
  private ownMoveUntil = 0;
  private settleUntil = 0;
  private saveTimer: NodeJS.Timeout | null = null;
  private resizeTimer: NodeJS.Timeout | null = null;
  private leaving = false;
  private readonly listeners: Array<() => void> = [];

  constructor(private readonly deps: HuddleWindowDeps) {
    this.prefs = sanitizeHuddlePrefs(deps.loadPrefs());
    this.mode.level = this.prefs.level;
    this.mode.dock = this.prefs.dock;
  }

  // ─── reading ───────────────────────────────────────────────────────────────

  state(): HuddleModeState { return { ...this.mode }; }
  isActive(): boolean { return this.mode.active; }
  webContents(): WebContents | null { return this.win && !this.win.isDestroyed() ? this.win.webContents : null; }
  window(): BrowserWindow | null { return this.win && !this.win.isDestroyed() ? this.win : null; }

  /** Real-app tour only: move the window as a person's drag would, then let go (the OS's own drag cannot be driven from outside). */
  debugMoveAndRelease(x: number, y: number): void {
    const w = this.window();
    if (!w) return;
    w.setPosition(Math.round(x), Math.round(y));
    this.ownMoveUntil = 0;
    this.movedByPerson();
  }

  /** What the window is doing, for diagnostics and the real-app tour. */
  describe(): Record<string, unknown> | null {
    const w = this.window();
    if (!w) return null;
    return {
      bounds: w.getBounds(), visible: w.isVisible(), focused: w.isFocused(), alwaysOnTop: w.isAlwaysOnTop(),
      focusable: (() => { try { return w.isFocusable(); } catch { return null; } })(),
      level: this.mode.level, dock: this.mode.dock, selectedAgentId: this.mode.selectedAgentId,
      mainMinimized: this.deps.getMainWindow()?.isMinimized() ?? null,
      displays: displaysNow().map((d) => ({ id: d.id, workArea: d.workArea, scaleFactor: d.scaleFactor }))
    };
  }

  // ─── entering and leaving ──────────────────────────────────────────────────

  /** Show the Huddle and minimise the main window. Safe to call twice. */
  enter(): void {
    if (this.mode.active && this.window()) { this.window()?.showInactive(); return; }
    const level = this.prefs.level === 'expanded' ? 'expanded' : 'compact';
    this.mode = { active: true, level, selectedAgentId: null, dock: this.prefs.dock };
    this.leaving = false;
    this.settleUntil = Date.now() + ENTER_SETTLE_MS;
    const rect = this.targetRect();
    const win = this.create(rect);
    this.win = win;
    this.deps.load(win);
    win.once('ready-to-show', () => {
      if (win.isDestroyed()) return;
      this.ownMoveUntil = Date.now() + OWN_MOVE_QUIET_MS;
      this.floatAbove(win);
      // showInactive: appearing must not interrupt typing in whatever app is in front.
      win.showInactive();
      // The Huddle is up first, then the main window steps aside, so there is never a moment with neither.
      const main = this.deps.getMainWindow();
      if (main && !main.isDestroyed() && !main.isMinimized()) main.minimize();
    });
    this.deps.onMode(this.state());
    this.watchDisplays();
  }

  /** Close the Huddle. By default the main window comes back. */
  exit(opts: { restoreMain?: boolean } = {}): void {
    if (!this.mode.active || this.leaving) return;
    this.leaving = true;
    this.persistNow();
    const win = this.window();
    this.mode = { ...this.mode, active: false, selectedAgentId: null, level: this.prefs.level };
    this.stopWatchingDisplays();
    if (this.resizeTimer) { clearTimeout(this.resizeTimer); this.resizeTimer = null; }
    if (opts.restoreMain !== false) {
      const main = this.deps.getMainWindow();
      if (main && !main.isDestroyed()) {
        if (main.isMinimized()) main.restore();
        main.show();
        main.focus();
      }
    }
    if (win) { win.destroy(); }
    this.win = null;
    this.deps.onMode(this.state());
  }

  /** The main window came back by some other route (the Dock, the app switcher): the Huddle has done its job. */
  mainWindowReturned(): void {
    if (!this.mode.active || Date.now() < this.settleUntil) return;
    this.exit({ restoreMain: false });
  }

  dispose(): void {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    this.stopWatchingDisplays();
    const win = this.window();
    this.win = null;
    this.mode.active = false;
    if (win) win.destroy();
  }

  /** The person is typing into one of the Huddle's own fields (on), or has stopped (off). Only then may it take the keyboard. */
  setKeyboard(on: boolean): void {
    const w = this.window();
    if (!w) return;
    try {
      w.setFocusable(on);
      if (on) w.focus();
    } catch { /* the window is closing */ }
  }

  // ─── levels ────────────────────────────────────────────────────────────────

  /** Move between the compact list, the expanded panel and one agent's view. */
  setLevel(level: HuddleLevel, agentId: string | null = null): void {
    if (!this.mode.active) return;
    const selectedAgentId = level === 'agent' ? agentId : null;
    if (level === 'agent' && !selectedAgentId) return;
    this.mode = { ...this.mode, level, selectedAgentId };
    if (level !== 'agent') this.prefs = { ...this.prefs, level };
    this.resizeToLevel(true);
    this.deps.onMode(this.state());
    this.schedulePersist();
  }

  /** The number of agents changed: the compact list grows or shrinks to fit. */
  agentCountChanged(): void {
    if (!this.mode.active || this.mode.level !== 'compact') return;
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => { this.resizeTimer = null; this.resizeToLevel(true); }, RESIZE_DEBOUNCE_MS);
  }

  // ─── geometry ──────────────────────────────────────────────────────────────

  private currentSize(): { width: number; height: number } {
    const displays = displaysNow();
    const where: Rect = this.window()?.getBounds() ?? { x: 0, y: 0, width: 1, height: 1 };
    const d = chooseDisplay(displays, where);
    return levelSize(this.mode.level, this.deps.agentCount(), d.workArea);
  }

  private targetRect(): Rectangle {
    const displays = displaysNow();
    const primary = screen.getPrimaryDisplay().id;
    // size for the display the saved position falls on
    const probe: Rect = { x: this.prefs.x ?? 0, y: this.prefs.y ?? 0, width: 1, height: 1 };
    const d = typeof this.prefs.x === 'number' ? chooseDisplay(displays, probe) : (displays.find((x) => x.id === primary) ?? displays[0]);
    const size = levelSize(this.mode.level, this.deps.agentCount(), d.workArea);
    return placeFromSaved({ x: this.prefs.x, y: this.prefs.y, displayId: this.prefs.displayId, dock: this.mode.dock }, size, displays, primary);
  }

  private resizeToLevel(animate: boolean): void {
    const win = this.window();
    if (!win) return;
    const size = this.currentSize();
    const next = resizeAnchored(win.getBounds(), size, this.mode.dock, displaysNow());
    this.applyBounds(win, next, animate);
    this.remember(next);
  }

  private applyBounds(win: BrowserWindow, rect: Rect, animate: boolean): void {
    this.ownMoveUntil = Date.now() + OWN_MOVE_QUIET_MS;
    try { win.setBounds(rect, animate && process.platform === 'darwin'); } catch { /* the window is closing */ }
  }

  private remember(rect: Rect): void {
    const d = chooseDisplay(displaysNow(), rect);
    this.prefs = { ...this.prefs, x: rect.x, y: rect.y, displayId: d.id, dock: this.mode.dock };
    this.schedulePersist();
  }

  /** The person finished dragging: dock if it is near an edge, then remember where it is. */
  private movedByPerson(): void {
    const win = this.window();
    if (!win || Date.now() < this.ownMoveUntil) return;
    const snapped = snapAfterMove(win.getBounds(), displaysNow());
    this.mode = { ...this.mode, dock: snapped.dock };
    const cur = win.getBounds();
    if (snapped.rect.x !== cur.x || snapped.rect.y !== cur.y) this.applyBounds(win, snapped.rect, true);
    this.remember(snapped.rect);
    this.deps.onMode(this.state());
  }

  // ─── displays ──────────────────────────────────────────────────────────────

  private displayHandler = (): void => {
    const win = this.window();
    if (!win || !this.mode.active) return;
    // a monitor came or went, or the resolution or scale changed: put the window back on a screen that exists
    const size = this.currentSize();
    const displays = displaysNow();
    const where = win.getBounds();
    const rect = placeFromSaved({ x: where.x, y: where.y, displayId: this.prefs.displayId, dock: this.mode.dock }, size, displays, screen.getPrimaryDisplay().id);
    this.applyBounds(win, rect, false);
    this.remember(rect);
  };

  private watchDisplays(): void {
    if (this.listeners.length) return;
    screen.on('display-added', this.displayHandler);
    screen.on('display-removed', this.displayHandler);
    screen.on('display-metrics-changed', this.displayHandler);
    this.listeners.push(
      () => screen.removeListener('display-added', this.displayHandler),
      () => screen.removeListener('display-removed', this.displayHandler),
      () => screen.removeListener('display-metrics-changed', this.displayHandler)
    );
  }

  private stopWatchingDisplays(): void {
    for (const off of this.listeners.splice(0)) off();
  }

  // ─── persistence ───────────────────────────────────────────────────────────

  private schedulePersist(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.persistNow(); }, SAVE_DELAY_MS);
  }

  private persistNow(): void {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    try { this.deps.savePrefs({ ...this.prefs, dock: this.mode.dock, v: 1 }); } catch { /* best-effort */ }
  }

  // ─── the window itself ─────────────────────────────────────────────────────

  private floatAbove(win: BrowserWindow): void {
    try {
      // 'screen-saver' sits above ordinary windows and, with the full-screen behaviour below, over a full-screen app.
      win.setAlwaysOnTop(true, 'screen-saver');
      if (process.platform === 'darwin') {
        // Calling this can drop the Dock icon unless told not to change the process type; and bring the icon back if it did.
        win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
        try { void app.dock?.show(); } catch { /* not a Dock platform */ }
      } else {
        win.setVisibleOnAllWorkspaces(true);
      }
    } catch { /* an older platform that lacks one of these: the window is still on top */ }
  }

  private create(rect: Rectangle): BrowserWindow {
    const win = new BrowserWindow({
      ...rect,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: true,
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      title: 'Mosbius & Co — Huddle',
      // The first click on the Huddle must act, not merely focus it: it is used without being the active window.
      acceptFirstMouse: true,
      // Cannot become the key window until the person types into it (setKeyboard): see the file header.
      focusable: false,
      webPreferences: {
        preload: this.deps.preload,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        // It shows agents working in real time; a throttled hidden page would show stale cards.
        backgroundThrottling: false
      }
    });
    const wc = win.webContents;
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-navigate', (e) => e.preventDefault());
    // macOS and Windows say once, when the person lets go. Linux says it continuously while dragging, so wait for it to stop.
    if (process.platform === 'linux') {
      let settle: NodeJS.Timeout | null = null;
      win.on('move', () => {
        if (settle) clearTimeout(settle);
        settle = setTimeout(() => { settle = null; this.movedByPerson(); }, 300);
      });
    } else {
      win.on('moved', () => this.movedByPerson());
    }
    win.on('closed', () => {
      this.deps.onClosed(wc);
      if (this.win === win) this.win = null;
      // closed by something other than us (the system, a crash of the page): the Huddle is over, the main window must not stay hidden
      if (this.mode.active && !this.leaving) {
        this.mode = { ...this.mode, active: false, selectedAgentId: null };
        const main = this.deps.getMainWindow();
        if (main && !main.isDestroyed()) { if (main.isMinimized()) main.restore(); main.show(); }
        this.deps.onMode(this.state());
      }
    });
    return win;
  }
}

