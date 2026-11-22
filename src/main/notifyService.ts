/**
 * The notification service: the one place real agent events become notifications.
 *
 * Producers (the activity tracker, the hive, the broker, the PTY) hand it an intent; it decides, from the
 * person's preferences, whether to record it, raise an operating-system banner and play a sound; it keeps one
 * notification per unresolved event however often that event repeats; it keeps a history that survives a
 * restart; and it tells every window when anything changed.
 *
 * Electron-free. Everything that touches the machine (the banner, the sound, the disk, the clock) arrives as a
 * port, so the rules are unit-tested under plain Node and the delivery code stays a thin adapter
 * (src/main/notifyDelivery.ts).
 */
import {
  ACTION_CATEGORIES, MAX_HISTORY, defaultPriority, defaultPrefs, deliveryPlan, renderText, sanitizePrefs, soundFor,
  type DeliveryReport, type NotificationIntent, type NotificationPrefs, type NotificationRecord, type Resolution,
  type SoundKind
} from '../shared/notifications';
import { clip } from '../shared/agentActivity';
import { SoundGate } from '../shared/soundPolicy';

export type DesktopOutcome = 'shown' | 'unsupported' | 'failed';
export type DesktopStatus = 'unknown' | 'ok' | 'unsupported' | 'blocked';

export interface NotifySnapshot {
  records: NotificationRecord[];
  unread: number;
  /** Open notifications that need a person. */
  pending: number;
  prefs: NotificationPrefs;
  desktop: { status: DesktopStatus; lastError?: string; lastShownAt?: number };
}

export interface PersistedNotifyState { v: 1; records: NotificationRecord[]; prefs: NotificationPrefs }

export interface NotifyPorts {
  now(): number;
  load(): unknown;
  save(state: PersistedNotifyState): void;
  /** Raise the operating system's banner. `onClick` runs if the person clicks it. */
  showDesktop(n: { id: string; title: string; body: string; urgent: boolean }, onClick: () => void): DesktopOutcome;
  desktopSupported(): boolean;
  /** Play a cue. `interrupt`: a lower sound is still sounding and this one takes over from it. */
  playSound(kind: SoundKind, opts?: { interrupt?: boolean }): boolean;
  /** How long this sound really lasts, when that is known and is not the app's own length for it (a replacement a person put in). */
  soundMs?(kind: SoundKind): number | undefined;
  /** The `notify` string table for the current language (main-side text for banners). */
  strings(): Record<string, unknown> | undefined;
  /** Called after every change, coalesced. */
  changed(snapshot: NotifySnapshot): void;
  /** The person clicked a banner. */
  activate(record: NotificationRecord): void;
  agentName?(agentId: string): string | undefined;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (h: unknown) => void;
}

/** At most this many banners in BURST_WINDOW_MS; the rest are folded into one summary banner. */
const BURST_MAX = 4;
const BURST_WINDOW_MS = 10_000;
const SAVE_DELAY_MS = 400;
const CHANGE_DELAY_MS = 60;

const SUMMARY_KEY = 'notify.more';

export class NotificationService {
  private records: NotificationRecord[] = [];
  private byId = new Map<string, NotificationRecord>();
  /** requestKey → id, for notifications that are open and need a person. */
  private openByKey = new Map<string, string>();
  private prefs: NotificationPrefs = defaultPrefs();
  private seq = 0;
  private desktopStatus: DesktopStatus = 'unknown';
  private desktopError: string | undefined;
  private lastShownAt: number | undefined;
  /** One sound at a time, the urgent over the routine, no repeats (src/shared/soundPolicy.ts). */
  private readonly gate = new SoundGate();
  private bannerTimes: number[] = [];
  private foldedBanners = 0;
  private summaryTimer: unknown = null;
  private saveTimer: unknown = null;
  private changeTimer: unknown = null;
  private disposed = false;

  constructor(private readonly ports: NotifyPorts) {
    this.restore();
    if (!ports.desktopSupported()) this.desktopStatus = 'unsupported';
  }

