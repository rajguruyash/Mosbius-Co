/**
 * How the app joins the pieces for MCP integrations that use the in-app engine:
 * which integrations the broker serves, which an agent is given an entry for, and
 * what a change to the access grants may contain. Pure functions over plain data,
 * so every rule is unit-tested without Electron.
 *
 * The one rule behind all of it: NOTHING IS ON UNTIL THE USER SAYS SO, AND SAYS IT
 * SEVERAL TIMES. An agent gets an entry for an integration only when
 *   1. the integration's engine is `broker` (opt-in, per integration),
 *   2. the user switched the integration ON (consent),
 *   3. the user signed in (a connected sign-in), and
 *   4. the user granted THIS agent some access (the default is none).
 * Each of them is also re-checked on every request the broker serves.
 */
import { INTEGRATION_SLUG_RE } from '../shared/integrations';
import { MCP_CATALOG, type McpCatalogEntry } from '../shared/mcpCatalog';
import type { McpIntegration } from './broker/mcp-route';
import {
  effectiveGrant, normalizeGrant, type IntegrationGrant, type McpGrants, type Preset
} from './broker/permissions';
import { engineFor } from './mcpEngine';
import type { ConnectionState } from './oauth/provider';

/** The part of the config these functions read. */
export interface WiringConfig {
  mcpEngine?: { [id: string]: unknown };
  mcpDefaults?: { [id: string]: { enabled?: unknown } | undefined };
  mcpGrants?: McpGrants;
  restGrants?: McpGrants;
  mcpTrustHints?: { [id: string]: boolean | undefined };
}

/**
 * Integrations the in-app broker can serve: EVERY catalogue entry. The local servers and the
 * hosted GitHub server are reached only through it (Stage B): the app runs the former and holds
 * the credential for the latter, so an agent's config never carries a command or a secret. A
 * bridged service (Gmail, Calendar, Drive, Slack) is served too once its engine is `broker`; with
 * the engine on `bridge` the old `mcp-remote` path is the one that runs, as before.
 */
export const brokerCapableIds = (): string[] => MCP_CATALOG.map((e) => e.id);

const isBrokerCapable = (id: string): boolean => brokerCapableIds().includes(id);

/** Explicit consent only: an absent entry is off, and so is anything but `true`. */
export const consented = (cfg: WiringConfig, id: string): boolean => cfg.mcpDefaults?.[id]?.enabled === true;

/** How long a request to an app-run local server may take before the route gives up on it (a
 *  browser or a fetch can be slow). The host has its own, longer, per-request limit. */
export const HOSTED_HEADERS_MS = 130_000;

/**
 * The route's view of an integration, or undefined when the broker does not serve it right now.
 * A bridged service is served only when its engine is `broker`; every other entry is served
 * whenever it exists (whether it is ON is `enabled`, which is the user's consent). The upstream
 * is the catalogue's and nothing an agent or the renderer can change.
 */
export function mcpIntegrationFor(id: string, cfg: WiringConfig): McpIntegration | undefined {
  const entry = MCP_CATALOG.find((e) => e.id === id);
  if (!entry) return undefined;
  const spec = entry.spec;
  // Tool classes the maintainers pinned from a real listing; an annotation is trusted only if the
  // entry says so, and then only to make a tool STRICTER. A tool nobody classed counts as
  // destructive, so no preset reaches it: it can only be named in an allow list.
  const classification = { toolClasses: spec.toolClasses, trustAnnotations: spec.trustAnnotations === true || cfg.mcpTrustHints?.[id] === true };
  if (spec.transport === 'bridge') {
    if (engineFor(cfg, entry) !== 'broker') return undefined;
    return { id: entry.id, url: spec.url, enabled: consented(cfg, id), classification };
  }
  if (spec.transport === 'http') return { id: entry.id, url: spec.url, enabled: consented(cfg, id), classification };
  return {
    id: entry.id, url: `app-hosted://${entry.id}`, enabled: consented(cfg, id), classification,
    hosted: true, headersMs: HOSTED_HEADERS_MS
  };
}

/** id → whether the in-app broker serves it right now: the engine is `broker` AND consent is on. */
export function brokerExposure(cfg: WiringConfig): Record<string, boolean> {
  return Object.fromEntries(brokerCapableIds().map((id) => [id, mcpIntegrationFor(id, cfg)?.enabled === true]));
}

/** Ids that were served and are not any more (switched off, or back to the bridge). Agent
 *  access to each must end AT ONCE, not at the next request. */
export function noLongerServed(before: Record<string, boolean> | null, after: Record<string, boolean>): string[] {
  if (!before) return [];
  return Object.keys(after).filter((id) => before[id] === true && after[id] !== true);
}

