/**
 * The notification model: what a notification is, what the person can switch off, and which real events
 * become which notification. Pure and Electron-free; the service in src/main/notifyService.ts gives it
 * persistence, de-duplication and delivery, and the UI renders it.
 *
 * Text is carried as keys and arguments, never as finished sentences, so the same record reads in English,
 * Chinese or Arabic and a history written yesterday follows today's language setting. Only text an agent
 * wrote (a command, a question, an option) travels as-is.
 */
import type { ActivitySignal, PendingRequest } from './agentActivity';
import { clip } from './agentActivity';

export type NotificationCategory = 'completed' | 'intervention' | 'input' | 'approval' | 'access' | 'info';

export const NOTIFICATION_CATEGORIES: readonly NotificationCategory[] = [
  'approval', 'input', 'intervention', 'access', 'completed', 'info'
];

export type NotificationPriority = 'critical' | 'high' | 'normal' | 'low';

/** Categories where the agent cannot go on until a person does something. */
export const ACTION_CATEGORIES: ReadonlySet<NotificationCategory> = new Set(['approval', 'input', 'intervention', 'access']);

export interface NotifText { key: string; args?: Record<string, string | number> }

/** What the person can do about a notification. Each one is wired to a real control. */
export type NotificationAction =
  | 'approve' | 'reject' | 'alternative'   // a permission prompt: answer it in the agent's terminal, or reject and say what to do instead
  | 'option'                               // pick one of the options the agent offered
  | 'answer'                               // write an answer (a question the agent put to its human)
  | 'open'                                 // go to the agent (its conversation and terminal)
  | 'restart'                              // Restart & Continue
  | 'settings';                            // Integrations & Skills: where access is granted

export type ResolutionAction = 'approved' | 'rejected' | 'alternative' | 'option' | 'answered' | 'dismissed' | 'opened' | 'resolved';

export interface Resolution {
  at: number;
  /** `agent`: the agent moved on by itself or the person answered in the terminal. */
  by: 'user' | 'agent' | 'system';
  action: ResolutionAction;
  note?: string;
}

export interface DeliveryReport {
  desktop: 'shown' | 'off' | 'muted' | 'unsupported' | 'failed' | 'none';
  sound: 'played' | 'off' | 'muted' | 'failed' | 'none';
}

export interface NotificationRecord {
  id: string;
  agentId: string;
  agentName: string;
  category: NotificationCategory;
  priority: NotificationPriority;
  title: NotifText;
  body: NotifText;
  /** What the agent said (a command, a question), redacted and clipped. Shown as written. */
  preview?: string;
  /** Options the agent offered, as it labelled them. */
  options?: string[];
  actions: NotificationAction[];
  createdAt: number;
  updatedAt: number;
  read: boolean;
  actionRequired: boolean;
  /** The hive task this came from, when it came from one. */
  taskId?: string;
  /** The hive conversation it belongs to. */
  conversationId?: string;
  integrationId?: string;
  /** The identity of the underlying event: the same unresolved event is one notification, however often it repeats. */
  requestKey: string;
  repeatCount: number;
  resolution?: Resolution;
  delivery: DeliveryReport;
}

/** What a producer hands the service. The service adds ids, times, and delivery. */
export interface NotificationIntent {
  agentId: string;
  category: NotificationCategory;
  priority?: NotificationPriority;
  title: NotifText;
  body: NotifText;
  preview?: string;
  options?: string[];
  actions?: NotificationAction[];
  taskId?: string;
  conversationId?: string;
  integrationId?: string;
  requestKey: string;
}

export interface NotificationPrefs {
  v: 1;
  /** Play a sound. Independent of the desktop banner: a blocked banner must not silence the sound. */
  sound: boolean;
  /** How loud, 0 to 1 (the slider's percentage). The app's own volume, on top of the system's. */
  volume: number;
  /**
   * One switch for each sound: which of them are on (an agent starting is one of them, and is not a notification, so it
   * has no category). A sound that is off is silent; its banner and its record are untouched. A preview ignores these:
   * a person can always hear a sound they have switched off.
   */
  cues: Record<SoundKind, boolean>;
  /** Show the operating system's notification. */
  desktop: boolean;
  /** Per category: false = no banner and no sound for it. The record is still kept, and an agent that is
   *  stuck still shows as stuck in the Huddle: this is about being interrupted, not about the truth. */
  categories: Record<NotificationCategory, boolean>;
  /** Keep routine progress (idle, paused, resumed, stopped) in the inbox. Off = it is never recorded. */
  showRoutine: boolean;
}

