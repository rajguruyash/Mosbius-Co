import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import type { CommandResult, HuddleAgentView, NamedKey } from '@shared/huddle';
import type { NotificationRecord } from '@shared/notifications';
import { isComposingKey } from '@shared/imeGuard';
import { HuddleCharacter } from './HuddleCharacter';
import { NotificationCard, type Resolver } from './NotificationCard';
import { activityText, errorText, queuedText } from './format';

type Message = {
  id: string; role: 'user' | 'assistant' | 'tool'; text?: string; at?: number;
  tool?: { name: string; label: { verb: string; arg?: string } };
};

// ─── conversation ────────────────────────────────────────────────────────────

function ConversationView({ agent }: { agent: HuddleAgentView }): JSX.Element {
  const { t, i18n } = useTranslation();
  const exists = (k: string): boolean => i18n.exists(k);
  const [msgs, setMsgs] = useState<Message[] | null>(null);
  const [source, setSource] = useState<'transcript' | 'hive'>('transcript');
  const [truncated, setTruncated] = useState(false);
  const [err, setErr] = useState('');
  const box = useRef<HTMLDivElement | null>(null);
  const stick = useRef(true);

  const load = useCallback(async (): Promise<void> => {
    try {
      const r = await window.huddle.conversation(agent.id);
      if (!r.ok) { setErr(r.error ?? 'unknown'); return; }
      setErr('');
      setMsgs((cur) => {
        const next = (r.messages ?? []) as Message[];
        // keep the same array when nothing changed, so a poll does not repaint the list
        return cur && cur.length === next.length && cur[cur.length - 1]?.id === next[next.length - 1]?.id ? cur : next;
      });
      setSource(r.source ?? 'transcript');
      setTruncated(!!r.truncated);
    } catch (e) { setErr(String(e)); }
  }, [agent.id]);

  // read now, again whenever the agent changes what it is doing, and every few seconds meanwhile
  useEffect(() => { setMsgs(null); void load(); }, [load]);
  useEffect(() => { void load(); }, [load, agent.stateSince]);
  useEffect(() => {
    const timer = setInterval(() => { if (!document.hidden) void load(); }, 2500);
    return () => clearInterval(timer);
  }, [load]);

  useLayoutEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [msgs]);

  const onScroll = (): void => {
    const el = box.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  return (
    <div className="hd-conv" ref={box} onScroll={onScroll}>
      {msgs === null && !err && <div className="hd-muted">{t('huddle.conversation.loading')}</div>}
      {err && <div className="hd-error" role="alert">{t('huddle.conversation.failed', { error: err })}</div>}
      {msgs && msgs.length === 0 && !err && <div className="hd-muted">{t('huddle.conversation.empty', { name: agent.name })}</div>}
      {truncated && <div className="hd-muted hd-conv-older">{t('huddle.conversation.older')}</div>}
      {msgs?.map((m) => m.role === 'tool' && m.tool ? (
        <div key={m.id} className="hd-msg hd-msg-tool">{activityText(t, exists, m.tool.label as never)}</div>
      ) : (
        <div key={m.id} className={`hd-msg hd-msg-${m.role}`}>
          <div className="hd-msg-who">{m.role === 'user' ? t('huddle.conversation.you') : agent.name}</div>
          <div className="hd-msg-text" dir="auto">{m.text}</div>
        </div>
      ))}
      {msgs && <div className="hd-conv-source">{source === 'transcript' ? t('huddle.conversation.fromTranscript') : t('huddle.conversation.fromHive')}</div>}
    </div>
  );
}

// ─── terminal ────────────────────────────────────────────────────────────────

const KEYS: Array<{ key: NamedKey; label: string }> = [
  { key: 'enter', label: 'huddle.terminal.enter' }, { key: 'esc', label: 'huddle.terminal.esc' },
  { key: 'up', label: 'huddle.terminal.up' }, { key: 'down', label: 'huddle.terminal.down' },
  { key: 'tab', label: 'huddle.terminal.tab' }
];