  // ─── persistence ───────────────────────────────────────────────────────────

  private restore(): void {
    let raw: unknown;
    try { raw = this.ports.load(); } catch { raw = undefined; }
    const state = raw && typeof raw === 'object' ? raw as Partial<PersistedNotifyState> : {};
    this.prefs = sanitizePrefs(state.prefs);
    const now = this.ports.now();
    for (const r of Array.isArray(state.records) ? state.records : []) {
      if (!r || typeof r !== 'object' || typeof (r as NotificationRecord).id !== 'string') continue;
      const rec = r as NotificationRecord;
      if (typeof rec.agentId !== 'string' || typeof rec.category !== 'string' || !rec.title || !rec.body) continue;
      // A request that was open when the app last ran belongs to a process that no longer exists: say so
      // rather than leave a button that answers nothing.
      if (rec.actionRequired && !rec.resolution) rec.resolution = { at: now, by: 'system', action: 'resolved', note: 'app-restarted' };
      this.records.push(rec);
      this.byId.set(rec.id, rec);
    }
    this.trim();
    const maxSeq = this.records.reduce((m, r) => Math.max(m, Number(r.id.split('-')[2]) || 0), 0);
    this.seq = maxSeq;
  }

  private persist(): void {
    if (this.disposed) return;
    if (this.saveTimer !== null) return;
    const set = this.ports.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.saveTimer = set(() => { this.saveTimer = null; this.flush(); }, SAVE_DELAY_MS);
  }

  /** Write now. Also called on quit. */
  flush(): void {
    const clear = this.ports.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    if (this.saveTimer !== null) { clear(this.saveTimer); this.saveTimer = null; }
    try { this.ports.save({ v: 1, records: this.records, prefs: this.prefs }); } catch { /* the history is best-effort; delivery is not */ }
  }

  private trim(): void {
    if (this.records.length <= MAX_HISTORY) return;
    // keep everything still open, then the newest of the rest
    const open = this.records.filter((r) => !r.resolution && r.actionRequired);
    const rest = this.records.filter((r) => r.resolution || !r.actionRequired);
    const keep = new Set([...open, ...rest.slice(-(MAX_HISTORY - open.length))].map((r) => r.id));
    this.records = this.records.filter((r) => keep.has(r.id));
    for (const id of [...this.byId.keys()]) if (!keep.has(id)) this.byId.delete(id);
  }

  private changed(): void {
    this.persist();
    if (this.disposed || this.changeTimer !== null) return;
    const set = this.ports.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.changeTimer = set(() => { this.changeTimer = null; if (!this.disposed) this.ports.changed(this.snapshot()); }, CHANGE_DELAY_MS);
  }

  // ─── reading ───────────────────────────────────────────────────────────────

  snapshot(): NotifySnapshot {
    const recent = this.records.slice(-200);
    return {
      records: recent.map((r) => ({ ...r })),
      unread: this.records.filter((r) => !r.read).length,
      pending: this.records.filter((r) => r.actionRequired && !r.resolution).length,
      prefs: { ...this.prefs, categories: { ...this.prefs.categories } },
      desktop: { status: this.desktopStatus, ...(this.desktopError ? { lastError: this.desktopError } : {}), ...(this.lastShownAt ? { lastShownAt: this.lastShownAt } : {}) }
    };
  }

  get(id: string): NotificationRecord | undefined { return this.byId.get(id); }

  /** The notifications for one agent that are still waiting on a person. */
  openFor(agentId: string): NotificationRecord[] {
    return this.records.filter((r) => r.agentId === agentId && r.actionRequired && !r.resolution);
  }

  getPrefs(): NotificationPrefs { return this.snapshot().prefs; }

  /** The volume slider, 0 to 1 (read each time a sound plays, so a change takes effect at once). */
  volume(): number { return this.prefs.volume; }