/** What a window may change: any of the switches, and any of the kinds. Merged into the current preferences by the main process. */
export type NotificationPrefsPatch = Partial<Omit<NotificationPrefs, 'categories' | 'cues'>> & {
  categories?: Partial<NotificationPrefs['categories']>;
  cues?: Partial<NotificationPrefs['cues']>;
};

export const DEFAULT_VOLUME = 0.8;

function allCuesOn(): Record<SoundKind, boolean> {
  return Object.fromEntries(SOUND_KINDS.map((k) => [k, true])) as Record<SoundKind, boolean>;
}

export function defaultPrefs(): NotificationPrefs {
  return {
    v: 1, sound: true, volume: DEFAULT_VOLUME, cues: allCuesOn(), desktop: true, showRoutine: false,
    categories: { approval: true, input: true, intervention: true, access: true, completed: true, info: false }
  };
}

/** Accept what is on disk or arrives over IPC: anything missing or of the wrong type falls back to the default. */
export function sanitizePrefs(raw: unknown): NotificationPrefs {
  const d = defaultPrefs();
  if (!raw || typeof raw !== 'object') return d;
  const r = raw as Record<string, unknown>;
  const cats = (r.categories && typeof r.categories === 'object' ? r.categories : {}) as Record<string, unknown>;
  const categories = { ...d.categories };
  for (const c of NOTIFICATION_CATEGORIES) if (typeof cats[c] === 'boolean') categories[c] = cats[c] as boolean;
  const rawCues = (r.cues && typeof r.cues === 'object' ? r.cues : {}) as Record<string, unknown>;
  const cues = { ...d.cues };
  for (const k of SOUND_KINDS) {
    if (typeof rawCues[k] === 'boolean') cues[k] = rawCues[k] as boolean;
    // preferences written before every sound had its own switch had one for the start sound only
    else if (k === 'started' && typeof r.startSound === 'boolean') cues[k] = r.startSound;
  }
  return {
    v: 1,
    sound: typeof r.sound === 'boolean' ? r.sound : d.sound,
    volume: typeof r.volume === 'number' && Number.isFinite(r.volume) ? Math.min(1, Math.max(0, Math.round(r.volume * 100) / 100)) : d.volume,
    cues,
    desktop: typeof r.desktop === 'boolean' ? r.desktop : d.desktop,
    showRoutine: typeof r.showRoutine === 'boolean' ? r.showRoutine : d.showRoutine,
    categories
  };
}

export function defaultPriority(category: NotificationCategory): NotificationPriority {
  switch (category) {
    case 'approval': case 'input': return 'high';
    case 'intervention': return 'high';
    case 'access': return 'normal';
    case 'completed': return 'normal';
    default: return 'low';
  }
}

/**
 * Every sound the app makes, in the order Settings lists them. One per kind of event, all variations of one tune
 * (src/main/soundSynth.ts). `started` is not a notification and `signature` is the tune itself: those two are never
 * the answer to a notification, only to an agent starting and to a preview.
 */
export const SOUND_KINDS = ['completed', 'intervention', 'input', 'approval', 'access', 'critical', 'started', 'signature'] as const;
export type SoundKind = typeof SOUND_KINDS[number];

export function isSoundKind(v: unknown): v is SoundKind {
  return typeof v === 'string' && (SOUND_KINDS as readonly string[]).includes(v);
}

/**
 * Which sound a notification gets. Routine information is silent: it is there when you look. A crash is the one
 * "critical" sound; everything else that needs a person has the sound of what it needs.
 */
