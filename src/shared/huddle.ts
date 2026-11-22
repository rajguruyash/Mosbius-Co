/**
 * The Huddle's contract: the shapes that cross between the main process, the main window and the Huddle window,
 * the window geometry rules (sizes per level, docking to a screen edge, staying on a screen that still exists),
 * and the validators every payload passes through before it is trusted.
 *
 * Pure and Electron-free: the geometry is the part most likely to be wrong on someone else's monitor setup, so it
 * is written as functions of plain rectangles and tested with made-up displays.
 */
import type { ActivityLabel, AgentState } from './agentActivity';

export type HuddleLevel = 'compact' | 'expanded' | 'agent';
export type DockEdge = 'left' | 'right';

// ─── what the main window tells the hub about its roster ─────────────────────

/** One agent as the main window knows it. The renderer owns names, faces and accents; the hub merges them with
 *  what it knows from hooks, terminals and controls. */
export interface RosterAgent {
  id: string;
  name: string;
  character: string;
  accent: string;
  isGod?: boolean;
  isAssistant?: boolean;
  ptyId?: string;
  provider?: string;
  model?: string;
  description?: string;
  project?: string;
  cwd?: string;
  /** The floor's own status for this agent (its StatusKind): corroboration where hooks say nothing. */
  status?: string;
  contextTokens?: number;
  contextLimit?: number;
  /** Messages waiting to be delivered to it. */
  queued?: number;
  archived?: boolean;
}

const ID_RE = /^[A-Za-z0-9._:@-]{1,120}$/;
export const isAgentId = (v: unknown): v is string => typeof v === 'string' && ID_RE.test(v);

const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.length <= max ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** Accept a roster from a renderer: keep only well-formed entries and only the fields we know. */
export function validateRoster(raw: unknown): RosterAgent[] {
  if (!Array.isArray(raw)) return [];
  const out: RosterAgent[] = [];
  const seen = new Set<string>();
  for (const e of raw.slice(0, 200)) {
    if (!e || typeof e !== 'object') continue;
    const r = e as Record<string, unknown>;
    if (!isAgentId(r.id) || seen.has(r.id)) continue;
    seen.add(r.id);
    out.push({
      id: r.id,
      name: str(r.name, 80) || r.id,
      character: str(r.character, 40) || 'marshall',
      accent: str(r.accent, 24) || 'sky',
      ...(r.isGod === true ? { isGod: true } : {}),
      ...(r.isAssistant === true ? { isAssistant: true } : {}),
      ...(str(r.ptyId, 160) ? { ptyId: r.ptyId as string } : {}),
      ...(str(r.provider, 40) ? { provider: r.provider as string } : {}),
      ...(str(r.model, 120) ? { model: r.model as string } : {}),
      ...(str(r.description, 300) ? { description: r.description as string } : {}),
      ...(str(r.project, 120) ? { project: r.project as string } : {}),
      ...(str(r.cwd, 600) ? { cwd: r.cwd as string } : {}),
      ...(str(r.status, 24) ? { status: r.status as string } : {}),
      ...(num(r.contextTokens) !== undefined ? { contextTokens: num(r.contextTokens) } : {}),
      ...(num(r.contextLimit) !== undefined ? { contextLimit: num(r.contextLimit) } : {}),
      ...(num(r.queued) !== undefined ? { queued: Math.max(0, Math.min(999, Math.floor(num(r.queued) as number))) } : {}),
      ...(r.archived === true ? { archived: true } : {})
    });
  }
  return out;
}

// ─── what the hub tells the windows ──────────────────────────────────────────

export interface AgentControls {
  /** A message can be queued for it. */
  send: boolean;
  /** Pause its tools (resume when paused). */
  pause: boolean;
  resume: boolean;
  /** Interrupt what it is doing now (Escape in its terminal). */
  interrupt: boolean;
  /** End its session. */
  end: boolean;
  /** Restart & Continue. */
  restart: boolean;
}

