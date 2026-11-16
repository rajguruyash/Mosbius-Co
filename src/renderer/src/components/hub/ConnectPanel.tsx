import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { HarnessConfig } from '@/store/config';
import { MCP_CATALOG, mcpNeedsOauthClient, type McpCatalogEntry } from '@shared/mcpCatalog';
import type { ProviderManifest } from '@shared/providers';
import { btn, catalogEntriesOf, entryState, field, label, note, row, type HubSnapshot } from './hubUi';

/**
 * How one provider is connected, one way after another, in the order the manifest lists them. Every action
 * here goes through a validated IPC: the page sends a short id, a public client id, or a secret to be sealed;
 * it is never given a credential back, and a failure is a fixed code translated here.
 */
export interface ConnectPanelProps {
  provider: ProviderManifest;
  config: HarnessConfig;
  snap: HubSnapshot;
  refresh: () => Promise<void>;
  /** Jump to another part of Settings or of the hub. */
  go: (to: 'rest' | 'ai-engines') => void;
}

const isDcr = (e: McpCatalogEntry): boolean => e.spec.transport === 'http' && !!e.spec.connect?.methods.some((m) => m.kind === 'dcr');
const isDevice = (e: McpCatalogEntry): boolean => e.spec.transport === 'http' && !!e.spec.connect?.methods.some((m) => m.kind === 'device');
const takesToken = (e: McpCatalogEntry): boolean =>
  (e.spec.transport === 'http' && !!e.spec.secretHeader) || ((e.spec.transport === undefined || e.spec.transport === 'stdio') && (e.spec.secretEnv?.length ?? 0) > 0);

