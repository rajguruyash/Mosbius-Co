import { useCallback, useEffect, useRef, useState } from 'react';
import { PixelButton } from './PixelButton';
import { SpritePortrait } from './SpritePortrait';
import type { OfficeCharacterName } from '@/scene/office/cast';

// The Agent Manager: which coding agents are on this computer, whether each is
// signed in (and how we know), and the Install / Sign in / Recheck / Update
// actions. Installs and updates run only after the exact command has been shown
// and approved. Used in Settings and in the first-run "Meet your coding team" step.

type Auth = 'signed-in' | 'probably-signed-in' | 'signed-out' | 'unknown';
interface Status {
  id: 'claude' | 'codex' | 'gemini';
  label: string;
  install: 'installed' | 'not-installed' | 'broken';
  path: string | null;
  version: string | null;
  auth: Auth;
  authHow: string;
  via: string | null;
  commands: { install?: string; signin?: string; update?: string };
  docsUrl: string;
  error?: string;
}

// Who wears each engine on the floor, purely for flavour.
const FACE: Record<Status['id'], OfficeCharacterName> = { claude: 'ted', codex: 'marshall', gemini: 'lily' };

function badge(s: Status): { text: string; bg: string; fg: string } {
  if (s.install === 'not-installed') return { text: 'NOT INSTALLED', bg: '#3d2e4a', fg: '#d9cfe0' };
  if (s.install === 'broken') return { text: 'WON’T START', bg: '#5a2020', fg: '#ffd0c8' };
  if (s.auth === 'signed-in') return { text: 'READY', bg: '#1f4a2c', fg: '#b4f0c0' };
  if (s.auth === 'probably-signed-in') return { text: 'PROBABLY READY', bg: '#4a4416', fg: '#ffec99' };
  if (s.auth === 'signed-out') return { text: 'SIGN-IN NEEDED', bg: '#5a3a14', fg: '#ffd9a0' };
  return { text: 'SIGN-IN UNKNOWN', bg: '#3d2e4a', fg: '#d9cfe0' };
}