function TerminalMirror({ agent, onKey }: { agent: HuddleAgentView; onKey: (key: NamedKey) => void }): JSX.Element {
  const { t } = useTranslation();
  const outer = useRef<HTMLDivElement | null>(null);
  const host = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<'attaching' | 'live' | 'exited' | 'failed'>('attaching');
  const [err, setErr] = useState('');

  useEffect(() => {
    const hostEl = host.current;
    const outerEl = outer.current;
    if (!hostEl || !outerEl) return undefined;
    let disposed = false;
    let ptyId = '';
    let ready = false;
    const queued: string[] = [];
    const term = new Terminal({
      disableStdin: true, cursorBlink: false, scrollback: 4000, fontSize: 12, lineHeight: 1.15,
      fontFamily: 'JetBrains Mono, ui-monospace, Menlo, monospace', allowProposedApi: true,
      theme: { background: '#14121a', foreground: '#e6e1ec', cursor: '#14121a', selectionBackground: '#4a3f5c' }
    });
    term.open(hostEl);

    const fit = (): void => {
      const screen = hostEl.querySelector('.xterm-screen') as HTMLElement | null;
      if (!screen) return;
      const naturalW = screen.offsetWidth;
      const naturalH = screen.offsetHeight;
      if (!naturalW) return;
      const s = Math.max(0.55, Math.min(1, (outerEl.clientWidth - 2) / naturalW));
      hostEl.style.transform = `scale(${s})`;
      hostEl.style.transformOrigin = 'top left';
      hostEl.style.width = `${naturalW}px`;
      outerEl.style.setProperty('--hd-term-h', `${Math.ceil(naturalH * s) + 2}px`);
    };

    // Listen BEFORE asking for the mirror: the main process starts sending at the moment it adds this window, and
    // anything that arrives before the screen's contents are in place waits its turn.
    const offData = window.huddle.onTerminalData((e) => { if (e.id !== ptyId) return; if (ready) term.write(e.data); else queued.push(e.data); });
    const offGeo = window.huddle.onTerminalGeometry((e) => { if (e.id === ptyId && !disposed) { term.resize(e.cols, e.rows); requestAnimationFrame(fit); } });
    const offExit = window.huddle.onTerminalExit((e) => { if (e.id === ptyId && !disposed) setStatus('exited'); });
    const ro = new ResizeObserver(() => fit());
    ro.observe(outerEl);

    void window.huddle.terminalAttach(agent.id).then((r) => {
      if (disposed) { if (r.ok) void window.huddle.terminalDetach(agent.id); return; }
      if (!r.ok || !r.ptyId) { setStatus('failed'); setErr(r.error ?? ''); return; }
      ptyId = r.ptyId;
      term.resize(r.cols ?? 100, r.rows ?? 30);
      term.write(r.replay ?? '', () => {
        if (disposed) return;
        for (const q of queued.splice(0)) term.write(q);
        ready = true;
        setStatus('live');
        fit();
        term.scrollToBottom();
      });
      requestAnimationFrame(fit);
    }).catch((e) => { if (!disposed) { setStatus('failed'); setErr(String(e)); } });

    return () => {
      disposed = true;
      offData(); offGeo(); offExit();
      ro.disconnect();
      void window.huddle.terminalDetach(agent.id);
      term.dispose();
    };
  }, [agent.id]);

  return (
    <div className="hd-term-wrap">
      {status === 'attaching' && <div className="hd-muted">{t('huddle.terminal.attaching')}</div>}
      {status === 'failed' && <div className="hd-error" role="alert">{t('huddle.terminal.failed', { error: err })}</div>}
      {status === 'exited' && <div className="hd-muted">{t('huddle.terminal.exited')}</div>}
      <div className="hd-term-outer" ref={outer} style={{ visibility: status === 'failed' ? 'hidden' : 'visible' }}>
        <div className="hd-term-host" ref={host} />
      </div>
      <div className="hd-term-keys" role="group" aria-label={t('huddle.terminal.keys')}>
        <span className="hd-muted hd-term-hint">{t('huddle.terminal.readOnly', { name: agent.name })}</span>
        <div className="hd-row">
          {KEYS.map((k) => <button key={k.key} className="hd-btn hd-btn-key" disabled={!agent.alive} onClick={() => onKey(k.key)}>{t(k.label)}</button>)}
        </div>
      </div>
    </div>
  );
}

