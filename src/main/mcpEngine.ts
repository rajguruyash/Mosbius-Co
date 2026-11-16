/**
 * Which implementation signs a bridged integration in.
 *
 * `bridge` (the default, always) is the `mcp-remote` path that has been working.
 * `broker` is the in-app OAuth engine (src/main/oauth/). The choice is per
 * integration, in `config.mcpEngine`, and ONLY an integration whose catalogue entry
 * has an `oauth` spec can ever be `broker`. Anything else — a missing key, a typo,
 * a value from a newer version, an id with no spec — is `bridge`. The way back is
 * always to leave the switch on `bridge`: the bridge code and its stored tokens are
 * untouched by the other engine.
 */
import { MCP_CATALOG, type McpCatalogEntry, type McpEngine } from '../shared/mcpCatalog';

export function engineFor(
  cfg: { mcpEngine?: { [id: string]: unknown } } | undefined,
  entry: McpCatalogEntry | undefined
): McpEngine {
  if (!entry || entry.spec.transport !== 'bridge' || !entry.spec.oauth) return 'bridge';
  return cfg?.mcpEngine?.[entry.id] === 'broker' ? 'broker' : 'bridge';
}

/** What a stored `mcpEngine` map is allowed to say: known ids, known engines. */
export function sanitizeMcpEngine(raw: unknown): { [id: string]: McpEngine } {
  const out: { [id: string]: McpEngine } = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const e of MCP_CATALOG) {
    if (e.spec.transport === 'bridge' && e.spec.oauth && Object.prototype.hasOwnProperty.call(raw, e.id)) {
      const v = (raw as Record<string, unknown>)[e.id];
      if (v === 'broker' || v === 'bridge') out[e.id] = v;
    }
  }
  return out;
}