export function AgentManager({ compact = false }: { compact?: boolean }): JSX.Element {
  const [list, setList] = useState<Status[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [confirm, setConfirm] = useState<{ s: Status; kind: 'install' | 'update' } | null>(null);
  const [running, setRunning] = useState<{ id: string; kind: string } | null>(null);
  const [log, setLog] = useState<Record<string, string[]>>({});
  const [note, setNote] = useState<Record<string, string>>({});
  const pollRef = useRef<number | null>(null);

  const recheck = useCallback(async () => {
    setChecking(true);
    try { setList(await window.cth.agentsStatus() as Status[]); } finally { setChecking(false); }
  }, []);

  useEffect(() => { void recheck(); }, [recheck]);
  useEffect(() => window.cth.onAgentsProgress(({ id, line }) => {
    setLog((l) => ({ ...l, [id]: [...(l[id] ?? []), line].slice(-8) }));
  }), []);
  useEffect(() => () => { if (pollRef.current) window.clearInterval(pollRef.current); }, []);

  const runApproved = async (s: Status, kind: 'install' | 'update') => {
    setConfirm(null);
    setRunning({ id: s.id, kind });
    setLog((l) => ({ ...l, [s.id]: [] }));
    const r = await window.cth.agentsRun(s.id, kind);
    setRunning(null);
    setNote((n) => ({ ...n, [s.id]: r.ok ? `${kind === 'install' ? 'Installed' : 'Updated'}. Checked again below.` : `${kind === 'install' ? 'Install' : 'Update'} failed (exit ${r.code}). The output is above.` }));
    await recheck();
  };

  const signIn = async (s: Status) => {
    const r = await window.cth.agentsSignIn(s.id);
    if (!r.ok) { setNote((n) => ({ ...n, [s.id]: `Could not open a terminal: ${r.how}` })); return; }
    setNote((n) => ({ ...n, [s.id]: `${s.label}'s own sign-in opened in ${r.how}. Finish it there; this checks again every few seconds.` }));
    if (pollRef.current) window.clearInterval(pollRef.current);
    let n = 0;
    pollRef.current = window.setInterval(async () => {
      n++;
      const next = await window.cth.agentsStatus() as Status[];
      setList(next);
      const now = next.find((x) => x.id === s.id);
      if ((now && (now.auth === 'signed-in' || now.auth === 'probably-signed-in')) || n > 60) {
        if (pollRef.current) window.clearInterval(pollRef.current);
        pollRef.current = null;
        if (now?.auth === 'signed-in') setNote((m) => ({ ...m, [s.id]: 'Signed in, confirmed by the CLI.' }));
      }
    }, 4000);
  };

  const ink = '#fff8e7', dim = '#a899b5';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 12, color: ink }}>
      {!compact && (
        <div style={{ color: '#d9cfe0', lineHeight: '18px' }}>
          Mosbius & Co uses the coding agents already installed on this computer, signed in with their own official logins. It never asks for your password or reads your login files.
        </div>
      )}
      {!list && <div style={{ color: dim }}>Looking for coding agents on this computer…</div>}
      {list?.map((s) => {
        const b = badge(s);
        const busy = running?.id === s.id;
        return (
          <div key={s.id} className="cth-dark-scope" style={{ background: '#1d1a26', boxShadow: '0 0 0 2px #3d2e4a', padding: 10, display: 'flex', gap: 12, alignItems: 'flex-start' }}>
            <div style={{ background: '#969aa6', lineHeight: 0, padding: 2, boxShadow: '0 0 0 2px #1a1320' }}>
              <SpritePortrait character={FACE[s.id]} scale={2} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontFamily: 'var(--cth-font-display)', fontSize: 11 }}>{s.label.toUpperCase()}</span>
                <span style={{ fontFamily: 'var(--cth-font-display)', fontSize: 7, padding: '3px 6px', background: b.bg, color: b.fg }}>{b.text}</span>
                {s.version && <span style={{ fontFamily: 'var(--cth-font-mono)', color: dim }}>v{s.version}</span>}
              </div>
              {s.path && <div style={{ fontFamily: 'var(--cth-font-mono)', fontSize: 11, color: dim, marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.path}{s.via && s.via !== 'unknown' ? `  ·  via ${s.via}` : ''}</div>}
              {s.install === 'installed' && <div style={{ marginTop: 3, color: s.auth === 'probably-signed-in' ? '#ffec99' : '#d9cfe0' }}>
                {s.auth === 'signed-in' ? 'Signed in' : s.auth === 'probably-signed-in' ? 'Probably signed in (not verified)' : s.auth === 'signed-out' ? 'Not signed in' : 'Sign-in state unknown'}
                <span style={{ color: dim }}> — {s.authHow}</span>
              </div>}
              {s.install === 'not-installed' && <div style={{ marginTop: 3, color: '#d9cfe0' }}>Not found on this computer.</div>}
              {s.error && <div style={{ marginTop: 3, color: '#ffb4b4' }}>{s.error}</div>}
              {(busy || (log[s.id]?.length ?? 0) > 0) && (
                <pre style={{ margin: '6px 0 0', padding: 6, background: '#0f0d14', color: '#b4e5bd', fontSize: 10, lineHeight: '14px', maxHeight: 96, overflow: 'auto', whiteSpace: 'pre-wrap' }}>
                  {(log[s.id] ?? []).join('\n') || 'starting…'}
                </pre>
              )}
              {note[s.id] && <div style={{ marginTop: 5, color: '#ffd93d' }}>{note[s.id]}</div>}
              <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                {s.install === 'not-installed' && s.commands.install && (
                  <PixelButton variant="primary" size="sm" disabled={!!running} onClick={() => setConfirm({ s, kind: 'install' })}>{busy ? 'installing…' : 'install'}</PixelButton>
                )}
                {s.install === 'installed' && s.auth !== 'signed-in' && (
                  <PixelButton variant="primary" size="sm" disabled={!!running} onClick={() => void signIn(s)}>sign in</PixelButton>
                )}
                {s.install === 'installed' && s.commands.update && (
                  <PixelButton variant="secondary" size="sm" disabled={!!running} onClick={() => setConfirm({ s, kind: 'update' })}>{busy ? 'updating…' : 'update'}</PixelButton>
                )}
                <PixelButton variant="ghost" size="sm" disabled={checking || !!running} onClick={() => void recheck()}>recheck</PixelButton>
                <PixelButton variant="ghost" size="sm" onClick={() => void window.cth.openExternal(s.docsUrl)}>docs</PixelButton>
              </div>
            </div>
          </div>
        );
      })}
      {confirm && (
        <div className="cth-dark-scope" style={{ background: '#2a2010', boxShadow: '0 0 0 2px #ffd93d', padding: 12 }}>
          <div style={{ fontFamily: 'var(--cth-font-display)', fontSize: 10, color: '#ffd93d', marginBottom: 8 }}>
            {confirm.kind === 'install' ? 'INSTALL' : 'UPDATE'} {confirm.s.label.toUpperCase()}?
          </div>
          <div style={{ color: '#d9cfe0', marginBottom: 6 }}>This will run exactly this command on your computer:</div>
          <pre style={{ margin: 0, padding: 8, background: '#0f0d14', color: '#fff8e7', fontFamily: 'var(--cth-font-mono)', fontSize: 12 }}>{confirm.s.commands[confirm.kind]}</pre>
          <div style={{ color: '#a899b5', marginTop: 6 }}>It comes from {confirm.s.label}'s official instructions and needs Node.js and npm for npm commands.</div>
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <PixelButton variant="primary" size="sm" onClick={() => void runApproved(confirm.s, confirm.kind)}>yes, run it</PixelButton>
            <PixelButton variant="ghost" size="sm" onClick={() => setConfirm(null)}>cancel</PixelButton>
          </div>
        </div>
      )}
    </div>
  );
}