// ─── composer ────────────────────────────────────────────────────────────────

interface Attached { path: string; name: string; image: boolean; preview?: string; bytes?: number }
interface Draft { text: string; files: Attached[] }
/** Drafts survive switching to another agent and back: each is keyed by the agent it is for. */
const drafts = new Map<string, Draft>();

function Composer({ agent }: { agent: HuddleAgentView }): JSX.Element {
  const { t, i18n } = useTranslation();
  const exists = (k: string): boolean => i18n.exists(k);
  const initial = drafts.get(agent.id) ?? { text: '', files: [] };
  const [text, setText] = useState(initial.text);
  const [files, setFiles] = useState<Attached[]>(initial.files);
  const [menu, setMenu] = useState(false);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const area = useRef<HTMLTextAreaElement | null>(null);

  // when the panel is for a different agent, load THAT agent's draft; never carry one agent's text to another
  useEffect(() => {
    const d = drafts.get(agent.id) ?? { text: '', files: [] };
    setText(d.text); setFiles(d.files); setNote(null); setMenu(false);
  }, [agent.id]);
  useEffect(() => { drafts.set(agent.id, { text, files }); }, [agent.id, text, files]);
  // a confirmation is for the moment it was sent in; it does not stay on the screen as if it were still news (the live
  // "queued" line below it comes from the agent's real queue and stays for as long as something is waiting)
  useEffect(() => {
    if (!note) return undefined;
    const timer = setTimeout(() => setNote(null), note.kind === 'ok' ? 6000 : 12_000);
    return () => clearTimeout(timer);
  }, [note]);

  const off = !agent.controls.send;
  const canSend = !off && !busy && (!!text.trim() || files.length > 0);

  const add = useCallback(async (picked: Array<{ path: string; name: string; image: boolean }>): Promise<void> => {
    setFiles((cur) => {
      const seen = new Set(cur.map((f) => f.path));
      return [...cur, ...picked.filter((p) => p.path && !seen.has(p.path))];
    });
    // a preview before sending: a thumbnail for an image, the system's icon for anything else
    for (const p of picked) {
      void window.huddle.previewFile(p.path).then((r) => {
        if (r.ok) setFiles((cur) => cur.map((f) => (f.path === p.path ? { ...f, preview: r.dataUrl, bytes: r.bytes } : f)));
      });
    }
  }, []);

  const pick = async (kind: 'files' | 'images'): Promise<void> => {
    setMenu(false);
    const r = await window.huddle.pickFiles(kind);
    if (r.ok && r.files) void add(r.files);
  };

  const onPaste = async (e: ClipboardEvent<HTMLTextAreaElement>): Promise<void> => {
    const items = Array.from(e.clipboardData?.items ?? []);
    if (items.some((it) => it.kind === 'file' && it.type.startsWith('image/'))) {
      e.preventDefault();
      const r = await window.huddle.pasteImage();
      if (r.ok && r.file) void add([r.file]); else setNote({ kind: 'err', text: t('huddle.composer.pasteFailed') });
      return;
    }
    const fs = Array.from(e.clipboardData?.files ?? []);
    if (fs.length) {
      e.preventDefault();
      void add(fs.map((f) => ({ path: window.huddle.pathForFile(f), name: f.name, image: f.type.startsWith('image/') })).filter((f) => f.path));
    }
  };

  const onDrop = (e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault(); setOver(false);
    const dropped = Array.from(e.dataTransfer?.files ?? []);
    if (dropped.length) void add(dropped.map((f) => ({ path: window.huddle.pathForFile(f), name: f.name, image: f.type.startsWith('image/') })).filter((f) => f.path));
  };

  const send = async (): Promise<void> => {
    if (!canSend) return;
    setBusy(true); setNote(null);
    // the agent id is read from the panel at the moment of sending: it is the one this composer is showing
    const r: CommandResult = await window.huddle.command({ type: 'send', agentId: agent.id, text, attachments: files.map((f) => ({ path: f.path, name: f.name })) });
    setBusy(false);
    if (r.ok) { setText(''); setFiles([]); drafts.delete(agent.id); setNote({ kind: 'ok', text: t('huddle.composer.queued', { name: agent.name }) }); }
    else setNote({ kind: 'err', text: t('huddle.composer.failed', { error: errorText(t, exists, r.error) }) });
  };

  const placeholder = off ? t('huddle.composer.placeholderOff', { name: agent.name })
    : agent.state === 'working' || agent.state === 'researching' ? t('huddle.composer.placeholderBusy', { name: agent.name })
    : t('huddle.composer.placeholder', { name: agent.name });

  return (
    <div className={`hd-composer${over ? ' hd-composer-over' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false); }} onDrop={onDrop}>
      {over && <div className="hd-composer-drop">{t('huddle.composer.drop', { name: agent.name })}</div>}
      {files.length > 0 && (
        <div className="hd-chips">
          {files.map((f) => (
            <span key={f.path} className="hd-chip" title={f.path}>
              {f.preview ? <img src={f.preview} alt="" className={f.image ? 'hd-chip-thumb' : 'hd-chip-icon'} /> : <span className="hd-chip-icon hd-chip-blank" />}
              <span className="hd-chip-name">{f.name}</span>
              <button className="hd-chip-x" aria-label={t('huddle.composer.remove')} title={t('huddle.composer.remove')} onClick={() => setFiles((cur) => cur.filter((x) => x.path !== f.path))}>×</button>
            </span>
          ))}
        </div>
      )}
      <textarea
        ref={area} rows={2} value={text} dir="auto" disabled={off} placeholder={placeholder} aria-label={placeholder}
        onChange={(e) => { setText(e.target.value); setNote((n) => (n && n.kind === 'ok' ? null : n)); }} onPaste={(e) => void onPaste(e)}
        onKeyDown={(e) => {
          if (isComposingKey(e)) return;
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); }
          if (e.key === 'Escape') { e.stopPropagation(); (e.target as HTMLElement).blur(); }
        }}
      />
      <div className="hd-composer-bar">
        <div className="hd-plus">
          <button className="hd-btn hd-btn-icon" disabled={off} aria-haspopup="menu" aria-expanded={menu} aria-label={t('huddle.composer.attach')} title={t('huddle.composer.attach')} onClick={() => setMenu((m) => !m)}>+</button>
          {menu && (
            <div className="hd-menu" role="menu">
              <button role="menuitem" className="hd-menu-item" onClick={() => void pick('files')}>{t('huddle.composer.attachFiles')}</button>
              <button role="menuitem" className="hd-menu-item" onClick={() => void pick('images')}>{t('huddle.composer.attachImages')}</button>
            </div>
          )}
        </div>
        <span className="hd-composer-note" role="status" data-kind={note?.kind}>
          {note ? note.text : agent.queued > 0 ? queuedText(t, agent.queued) : ''}
        </span>
        <button className="hd-btn hd-btn-primary" disabled={!canSend} onClick={() => void send()}>{t('huddle.composer.send')}</button>
      </div>
    </div>
  );
}

// ─── the panel ───────────────────────────────────────────────────────────────

export function AgentPanel({ agent, notes, resolve, now }: { agent: HuddleAgentView; notes: NotificationRecord[]; resolve: Resolver; now: number }): JSX.Element {
  const { t, i18n } = useTranslation();
  const exists = (k: string): boolean => i18n.exists(k);
  const [tab, setTab] = useState<'conversation' | 'terminal'>('conversation');
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [flash, setFlash] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => { setConfirmEnd(false); setFlash(null); }, [agent.id]);
  useEffect(() => {
    if (!flash) return undefined;
    const timer = setTimeout(() => setFlash(null), 3500);
    return () => clearTimeout(timer);
  }, [flash]);

  const run = async (cmd: Parameters<typeof window.huddle.command>[0]): Promise<void> => {
    const r = await window.huddle.command(cmd);
    setFlash(r.ok ? { kind: 'ok', text: t('huddle.controls.ok') } : { kind: 'err', text: t('huddle.controls.failed', { error: errorText(t, exists, r.error) }) });
  };
  const open = notes.filter((n) => n.agentId === agent.id && n.actionRequired && !n.resolution);
  const c = agent.controls;

  return (
    <div className="hd-agent" data-agent={agent.id}>
      <div className="hd-agent-top">
        <HuddleCharacter character={agent.character} state={agent.state} asking={!!agent.attention} askingKey={agent.attention?.since ?? 0} critical={agent.attention?.critical} scale={2} />
        <div className="hd-agent-id">
          <div className="hd-name">{agent.name}</div>
          <div className={`hd-chip-state hd-s-${agent.state}`}>{t(`huddle.state.${agent.state}`)}</div>
          <div className="hd-sub" title={activityText(t, exists, agent.activity)}>{activityText(t, exists, agent.activity)}</div>
        </div>
      </div>

      <div className="hd-controls" role="toolbar" aria-label={agent.name}>
        {c.pause && <button className="hd-btn" title={t('huddle.controls.pauseTip')} onClick={() => void run({ type: 'pause', agentId: agent.id })}>{t('huddle.controls.pause')}</button>}
        {c.resume && <button className="hd-btn hd-btn-primary" title={t('huddle.controls.resumeTip')} onClick={() => void run({ type: 'resume', agentId: agent.id })}>{t('huddle.controls.resume')}</button>}
        <button className="hd-btn" disabled={!c.interrupt} title={t('huddle.controls.interruptTip')} onClick={() => void run({ type: 'interrupt', agentId: agent.id })}>{t('huddle.controls.interrupt')}</button>
        <button className="hd-btn" disabled={!c.restart} title={t('huddle.controls.restartTip')} onClick={() => void run({ type: 'restart', agentId: agent.id })}>{t('huddle.controls.restart')}</button>
        {!confirmEnd
          ? <button className="hd-btn hd-btn-danger" disabled={!c.end} title={t('huddle.controls.endTip')} onClick={() => setConfirmEnd(true)}>{t('huddle.controls.end')}</button>
          : (
            <span className="hd-confirm" role="alertdialog" aria-label={t('huddle.controls.endConfirm', { name: agent.name })}>
              <span>{t('huddle.controls.endConfirm', { name: agent.name })}</span>
              <button className="hd-btn hd-btn-danger" onClick={() => { setConfirmEnd(false); void run({ type: 'end', agentId: agent.id }); }}>{t('huddle.controls.endYes')}</button>
              <button className="hd-btn" onClick={() => setConfirmEnd(false)}>{t('huddle.controls.endNo')}</button>
            </span>
          )}
        {flash && <span className="hd-flash" data-kind={flash.kind} role="status">{flash.text}</span>}
      </div>

      {open.length > 0 && (
        <div className="hd-agent-notes">
          {open.map((n) => <NotificationCard key={n.id} rec={n} resolve={resolve} now={now} />)}
        </div>
      )}

      <div className="hd-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'conversation'} className={`hd-tab${tab === 'conversation' ? ' hd-tab-on' : ''}`} onClick={() => setTab('conversation')}>{t('huddle.tabs.conversation')}</button>
        <button role="tab" aria-selected={tab === 'terminal'} className={`hd-tab${tab === 'terminal' ? ' hd-tab-on' : ''}`} onClick={() => setTab('terminal')}>{t('huddle.tabs.terminal')}</button>
      </div>
      <div className="hd-agent-body" role="tabpanel">
        {tab === 'conversation' ? <ConversationView agent={agent} /> : <TerminalMirror agent={agent} onKey={(key) => void run({ type: 'keys', agentId: agent.id, key })} />}
      </div>
      <Composer agent={agent} />
    </div>
  );
}
