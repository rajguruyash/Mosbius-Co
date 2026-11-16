import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { HarnessConfig } from '@/store/config';
import {
  MCP_CATALOG, mcpNeedsSecret, mcpNeedsOauthClient, mcpPackageOf, type McpTier, type McpCatalogEntry, type McpEngine
} from '@shared/mcpCatalog';
import type { McpSecretStatusEntry } from '@shared/mcpAccess';
import { McpAccessSection } from './McpAccessSection';

export interface McpDefaultsSettingsProps {
  config: HarnessConfig;
}

const TIER_ORDER: McpTier[] = ['safe-readonly', 'write', 'secret', 'oauth-bridge'];
const TIER_LABEL_KEY: Record<McpTier, string> = {
  'safe-readonly': 'mcpDefaults.tiers.safeReadonly',
  'write': 'mcpDefaults.tiers.write',
  'secret': 'mcpDefaults.tiers.secret',
  'oauth-bridge': 'mcpDefaults.tiers.oauthBridge'
};
const TIER_NOTE_KEY: Record<McpTier, string> = {
  'safe-readonly': 'mcpDefaults.tiers.safeReadonlyNote',
  'write': 'mcpDefaults.tiers.writeNote',
  'secret': 'mcpDefaults.tiers.secretNote',
  'oauth-bridge': 'mcpDefaults.tiers.oauthBridgeNote'
};

/** Booleans and words only — the renderer never sees a stored credential. */
type SecretStatus = McpSecretStatusEntry;

/** The fixed codes main returns for a failed sign-in → the string that explains it. */
const SIGN_IN_ERROR_KEY: Record<string, string> = {
  'in-progress': 'mcpDefaults.signInErrors.inProgress',
  'port-busy': 'mcpDefaults.signInErrors.portBusy',
  'no-npx': 'mcpDefaults.signInErrors.noNpx',
  'timeout': 'mcpDefaults.signInErrors.timeout',
  'not-stored': 'mcpDefaults.signInErrors.notStored',
  'no-client': 'mcpDefaults.needsBoth',
  // the in-app engine's own codes
  'denied': 'mcpDefaults.signInErrors.denied',
  'cancelled': 'mcpDefaults.signInErrors.cancelled',
  'provider-error': 'mcpDefaults.signInErrors.providerError',
  'invalid-callback': 'mcpDefaults.signInErrors.invalidCallback',
  'exchange-failed': 'mcpDefaults.signInErrors.exchangeFailed',
  'bad-token-response': 'mcpDefaults.signInErrors.badTokenResponse',
  'unavailable': 'mcpDefaults.signInErrors.unavailable',
  'no-browser': 'mcpDefaults.signInErrors.noBrowser'
};

const STATE_KEY: Record<string, string> = {
  'unconfigured': 'mcpAccess.state.unconfigured',
  'signed-out': 'mcpAccess.state.signedOut',
  'connected': 'mcpAccess.state.connected',
  'needs-signin': 'mcpAccess.state.needsSignin',
  'unavailable': 'mcpAccess.state.unavailable'
};
const IMPORT_KEY: Record<string, string> = {
  'copied': 'mcpAccess.imported.copied',
  'copied-short': 'mcpAccess.imported.copiedShort',
  'none': 'mcpAccess.imported.none',
  'already': 'mcpAccess.imported.already',
  'failed': 'mcpAccess.imported.failed'
};

const labelStyle: React.CSSProperties = {
  fontFamily: 'var(--cth-font-display)',
  fontSize: 8,
  lineHeight: '12px',
  color: 'var(--cth-ink-500)',
  textTransform: 'uppercase'
};