  setPrefs(next: unknown): NotificationPrefs {
    this.prefs = sanitizePrefs(next);
    this.changed();
    return this.getPrefs();
  }

  // ─── ingesting ─────────────────────────────────────────────────────────────

  /**
   * Record a notification and deliver it. A repeat of an event that is still open is the same notification:
   * its counter goes up and nothing rings a second time.
   */
  ingest(intent: NotificationIntent, agentName?: string): NotificationRecord | null {
    if (this.disposed) return null;
    const priority = intent.priority ?? defaultPriority(intent.category);
    const plan = deliveryPlan(this.prefs, intent.category, priority);
    if (!plan.record) return null;
    const now = this.ports.now();

    const openId = this.openByKey.get(intent.requestKey);
    const open = openId ? this.byId.get(openId) : undefined;
    if (open && !open.resolution) {
      open.repeatCount += 1;
      open.updatedAt = now;
      if (intent.preview && intent.preview !== open.preview) open.preview = intent.preview;
      this.changed();
      return open;
    }

    const name = agentName
      ?? this.ports.agentName?.(intent.agentId)
      ?? (intent.title.args?.agent !== undefined ? String(intent.title.args.agent) : intent.agentId);
    const record: NotificationRecord = {
      id: `n-${now.toString(36)}-${++this.seq}`,
      agentId: intent.agentId,
      agentName: name,
      category: intent.category,
      priority,
      title: intent.title,
      body: intent.body,
      ...(intent.preview ? { preview: clip(intent.preview) } : {}),
      ...(intent.options?.length ? { options: intent.options.slice(0, 8) } : {}),
      actions: intent.actions ?? ['open'],
      createdAt: now,
      updatedAt: now,
      read: false,
      actionRequired: ACTION_CATEGORIES.has(intent.category),
      ...(intent.taskId ? { taskId: intent.taskId } : {}),
      ...(intent.conversationId ? { conversationId: intent.conversationId } : {}),
      ...(intent.integrationId ? { integrationId: intent.integrationId } : {}),
      requestKey: intent.requestKey,
      repeatCount: 1,
      delivery: { desktop: 'none', sound: 'none' }
    };
    record.delivery = this.deliver(record, plan);
    this.records.push(record);
    this.byId.set(record.id, record);
    if (record.actionRequired) this.openByKey.set(record.requestKey, record.id);
    this.trim();
    this.changed();
    return record;
  }

  private deliver(record: NotificationRecord, plan: { desktop: boolean; sound: SoundKind | null }): DeliveryReport {
    const report: DeliveryReport = { desktop: 'none', sound: 'none' };
    const wanted = this.prefs.categories[record.category] !== false;

    // sound first and on its own: a blocked banner must never silence it
    if (plan.sound) report.sound = this.ring(plan.sound);
    else if (record.priority !== 'low') {
      // off for any reason a person gave: the master switch, this kind of notification, or this one sound
      const kind = soundFor(record.category, record.priority);
      report.sound = !wanted || !this.prefs.sound || (kind !== null && this.prefs.cues[kind] === false) ? 'off' : 'none';
    }

    if (plan.desktop) report.desktop = this.banner(record);
    else if (record.priority !== 'low') report.desktop = !wanted || !this.prefs.desktop ? 'off' : 'none';
    return report;
  }

  /**
   * Ring a cue through the gate: one sound at a time, an urgent one over a routine one, the same one not twice in a
   * breath. A sound that is dropped is not a lost notification; the record, the banner and the Huddle still say it.
   */
  private ring(kind: SoundKind): DeliveryReport['sound'] {
    const verdict = this.gate.request(kind, this.ports.now(), this.ports.soundMs?.(kind));
    if (verdict.verdict === 'dropped') return 'muted';
    let ok = false;
    try { ok = this.ports.playSound(kind, { interrupt: verdict.interrupt }); } catch { ok = false; }
    if (!ok) { this.gate.abort(kind); return 'failed'; }
    return 'played';
  }