/** The integrations an agent should be handed an entry for at spawn, as ids. */
export function eligibleIntegrationIds(
  cfg: WiringConfig, agentId: string, status: (id: string) => ConnectionState, now: number
): string[] {
  const out: string[] = [];
  for (const entry of MCP_CATALOG) {
    if (!isEligible(entry, cfg)) continue;
    if (status(entry.id) !== 'connected') continue;
    if (effectiveGrant(cfg.mcpGrants, agentId, entry.id, now).preset === 'none') continue;
    out.push(entry.id);
  }
  return out;
}

function isEligible(entry: McpCatalogEntry, cfg: WiringConfig): boolean {
  if (!consented(cfg, entry.id)) return false;
  // a bridged service needs its engine switched to the broker; every other entry has no other way in
  return entry.spec.transport !== 'bridge' || (!!entry.spec.oauth && engineFor(cfg, entry) === 'broker');
}

// ─── what the general config update may not touch ───────────────────────────

/**
 * Config keys that decide what an agent can reach. The renderer's general
 * `config:update` writes any key it is given, so these two are DROPPED from it: they
 * change only through `mcp:grants:set` and `mcp:setEngine`, which validate the value
 * and the sender. A page that has been tricked into calling `updateConfig` therefore
 * cannot widen an agent's access.
 */
export const PROTECTED_CONFIG_KEYS = ['mcpGrants', 'mcpEngine', 'restGrants', 'connectClientIds', 'mcpTrustHints'] as const;

export function withoutProtectedKeys<T extends object>(patch: T): T {
  if (!patch || typeof patch !== 'object') return patch;
  const copy: Record<string, unknown> = { ...(patch as Record<string, unknown>) };
  for (const k of PROTECTED_CONFIG_KEYS) delete copy[k];
  return copy as T;
}

// ─── grants: what a stored or submitted value may say ───────────────────────

export const AGENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
export const MAX_TOOL_NAMES = 200;
export const MAX_AGENT_ENTRIES = 200;
const TOOL_NAME_RE = /^[^\u0000-\u001f\u007f]{1,256}$/;

const hasOwn = (o: unknown, k: string): boolean => !!o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);

/** Whether an id is a REST integration's id (a slug). Registry membership is checked where a
 *  grant is WRITTEN; a stored grant only has to be well formed, so one for an integration that
 *  was removed since is harmless and is dropped by `withoutGrantsFor`. */
export const isRestIntegrationId = (id: unknown): id is string => typeof id === 'string' && INTEGRATION_SLUG_RE.test(id);

/** What a stored `mcpGrants` is allowed to say: known integrations, known presets, bounded lists. */
export function sanitizeMcpGrants(raw: unknown): McpGrants {
  return sanitizeGrants(raw, brokerCapableIds());
}

/** The same for `restGrants`: any well-formed integration slug. */
export function sanitizeRestGrants(raw: unknown): McpGrants {
  return sanitizeGrants(raw, (id) => isRestIntegrationId(id));
}

/** `restGrants` with every trace of one integration removed (it was deleted from the registry). */
export function withoutGrantsFor(grants: McpGrants | undefined, id: string): McpGrants {
  const base = sanitizeRestGrants(grants);
  delete base.defaults![id];
  for (const agent of Object.keys(base.agents!)) {
    delete base.agents![agent][id];
    if (Object.keys(base.agents![agent]).length === 0) delete base.agents![agent];
  }
  return base;
}

/** The REST integrations an agent should be handed a capability for: enabled ones it holds a grant for. */
export function restEligibleIds(cfg: WiringConfig, agentId: string, enabledIds: readonly string[], now: number): string[] {
  return enabledIds.filter((id) => effectiveGrant(cfg.restGrants, agentId, id, now).preset !== 'none');
}

export function sanitizeGrants(raw: unknown, valid: readonly string[] | ((id: string) => boolean)): McpGrants {
  const out: McpGrants = { defaults: {}, agents: {} };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const r = raw as { defaults?: unknown; agents?: unknown };
  const capable: string[] = Array.isArray(valid)
    ? [...valid]
    : [...new Set([
      ...Object.keys((r.defaults && typeof r.defaults === 'object' && !Array.isArray(r.defaults)) ? r.defaults as object : {}),
      ...Object.values((r.agents && typeof r.agents === 'object' && !Array.isArray(r.agents)) ? r.agents as Record<string, unknown> : {})
        .flatMap((v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v as object) : []))
    ])].filter((id) => (valid as (id: string) => boolean)(id));
  const keep = (g: unknown): IntegrationGrant => {
    const n = normalizeGrant(g);
    return {
      ...n,
      ...(n.allow ? { allow: n.allow.filter((x) => TOOL_NAME_RE.test(x)).slice(0, MAX_TOOL_NAMES) } : {}),
      ...(n.deny ? { deny: n.deny.filter((x) => TOOL_NAME_RE.test(x)).slice(0, MAX_TOOL_NAMES) } : {})
    };
  };
  if (r.defaults && typeof r.defaults === 'object' && !Array.isArray(r.defaults)) {
    for (const id of capable) if (hasOwn(r.defaults, id)) out.defaults![id] = keep((r.defaults as Record<string, unknown>)[id]);
  }
  if (r.agents && typeof r.agents === 'object' && !Array.isArray(r.agents)) {
    let n = 0;
    for (const agentId of Object.keys(r.agents)) {
      if (!AGENT_ID_RE.test(agentId) || n >= MAX_AGENT_ENTRIES) continue;
      const per = (r.agents as Record<string, unknown>)[agentId];
      if (!per || typeof per !== 'object' || Array.isArray(per)) continue;
      const mine: Record<string, IntegrationGrant> = {};
      for (const id of capable) if (hasOwn(per, id)) mine[id] = keep((per as Record<string, unknown>)[id]);
      if (Object.keys(mine).length) { out.agents![agentId] = mine; n++; }
    }
  }
  return out;
}