export interface HuddleAgentView {
  id: string;
  name: string;
  character: string;
  accent: string;
  isGod: boolean;
  provider?: string;
  model?: string;
  description?: string;
  project?: string;
  alive: boolean;
  state: AgentState;
  /** When `state` last changed. */
  stateSince: number;
  activity: ActivityLabel;
  tool?: string;
  /** Real progress only: the agent's own checklist, or its hive tasks. Absent when there is nothing to measure. */
  progress?: { done: number; total: number; current?: string; source: 'todos' | 'tasks' };
  contextPct?: number;
  /** The hive tasks assigned to it that are not finished (at most a few), so the expanded panel can list them. */
  tasks?: Array<{ id: string; title: string; status: string }>;
  queued: number;
  paused: boolean;
  /** Open notifications that need a person, newest first (ids into the notification list). */
  attention: { ids: string[]; since: number; critical: boolean } | null;
  error?: string;
  /** The agent has gone; its card stays until this time. */
  lingerUntil?: number;
  controls: AgentControls;
}

export interface HuddleCounts {
  total: number;
  attention: number;
  working: number;
  completed: number;
  error: number;
  paused: number;
}

export interface HuddleModeState {
  active: boolean;
  level: HuddleLevel;
  selectedAgentId: string | null;
  dock: DockEdge | null;
}

export interface HuddleState {
  v: 1;
  at: number;
  agents: HuddleAgentView[];
  counts: HuddleCounts;
  mode: HuddleModeState;
  /** The main window can carry out messages and restarts. */
  mainAvailable: boolean;
}

// ─── commands ────────────────────────────────────────────────────────────────

export interface AttachmentRef { path: string; name: string }

export type HuddleCommand =
  | { type: 'send'; agentId: string; text: string; attachments: AttachmentRef[] }
  | { type: 'pause'; agentId: string }
  | { type: 'resume'; agentId: string }
  | { type: 'interrupt'; agentId: string }
  | { type: 'end'; agentId: string }
  | { type: 'restart'; agentId: string }
  /** Press one named key in the agent's terminal (answering a prompt from the Huddle's terminal view). */
  | { type: 'keys'; agentId: string; key: NamedKey };

/** The keys the Huddle may press for a person. A fixed list, not arbitrary text: typing goes through a message. */
export const NAMED_KEYS = ['enter', 'esc', 'up', 'down', 'tab', 'y', 'n', '1', '2', '3'] as const;
export type NamedKey = (typeof NAMED_KEYS)[number];

/** What each named key sends to the terminal. */
export const KEY_BYTES: Record<NamedKey, string> = {
  enter: '\r', esc: '\u001b', up: '\u001b[A', down: '\u001b[B', tab: '\t', y: 'y', n: 'n', '1': '1', '2': '2', '3': '3'
};

export interface CommandResult { ok: boolean; error?: string; queued?: boolean }

export const MAX_MESSAGE_CHARS = 20_000;
export const MAX_ATTACHMENTS = 12;

export function validateCommand(raw: unknown): HuddleCommand | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!isAgentId(r.agentId)) return null;
  switch (r.type) {
    case 'send': {
      const text = typeof r.text === 'string' ? r.text : '';
      if (text.length > MAX_MESSAGE_CHARS) return null;
      const attachments: AttachmentRef[] = [];
      if (Array.isArray(r.attachments)) {
        for (const a of r.attachments.slice(0, MAX_ATTACHMENTS)) {
          const o = a as { path?: unknown; name?: unknown } | null;
          if (o && typeof o.path === 'string' && o.path && o.path.length < 2048) {
            attachments.push({ path: o.path, name: typeof o.name === 'string' && o.name ? o.name.slice(0, 200) : o.path.split(/[\\/]/).pop() ?? o.path });
          }
        }
      }
      if (!text.trim() && attachments.length === 0) return null;
      return { type: 'send', agentId: r.agentId, text, attachments };
    }
    case 'pause': case 'resume': case 'interrupt': case 'end': case 'restart':
      return { type: r.type, agentId: r.agentId };
    case 'keys':
      return (NAMED_KEYS as readonly string[]).includes(r.key as string) ? { type: 'keys', agentId: r.agentId, key: r.key as NamedKey } : null;
    default: return null;
  }
}

/** The text that reaches an agent: what was typed, then the attachments as paths it can read. Identical to the
 *  composer in the main window, so an agent cannot tell which one a message came from. */
export function formatOutgoing(text: string, attachments: readonly AttachmentRef[]): string {
  if (attachments.length === 0) return text;
  const list = attachments.map((a) => `- ${a.path} (${a.name})`).join('\n');
  return (text.trim() ? `${text}\n\nAttached files:\n` : 'Attached files:\n') + list;
}