  /**
   * A sound that is not a notification (an agent starting): nothing is recorded and no banner is raised. It follows the
   * master sound switch and the sound's own switch, and it gives way to every real notification.
   */
  cue(kind: SoundKind): DeliveryReport['sound'] {
    if (this.disposed || !this.prefs.sound || this.prefs.cues[kind] === false) return 'off';
    return this.ring(kind);
  }

  /**
   * The Settings page's "play" buttons: the sound alone. No record, no banner, nothing changes for any agent. It
   * sounds even when notification sounds are switched off, so a person can hear what they are choosing, and it takes
   * over from whatever is still sounding, so pressing another button simply plays that one.
   */
  previewSound(kind: SoundKind): 'played' | 'failed' {
    if (this.disposed) return 'failed';
    const { interrupt } = this.gate.preview(kind, this.ports.now(), this.ports.soundMs?.(kind));
    let ok = false;
    try { ok = this.ports.playSound(kind, { interrupt }); } catch { ok = false; }
    if (!ok) { this.gate.abort(kind); return 'failed'; }
    return 'played';
  }

  private text(record: NotificationRecord): { title: string; body: string } {
    const strings = this.ports.strings();
    const title = renderText(strings, record.title);
    const body = renderText(strings, record.body);
    return { title, body: record.preview ? `${body}\n${clip(record.preview, 140)}`.trim() : body };
  }

  private banner(record: NotificationRecord): DeliveryReport['desktop'] {
    if (!this.ports.desktopSupported()) { this.desktopStatus = 'unsupported'; return 'unsupported'; }
    const now = this.ports.now();
    this.bannerTimes = this.bannerTimes.filter((t) => now - t < BURST_WINDOW_MS);
    if (this.bannerTimes.length >= BURST_MAX) {
      // a burst: the rest become one summary instead of a wall of banners
      this.foldedBanners += 1;
      this.scheduleSummary();
      return 'muted';
    }
    this.bannerTimes.push(now);
    const { title, body } = this.text(record);
    let outcome: DesktopOutcome;
    try {
      outcome = this.ports.showDesktop({ id: record.id, title, body, urgent: record.priority === 'critical' || record.priority === 'high' }, () => this.ports.activate(record));
    } catch (e) { outcome = 'failed'; this.desktopError = e instanceof Error ? e.message : String(e); }
    if (outcome === 'shown') { this.desktopStatus = 'ok'; this.desktopError = undefined; this.lastShownAt = now; }
    else if (outcome === 'unsupported') this.desktopStatus = 'unsupported';
    else this.desktopStatus = 'blocked';
    return outcome;
  }

  private scheduleSummary(): void {
    if (this.summaryTimer !== null) return;
    const set = this.ports.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.summaryTimer = set(() => {
      this.summaryTimer = null;
      const n = this.foldedBanners;
      this.foldedBanners = 0;
      if (n <= 0 || this.disposed || !this.prefs.desktop) return;
      const strings = this.ports.strings();
      const text = { key: SUMMARY_KEY, args: { count: n } };
      try { this.ports.showDesktop({ id: 'summary', title: renderText(strings, { key: 'notify.moreTitle' }), body: renderText(strings, text), urgent: false }, () => this.ports.activate({ id: 'summary' } as NotificationRecord)); } catch { /* ignore */ }
    }, BURST_WINDOW_MS);
  }

  /** Send a test banner and report what happened, for the Settings page. */
  testDesktop(): DesktopStatus {
    if (!this.ports.desktopSupported()) { this.desktopStatus = 'unsupported'; this.changed(); return this.desktopStatus; }
    const strings = this.ports.strings();
    let outcome: DesktopOutcome;
    try {
      outcome = this.ports.showDesktop({ id: 'test', title: renderText(strings, { key: 'notify.test.title' }), body: renderText(strings, { key: 'notify.test.body' }), urgent: false }, () => undefined);
    } catch (e) { outcome = 'failed'; this.desktopError = e instanceof Error ? e.message : String(e); }
    if (outcome === 'shown') { this.desktopStatus = 'ok'; this.desktopError = undefined; this.lastShownAt = this.ports.now(); }
    else this.desktopStatus = outcome === 'unsupported' ? 'unsupported' : 'blocked';
    if (this.prefs.sound && this.prefs.cues.signature !== false) this.ring('signature');
    this.changed();
    return this.desktopStatus;
  }