export type GrantUpdateResult = { ok: true; grants: McpGrants } | { ok: false; error: string };

const PRESETS: readonly Preset[] = ['none', 'read', 'write', 'custom'];

function toolList(v: unknown, what: string): { ok: true; list: string[] | undefined } | { ok: false; error: string } {
  if (v === undefined || v === null) return { ok: true, list: undefined };
  if (!Array.isArray(v)) return { ok: false, error: `${what} must be a list of tool names` };
  if (v.length > MAX_TOOL_NAMES) return { ok: false, error: `${what} may name at most ${MAX_TOOL_NAMES} tools` };
  const list: string[] = [];
  for (const x of v) {
    if (typeof x !== 'string' || !TOOL_NAME_RE.test(x)) return { ok: false, error: `${what} holds something that is not a tool name` };
    if (!list.includes(x)) list.push(x);
  }
  return { ok: true, list: list.length ? list : undefined };
}

/**
 * Apply one change to the grants, or refuse it. `input` is what the renderer sent, so
 * every part of it is checked: the integration must be one the engine can serve, an
 * agent id must look like an agent id, and a grant must be exactly a preset with
 * bounded, plain-text tool lists. `grant: null` removes the entry (for an agent that
 * means "use the default"; for the default it means "no access").
 */
export function applyGrantUpdate(
  current: McpGrants | undefined, input: unknown, isValidId: (id: string) => boolean = isBrokerCapable
): GrantUpdateResult {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'invalid request' };
  const u = input as { id?: unknown; agentId?: unknown; grant?: unknown };
  if (typeof u.id !== 'string' || !isValidId(u.id)) return { ok: false, error: 'unknown integration' };
  const agentId = u.agentId === undefined || u.agentId === null ? null : u.agentId;
  if (agentId !== null && (typeof agentId !== 'string' || !AGENT_ID_RE.test(agentId))) return { ok: false, error: 'invalid agent' };

  let next: IntegrationGrant | null = null;
  if (u.grant !== null && u.grant !== undefined) {
    if (typeof u.grant !== 'object' || Array.isArray(u.grant)) return { ok: false, error: 'invalid grant' };
    const g = u.grant as { preset?: unknown; allow?: unknown; deny?: unknown; expiresAt?: unknown };
    if (typeof g.preset !== 'string' || !PRESETS.includes(g.preset as Preset)) return { ok: false, error: 'unknown preset' };
    const allow = toolList(g.allow, 'allow');
    if (!allow.ok) return allow;
    const deny = toolList(g.deny, 'deny');
    if (!deny.ok) return deny;
    if (g.expiresAt !== undefined && g.expiresAt !== null && !(typeof g.expiresAt === 'number' && Number.isFinite(g.expiresAt) && g.expiresAt > 0)) {
      return { ok: false, error: 'invalid expiry' };
    }
    next = g.preset === 'none'
      ? { preset: 'none' }
      : {
        preset: g.preset as Preset,
        ...(allow.list ? { allow: allow.list } : {}),
        ...(deny.list ? { deny: deny.list } : {}),
        ...(typeof g.expiresAt === 'number' ? { expiresAt: g.expiresAt } : {})
      };
  }

  const base = sanitizeGrants(current, isValidId === isBrokerCapable ? brokerCapableIds() : (id) => isValidId(id) || isRestIntegrationId(id));
  if (agentId === null) {
    if (next === null) delete base.defaults![u.id]; else base.defaults![u.id] = next;
  } else {
    const mine = { ...(base.agents![agentId] ?? {}) };
    if (next === null) delete mine[u.id]; else mine[u.id] = next;
    if (Object.keys(mine).length) {
      if (!hasOwn(base.agents, agentId) && Object.keys(base.agents!).length >= MAX_AGENT_ENTRIES) return { ok: false, error: 'too many agents have their own access settings' };
      base.agents![agentId] = mine;
    } else delete base.agents![agentId];
  }
  return { ok: true, grants: base };
}
