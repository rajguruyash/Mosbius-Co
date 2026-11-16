import { useCallback, useEffect, useRef, useState } from 'react';
import type { HarnessConfig } from '@/store/config';
import type { McpSecretStatusEntry } from '@shared/mcpAccess';
import type { ConnectionSummary } from '@shared/connect';
import type { HubSnapshot } from './hubUi';

/**
 * Everything the hub tabs need from the main process, in one place, refreshed together. Booleans, statuses and
 * names only: nothing it holds is, or can be turned into, a credential.
 */
const EMPTY: HubSnapshot = { connections: {}, secrets: {}, packages: {}, trust: {}, agents: [] };

export function useHubData(config: HarnessConfig): { snap: HubSnapshot; refresh: () => Promise<void>; loaded: boolean } {
  const [snap, setSnap] = useState<HubSnapshot>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const refresh = useCallback(async () => {
    const api = window.cth;
    const [c, s, p, tr, reg] = await Promise.allSettled([
      api.connectList(), api.mcpSecretStatus(), api.mcpPackageStatus(), api.mcpTrustHintsGet(), api.hiveRegistry()
    ]);
    if (!alive.current) return;
    const connections: Record<string, ConnectionSummary> = {};
    if (c.status === 'fulfilled' && c.value.ok && c.value.connections) for (const x of c.value.connections) connections[x.id] = x;
    const secrets: Record<string, McpSecretStatusEntry> = {};
    if (s.status === 'fulfilled') for (const x of s.value as McpSecretStatusEntry[]) secrets[x.id] = x;
    const packages = p.status === 'fulfilled' && p.value.ok && p.value.packages ? p.value.packages : {};
    const trust = tr.status === 'fulfilled' && tr.value.ok && tr.value.trust ? tr.value.trust : {};
    const agents = reg.status === 'fulfilled' && reg.value?.agents
      ? Object.entries(reg.value.agents).filter(([, a]) => !a.archived).map(([id, a]) => ({ id, name: a.name || id, provider: typeof a.provider === 'string' ? a.provider : undefined }))
      : [];
    setSnap({ connections, secrets, packages, trust, agents });
    setLoaded(true);
  }, []);

  useEffect(() => { void refresh(); }, [refresh, config.mcpDefaults]);

  // while a sign-in waits or a package installs, look again; otherwise stay quiet
  const busy = Object.values(snap.connections).some((c) => c.pending) || Object.values(snap.packages).some((p) => p.state === 'installing');
  useEffect(() => {
    if (!busy) return undefined;
    const timer = setInterval(() => { void refresh(); }, 1500);
    return () => clearInterval(timer);
  }, [busy, refresh]);

  return { snap, refresh, loaded };
}
