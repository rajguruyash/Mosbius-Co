/**
 * Who may do what through the MCP route. Pure functions over plain data, so the
 * whole policy is unit-tested without a server.
 *
 * Least privilege is the default at every step:
 *   • no grant means no access, not "everything" — and an agent-level grant of
 *     `none` beats an integration-wide default;
 *   • the presets reach only `read` tools (`read`) or `read` + `write` tools
 *     (`write`). A `destructive` tool (send, post, delete…) is NEVER reached by a
 *     preset: it must be named in `allow`;
 *   • `deny` always wins;
 *   • a tool the broker has never seen listed is denied (unless it is named in
 *     `allow`), because its class is unknown;
 *   • a tool's class comes from the catalogue first. The server's own
 *     annotations are consulted only when the entry says to trust them, and can
 *     only make a tool STRICTER than the catalogue says, never looser. A tool
 *     whose class is unknown counts as `destructive`: no preset reaches it;
 *   • an unrecognised JSON-RPC method is denied.
 */

export type ToolClass = 'read' | 'write' | 'destructive';
export type Preset = 'none' | 'read' | 'write' | 'custom';

export interface IntegrationGrant {
  preset: Preset;
  /** Tool names granted by name. The only way to reach a destructive tool. */
  allow?: string[];
  /** Tool names refused whatever else says. */
  deny?: string[];
  /** Epoch ms. A grant at or past this instant is no grant. */
  expiresAt?: number;
}

export interface McpGrants {
  /** Applies to every agent that has no entry of its own for the integration. */
  defaults?: Record<string, IntegrationGrant>;
  agents?: Record<string, Record<string, IntegrationGrant>>;
}

export interface ToolAnnotations { readOnlyHint?: boolean; destructiveHint?: boolean }
export interface ToolInfo { name: string; annotations?: ToolAnnotations }

export interface ClassificationPolicy {
  /** Classes the catalogue pins, by tool name. */
  toolClasses?: Record<string, ToolClass>;
  /** Consult the server's own annotations. Off until a live listing has been checked. */
  trustAnnotations?: boolean;
}

export const NO_ACCESS: IntegrationGrant = Object.freeze({ preset: 'none' as Preset });

const SEVERITY: Record<ToolClass, number> = { read: 0, write: 1, destructive: 2 };
const PRESETS: readonly Preset[] = ['none', 'read', 'write', 'custom'];
const hasOwn = (o: unknown, k: string): boolean => !!o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);

const stricter = (a: ToolClass, b: ToolClass): ToolClass => (SEVERITY[a] >= SEVERITY[b] ? a : b);

function stringList(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 256);
  return out.length ? out : undefined;
}

/** Config is untrusted input: anything unrecognised becomes `none`. */
export function normalizeGrant(raw: unknown): IntegrationGrant {
  if (!raw || typeof raw !== 'object') return NO_ACCESS;
  const r = raw as Record<string, unknown>;
  const preset = PRESETS.includes(r.preset as Preset) ? (r.preset as Preset) : 'none';
  if (preset === 'none') return NO_ACCESS;
  const allow = stringList(r.allow);
  const deny = stringList(r.deny);
  const expiresAt = typeof r.expiresAt === 'number' && Number.isFinite(r.expiresAt) ? r.expiresAt : undefined;
  return { preset, ...(allow ? { allow } : {}), ...(deny ? { deny } : {}), ...(expiresAt !== undefined ? { expiresAt } : {}) };
}

/** The grant in force for one agent on one integration right now. */
export function effectiveGrant(
  grants: McpGrants | undefined,
  agentId: string,
  integrationId: string,
  now: number
): IntegrationGrant {
  const perAgent = hasOwn(grants?.agents, agentId) ? grants!.agents![agentId] : undefined;
  // An explicit entry for the agent wins even when it says `none`: that is how
  // one agent is cut off while the default stays.
  const raw = hasOwn(perAgent, integrationId)
    ? perAgent![integrationId]
    : hasOwn(grants?.defaults, integrationId) ? grants!.defaults![integrationId] : undefined;
  const grant = normalizeGrant(raw);
  if (grant.expiresAt !== undefined && grant.expiresAt <= now) return NO_ACCESS;
  return grant;
}

/**
 * A tool's class: the stricter of what the catalogue pins and, when trusted, what
 * the server's annotations say.
 *
 * A tool whose class is NOT known is treated as `destructive`. That is deliberate:
 * until a maintainer has pinned the real tool list, every tool is unclassified, and
 * calling those `write` would let the write preset reach a send or delete tool.
 * An unclassified tool is reachable only by naming it in `allow`.
 *
 * Annotations follow the MCP spec's own defaults: `readOnlyHint: true` is a read;
 * otherwise a tool is destructive unless it says `destructiveHint: false`.
 */
export function classifyTool(tool: ToolInfo, policy: ClassificationPolicy = {}): ToolClass {
  const pinned = hasOwn(policy.toolClasses, tool.name) ? policy.toolClasses![tool.name] : undefined;
  let fromAnnotations: ToolClass | undefined;
  if (policy.trustAnnotations && tool.annotations && typeof tool.annotations === 'object' && !Array.isArray(tool.annotations)) {
    const a = tool.annotations;
    if (a.destructiveHint === true) fromAnnotations = 'destructive';
    else if (a.readOnlyHint === true) fromAnnotations = 'read';
    else if (a.destructiveHint === false) fromAnnotations = 'write';
    else fromAnnotations = 'destructive';
  }
  if (pinned && fromAnnotations) return stricter(pinned, fromAnnotations);
  return pinned ?? fromAnnotations ?? 'destructive';
}

/** May this grant call this tool? `cls` is undefined when the tool is not known. */
export function toolAllowed(grant: IntegrationGrant, toolName: string, cls: ToolClass | undefined): boolean {
  if (grant.preset === 'none') return false;
  if (grant.deny?.includes(toolName)) return false;
  if (grant.allow?.includes(toolName)) return true;
  if (cls === undefined) return false;
  if (grant.preset === 'read') return cls === 'read';
  if (grant.preset === 'write') return cls === 'read' || cls === 'write';
  return false; // 'custom' is exactly its allow list
}

export type MethodVerdict =
  | { allow: true; kind: 'passthrough' | 'tools/list' | 'tools/call' | 'response' }
  | { allow: false; reason: string };

const deny = (reason: string): MethodVerdict => ({ allow: false, reason });

/** What a JSON-RPC method may do under a grant. `method` undefined is a JSON-RPC
 *  response (the client answering a server request), which is always let through. */
export function methodVerdict(method: string | undefined, grant: IntegrationGrant): MethodVerdict {
  if (grant.preset === 'none') return deny('no access has been granted');
  if (method === undefined) return { allow: true, kind: 'response' };
  if (method === 'initialize' || method === 'ping' || method === 'completion/complete'
    || method.startsWith('notifications/') || method.startsWith('logging/')) {
    return { allow: true, kind: 'passthrough' };
  }
  if (method === 'tools/list') return { allow: true, kind: 'tools/list' };
  if (method === 'tools/call') return { allow: true, kind: 'tools/call' };
  if (method.startsWith('resources/') || method.startsWith('prompts/')) {
    return grant.preset === 'read' || grant.preset === 'write'
      ? { allow: true, kind: 'passthrough' }
      : deny('resources and prompts need the read or write preset');
  }
  return deny('this method is not permitted');
}