export function soundFor(category: NotificationCategory, priority: NotificationPriority): SoundKind | null {
  if (priority === 'low') return null;
  switch (category) {
    case 'completed': return 'completed';
    case 'approval': return 'approval';
    case 'input': return 'input';
    case 'access': return 'access';
    case 'intervention': return priority === 'critical' ? 'critical' : 'intervention';
    default: return null;
  }
}

export interface DeliveryPlan {
  /** Keep it at all (routine progress off = not recorded). */
  record: boolean;
  desktop: boolean;
  sound: SoundKind | null;
}

/** What to do with a notification, given the person's preferences. Pure. */
export function deliveryPlan(prefs: NotificationPrefs, category: NotificationCategory, priority: NotificationPriority): DeliveryPlan {
  if (category === 'info' && !prefs.showRoutine) return { record: false, desktop: false, sound: null };
  const wanted = prefs.categories[category] !== false;
  const kind = soundFor(category, priority);
  const sound = wanted && prefs.sound && kind !== null && prefs.cues[kind] !== false ? kind : null;
  // routine information never raises an OS banner; it waits in the inbox
  const desktop = wanted && prefs.desktop && priority !== 'low';
  return { record: true, desktop, sound };
}

/** "{{name}}"-style interpolation, the same syntax the UI's i18n uses, so one string table serves both. */
export function renderText(strings: Record<string, unknown> | undefined, text: NotifText): string {
  const lookup = text.key.split('.').reduce<unknown>((o, p) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[p] : undefined), strings);
  const template = typeof lookup === 'string' ? lookup : text.key;
  return template.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_m, name: string) => {
    const v = text.args?.[name];
    return v === undefined ? '' : String(v);
  });
}

// ─── events → notifications ──────────────────────────────────────────────────

export interface AgentRef { id: string; name: string; isGod?: boolean }

export function durationText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function approvalIntent(agent: AgentRef, request: PendingRequest): NotificationIntent {
  return {
    agentId: agent.id, category: 'approval', priority: 'high',
    title: { key: 'notify.approval.title', args: { agent: agent.name, tool: request.tool ?? '' } },
    body: { key: request.tool ? 'notify.approval.body' : 'notify.approval.bodyPlain', args: { tool: request.tool ?? '' } },
    preview: request.preview || undefined,
    actions: request.automatable ? ['approve', 'reject', 'alternative', 'open'] : ['open'],
    requestKey: `${agent.id}|${request.id}`
  };
}

function inputIntent(agent: AgentRef, request: PendingRequest): NotificationIntent {
  const asOptions = request.automatable && !!request.options?.length;
  return {
    agentId: agent.id, category: 'input', priority: 'high',
    title: { key: 'notify.input.title', args: { agent: agent.name } },
    body: { key: request.options?.length ? 'notify.input.bodyOptions' : 'notify.input.body' },
    preview: request.preview || undefined,
    options: request.options,
    actions: asOptions ? ['option', 'open'] : ['open'],
    requestKey: `${agent.id}|${request.id}`
  };
}

/**
 * The notification, if any, that a lifecycle signal deserves. Returns null for a signal that is not news
 * (a routine finish, a start, a request being resolved: that one resolves a record instead).
 */