// ─── geometry ────────────────────────────────────────────────────────────────

export interface Rect { x: number; y: number; width: number; height: number }
export interface DisplayLite { id: number; bounds: Rect; workArea: Rect; scaleFactor: number }

/** Space kept between the window and the edge of the screen. */
export const EDGE_MARGIN = 8;
/** Within this many pixels of an edge, a released window docks to it. */
export const SNAP_DISTANCE = 28;

/** Measured in the real window (tools/huddle-validate.cjs checks them): a card is 76px and the list spaces cards 4px apart, so each
 *  costs 80; the list has 10px of padding and the window a 2px border, so with the header the fixed part is 48 (a 2px spare is
 *  included, so a fractional display scale never leaves a sliver to scroll). The single roomier card is 116px tall. */
export const COMPACT = { width: 312, header: 40, card: 80, cardSingle: 118, footer: 10, empty: 132, maxVisible: 6 } as const;
export const EXPANDED = { width: 432, height: 580 } as const;
export const AGENT_VIEW = { width: 520, height: 660 } as const;

/** The window size for a level. The compact list grows with its agents up to a limit and then scrolls; nothing is ever bigger than the screen. */
export function levelSize(level: HuddleLevel, agentCount: number, workArea: Rect): { width: number; height: number } {
  const maxH = Math.max(120, workArea.height - 2 * EDGE_MARGIN);
  const maxW = Math.max(240, workArea.width - 2 * EDGE_MARGIN);
  let width: number;
  let height: number;
  if (level === 'compact') {
    width = COMPACT.width;
    if (agentCount <= 0) height = COMPACT.empty;
    else if (agentCount === 1) height = COMPACT.header + COMPACT.cardSingle + COMPACT.footer;
    else height = COMPACT.header + Math.min(agentCount, COMPACT.maxVisible) * COMPACT.card + COMPACT.footer;
  } else if (level === 'expanded') {
    width = EXPANDED.width; height = EXPANDED.height;
  } else {
    width = AGENT_VIEW.width; height = AGENT_VIEW.height;
  }
  return { width: Math.round(Math.min(width, maxW)), height: Math.round(Math.min(height, maxH)) };
}

