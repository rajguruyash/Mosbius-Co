/**
 * What the Settings panel and the main process say to each other about the in-app MCP
 * broker's access controls. Plain data, importable by both; no secret is ever in it:
 * an integration's state, its tools' names, classes and descriptions, who is allowed to
 * do what, and what was recently used (metadata only).
 */
import type { McpEngine, McpToolClass } from './mcpCatalog';

export type McpConnectionState = 'unconfigured' | 'signed-out' | 'connected' | 'needs-signin' | 'unavailable';

export type McpPreset = 'none' | 'read' | 'write' | 'custom';

/** One grant: a preset, tools named on top of it, tools refused whatever else says, and an optional end. */
export interface McpGrantView {
  preset: McpPreset;
  allow?: string[];
  deny?: string[];
  /** Epoch ms. At or past this instant the grant is no grant. */
  expiresAt?: number;
}

export interface McpGrantsView {
  /** Applies to every agent that has no entry of its own for the integration. */
  defaults?: Record<string, McpGrantView>;
  /** An entry for an agent wins over the default, even when it says `none`. */
  agents?: Record<string, Record<string, McpGrantView>>;
}

/** A change to the grants: one integration, for every agent (`agentId` null) or for one.
 *  `grant: null` removes the entry (for an agent: back to the default). */
export interface McpGrantUpdate {
  id: string;
  agentId: string | null;
  grant: McpGrantView | null;
}

export interface McpToolEntry {
  name: string;
  description: string;
  /** `destructive` also stands for "not classified yet": nothing a preset can reach. */
  class: McpToolClass;
}

/** One record of the durable audit trail, as the renderer may see it. Metadata only: no
 *  body, argument, header or credential is ever recorded (src/main/broker/audit-store.ts). */
export interface AuditEventView {
  seq: number;
  at: number;
  kind: string;
  actor?: string;
  agentId?: string;
  integrationId?: string;
  action?: string;
  decision?: 'allow' | 'deny';
  reason?: string;
  detail?: string;
  count?: number;
}

export interface McpActivityEvent {
  at: number;
  agentId: string;
  integrationId: string;
  method?: string;
  tool?: string;
  decision: 'allow' | 'deny';
  reason?: string;
}

/** What `mcpSecretStatus` says about one integration. Booleans and words, never a value. */
export interface McpSecretStatusEntry {
  id: string;
  needsOauthClient: boolean;
  stored: boolean[];
  ready: boolean;
  connected: boolean;
  engine: McpEngine;
  /** Whether this integration can use the in-app engine at all. */
  inAppCapable: boolean;
  state?: McpConnectionState;
}

/** What switching an integration's engine did to an existing sign-in. */
export type McpImportResult = 'copied' | 'copied-short' | 'none' | 'already' | 'failed' | 'unchanged' | 'n/a';