export function ConnectPanel({ provider, config, snap, refresh, go }: ConnectPanelProps) {
  const { t } = useTranslation();
  const entries = catalogEntriesOf(provider, MCP_CATALOG);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [tier, setTier] = useState<'read' | 'write'>('read');

  const say = (tone: 'ok' | 'bad', text: string) => { setMsg({ tone, text }); setTimeout(() => setMsg(null), 9000); };
  const turnOn = async (id: string) => {
    if (config.mcpDefaults?.[id]?.enabled !== true) await window.cth.updateConfig({ mcpDefaults: { ...(config.mcpDefaults ?? {}), [id]: { enabled: true } } });
  };
  const errorText = (code?: string) => t(`hub.connect.errors.${code && /^[a-z-]{2,30}$/.test(code) ? code : 'failed'}`, { defaultValue: t('hub.connect.errors.failed') });

  // ─── sign in with the account (the app registers itself) ─────────────────────────────────────────────
  const account = entries.find(isDcr);
  const connectAccount = async (e: McpCatalogEntry) => {
    setBusy(`account:${e.id}`);
    const r = await window.cth.connectStart({ id: e.id, method: 'dcr', tier });
    setBusy(null);
    if (r.ok) { await turnOn(e.id); say('ok', t('hub.connect.done', { label: provider.label })); } else say('bad', errorText(r.error));
    await refresh();
  };

  // ─── a code typed at the provider's page ─────────────────────────────────────────────────────────────
  const device = entries.find(isDevice);
  const connectDevice = async (e: McpCatalogEntry) => {
    const clientId = (draft[`cid:${e.id}`] ?? config.connectClientIds?.[e.id] ?? '').trim();
    setBusy(`device:${e.id}`);
    const r = await window.cth.connectStart({ id: e.id, method: 'device', clientId });
    setBusy(null);
    if (r.ok) { await turnOn(e.id); say('ok', t('hub.connect.done', { label: provider.label })); } else say('bad', errorText(r.error));
    await refresh();
  };

  // ─── a key you create at the provider ────────────────────────────────────────────────────────────────
  const keyed = entries.find(takesToken);
  const saveKey = async (e: McpCatalogEntry) => {
    const v = (draft[`key:${e.id}`] ?? '').trim();
    if (!v) return;
    const r = await window.cth.mcpSetSecret({ id: e.id, secret: v });
    setDraft((d) => ({ ...d, [`key:${e.id}`]: '' }));               // never keep plaintext around
    if (r.ok) { await turnOn(e.id); say('ok', t('hub.key.saved', { label: provider.label })); } else say('bad', r.error ?? t('hub.connect.errors.failed'));
    await refresh();
  };

  // ─── an app of your own, then one sign-in ────────────────────────────────────────────────────────────
  const ownApp = entries.find(mcpNeedsOauthClient);
  const saveHalf = async (e: McpCatalogEntry, f: 'client_id' | 'client_secret') => {
    const v = (draft[`${f}:${e.id}`] ?? '').trim();
    if (!v) return;
    const r = await window.cth.mcpSetSecret({ id: e.id, field: f, secret: v });
    setDraft((d) => ({ ...d, [`${f}:${e.id}`]: '' }));
    if (!r.ok) say('bad', r.error ?? t('hub.connect.errors.failed'));
    await refresh();
  };
  const signInOwn = async (e: McpCatalogEntry) => {
    setBusy(`own:${e.id}`);
    const r = await window.cth.mcpSignIn(e.id);
    setBusy(null);
    if (r.ok) { await turnOn(e.id); say('ok', t('hub.connect.done', { label: provider.label })); } else say('bad', errorText(r.error));
    await refresh();
  };

  // ─── run on this computer ────────────────────────────────────────────────────────────────────────────
  const local = entries.find((e) => e.spec.transport === undefined || e.spec.transport === 'stdio');
  const installLocal = async (e: McpCatalogEntry) => {
    setBusy(`local:${e.id}`);
    const r = await window.cth.mcpPackageInstall(e.id);
    setBusy(null);
    if (!r.ok) say('bad', t('hub.local.installFailed', { label: e.label }));
    await refresh();
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {provider.ways.map((way) => {
        if (way === 'account' && account) {
          const c = snap.connections[account.id];
          const waiting = c?.pending?.kind === 'browser' || busy === `account:${account.id}`;
          const tiers = account.spec.transport === 'http' && account.spec.connect?.scopes?.read !== undefined && account.spec.connect?.scopes?.write !== undefined;
          return (
            <div key={way} style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              <span style={label}>{t('hub.way.account')}</span>
              <span style={note}>{t('hub.account.help', { label: provider.label })}</span>
              {tiers && (
                <div style={row}>
                  <span style={note}>{t('hub.connect.tier')}</span>
                  {(['read', 'write'] as const).map((x) => (
                    <button key={x} type="button" style={btn(tier === x)} onClick={() => setTier(x)}>{t(x === 'read' ? 'hub.connect.tierRead' : 'hub.connect.tierWrite')}</button>
                  ))}
                </div>
              )}
              <div style={row}>
                <button type="button" style={btn(false, waiting)} disabled={waiting} onClick={() => { void connectAccount(account); }}>
                  {c?.status === 'connected' || c?.status === 'needs-signin' ? t('hub.card.reconnect') : t('hub.card.connect')}
                </button>
                {waiting && (<>
                  <span style={note}>{t('hub.connect.waitingBrowser')}</span>
                  <button type="button" style={btn()} onClick={() => { void window.cth.connectCancel(account.id).then(refresh); }}>{t('hub.connect.cancel')}</button>
                </>)}
              </div>
            </div>
          );
        }
        if (way === 'device' && device) {
          const c = snap.connections[device.id];
          const pending = c?.pending?.kind === 'device' ? c.pending : undefined;
          const waiting = !!pending || busy === `device:${device.id}`;
          const cid = draft[`cid:${device.id}`] ?? config.connectClientIds?.[device.id] ?? '';
          return (
            <div key={way} style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              <span style={label}>{t('hub.way.device')}</span>
              <span style={note}>{t('hub.device.help')}</span>
              <div style={row}>
                <span style={{ ...label, width: 92, flexShrink: 0 }}>{t('hub.connect.clientId')}</span>
                <input type="text" spellCheck={false} autoComplete="off" value={cid} placeholder={t('hub.connect.clientIdPlaceholder')} style={field}
                  onChange={(ev) => setDraft((d) => ({ ...d, [`cid:${device.id}`]: ev.target.value }))} />
              </div>
              <div style={row}>
                <button type="button" style={btn(false, waiting || !cid.trim())} disabled={waiting || !cid.trim()} onClick={() => { void connectDevice(device); }}>
                  {t('hub.card.connect')}
                </button>
                {waiting && !pending && <span style={note}>{t('hub.connect.starting')}</span>}
                {waiting && <button type="button" style={btn()} onClick={() => { void window.cth.connectCancel(device.id).then(refresh); }}>{t('hub.connect.cancel')}</button>}
              </div>
              {pending && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '8px 10px', boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)' }}>
                  <span style={label}>{t('hub.device.title')}</span>
                  <code style={{ fontSize: 22, letterSpacing: 3, fontFamily: 'var(--cth-font-mono)', color: 'var(--cth-ink-900)' }} dir="ltr">{pending.userCode}</code>
                  <span style={note}>{t('hub.device.open', { url: pending.verificationUri })}</span>
                  <div style={row}>
                    <button type="button" style={btn()} onClick={() => { void window.cth.openExternal(pending.verificationUri); }}>{t('hub.device.openButton')}</button>
                  </div>
                </div>
              )}
            </div>
          );
        }
        if (way === 'key') {
          if (keyed) {
            const st = snap.secrets[keyed.id];
            return (
              <div key={way} style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                <span style={label}>{t('hub.way.key')}</span>
                {keyed.secretHelp && <span style={note}>{keyed.secretHelp}</span>}
                <div style={row}>
                  <span style={{ ...label, width: 92, flexShrink: 0 }}>{keyed.secretLabel ?? t('mcpDefaults.token')}</span>
                  <input type="password" autoComplete="off" spellCheck={false} style={field}
                    placeholder={st?.ready ? t('mcpDefaults.stored') : t('mcpDefaults.notSet')} value={draft[`key:${keyed.id}`] ?? ''}
                    onChange={(ev) => setDraft((d) => ({ ...d, [`key:${keyed.id}`]: ev.target.value }))} />
                  <button type="button" style={btn()} onClick={() => { void saveKey(keyed); }}>{t('mcpDefaults.save')}</button>
                </div>
                <span style={note}>{t('hub.key.privacy')}</span>
              </div>
            );
          }
          if (provider.rest.length > 0) {
            return (
              <div key={way} style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                <span style={label}>{t('hub.way.key')}</span>
                <span style={note}>{t('hub.rest.help', { label: provider.label })}</span>
                <div style={row}><button type="button" style={btn()} onClick={() => go('rest')}>{t('hub.rest.open')}</button></div>
              </div>
            );
          }
        }
        if (way === 'own-app' && ownApp) {
          const st = snap.secrets[ownApp.id];
          const waiting = busy === `own:${ownApp.id}`;
          const connected = entryState(ownApp, snap) === 'connected';
          return (
            <div key={way} style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              <span style={label}>{t('hub.way.ownApp')}</span>
              {ownApp.secretHelp && <span style={note}>{ownApp.secretHelp}</span>}
              {(['client_id', 'client_secret'] as const).map((f, i) => (
                <div key={f} style={row}>
                  <span style={{ ...label, width: 92, flexShrink: 0 }}>{t(f === 'client_id' ? 'mcpDefaults.clientId' : 'mcpDefaults.clientSecret')}</span>
                  <input type="password" autoComplete="off" spellCheck={false} style={field}
                    placeholder={st?.stored[i] ? t('mcpDefaults.stored') : t('mcpDefaults.notSet')} value={draft[`${f}:${ownApp.id}`] ?? ''}
                    onChange={(ev) => setDraft((d) => ({ ...d, [`${f}:${ownApp.id}`]: ev.target.value }))} />
                  <button type="button" style={btn()} onClick={() => { void saveHalf(ownApp, f); }}>{t('mcpDefaults.save')}</button>
                </div>
              ))}
              <div style={row}>
                <button type="button" style={btn(false, !st?.ready || waiting || connected)} disabled={!st?.ready || waiting || connected} onClick={() => { void signInOwn(ownApp); }}>
                  {waiting ? t('mcpDefaults.signingIn') : t('mcpDefaults.signIn')}
                </button>
                {!st?.ready && <span style={note}>{t('mcpDefaults.needsBoth')}</span>}
              </div>
            </div>
          );
        }
        if (way === 'local' && local) {
          const pkg = snap.packages[local.id];
          const on = config.mcpDefaults?.[local.id]?.enabled === true;
          return (
            <div key={way} style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              <span style={label}>{t('hub.way.local')}</span>
              <span style={note}>{t('hub.local.help')}</span>
              <div style={row}>
                <button type="button" style={btn(on)} onClick={() => { void window.cth.updateConfig({ mcpDefaults: { ...(config.mcpDefaults ?? {}), [local.id]: { enabled: !on } } }).then(refresh); }}>
                  {on ? t('common.on') : t('common.off')}
                </button>
                {on && pkg && <span style={note}>{t(`mcpDefaults.pkg.${pkg.state}`)}</span>}
                {on && pkg && (pkg.state === 'failed' || pkg.state === 'missing') && (
                  <button type="button" style={btn(false, busy === `local:${local.id}`)} onClick={() => { void installLocal(local); }}>{t('mcpDefaults.pkg.install')}</button>
                )}
              </div>
            </div>
          );
        }
        if (way === 'engine') {
          return (
            <div key={way} style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              <span style={label}>{t('hub.way.engine')}</span>
              <div style={row}><button type="button" style={btn()} onClick={() => go('ai-engines')}>{t('hub.engine.open')}</button></div>
            </div>
          );
        }
        return null;
      })}
      {provider.ways.length === 0 && <span style={note}>{t('hub.planned')}</span>}
      {msg && <span style={{ fontSize: 12, color: msg.tone === 'ok' ? 'var(--cth-mint-700)' : 'var(--cth-danger)' }} role="status">{msg.text}</span>}
    </div>
  );
}