  /** The operating system said it could not show a banner (or that it did): learned after the fact. */
  noteDesktopResult(ok: boolean, error?: string): void {
    this.desktopStatus = ok ? 'ok' : 'blocked';
    this.desktopError = ok ? undefined : error;
    if (ok) this.lastShownAt = this.ports.now();
    this.changed();
  }

  // ─── resolving ─────────────────────────────────────────────────────────────

  private close(record: NotificationRecord, resolution: Resolution): NotificationRecord {
    record.resolution = resolution;
    record.read = true;
    record.updatedAt = resolution.at;
    if (this.openByKey.get(record.requestKey) === record.id) this.openByKey.delete(record.requestKey);
    return record;
  }

  /** Close one notification. Returns it, or null when it is unknown or already closed. */
  resolve(id: string, resolution: Omit<Resolution, 'at'>): NotificationRecord | null {
    const record = this.byId.get(id);
    if (!record || record.resolution) return null;
    this.close(record, { ...resolution, at: this.ports.now() });
    this.changed();
    return record;
  }

  /** The agent moved on by itself (or the person answered in the terminal): close what was waiting on it. */
  resolveByKey(requestKey: string, resolution: Omit<Resolution, 'at'>): NotificationRecord | null {
    const id = this.openByKey.get(requestKey);
    return id ? this.resolve(id, resolution) : null;
  }

  /** Close everything open for an agent (it exited; the prompts died with it). */
  resolveAgent(agentId: string, resolution: Omit<Resolution, 'at'>, categories?: readonly string[]): number {
    let n = 0;
    for (const r of this.openFor(agentId)) {
      if (categories && !categories.includes(r.category)) continue;
      this.close(r, { ...resolution, at: this.ports.now() });
      n += 1;
    }
    if (n) this.changed();
    return n;
  }

  /** Close every open record matching a predicate (an ask that was answered, access that was granted). */
  resolveWhere(match: (r: NotificationRecord) => boolean, resolution: Omit<Resolution, 'at'>): number {
    let n = 0;
    for (const r of this.records) {
      if (r.resolution || !r.actionRequired || !match(r)) continue;
      this.close(r, { ...resolution, at: this.ports.now() });
      n += 1;
    }
    if (n) this.changed();
    return n;
  }

  dismiss(id: string): NotificationRecord | null {
    const record = this.byId.get(id);
    if (!record) return null;
    if (!record.resolution) this.close(record, { at: this.ports.now(), by: 'user', action: 'dismissed' });
    else record.read = true;
    this.changed();
    return record;
  }

  markRead(id: string): void {
    const r = this.byId.get(id);
    if (r && !r.read) { r.read = true; this.changed(); }
  }

  markAllRead(): void {
    let any = false;
    for (const r of this.records) if (!r.read) { r.read = true; any = true; }
    if (any) this.changed();
  }

  /** Remove history. Open requests are kept: clearing the list must not hide an agent that is waiting. */
  clear(): number {
    const before = this.records.length;
    this.records = this.records.filter((r) => r.actionRequired && !r.resolution);
    this.byId = new Map(this.records.map((r) => [r.id, r]));
    this.changed();
    return before - this.records.length;
  }

  dispose(): void {
    if (this.disposed) return;
    this.flush();
    this.disposed = true;
    const clear = this.ports.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    for (const t of [this.summaryTimer, this.changeTimer]) if (t !== null) clear(t);
    this.summaryTimer = this.changeTimer = this.saveTimer = null;
  }
}
