import type { CSSProperties } from 'react';
import type { McpCatalogEntry } from '@shared/mcpCatalog';
import type { ConnectionSummary } from '@shared/connect';
import type { McpSecretStatusEntry } from '@shared/mcpAccess';
import type { ProviderManifest } from '@shared/providers';

/**
 * Styles and small derivations shared by the hub's tabs. Logical CSS properties throughout (inline-start,
 * inline-end), so the page reads right-to-left in Arabic without a second set of rules.
 */

export const label: CSSProperties = {
  fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
  color: 'var(--cth-ink-500)', textTransform: 'uppercase'
};
export const note: CSSProperties = { fontSize: 11, lineHeight: '15px', color: 'var(--cth-ink-500)' };
export const body: CSSProperties = { fontSize: 12, lineHeight: '17px', color: 'var(--cth-ink-900)' };

export const card: CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 6, padding: '9px 11px', minWidth: 0,
  background: 'var(--cth-cream-100, var(--cth-paper-100))', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
};

export const btn = (on = false, disabled = false): CSSProperties => ({
  flexShrink: 0, padding: '3px 9px 1px', border: 'none', textTransform: 'uppercase',
  fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '14px', color: on ? 'var(--cth-on-accent)' : 'var(--cth-ink-900)',
  background: on ? 'var(--cth-lemon)' : 'var(--cth-cream-200)',
  boxShadow: `inset 0 0 0 1px ${on ? 'var(--cth-ink-900)' : 'var(--cth-ink-700)'}`,
  cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.45 : 1
});

export const field: CSSProperties = {
  flex: 1, minWidth: 0, padding: '3px 6px', fontSize: 11, fontFamily: 'var(--cth-font-mono)',
  background: 'var(--cth-cream-200)', border: 'none', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)', color: 'var(--cth-ink-900)'
};

export const chip = (tone: 'ok' | 'warn' | 'bad' | 'quiet' = 'quiet'): CSSProperties => ({
  display: 'inline-block', padding: '1px 6px', fontSize: 10, lineHeight: '14px',
  // The accent "-light" fills are pale in the light theme and deep in the dark one, so the ordinary ink reads on both.
  color: tone === 'bad' ? 'var(--cth-danger)' : tone === 'ok' || tone === 'warn' ? 'var(--cth-ink-900)' : 'var(--cth-ink-700)',
  background: tone === 'ok' ? 'var(--cth-mint-light)' : tone === 'warn' ? 'var(--cth-lemon-light)' : 'transparent',
  boxShadow: `inset 0 0 0 1px ${tone === 'bad' ? 'var(--cth-danger)' : tone === 'ok' ? 'var(--cth-mint)' : tone === 'warn' ? 'var(--cth-lemon)' : 'var(--cth-ink-300)'}`
});

export const row: CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' };

/** What the hub knows about the server entries, gathered once per refresh. */
export interface HubSnapshot {
  connections: Record<string, ConnectionSummary>;
  secrets: Record<string, McpSecretStatusEntry>;
  packages: Record<string, { state: 'ready' | 'installing' | 'missing' | 'failed'; name: string; version: string }>;
  trust: Record<string, boolean>;
  /** Each live agent, with its CLI (`provider`) so the page can say what that CLI can do with an integration. */
  agents: Array<{ id: string; name: string; provider?: string }>;
}

export type EntryState = 'connected' | 'needs-signin' | 'ready' | 'not-connected' | 'unavailable';

/** Whether an entry can serve an agent right now, from what the main process reports. Mirrors mcpStatusOf. */
export function entryState(e: McpCatalogEntry, snap: HubSnapshot): EntryState {
  const spec = e.spec;
  const secret = snap.secrets[e.id];
  if (spec.transport === 'bridge') {
    const st = secret?.engine === 'broker' ? secret.state : secret?.connected ? 'connected' : secret?.ready ? 'signed-out' : 'unconfigured';
    return st === 'connected' ? 'connected' : st === 'needs-signin' ? 'needs-signin' : st === 'unavailable' ? 'unavailable' : 'not-connected';
  }
  if (spec.transport === 'http') {
    const c = snap.connections[e.id];
    if (c?.status === 'connected') return 'connected';
    if (spec.secretHeader && secret?.ready) return 'connected';
    if (c?.status === 'needs-signin') return 'needs-signin';
    if (c?.status === 'unavailable') return 'unavailable';
    return 'not-connected';
  }
  if ((spec.secretEnv?.length ?? 0) > 0 && !secret?.ready) return 'not-connected';
  return snap.packages[e.id]?.state === 'ready' ? 'connected' : 'ready';
}

/** The best state among a provider's entries (connected beats everything). */
export function providerState(entries: McpCatalogEntry[], snap: HubSnapshot): EntryState {
  const states = entries.map((e) => entryState(e, snap));
  for (const s of ['connected', 'needs-signin', 'unavailable', 'ready'] as EntryState[]) if (states.includes(s)) return s;
  return 'not-connected';
}

export const catalogEntriesOf = (p: ProviderManifest, all: readonly McpCatalogEntry[]): McpCatalogEntry[] =>
  p.mcp.map((id) => all.find((e) => e.id === id)).filter((e): e is McpCatalogEntry => !!e);
