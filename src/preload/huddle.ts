/**
 * The Huddle window's bridge: only what a floating view of the agents needs, nothing more.
 *
 * It is a separate preload from the main window's (which exposes the whole app) on purpose: the Huddle shows
 * agent output and takes typed instructions, so it gets a narrow, named surface. It can show state, send a
 * message, pause/resume/interrupt/end/restart an agent, answer a notification, and look at a terminal and a
 * conversation. It cannot read files, change settings, or reach the integrations.
 */
import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
import type { CommandResult, HuddleCommand, HuddleLevel, HuddleState } from '../shared/huddle';
import type { NotificationPrefs, NotificationPrefsPatch } from '../shared/notifications';
import type { NotifySnapshot } from '../main/notifyService';
import type { ConversationMessage } from '../main/conversation';

export interface PickedFile { path: string; name: string; image: boolean }
export interface FilePreview { ok: boolean; kind?: 'image' | 'file'; dataUrl?: string; width?: number; height?: number; bytes?: number; error?: string }

const on = <T>(channel: string, cb: (payload: T) => void): (() => void) => {
  const listener = (_e: IpcRendererEvent, payload: T): void => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

const api = {
  /** The whole picture: every agent, what it is doing, what is waiting on a person. */
  state: (): Promise<HuddleState | null> => ipcRenderer.invoke('huddle:getState'),
  onState: (cb: (s: HuddleState) => void): (() => void) => on('huddle:state', cb),
  notifications: (): Promise<NotifySnapshot | null> => ipcRenderer.invoke('notify:get'),
  onNotifications: (cb: (s: NotifySnapshot) => void): (() => void) => on('notify:changed', cb),
  /** Another part of the app (a clicked banner) asked the Huddle to show one agent. */
  onOpenAgent: (cb: (e: { agentId: string }) => void): (() => void) => on('huddle:openAgent', cb),

  /** Compact list, expanded panel, or one agent. The window resizes to fit. */
  setLevel: (level: HuddleLevel, agentId?: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('huddle:setLevel', level, agentId),
  /** The person is typing into one of the Huddle's fields: only then may the window take the keyboard. */
  keyboard: (on: boolean): Promise<{ ok: boolean }> => ipcRenderer.invoke('huddle:keyboard', on),
  /** Back to the full app: the main window returns and the Huddle closes. */
  exit: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('huddle:exit'),

  /** Send, pause, resume, interrupt, end or restart: each reaches only the agent it names. */
  command: (cmd: HuddleCommand): Promise<CommandResult> => ipcRenderer.invoke('huddle:command', cmd),
  /** Act on a notification: approve, reject, an alternative, an option, an answer, open, dismiss, restart. */
  resolve: (req: { id: string; action: string; text?: string; index?: number }): Promise<CommandResult> => ipcRenderer.invoke('notify:resolve', req),
  markRead: (id: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('notify:markRead', id),
  markAllRead: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('notify:markAllRead'),
  clearNotifications: (): Promise<{ ok: boolean; removed?: number }> => ipcRenderer.invoke('notify:clear'),
  setNotificationPrefs: (patch: NotificationPrefsPatch): Promise<{ ok: boolean; prefs?: NotificationPrefs }> => ipcRenderer.invoke('notify:setPrefs', patch),
  testNotification: (): Promise<{ ok: boolean; status?: string }> => ipcRenderer.invoke('notify:testDesktop'),
  /** Play one of the app's sounds, and nothing else: no notification, no change to any agent. */
  previewNotificationSound: (kind: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('notify:previewSound', kind),
  openSystemNotificationSettings: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('notify:openSystemSettings'),

  /** A read-only mirror of an agent's terminal: what is on its screen now, then everything new. */
  terminalAttach: (agentId: string): Promise<{ ok: boolean; error?: string; ptyId?: string; replay?: string; cols?: number; rows?: number }> =>
    ipcRenderer.invoke('huddle:terminalAttach', agentId),
  terminalDetach: (agentId: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('huddle:terminalDetach', agentId),
  onTerminalData: (cb: (e: { id: string; data: string }) => void): (() => void) => on('huddle:ptyData', cb),
  onTerminalGeometry: (cb: (e: { id: string; cols: number; rows: number }) => void): (() => void) => on('huddle:ptyGeometry', cb),
  onTerminalExit: (cb: (e: { id: string; exitCode?: number; signal?: number }) => void): (() => void) => on('huddle:ptyExit', cb),

  /** The agent's conversation, from the transcript its CLI keeps (or the hive thread where it keeps none). */
  conversation: (agentId: string): Promise<{ ok: boolean; error?: string; source?: 'transcript' | 'hive'; messages?: ConversationMessage[]; truncated?: boolean }> =>
    ipcRenderer.invoke('huddle:conversation', agentId),

  /** Attachments: the system's own file picker, a preview before sending, a pasted screenshot, a dropped file. */
  pickFiles: (kind: 'files' | 'images'): Promise<{ ok: boolean; error?: string; files?: PickedFile[] }> => ipcRenderer.invoke('huddle:pickFiles', kind),
  previewFile: (path: string): Promise<FilePreview> => ipcRenderer.invoke('huddle:previewFile', path),
  pasteImage: (): Promise<{ ok: boolean; error?: string; file?: PickedFile }> => ipcRenderer.invoke('huddle:pasteImage'),
  pathForFile: (file: File): string => webUtils.getPathForFile(file),

  reportLanguage: (lng: string): void => ipcRenderer.send('app:reportLanguage', lng),
  /** Only present when the app was started by the real-app tour. */
  debug: (): Promise<unknown> => ipcRenderer.invoke('huddle:debug'),
  debugMove: (x: number, y: number): Promise<unknown> => ipcRenderer.invoke('huddle:debugMove', x, y),
  platform: process.platform as string
};

contextBridge.exposeInMainWorld('huddle', api);
export type HuddleApi = typeof api;
