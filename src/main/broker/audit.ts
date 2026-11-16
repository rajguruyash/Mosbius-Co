/**
 * What agents have used, for the Access section of Settings.
 *
 * METADATA ONLY, in memory, bounded. An entry says which agent called which
 * integration's method or tool and whether the broker allowed it. It never holds a
 * request or response body, a tool argument, a header or a credential: the route
 * builds it from fixed fields (and a tool name an agent chose, stripped of control
 * characters and cut short), and this class refuses to store anything else.
 */
import type { McpAuditEvent } from './mcp-route';

export const AUDIT_CAPACITY = 500;
const TEXT_LIMIT = 128;

const clean = (v: unknown): string | undefined =>
  typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, TEXT_LIMIT) : undefined;

export class AuditLog {
  private readonly ring: McpAuditEvent[] = [];

  constructor(private readonly capacity = AUDIT_CAPACITY) {}

  push(e: McpAuditEvent): void {
    // copy field by field: nothing the route did not mean to pass can ride along
    const entry: McpAuditEvent = {
      at: Number.isFinite(e.at) ? e.at : 0,
      agentId: clean(e.agentId) ?? '',
      integrationId: clean(e.integrationId) ?? '',
      decision: e.decision === 'allow' ? 'allow' : 'deny',
      ...(clean(e.method) !== undefined ? { method: clean(e.method) } : {}),
      ...(clean(e.tool) !== undefined ? { tool: clean(e.tool) } : {}),
      ...(clean(e.reason) !== undefined ? { reason: clean(e.reason) } : {})
    };
    this.ring.push(entry);
    if (this.ring.length > this.capacity) this.ring.splice(0, this.ring.length - this.capacity);
  }

  /** Newest first. `integrationId` narrows it; `limit` caps it. */
  recent(integrationId?: string, limit = 100): McpAuditEvent[] {
    const out: McpAuditEvent[] = [];
    for (let i = this.ring.length - 1; i >= 0 && out.length < limit; i--) {
      if (integrationId === undefined || this.ring[i].integrationId === integrationId) out.push({ ...this.ring[i] });
    }
    return out;
  }

  /** Forget what was recorded for one integration (it was disconnected). */
  clear(integrationId?: string): void {
    if (integrationId === undefined) { this.ring.length = 0; return; }
    for (let i = this.ring.length - 1; i >= 0; i--) if (this.ring[i].integrationId === integrationId) this.ring.splice(i, 1);
  }

  size(): number { return this.ring.length; }
}