export function intentFromSignal(agent: AgentRef, signal: ActivitySignal, at: number): NotificationIntent | null {
  switch (signal.kind) {
    case 'approval-requested': return approvalIntent(agent, signal.request);
    case 'input-requested': return inputIntent(agent, signal.request);
    case 'turn-completed': {
      if (!signal.substantial) return null;
      // The orchestrator answers its inbox all day; only a turn a person asked for is news.
      if (agent.isGod && !signal.userInitiated) return null;
      return {
        agentId: agent.id, category: 'completed', priority: 'normal',
        title: { key: 'notify.completed.title', args: { agent: agent.name } },
        body: { key: signal.tools > 0 ? 'notify.completed.bodyTools' : 'notify.completed.body', args: { duration: durationText(signal.ms), tools: signal.tools } },
        actions: ['open'],
        // each finish is its own event; the clock makes the key unique
        requestKey: `${agent.id}|done|${at}`
      };
    }
    case 'crashed': {
      return {
        agentId: agent.id, category: 'intervention', priority: 'critical',
        title: { key: 'notify.crashed.title', args: { agent: agent.name } },
        body: { key: signal.message ? 'notify.crashed.bodyMessage' : 'notify.crashed.body', args: { code: signal.exitCode ?? signal.signal ?? '?' } },
        preview: signal.message || undefined,
        actions: ['restart', 'open'],
        requestKey: `${agent.id}|crash|${at}`
      };
    }
    case 'breaker': {
      return {
        agentId: agent.id, category: 'intervention', priority: 'high',
        title: { key: signal.level === 'stopped' ? 'notify.breaker.stoppedTitle' : 'notify.breaker.title', args: { agent: agent.name } },
        body: { key: 'notify.breaker.body' },
        preview: signal.reason || undefined,
        actions: ['open'],
        requestKey: `${agent.id}|breaker`
      };
    }
    case 'idle-waiting': {
      return {
        agentId: agent.id, category: 'info', priority: 'low',
        title: { key: 'notify.idle.title', args: { agent: agent.name } },
        body: { key: 'notify.idle.body' },
        actions: ['open'],
        requestKey: `${agent.id}|idle|${at}`
      };
    }
    case 'stopped': {
      return {
        agentId: agent.id, category: 'info', priority: 'low',
        title: { key: 'notify.stopped.title', args: { agent: agent.name } },
        body: { key: 'notify.stopped.body' },
        actions: ['restart', 'open'],
        requestKey: `${agent.id}|stopped|${at}`
      };
    }
    case 'paused': case 'resumed': {
      return {
        agentId: agent.id, category: 'info', priority: 'low',
        title: { key: signal.kind === 'paused' ? 'notify.paused.title' : 'notify.resumed.title', args: { agent: agent.name } },
        body: { key: signal.kind === 'paused' ? 'notify.paused.body' : 'notify.resumed.body' },
        actions: ['open'],
        requestKey: `${agent.id}|${signal.kind}|${at}`
      };
    }
    default: return null;
  }
}

/** A question the agent put to its human through the hive (a task's open question, or a message marked needs-human). */
export function intentFromHumanAsk(agent: AgentRef, ask: { taskId?: string; conversationId?: string; subject: string; question: string; key: string }): NotificationIntent {
  return {
    agentId: agent.id, category: 'input', priority: 'high',
    title: { key: 'notify.ask.title', args: { agent: agent.name } },
    body: { key: 'notify.ask.body', args: { subject: clip(ask.subject, 80) } },
    preview: clip(ask.question),
    actions: ask.taskId ? ['answer', 'open'] : ['open'],
    taskId: ask.taskId,
    conversationId: ask.conversationId,
    requestKey: `${agent.id}|ask|${ask.key}`
  };
}

/** The in-app broker refused an integration call: the agent needs access it was not given. */
export function intentFromAccessDenied(agent: AgentRef, e: { integrationId: string; tool?: string; reason?: string }): NotificationIntent {
  return {
    agentId: agent.id, category: 'access', priority: 'normal',
    title: { key: 'notify.access.title', args: { agent: agent.name, integration: e.integrationId } },
    body: { key: e.tool ? 'notify.access.bodyTool' : 'notify.access.body', args: { integration: e.integrationId, tool: e.tool ?? '' } },
    integrationId: e.integrationId,
    actions: ['settings', 'open'],
    // one notification per agent and integration until access is granted, however many calls were refused
    requestKey: `${agent.id}|access|${e.integrationId}`
  };
}

/** The agent sits at a prompt the terminal parser recognised but no hook announced (an engine without hooks).
 *  `since` is when that episode began, so one episode is one notification however long it lasts. */
export function intentFromStuckPrompt(agent: AgentRef, since: number): NotificationIntent {
  return {
    agentId: agent.id, category: 'intervention', priority: 'high',
    title: { key: 'notify.stuck.title', args: { agent: agent.name } },
    body: { key: 'notify.stuck.body' },
    actions: ['open'],
    requestKey: `${agent.id}|stuck|${since}`
  };
}

export const MAX_HISTORY = 400;
