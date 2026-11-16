/**
 * Capability tokens: who may call the broker, on which channel, for what.
 *
 * A capability is a random handle, not a credential. It names an AGENT and a
 * CHANNEL (`rest` or `mcp`), and lists the integration ids that agent may reach
 * on that channel. Rules this registry enforces:
 *
 *   • one token per agent per channel — never shared between agents, and never
 *     valid on the other channel, so the weaker delivery path (the REST token
 *     travels in an environment variable) cannot unlock the stronger one;
 *   • least privilege: a grant lists ids explicitly; an empty list reaches nothing;
 *   • revocation is synchronous: the very next lookup fails, and listeners are
 *     told in the same tick so in-flight requests can be cut off;
 *   • tokens live in memory only, are never logged, and are looked up by their
 *     SHA-256 digest with a constant-time comparison.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export type Channel = 'rest' | 'mcp';
export const CHANNELS: readonly Channel[] = ['rest', 'mcp'];

export interface Capability {
  /** Opaque id of this grant (NOT the token). Safe to log; used to track streams. */
  readonly id: string;
  readonly agentId: string;
  readonly channel: Channel;
  /** Integration ids reachable with this capability. Mutated in place on revoke. */
  readonly allowedIds: Set<string>;
  readonly grantedAt: number;
}

export type RevokeReason = 'replaced' | 'revoked' | 'integration' | 'cleared';
export type RevokeListener = (cap: Capability, reason: RevokeReason, integrationId?: string) => void;

interface Entry { cap: Capability; digest: Buffer }

const MAX_TOKEN_LENGTH = 512;

const digestOf = (token: string): Buffer => createHash('sha256').update(token, 'utf8').digest();

export class CapabilityRegistry {
  private readonly byDigest = new Map<string, Entry>();
  /** agentId → channel → digest hex */
  private readonly byAgent = new Map<string, Map<Channel, string>>();
  private readonly listeners = new Set<RevokeListener>();

  /**
   * Mint a token for `agentId` on `channel`, valid for `allowedIds`. Any earlier
   * token for the same agent and channel is revoked first. Returns the token.
   */
  grant(agentId: string, channel: Channel, allowedIds: Iterable<string>): string {
    if (typeof agentId !== 'string' || !agentId) throw new TypeError('agentId must be a non-empty string');
    if (!CHANNELS.includes(channel)) throw new TypeError(`unknown channel: ${String(channel)}`);
    const ids = new Set<string>();
    for (const id of allowedIds) {
      if (typeof id !== 'string' || !id) throw new TypeError('allowed ids must be non-empty strings');
      ids.add(id);
    }
    this.revokeChannel(agentId, channel, 'replaced');

    let token: string;
    let digest: Buffer;
    do {
      token = randomBytes(32).toString('base64url');
      digest = digestOf(token);
    } while (this.byDigest.has(digest.toString('hex')));

    const cap: Capability = {
      id: randomBytes(9).toString('base64url'), agentId, channel, allowedIds: ids, grantedAt: Date.now()
    };
    const hex = digest.toString('hex');
    this.byDigest.set(hex, { cap, digest });
    let perAgent = this.byAgent.get(agentId);
    if (!perAgent) { perAgent = new Map(); this.byAgent.set(agentId, perAgent); }
    perAgent.set(channel, hex);
    return token;
  }

  /** The capability a presented token belongs to, or undefined. */
  resolve(presented: string | undefined): Capability | undefined {
    if (typeof presented !== 'string' || !presented || presented.length > MAX_TOKEN_LENGTH) return undefined;
    const digest = digestOf(presented);
    const entry = this.byDigest.get(digest.toString('hex'));
    if (!entry) return undefined;
    return timingSafeEqual(digest, entry.digest) ? entry.cap : undefined;
  }

  /** Revoke one agent's token on one channel. Returns whether there was one. */
  revokeChannel(agentId: string, channel: Channel, reason: RevokeReason = 'revoked'): boolean {
    const perAgent = this.byAgent.get(agentId);
    const hex = perAgent?.get(channel);
    if (!perAgent || !hex) return false;
    const entry = this.byDigest.get(hex);
    this.byDigest.delete(hex);
    perAgent.delete(channel);
    if (perAgent.size === 0) this.byAgent.delete(agentId);
    if (entry) this.notify(entry.cap, reason);
    return true;
  }

  /** Revoke every token an agent holds, on every channel. Returns how many. */
  revokeAgent(agentId: string): number {
    let n = 0;
    for (const channel of CHANNELS) if (this.revokeChannel(agentId, channel)) n++;
    return n;
  }

  /**
   * Take one integration away from every capability (optionally just on one
   * channel), without touching the rest of what they can reach. Returns how many
   * capabilities lost it.
   */
  revokeIntegration(integrationId: string, channel?: Channel): number {
    let n = 0;
    for (const { cap } of this.byDigest.values()) {
      if (channel && cap.channel !== channel) continue;
      if (cap.allowedIds.delete(integrationId)) { n++; this.notify(cap, 'integration', integrationId); }
    }
    return n;
  }

  /** Revoke everything. */
  clear(): void {
    const all = [...this.byDigest.values()];
    this.byDigest.clear();
    this.byAgent.clear();
    for (const { cap } of all) this.notify(cap, 'cleared');
  }

  /** Called synchronously whenever a capability, or one integration of it, is revoked. */
  onRevoke(listener: RevokeListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  has(agentId: string, channel: Channel): boolean {
    return !!this.byAgent.get(agentId)?.has(channel);
  }

  size(): number { return this.byDigest.size; }

  /** What exists, with no tokens in it — for tests and diagnostics. */
  describe(): Array<{ agentId: string; channel: Channel; allowedIds: string[] }> {
    return [...this.byDigest.values()].map(({ cap }) => ({
      agentId: cap.agentId, channel: cap.channel, allowedIds: [...cap.allowedIds].sort()
    }));
  }

  private notify(cap: Capability, reason: RevokeReason, integrationId?: string): void {
    for (const l of [...this.listeners]) {
      try { l(cap, reason, integrationId); } catch { /* a listener must never block a revoke */ }
    }
  }
}