export function McpDefaultsSettings({ config }: McpDefaultsSettingsProps) {
  const { t } = useTranslation();
  const [note, setNote] = useState('');

  const enabledFor = (id: string): boolean =>
    config.mcpDefaults?.[id]?.enabled ?? MCP_CATALOG.find((e) => e.id === id)?.defaultEnabled ?? false;

  const toggle = async (id: string) => {
    const next = !enabledFor(id);
    try {
      await window.cth.updateConfig({
        mcpDefaults: { ...(config.mcpDefaults ?? {}), [id]: { enabled: next } }
      });
      setNote(t('mcpDefaults.toggleNote', { id, state: next ? t('common.on') : t('common.off') }));
      setTimeout(() => setNote(''), 1800);
    } catch {
      setNote(t('mcpDefaults.couldNotSave'));
      setTimeout(() => setNote(''), 2000);
    }
  };

  const byTier = (tier: McpTier) => MCP_CATALOG.filter((e) => e.tier === tier);

  // ── credentials ──────────────────────────────────────────────────────────
  // Write-only: we can ask whether each half is stored and we can set it, and
  // we can never read one back.
  const [secrets, setSecrets] = useState<SecretStatus[]>([]);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const refreshSecrets = async () => {
    try { setSecrets(await window.cth.mcpSecretStatus()); } catch { /* panel still works */ }
  };
  useEffect(() => { void refreshSecrets(); }, []);
  const statusFor = (id: string) => secrets.find((s) => s.id === id);

  // ── local servers: installed by the app from a hash-pinned lock, run by the app ─────────────────
  type PackageState = 'ready' | 'installing' | 'missing' | 'failed';
  const [packages, setPackages] = useState<Record<string, { state: PackageState; name: string; version: string }>>({});
  const refreshPackages = async () => {
    try { const r = await window.cth.mcpPackageStatus(); if (r.ok && r.packages) setPackages(r.packages); } catch { /* leave as is */ }
  };
  useEffect(() => { void refreshPackages(); }, [config.mcpDefaults]);
  useEffect(() => {
    // while something is installing, look again
    if (!Object.values(packages).some((p) => p.state === 'installing')) return undefined;
    const timer = setInterval(() => { void refreshPackages(); }, 1500);
    return () => clearInterval(timer);
  }, [packages]);
  const installPackage = async (entry: McpCatalogEntry) => {
    const r = await window.cth.mcpPackageInstall(entry.id);
    setNote(r.ok ? t('mcpDefaults.pkg.installed', { label: entry.label }) : t('mcpDefaults.pkg.installFailed', { label: entry.label }));
    setTimeout(() => setNote(''), 4000);
    await refreshPackages();
  };
  /** One line under a switched-on local server: where it comes from, and whether it is ready. */
  const packageRow = (entry: McpCatalogEntry) => {
    const pkg = mcpPackageOf(entry);
    if (!pkg) return null;
    const p = packages[entry.id];
    const state: PackageState = p?.state ?? 'missing';
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', padding: '5px 10px', background: 'var(--cth-cream-100, var(--cth-paper-100))', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)' }}>
        <code style={{ fontSize: 11, color: 'var(--cth-ink-700)' }}>{pkg.name}@{pkg.version}</code>
        <span style={{ fontSize: 11, color: state === 'ready' ? 'var(--cth-mint)' : state === 'failed' ? '#6E1423' : 'var(--cth-ink-500)' }}>
          {t(`mcpDefaults.pkg.${state}`)}
        </span>
        {(state === 'failed' || state === 'missing') && (
          <button type="button" style={{ padding: '2px 8px 0', background: 'var(--cth-cream-200)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)', border: 'none', fontFamily: 'var(--cth-font-display)', fontSize: 8, color: 'var(--cth-ink-900)', cursor: 'pointer', textTransform: 'uppercase' }} onClick={() => { void installPackage(entry); }}>
            {t('mcpDefaults.pkg.install')}
          </button>
        )}
        <span style={{ fontSize: 11, color: 'var(--cth-ink-500)', flexBasis: '100%' }}>{t('mcpDefaults.pkg.note')}</span>
      </div>
    );
  };

  const saveSecret = async (entry: McpCatalogEntry, field?: 'client_id' | 'client_secret') => {
    const key = `${entry.id}:${field ?? 'token'}`;
    const value = (draft[key] ?? '').trim();
    if (!value) return;
    const res = await window.cth.mcpSetSecret({ id: entry.id, field, secret: value });
    setDraft((d) => ({ ...d, [key]: '' }));            // never keep plaintext around
    setNote(res.ok ? t('mcpDefaults.saved', { label: entry.label }) : (res.error ?? t('mcpDefaults.couldNotSave')));
    setTimeout(() => setNote(''), 2200);
    await refreshSecrets();
  };

  const [signingIn, setSigningIn] = useState<string | null>(null);
  const signIn = async (entry: McpCatalogEntry) => {
    setSigningIn(entry.id);
    try {
      const res = await window.cth.mcpSignIn(entry.id);
      const port = entry.spec.transport === 'bridge' ? entry.spec.callbackPort : 0;
      setNote(res.ok
        ? t('mcpDefaults.signedIn', { label: entry.label })
        : t(SIGN_IN_ERROR_KEY[res.error ?? ''] ?? 'mcpDefaults.signInErrors.failed', { port }));
    } catch {
      setNote(t('mcpDefaults.signInErrors.failed'));
    } finally {
      setSigningIn(null);
    }
    setTimeout(() => setNote(''), 6000);
    await refreshSecrets();
  };

  /** Revoke at the service where possible, then forget tokens and client. */
  const disconnect = async (entry: McpCatalogEntry) => {
    const res = await window.cth.mcpDisconnect(entry.id);
    setNote(res.ok
      ? t(res.revoked ? 'mcpDefaults.disconnected' : 'mcpDefaults.disconnectedLocal', { label: entry.label })
      : (res.error ?? t('mcpDefaults.couldNotSave')));
    setTimeout(() => setNote(''), 8000);
    await refreshSecrets();
  };

  /** Choose the sign-in implementation. Nothing stored is deleted either way. */
  const switchEngine = async (entry: McpCatalogEntry, engine: McpEngine) => {
    const res = await window.cth.mcpSetEngine({ id: entry.id, engine });
    if (res.ok) {
      const how = t(engine === 'broker' ? 'mcpAccess.engineInApp' : 'mcpAccess.engineBridge');
      const extra = res.imported && IMPORT_KEY[res.imported] ? ` ${t(IMPORT_KEY[res.imported])}` : '';
      setNote(`${t('mcpAccess.switched', { label: entry.label, engine: how })}${extra}`);
    } else {
      setNote(t('mcpAccess.switchFailed'));
    }
    setTimeout(() => setNote(''), 9000);
    await refreshSecrets();
  };

  const forget = async (entry: McpCatalogEntry) => {
    const res = await window.cth.mcpClearSecret(entry.id);
    // A failed delete must not read as "forgotten": the credential is still stored.
    setNote(res.ok ? t('mcpDefaults.forgot', { label: entry.label }) : (res.error ?? t('mcpDefaults.couldNotSave')));
    setTimeout(() => setNote(''), res.ok ? 2200 : 8000);
    await refreshSecrets();
  };

  const fieldStyle: React.CSSProperties = {
    flex: 1, minWidth: 0, padding: '3px 6px', fontSize: 11,
    fontFamily: 'var(--cth-font-mono)', background: 'var(--cth-cream-200)',
    border: 'none', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)', color: 'var(--cth-ink-900)'
  };
  const smallBtn: React.CSSProperties = {
    flexShrink: 0, padding: '3px 8px 1px', background: 'var(--cth-cream-200)',
    boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)', border: 'none',
    fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '14px',
    color: 'var(--cth-ink-900)', cursor: 'pointer', textTransform: 'uppercase'
  };

  /** The credential rows under a server that needs one. Shown only once the
   *  server is switched on — nothing here is worth filling in before that. */
  const credentials = (entry: McpCatalogEntry) => {
    if (!mcpNeedsSecret(entry)) return null;
    const st = statusFor(entry.id);
    const pair = mcpNeedsOauthClient(entry);
    const fields: Array<{ field?: 'client_id' | 'client_secret'; label: string; set: boolean }> = pair
      ? [
        { field: 'client_id', label: t('mcpDefaults.clientId'), set: !!st?.stored[0] },
        { field: 'client_secret', label: t('mcpDefaults.clientSecret'), set: !!st?.stored[1] }
      ]
      : [{ field: undefined, label: entry.secretLabel ?? t('mcpDefaults.token'), set: !!st?.stored[0] }];
    return (
      <div style={{
        display: 'flex', flexDirection: 'column', gap: 5,
        padding: '7px 10px', background: 'var(--cth-cream-100, var(--cth-paper-100))',
        boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
      }}>
        {entry.secretHelp && (
          <span style={{ fontSize: 11, lineHeight: '15px', color: 'var(--cth-ink-500)' }}>
            {entry.secretHelp}
          </span>
        )}
        {fields.map(({ field, label, set }) => {
          const key = `${entry.id}:${field ?? 'token'}`;
          return (
            <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ ...labelStyle, width: 86, flexShrink: 0 }}>{label}</span>
              <input
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder={set ? t('mcpDefaults.stored') : t('mcpDefaults.notSet')}
                value={draft[key] ?? ''}
                onChange={(ev) => setDraft((d) => ({ ...d, [key]: ev.target.value }))}
                style={fieldStyle}
              />
              <button type="button" style={smallBtn} onClick={() => { void saveSecret(entry, field); }}>
                {t('mcpDefaults.save')}
              </button>
            </div>
          );
        })}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          {pair && !st?.connected && (() => {
            const can = !!st?.ready && signingIn === null;
            return (
              <button
                type="button"
                style={{ ...smallBtn, opacity: can ? 1 : 0.45, cursor: can ? 'pointer' : 'not-allowed' }}
                disabled={!can}
                onClick={() => { void signIn(entry); }}
              >
                {t('mcpDefaults.signIn')}
              </button>
            );
          })()}
          {pair && (st?.connected || st?.stored.some(Boolean)) && (
            <button type="button" style={smallBtn} onClick={() => { void disconnect(entry); }}>
              {t('mcpDefaults.disconnect')}
            </button>
          )}
          {!pair && st?.stored.some(Boolean) && (
            <button type="button" style={smallBtn} onClick={() => { void forget(entry); }}>
              {t('mcpDefaults.forget')}
            </button>
          )}
          <span style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>
            {pair
              ? (signingIn === entry.id ? t('mcpDefaults.signingIn')
                : st?.engine === 'broker' && st.state && STATE_KEY[st.state] ? t(STATE_KEY[st.state])
                  : st?.connected ? t('mcpDefaults.connected')
                    : st?.ready ? t('mcpDefaults.notConnected') : t('mcpDefaults.needsBoth'))
              : (st?.ready ? t('mcpDefaults.ready') : t('mcpDefaults.skippedUntilSet'))}
          </span>
        </div>
        {pair && st?.inAppCapable && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <span style={labelStyle}>{t('mcpAccess.engineTitle')}</span>
              {(['bridge', 'broker'] as McpEngine[]).map((eng) => (
                <button
                  key={eng}
                  type="button"
                  style={{ ...smallBtn, background: st.engine === eng ? 'var(--cth-lemon)' : 'var(--cth-cream-200)', cursor: signingIn === null ? 'pointer' : 'not-allowed' }}
                  disabled={signingIn !== null}
                  onClick={() => { if (st.engine !== eng) void switchEngine(entry, eng); }}
                >
                  {t(eng === 'broker' ? 'mcpAccess.engineInApp' : 'mcpAccess.engineBridge')}
                </button>
              ))}
            </div>
            <span style={{ fontSize: 11, lineHeight: '15px', color: 'var(--cth-ink-500)' }}>{t('mcpAccess.engineNote')}</span>
          </div>
        )}
        {pair && st?.engine === 'broker' && st.connected && <McpAccessSection entry={entry} />}
      </div>
    );
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <div style={{ ...labelStyle, marginBottom: 6 }}>{t('mcpDefaults.title')}</div>
        <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
          {t('mcpDefaults.desc')}
        </span>
      </div>

      {TIER_ORDER.map((tier) => {
        const entries = byTier(tier);
        if (entries.length === 0) return null;
        // Every tier is opt-in now, so a server that is switched on is highlighted in all of them.
        const isConsent = true;
        return (
          <div key={tier} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              <span style={{
                fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
                color: isConsent ? '#6E1423' : 'var(--cth-ink-500)',
                textTransform: 'uppercase'
              }}>
                {t(TIER_LABEL_KEY[tier])}
              </span>
              <span style={{ fontSize: 11, lineHeight: '15px', color: 'var(--cth-ink-400, var(--cth-ink-500))' }}>
                {t(TIER_NOTE_KEY[tier])}
              </span>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {entries.map((entry) => {
                const on = enabledFor(entry.id);
                return (
                  <div key={entry.id} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div
                    style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      gap: 12, padding: '7px 10px',
                      background: 'var(--cth-paper-100)',
                      boxShadow: `inset 0 0 0 1px ${isConsent && on ? '#6E1423' : 'var(--cth-ink-300)'}`
                    }}
                  >
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 1, flex: 1, minWidth: 0 }}>
                      <span style={{ fontSize: 12, lineHeight: '18px', color: 'var(--cth-ink-900)', fontWeight: 600 }}>
                        {entry.label}
                        <code style={{
                          marginLeft: 6,
                          fontFamily: 'var(--cth-font-mono)',
                          fontSize: 11,
                          color: 'var(--cth-ink-500)',
                          fontWeight: 400
                        }}>{entry.id}</code>
                      </span>
                      <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)', wordBreak: 'break-word' }}>
                        {entry.description}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => { void toggle(entry.id); }}
                      style={{
                        flexShrink: 0,
                        padding: '3px 10px 1px',
                        background: on
                          ? (isConsent ? 'var(--cth-coral-light, #f6d3c4)' : 'var(--cth-lemon)')
                          : 'var(--cth-cream-200)',
                        boxShadow: `inset 0 0 0 1px ${on ? 'var(--cth-ink-900)' : 'var(--cth-ink-700)'}`,
                        border: 'none',
                        fontFamily: 'var(--cth-font-display)',
                        fontSize: 8,
                        lineHeight: '14px',
                        color: 'var(--cth-ink-900)',
                        cursor: 'pointer',
                        textTransform: 'uppercase'
                      }}
                    >
                      {on ? t('common.on') : t('common.off')}
                    </button>
                  </div>
                  {on && packageRow(entry)}
                  {on && credentials(entry)}
                  {/* Who may use it, and which of its tools: for every server the broker serves, the default is NO ONE.
                      (A bridged service shows this once it is on the in-app engine and signed in, as before.) */}
                  {on && !mcpNeedsOauthClient(entry) && <McpAccessSection entry={entry} />}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}

      {note && (
        <span style={{ fontSize: 12, color: 'var(--cth-mint)' }}>{note}</span>
      )}
    </div>
  );
}