function overlap(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** The display a rectangle mostly sits on; when it is on none, the one nearest its centre; when there is no
 *  display at all (it happens during a hot-plug), a plausible default. */
export function chooseDisplay(displays: readonly DisplayLite[], rect: Rect): DisplayLite {
  if (displays.length === 0) {
    const wa = { x: 0, y: 0, width: 1440, height: 900 };
    return { id: 0, bounds: wa, workArea: wa, scaleFactor: 1 };
  }
  let best = displays[0];
  let bestOverlap = -1;
  for (const d of displays) {
    const o = overlap(rect, d.workArea);
    if (o > bestOverlap) { best = d; bestOverlap = o; }
  }
  if (bestOverlap > 0) return best;
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  let nearest = displays[0];
  let nearestD = Infinity;
  for (const d of displays) {
    const dx = Math.max(d.workArea.x - cx, 0, cx - (d.workArea.x + d.workArea.width));
    const dy = Math.max(d.workArea.y - cy, 0, cy - (d.workArea.y + d.workArea.height));
    const dist = dx * dx + dy * dy;
    if (dist < nearestD) { nearest = d; nearestD = dist; }
  }
  return nearest;
}

/** Keep a rectangle inside a work area, with the margin. A rectangle larger than the area is shrunk to fit. */
export function clampRect(rect: Rect, workArea: Rect, margin = EDGE_MARGIN): Rect {
  const width = Math.min(rect.width, Math.max(1, workArea.width - 2 * margin));
  const height = Math.min(rect.height, Math.max(1, workArea.height - 2 * margin));
  const x = Math.min(Math.max(rect.x, workArea.x + margin), workArea.x + workArea.width - width - margin);
  const y = Math.min(Math.max(rect.y, workArea.y + margin), workArea.y + workArea.height - height - margin);
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

/** The x for a window of `width` docked against an edge of the work area. */
export function dockX(edge: DockEdge, width: number, workArea: Rect): number {
  return edge === 'left' ? workArea.x + EDGE_MARGIN : workArea.x + workArea.width - width - EDGE_MARGIN;
}

/** Where a window ends up when the person lets go of it: docked if it is near an edge of the display it is on. */
export function snapAfterMove(rect: Rect, displays: readonly DisplayLite[]): { rect: Rect; dock: DockEdge | null; displayId: number } {
  const d = chooseDisplay(displays, rect);
  const wa = d.workArea;
  const left = rect.x - wa.x;
  const right = wa.x + wa.width - (rect.x + rect.width);
  let dock: DockEdge | null = null;
  if (left <= SNAP_DISTANCE && left <= right) dock = 'left';
  else if (right <= SNAP_DISTANCE) dock = 'right';
  const clamped = clampRect(rect, wa);
  const placed = dock ? { ...clamped, x: dockX(dock, clamped.width, wa) } : clamped;
  return { rect: placed, dock, displayId: d.id };
}

/** The rectangle for a new size, keeping the window where the person put it: a docked window keeps its edge,
 *  a free one keeps its top-left corner, and either is pulled back onto the screen if the new size would not fit. */
export function resizeAnchored(prev: Rect, size: { width: number; height: number }, dock: DockEdge | null, displays: readonly DisplayLite[]): Rect {
  const d = chooseDisplay(displays, prev);
  const wa = d.workArea;
  const next: Rect = { x: prev.x, y: prev.y, width: size.width, height: size.height };
  if (dock) next.x = dockX(dock, size.width, wa);
  return clampRect(next, wa);
}

export interface SavedPlacement { x?: number; y?: number; displayId?: number; dock?: DockEdge | null }

/** The rectangle to open at, from what was saved, on the screens that exist now. A saved position on a monitor
 *  that has been unplugged falls back to the nearest screen; with nothing saved the window opens docked right. */
export function placeFromSaved(saved: SavedPlacement | undefined, size: { width: number; height: number }, displays: readonly DisplayLite[], primaryId?: number): Rect {
  const primary = displays.find((d) => d.id === primaryId) ?? displays[0];
  if (!saved || typeof saved.x !== 'number' || typeof saved.y !== 'number') {
    const wa = (primary ?? chooseDisplay(displays, { x: 0, y: 0, width: 1, height: 1 })).workArea;
    const dock = saved?.dock ?? 'right';
    return clampRect({ x: dockX(dock, size.width, wa), y: wa.y + EDGE_MARGIN + 40, width: size.width, height: size.height }, wa);
  }
  const want: Rect = { x: saved.x, y: saved.y, width: size.width, height: size.height };
  // the display it used to be on, if that one still exists; else whichever one the position falls on or nearest
  const home = typeof saved.displayId === 'number' ? displays.find((d) => d.id === saved.displayId) : undefined;
  const d = home && overlap(want, home.workArea) > 0 ? home : chooseDisplay(displays, want);
  const placed = clampRect(want, d.workArea);
  return saved.dock ? { ...placed, x: dockX(saved.dock, placed.width, d.workArea) } : placed;
}

export interface HuddlePrefs {
  v: 1;
  level: HuddleLevel;
  dock: DockEdge | null;
  x?: number;
  y?: number;
  displayId?: number;
}

export function defaultHuddlePrefs(): HuddlePrefs { return { v: 1, level: 'compact', dock: 'right' }; }

export function sanitizeHuddlePrefs(raw: unknown): HuddlePrefs {
  const d = defaultHuddlePrefs();
  if (!raw || typeof raw !== 'object') return d;
  const r = raw as Record<string, unknown>;
  const level: HuddleLevel = r.level === 'expanded' ? 'expanded' : 'compact'; // the agent view is never restored: the agent may be gone
  const dock: DockEdge | null = r.dock === 'left' || r.dock === 'right' ? r.dock : r.dock === null ? null : d.dock;
  return {
    v: 1, level, dock,
    ...(typeof r.x === 'number' && Number.isFinite(r.x) ? { x: Math.round(r.x) } : {}),
    ...(typeof r.y === 'number' && Number.isFinite(r.y) ? { y: Math.round(r.y) } : {}),
    ...(typeof r.displayId === 'number' && Number.isFinite(r.displayId) ? { displayId: r.displayId } : {})
  };
}

export function emptyCounts(): HuddleCounts {
  return { total: 0, attention: 0, working: 0, completed: 0, error: 0, paused: 0 };
}

