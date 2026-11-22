'use strict';

/**
 * The notification service: which real events become notifications, what the person's preferences switch off,
 * that the same unresolved event is one notification however often it repeats, that the history survives a
 * restart, and that a banner the operating system will not show never silences the sound or hides the record.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { NotificationService } = loadTs('src/main/notifyService.ts');
const N = loadTs('src/shared/notifications.ts');
const { handleSignals } = loadTs('src/main/lifecycleWiring.ts');
const { ActivityTracker } = loadTs('src/main/activityTracker.ts');
const { createNotifyStore } = (() => {
  // the real store lives beside electron imports; load only the file-store half
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/main/notifyDelivery.ts'), 'utf8');
  assert.match(src, /export function createNotifyStore/);
  return {};
})();

const STRINGS = {
  notify: {}
};

function rig(opts = {}) {
  let clock = 1_700_000_000_000;
  const saved = [];
  const banners = [];
  const sounds = [];
  const soundCalls = [];
  const changes = [];
  const activated = [];
  const timers = [];
  let store = opts.initial;
  const ports = {
    now: () => clock,
    load: () => store,
    save: (s) => { store = JSON.parse(JSON.stringify(s)); saved.push(store); },
    showDesktop: (n, onClick) => { banners.push({ ...n, onClick }); return opts.desktopOutcome ?? 'shown'; },
    desktopSupported: () => opts.supported !== false,
    playSound: (k, o) => { sounds.push(k); soundCalls.push({ kind: k, interrupt: !!(o && o.interrupt) }); return opts.soundOk !== false; },
    soundMs: opts.soundMs,
    strings: () => ({ notify: { approval: { title: '{{agent}} needs approval', body: 'to use {{tool}}' }, completed: { title: '{{agent}} finished', body: 'Took {{duration}}' }, more: '{{count}} more', moreTitle: 'More' } }),
    changed: (s) => changes.push(s),
    activate: (r) => activated.push(r),
    agentName: (id) => ({ a1: 'Marshall', a2: 'Lily' }[id]),
    setTimeout: (fn, ms) => { const t = { fn, ms, at: clock + ms }; timers.push(t); return t; },
    clearTimeout: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); }
  };
  const svc = new NotificationService(ports);
  const advance = (ms) => { clock += ms; for (const t of [...timers]) if (t.at <= clock) { timers.splice(timers.indexOf(t), 1); t.fn(); } };
  return { svc, banners, sounds, soundCalls, changes, activated, saved, advance, tick: () => advance(500), setNow: (n) => { clock = n; }, now: () => clock, store: () => store, timers };
}

const approval = (key = 'a1|approval:1') => ({
  agentId: 'a1', category: 'approval', title: { key: 'notify.approval.title', args: { agent: 'Marshall' } }, body: { key: 'notify.approval.body', args: { tool: 'Bash' } },
  preview: 'Bash: npm test', actions: ['approve', 'reject', 'alternative', 'open'], requestKey: key
});
const completed = (key) => ({ agentId: 'a1', category: 'completed', title: { key: 'notify.completed.title', args: { agent: 'Marshall' } }, body: { key: 'notify.completed.body', args: { duration: '1m' } }, actions: ['open'], requestKey: key });
const info = (key) => ({ agentId: 'a1', category: 'info', title: { key: 'notify.idle.title', args: { agent: 'Marshall' } }, body: { key: 'notify.idle.body' }, requestKey: key });

test('an approval request is recorded as action-required, high priority, with a banner and the approval sound', () => {
  const r = rig();
  const rec = r.svc.ingest(approval());
  assert.equal(rec.category, 'approval');
  assert.equal(rec.priority, 'high');
  assert.equal(rec.actionRequired, true);
  assert.equal(rec.read, false);
  assert.equal(rec.agentName, 'Marshall');
  assert.deepEqual(rec.delivery, { desktop: 'shown', sound: 'played' });
  assert.equal(r.banners.length, 1);
  assert.equal(r.banners[0].title, 'Marshall needs approval');
  assert.match(r.banners[0].body, /to use Bash/);
  assert.match(r.banners[0].body, /npm test/, 'the banner carries the preview of what is being asked');
  assert.deepEqual(r.sounds, ['approval']);
  assert.equal(r.svc.snapshot().pending, 1);
  assert.equal(r.svc.snapshot().unread, 1);
});

test('a completion is not action-required, gets the soft sound, and does not stay "pending"', () => {
  const r = rig();
  const rec = r.svc.ingest(completed('a1|done|1'));
  assert.equal(rec.actionRequired, false);
  assert.deepEqual(r.sounds, ['completed']);
  assert.equal(r.svc.snapshot().pending, 0);
});

test('the same unresolved event is one notification: a repeat counts, and rings nothing', () => {
  const r = rig();
  const first = r.svc.ingest(approval());
  r.setNow(r.now() + 60_000);
  const again = r.svc.ingest(approval());
  assert.equal(again.id, first.id);
  assert.equal(again.repeatCount, 2);
  assert.equal(r.banners.length, 1, 'no second banner');
  assert.equal(r.sounds.length, 1, 'no second sound');
  assert.equal(r.svc.snapshot().records.length, 1);
});

test('once it is resolved, the same request asked again is a new notification', () => {
  const r = rig();
  const first = r.svc.ingest(approval());
  r.svc.resolve(first.id, { by: 'user', action: 'approved' });
  r.setNow(r.now() + 5_000);
  const second = r.svc.ingest(approval());
  assert.notEqual(second.id, first.id);
  assert.equal(r.svc.snapshot().records.length, 2);
  assert.equal(r.banners.length, 2);
});

test('different requests from the same agent are different notifications', () => {
  const r = rig();
  r.svc.ingest(approval('a1|approval:1'));
  r.setNow(r.now() + 2_000);
  r.svc.ingest(approval('a1|approval:2'));
  assert.equal(r.svc.openFor('a1').length, 2);
});

test('resolving closes it with who and how, marks it read, and frees its key; resolving twice is a no-op', () => {
  const r = rig();
  const rec = r.svc.ingest(approval());
  const done = r.svc.resolve(rec.id, { by: 'user', action: 'approved' });
  assert.equal(done.resolution.by, 'user');
  assert.equal(done.resolution.action, 'approved');
  assert.equal(done.read, true);
  assert.equal(typeof done.resolution.at, 'number');
  assert.equal(r.svc.resolve(rec.id, { by: 'user', action: 'rejected' }), null, 'already closed');
  assert.equal(r.svc.get(rec.id).resolution.action, 'approved');
  assert.equal(r.svc.openFor('a1').length, 0);
  assert.equal(r.svc.snapshot().pending, 0);
});

test('resolveByKey closes what the agent itself moved past; dismissing records that the person did it', () => {
  const r = rig();
  r.svc.ingest(approval('a1|approval:9'));
  const closed = r.svc.resolveByKey('a1|approval:9', { by: 'agent', action: 'resolved', note: 'agent-moved-on' });
  assert.equal(closed.resolution.by, 'agent');
  assert.equal(r.svc.resolveByKey('a1|approval:9', { by: 'agent', action: 'resolved' }), null);
  const open = r.svc.ingest(approval('a1|approval:10'));
  const dismissed = r.svc.dismiss(open.id);
  assert.equal(dismissed.resolution.action, 'dismissed');
  assert.equal(dismissed.resolution.by, 'user');
});

test('desktop notifications off: no banner, but the record, the sound and the pending count are all still there', () => {
  const r = rig();
  r.svc.setPrefs({ ...r.svc.getPrefs(), desktop: false });
  const rec = r.svc.ingest(approval());
  assert.equal(r.banners.length, 0);
  assert.equal(rec.delivery.desktop, 'off');
  assert.deepEqual(r.sounds, ['approval']);
  assert.equal(r.svc.snapshot().pending, 1);
});

test('sounds off: the banner still shows', () => {
  const r = rig();
  r.svc.setPrefs({ ...r.svc.getPrefs(), sound: false });
  const rec = r.svc.ingest(approval());
  assert.equal(r.banners.length, 1);
  assert.equal(r.sounds.length, 0);
  assert.equal(rec.delivery.sound, 'off');
});

test('a category switched off is recorded but silent: no banner, no sound, and an agent that is stuck is still pending', () => {
  const r = rig();
  r.svc.setPrefs({ ...r.svc.getPrefs(), categories: { ...r.svc.getPrefs().categories, approval: false } });
  const rec = r.svc.ingest(approval());
  assert.equal(r.banners.length, 0);
  assert.equal(r.sounds.length, 0);
  assert.equal(rec.actionRequired, true, 'the truth does not depend on whether it interrupts you');
  assert.equal(r.svc.snapshot().pending, 1);
  const done = r.svc.ingest(completed('a1|done|1'));
  assert.equal(done.delivery.desktop, 'shown', 'other categories are unaffected');
});

test('routine progress is recorded only when asked for, and never raises a banner or a sound', () => {
  const off = rig();
  assert.equal(off.svc.ingest(info('a1|idle|1')), null, 'routine progress is hidden by default');
  assert.equal(off.svc.snapshot().records.length, 0);
  const on = rig();
  on.svc.setPrefs({ ...on.svc.getPrefs(), showRoutine: true, categories: { ...on.svc.getPrefs().categories, info: true } });
  const rec = on.svc.ingest(info('a1|idle|1'));
  assert.ok(rec);
  assert.equal(rec.priority, 'low');
  assert.equal(on.banners.length, 0);
  assert.equal(on.sounds.length, 0);
});

test('a banner the operating system will not show is reported, and the sound and the record are unaffected', () => {
  const unsupported = rig({ supported: false });
  const rec = unsupported.svc.ingest(approval());
  assert.equal(rec.delivery.desktop, 'unsupported');
  assert.equal(unsupported.svc.snapshot().desktop.status, 'unsupported');
  assert.deepEqual(unsupported.sounds, ['approval'], 'the sound does not depend on the banner');

  const failed = rig({ desktopOutcome: 'failed' });
  const rec2 = failed.svc.ingest(approval());
  assert.equal(rec2.delivery.desktop, 'failed');
  assert.equal(failed.svc.snapshot().desktop.status, 'blocked');
  assert.equal(failed.svc.snapshot().pending, 1);

  const ok = rig();
  ok.svc.ingest(approval());
  assert.equal(ok.svc.snapshot().desktop.status, 'ok');
  ok.svc.noteDesktopResult(false, 'denied');
  assert.equal(ok.svc.snapshot().desktop.status, 'blocked');
  assert.equal(ok.svc.snapshot().desktop.lastError, 'denied');
});

test('a sound that cannot play is reported without losing the notification', () => {
  const r = rig({ soundOk: false });
  const rec = r.svc.ingest(approval());
  assert.equal(rec.delivery.sound, 'failed');
  assert.equal(rec.delivery.desktop, 'shown');
});

test('a burst is folded: the first few banners show, the rest become one summary', () => {
  const r = rig();
  for (let i = 0; i < 9; i++) r.svc.ingest(approval(`a1|approval:${i}`));
  assert.equal(r.banners.length, 4, 'four banners, then no more');
  assert.equal(r.svc.snapshot().records.length, 9, 'every one is still recorded');
  r.advance(11_000);
  assert.equal(r.banners.length, 5);
  assert.equal(r.banners[4].body, '5 more');
});

test('sounds closer together than a moment are one sound', () => {
  const r = rig();
  r.svc.ingest(approval('a1|approval:1'));
  r.svc.ingest(approval('a1|approval:2'));
  assert.equal(r.sounds.length, 1);
  r.setNow(r.now() + 2_000);
  r.svc.ingest(approval('a1|approval:3'));
  assert.equal(r.sounds.length, 2);
});

test('clicking a banner activates that notification', () => {
  const r = rig();
  const rec = r.svc.ingest(approval());
  r.banners[0].onClick();
  assert.equal(r.activated[0].id, rec.id);
});

test('unread counts, mark read, mark all read, and clear that keeps what is still open', () => {
  const r = rig();
  const a = r.svc.ingest(approval('a1|approval:1'));
  r.svc.ingest(completed('a1|done|1'));
  r.svc.ingest(completed('a1|done|2'));
  assert.equal(r.svc.snapshot().unread, 3);
  r.svc.markRead(a.id);
  assert.equal(r.svc.snapshot().unread, 2);
  r.svc.markAllRead();
  assert.equal(r.svc.snapshot().unread, 0);
  assert.equal(r.svc.clear(), 2);
  assert.equal(r.svc.snapshot().records.length, 1, 'the open approval is not cleared away');
});

test('the history is persisted and comes back; what was open when the app last ran is closed, not left dangling', () => {
  const r = rig();
  r.svc.ingest(approval());
  r.svc.ingest(completed('a1|done|1'));
  r.svc.setPrefs({ ...r.svc.getPrefs(), sound: false });
  r.svc.flush();
  const saved = r.store();
  assert.equal(saved.records.length, 2);
  const r2 = rig({ initial: saved });
  const snap = r2.svc.snapshot();
  assert.equal(snap.records.length, 2);
  assert.equal(snap.prefs.sound, false, 'preferences persist too');
  assert.equal(snap.pending, 0, 'a request from the last run cannot be answered now');
  const old = snap.records.find((x) => x.category === 'approval');
  assert.equal(old.resolution.by, 'system');
  assert.equal(old.resolution.note, 'app-restarted');
  const fresh = r2.svc.ingest(approval());
  assert.ok(fresh.id !== old.id, 'ids do not collide with the restored ones');
});

test('a damaged history file is survivable: junk entries are dropped, defaults apply', () => {
  const r = rig({ initial: { v: 1, records: [null, 5, { id: 1 }, { id: 'n-x-1', agentId: 'a1', category: 'completed', title: { key: 'k' }, body: { key: 'k' }, actions: [], createdAt: 1, updatedAt: 1, read: false, actionRequired: false, requestKey: 'k', repeatCount: 1, delivery: {} }], prefs: { sound: 'yes', categories: { approval: 'no' } } } });
  const snap = r.svc.snapshot();
  assert.equal(snap.records.length, 1);
  assert.equal(snap.prefs.sound, true, 'a pref of the wrong type falls back to its default');
  assert.equal(snap.prefs.categories.approval, true);
  const garbage = rig({ initial: 'not an object' });
  assert.equal(garbage.svc.snapshot().records.length, 0);
});

test('persistence is debounced: a burst of changes is one write, and flush writes at once', () => {
  const r = rig();
  r.svc.ingest(approval('a1|approval:1'));
  r.svc.ingest(approval('a1|approval:2'));
  assert.equal(r.saved.length, 0);
  r.advance(500);
  assert.equal(r.saved.length, 1);
  r.svc.ingest(approval('a1|approval:3'));
  r.svc.flush();
  assert.equal(r.saved.length, 2);
});

test('the windows are told after a change, once for a burst', () => {
  const r = rig();
  r.svc.ingest(approval('a1|approval:1'));
  r.svc.ingest(approval('a1|approval:2'));
  assert.equal(r.changes.length, 0, 'coalesced');
  r.advance(100);
  assert.equal(r.changes.length, 1);
  assert.equal(r.changes[0].records.length, 2);
});

test('history is bounded, and trimming never drops an open request', () => {
  const r = rig();
  const first = r.svc.ingest(approval('a1|approval:keep'));
  for (let i = 0; i < N.MAX_HISTORY + 50; i++) { r.setNow(r.now() + 1); r.svc.ingest(completed(`a1|done|${i}`)); }
  const snap = r.svc.snapshot();
  assert.ok(snap.records.length <= 200, 'the snapshot sent to windows is capped');
  assert.ok(r.svc.get(first.id), 'the open approval is still there');
  assert.equal(r.svc.openFor('a1').length, 1);
});

test('resolveAgent closes only what that agent had open, and only the categories asked for', () => {
  const r = rig();
  r.svc.ingest(approval('a1|approval:1'));
  r.svc.ingest({ ...approval('a2|approval:1'), agentId: 'a2' });
  r.svc.ingest({ agentId: 'a1', category: 'intervention', title: { key: 'k' }, body: { key: 'k' }, requestKey: 'a1|crash|1', actions: ['restart'] });
  assert.equal(r.svc.resolveAgent('a1', { by: 'system', action: 'resolved' }, ['approval']), 1);
  assert.equal(r.svc.openFor('a1').length, 1, 'the crash is still open');
  assert.equal(r.svc.openFor('a2').length, 1, 'another agent is untouched');
  assert.equal(r.svc.resolveAgent('a1', { by: 'system', action: 'resolved' }), 1);
});

test('the test banner reports what happened', () => {
  const ok = rig();
  assert.equal(ok.svc.testDesktop(), 'ok');
  const no = rig({ supported: false });
  assert.equal(no.svc.testDesktop(), 'unsupported');
  const bad = rig({ desktopOutcome: 'failed' });
  assert.equal(bad.svc.testDesktop(), 'blocked');
});

test('dispose writes the history and stops further delivery', () => {
  const r = rig();
  r.svc.ingest(approval());
  r.svc.dispose();
  assert.equal(r.saved.length, 1);
  assert.equal(r.svc.ingest(approval('a1|approval:2')), null);
});

test('the preferences accept only what they know', () => {
  const d = N.defaultPrefs();
  assert.equal(d.sound, true);
  assert.equal(d.desktop, true);
  assert.equal(d.showRoutine, false);
  assert.deepEqual(N.sanitizePrefs(undefined), d);
  assert.equal(N.sanitizePrefs({ categories: { completed: false, nonsense: false } }).categories.completed, false);
  assert.equal('nonsense' in N.sanitizePrefs({ categories: { nonsense: false } }).categories, false);
});

test('delivery plan: routine is hidden unless asked for, low priority never rings, the rest follow the switches', () => {
  const p = N.defaultPrefs();
  assert.deepEqual(N.deliveryPlan(p, 'info', 'low'), { record: false, desktop: false, sound: null });
  assert.deepEqual(N.deliveryPlan(p, 'approval', 'high'), { record: true, desktop: true, sound: 'approval' });
  assert.deepEqual(N.deliveryPlan(p, 'completed', 'normal'), { record: true, desktop: true, sound: 'completed' });
  assert.deepEqual(N.deliveryPlan({ ...p, showRoutine: true, categories: { ...p.categories, info: true } }, 'info', 'low'), { record: true, desktop: false, sound: null });
  assert.deepEqual(N.deliveryPlan({ ...p, sound: false, desktop: false }, 'approval', 'high'), { record: true, desktop: false, sound: null });
});

// ─── the sounds: one for each kind of event, never two at once, previewed without a notification ───────────

const ring = (category, key, priority) => ({
  agentId: 'a1', category, ...(priority ? { priority } : {}),
  title: { key: 'notify.x.title' }, body: { key: 'notify.x.body' }, actions: ['open'], requestKey: key
});

test('each kind of event has its own sound, routine information has none, and a low priority never rings', () => {
  const cases = [
    ['completed', 'normal', 'completed'], ['approval', 'high', 'approval'], ['input', 'high', 'input'],
    ['access', 'normal', 'access'], ['intervention', 'high', 'intervention'], ['intervention', 'critical', 'critical']
  ];
  for (const [category, priority, want] of cases) {
    assert.equal(N.soundFor(category, priority), want, `${category}/${priority}`);
    const r = rig();
    const rec = r.svc.ingest(ring(category, `a1|${category}|1`, priority));
    assert.deepEqual(r.sounds, [want], `${category}/${priority} through the service`);
    assert.equal(rec.delivery.sound, 'played');
  }
  for (const category of ['approval', 'input', 'intervention', 'access', 'completed', 'info']) assert.equal(N.soundFor(category, 'low'), null, `${category} at low priority`);
  assert.equal(N.soundFor('info', 'high'), null, 'routine information is silent whatever its priority');
});

test('the real events pick the sound: a crash is critical, a stuck prompt or a stopped breaker needs attention, an ask needs input, a refused call needs access', () => {
  const agent = { id: 'a1', name: 'Marshall' };
  const sound = (intent) => N.soundFor(intent.category, intent.priority ?? N.defaultPriority(intent.category));
  assert.equal(sound(N.intentFromSignal(agent, { kind: 'crashed', message: 'boom', exitCode: 1 }, 1)), 'critical');
  assert.equal(sound(N.intentFromStuckPrompt(agent, 5)), 'intervention');
  assert.equal(sound(N.intentFromSignal(agent, { kind: 'breaker', level: 'stopped', reason: 'x' }, 1)), 'intervention');
  assert.equal(sound(N.intentFromHumanAsk(agent, { subject: 's', question: 'q', key: 'k' })), 'input');
  assert.equal(sound(N.intentFromAccessDenied(agent, { integrationId: 'gmail' })), 'access');
  assert.equal(sound(N.intentFromSignal(agent, { kind: 'turn-completed', ms: 90_000, tools: 3, substantial: true, userInitiated: true }, 1)), 'completed');
  assert.equal(N.intentFromSignal(agent, { kind: 'started' }, 1), null, 'a start is not a notification');
});

test('sounds never overlap: a repeat is one sound, a lower one is dropped, a higher one takes over, and the speakers free up when a sound ends', () => {
  const r = rig();
  r.svc.ingest(completed('a1|done|1'));
  assert.deepEqual(r.soundCalls, [{ kind: 'completed', interrupt: false }]);
  r.advance(200);
  const second = r.svc.ingest(completed('a1|done|2'));          // another agent finishing in the same breath
  assert.equal(second.delivery.sound, 'muted');
  assert.equal(r.sounds.length, 1);
  const needs = r.svc.ingest(approval('a1|approval:9'));        // something that needs a person takes over
  assert.equal(needs.delivery.sound, 'played');
  assert.deepEqual(r.soundCalls[1], { kind: 'approval', interrupt: true });
  const lower = r.svc.ingest(ring('input', 'a1|input|1'));      // lower than the approval that is sounding
  assert.equal(lower.delivery.sound, 'muted');
  assert.equal(r.sounds.length, 2);
  assert.equal(lower.actionRequired, true, 'a dropped sound is not a lost notification: it is recorded and waiting');
  r.advance(1500);
  assert.equal(r.svc.ingest(completed('a1|done|4')).delivery.sound, 'muted', 'the piano hook is not rung again within six seconds of the last one');
  r.advance(6000);
  r.svc.ingest(completed('a1|done|3'));
  assert.deepEqual(r.soundCalls[2], { kind: 'completed', interrupt: false }, 'the speakers were free again, and the six seconds were up');
});

test('a sound the player could not make is reported as failed and does not hold the speakers', () => {
  const bad = rig({ soundOk: false });
  const rec = bad.svc.ingest(approval());
  assert.equal(rec.delivery.sound, 'failed');
  const again = bad.svc.ingest(approval('a1|approval:2'));
  assert.equal(again.delivery.sound, 'failed', 'asked again at once, not "muted": the first one never sounded');
  assert.equal(bad.sounds.length, 2);
});

test('an agent starting rings the soft cue once, records nothing, raises no banner, and a crowd of agents starting is one pluck', () => {
  const r = rig();
  const ports = { notifications: r.svc, agentRef: (id) => ({ id, name: id }), now: () => r.now() };
  handleSignals(ports, 'a1', [{ kind: 'started' }], {});
  assert.deepEqual(r.sounds, ['started']);
  assert.equal(r.svc.snapshot().records.length, 0);
  assert.equal(r.banners.length, 0);
  for (let i = 0; i < 8; i++) handleSignals(ports, `b${i}`, [{ kind: 'started' }], {});
  assert.equal(r.sounds.length, 1, 'rare as well as quiet');
});

const cuesWith = (r, patch) => ({ ...r.svc.getPrefs().cues, ...patch });

test('the start sound follows the master switch and its own switch; a notification still rings with it off', () => {
  const r = rig();
  r.svc.setPrefs({ ...r.svc.getPrefs(), cues: cuesWith(r, { started: false }) });
  assert.equal(r.svc.cue('started'), 'off');
  assert.equal(r.sounds.length, 0);
  r.svc.setPrefs({ ...r.svc.getPrefs(), cues: cuesWith(r, { started: true }), sound: false });
  assert.equal(r.svc.cue('started'), 'off', 'master switch off');
  r.svc.setPrefs({ ...r.svc.getPrefs(), sound: true });
  assert.equal(r.svc.cue('started'), 'played');
  assert.deepEqual(r.sounds, ['started']);
  const quiet = rig();
  quiet.svc.setPrefs({ ...quiet.svc.getPrefs(), cues: cuesWith(quiet, { started: false }) });
  quiet.svc.ingest(approval());
  assert.deepEqual(quiet.sounds, ['approval'], 'only the start sound is off');
});

test('every sound has its own switch: a sound that is off is silent, its notification is still recorded with its banner, and every other sound still rings', () => {
  const events = [
    ['completed', 'completed', 'normal'], ['intervention', 'intervention', 'high'], ['input', 'input', 'high'],
    ['approval', 'approval', 'high'], ['access', 'access', 'normal'], ['critical', 'intervention', 'critical']
  ];
  for (const [sound, category, priority] of events) {
    const r = rig();
    r.svc.setPrefs({ ...r.svc.getPrefs(), cues: cuesWith(r, { [sound]: false }) });
    const rec = r.svc.ingest(ring(category, `a1|${sound}|1`, priority));
    assert.equal(rec.delivery.sound, 'off', `${sound}: reported off`);
    assert.deepEqual(r.sounds, [], `${sound}: nothing was asked of the player`);
    assert.equal(r.banners.length, 1, `${sound}: the banner still shows`);
    assert.equal(r.svc.snapshot().records.length, 1, `${sound}: and it is recorded`);
    // the others are untouched
    for (const [other, otherCategory, otherPriority] of events.filter((e) => e[0] !== sound)) {
      const o = rig();
      o.svc.setPrefs({ ...o.svc.getPrefs(), cues: cuesWith(o, { [sound]: false }) });
      o.svc.ingest(ring(otherCategory, `a1|${other}|1`, otherPriority));
      assert.deepEqual(o.sounds, [other], `${other} still rings with ${sound} off`);
    }
  }
});

test('a sound switched off can still be previewed, and switching it back on makes it ring again', () => {
  const r = rig();
  r.svc.setPrefs({ ...r.svc.getPrefs(), cues: cuesWith(r, { approval: false }) });
  assert.equal(r.svc.previewSound('approval'), 'played', 'a person can always hear what they switched off');
  assert.deepEqual(r.sounds, ['approval']);
  r.sounds.length = 0;
  r.advance(5000);
  r.svc.setPrefs({ ...r.svc.getPrefs(), cues: cuesWith(r, { approval: true }) });
  const rec = r.svc.ingest(approval('a1|approval:9'));
  assert.equal(rec.delivery.sound, 'played');
  assert.deepEqual(r.sounds, ['approval']);
});

test('the delivery plan names no sound for a sound that is switched off, and the switches are the whole story for the rest', () => {
  const p = N.defaultPrefs();
  const off = { ...p, cues: { ...p.cues, approval: false } };
  assert.deepEqual(N.deliveryPlan(off, 'approval', 'high'), { record: true, desktop: true, sound: null });
  assert.deepEqual(N.deliveryPlan(off, 'input', 'high'), { record: true, desktop: true, sound: 'input' });
  assert.deepEqual(N.deliveryPlan({ ...p, cues: { ...p.cues, critical: false } }, 'intervention', 'critical'), { record: true, desktop: true, sound: null });
  assert.deepEqual(N.deliveryPlan({ ...p, cues: { ...p.cues, critical: false } }, 'intervention', 'high'), { record: true, desktop: true, sound: 'intervention' }, 'the crash sound and the attention sound are two switches');
});

test('a preview plays the sound alone: no record, no banner, nothing changes for an agent that is waiting, and it works with the sounds off', () => {
  const r = rig();
  r.svc.ingest(approval());
  r.sounds.length = 0; r.soundCalls.length = 0;
  const recordsBefore = JSON.stringify(r.svc.snapshot().records);
  const banners = r.banners.length;
  r.svc.setPrefs({ ...r.svc.getPrefs(), sound: false });
  assert.equal(r.svc.previewSound('critical'), 'played');
  assert.deepEqual(r.sounds, ['critical']);
  assert.equal(r.banners.length, banners, 'no banner');
  assert.equal(JSON.stringify(r.svc.snapshot().records), recordsBefore, 'no record was added or changed');
  assert.equal(r.svc.snapshot().pending, 1, 'the agent that was waiting still is');
  assert.equal(r.svc.previewSound('signature'), 'played');
  assert.deepEqual(r.soundCalls.at(-1), { kind: 'signature', interrupt: true }, 'another preview takes over from the first');
  assert.equal(rig({ soundOk: false }).svc.previewSound('input'), 'failed');
});

test('volume and the switch of each sound are preferences: clamped, defaulted, kept, migrated from older files, and read when a sound plays', () => {
  const d = N.defaultPrefs();
  assert.equal(d.volume, 0.8);
  assert.deepEqual(Object.keys(d.cues).sort(), [...N.SOUND_KINDS].sort(), 'one switch for every sound');
  assert.ok(Object.values(d.cues).every((v) => v === true), 'all on by default');
  assert.equal(N.sanitizePrefs({ volume: 2 }).volume, 1);
  assert.equal(N.sanitizePrefs({ volume: -1 }).volume, 0);
  assert.equal(N.sanitizePrefs({ volume: 'loud' }).volume, 0.8);
  assert.equal(N.sanitizePrefs({ volume: Number.NaN }).volume, 0.8);
  assert.equal(N.sanitizePrefs({ volume: 0.456 }).volume, 0.46);
  assert.equal(N.sanitizePrefs({ cues: { approval: 'no', input: false, nonsense: false } }).cues.approval, true, 'a switch of the wrong type falls back to on');
  assert.equal(N.sanitizePrefs({ cues: { input: false } }).cues.input, false);
  assert.equal('nonsense' in N.sanitizePrefs({ cues: { nonsense: false } }).cues, false);
  const r = rig();
  r.svc.setPrefs({ ...r.svc.getPrefs(), volume: 0.3, cues: cuesWith(r, { started: false, approval: false }) });
  assert.equal(r.svc.volume(), 0.3);
  r.svc.flush();
  assert.equal(r.store().prefs.volume, 0.3);
  assert.equal(r.store().prefs.cues.started, false);
  assert.equal(r.store().prefs.cues.approval, false);
  assert.equal(r.store().prefs.cues.input, true);
  // preferences written before there was a volume still load, with the default
  const old = rig({ initial: { v: 1, records: [], prefs: { v: 1, sound: false, desktop: true, showRoutine: false, categories: {} } } });
  assert.equal(old.svc.getPrefs().sound, false);
  assert.equal(old.svc.getPrefs().volume, 0.8);
  assert.ok(Object.values(old.svc.getPrefs().cues).every((v) => v === true));
  // and the single start-sound switch of the version before this one becomes the start sound's switch
  const before = rig({ initial: { v: 1, records: [], prefs: { v: 1, sound: true, volume: 0.6, startSound: false, desktop: true, showRoutine: false, categories: {} } } });
  assert.equal(before.svc.getPrefs().cues.started, false, 'a person who had switched the start sound off still has it off');
  assert.equal(before.svc.getPrefs().cues.approval, true);
  assert.equal(before.svc.getPrefs().volume, 0.6);
  assert.equal(before.svc.cue('started'), 'off');
});

test('a sound that lasts longer than the app\'s own for it (a replacement: the person\'s own file, or the one that ships) holds the speakers for as long, and the pause after it is as long as it was', () => {
  const r = rig({ soundMs: (k) => (k === 'completed' ? 7000 : undefined) });
  assert.equal(r.svc.ingest(completed('a1|done|1')).delivery.sound, 'played');
  r.advance(6500);                                      // past the six-second cooldown, but its seven seconds are still sounding
  assert.equal(r.svc.ingest(completed('a1|done|2')).delivery.sound, 'muted', 'it does not start another over the end of the first');
  r.advance(700);                                       // 7.2 s: it is over, but the pause after it (six seconds plus how much longer it is than the app\'s own) is not
  assert.equal(r.svc.ingest(completed('a1|done|3')).delivery.sound, 'muted', 'and the same news is not rung again straight after it');
  r.advance(2500);                                      // 9.7 s
  assert.equal(r.svc.ingest(completed('a1|done|4')).delivery.sound, 'played', 'once the pause is over, it does');
  assert.equal(r.svc.previewSound('completed'), 'played');
  assert.deepEqual(r.soundCalls.at(-1), { kind: 'completed', interrupt: true }, 'a preview still takes over, and is held for the real length too');
  const plain = rig();                                  // no replacement: the app's own length
  plain.svc.ingest(completed('a1|done|1'));
  plain.advance(6500);
  assert.equal(plain.svc.ingest(completed('a1|done|2')).delivery.sound, 'played');
});

test('the test notification plays the signature tune, through the same gate and only with the sounds on', () => {
  const r = rig();
  r.svc.testDesktop();
  assert.deepEqual(r.sounds, ['signature']);
  const off = rig();
  off.svc.setPrefs({ ...off.svc.getPrefs(), sound: false });
  off.svc.testDesktop();
  assert.equal(off.sounds.length, 0);
});

// ─── events → notifications, end to end through the tracker ───────────────────

function pipeline() {
  const r = rig();
  const tracker = new ActivityTracker({
    now: r.now,
    onSignals: (agentId, signals, activity) => handleSignals({ notifications: r.svc, agentRef: (id) => ({ id, name: { a1: 'Marshall', god: 'Ted' }[id] ?? id, isGod: id === 'god' }), now: r.now }, agentId, signals, activity)
  });
  return { ...r, tracker };
}

test('a permission prompt from a real hook payload becomes one approval notification, and approving in the terminal resolves it', () => {
  const p = pipeline();
  p.tracker.hook('a1', { event: 'UserPromptSubmit', prompt: 'ship it' });
  p.tracker.hook('a1', { event: 'PreToolUse', tool: 'Bash', toolInput: { command: 'git push origin main' } });
  p.tracker.hook('a1', { event: 'Notification', notificationType: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
  p.tracker.hook('a1', { event: 'Notification', notificationType: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
  const open = p.svc.openFor('a1');
  assert.equal(open.length, 1, 'the repeat did not make a second one');
  assert.equal(open[0].category, 'approval');
  assert.match(open[0].preview, /git push origin main/);
  assert.deepEqual(open[0].actions, ['approve', 'reject', 'alternative', 'open']);
  p.tracker.hook('a1', { event: 'PostToolUse', tool: 'Bash' });
  assert.equal(p.svc.openFor('a1').length, 0);
  const rec = p.svc.get(open[0].id);
  assert.equal(rec.resolution.by, 'agent');
  assert.equal(rec.resolution.note, 'agent-moved-on');
});

test('a substantial finish notifies; a routine one does not; the orchestrator only for turns a person asked for', () => {
  const p = pipeline();
  p.tracker.hook('a1', { event: 'UserPromptSubmit', prompt: 'refactor' });
  for (let i = 0; i < 3; i++) p.tracker.hook('a1', { event: 'PreToolUse', tool: 'Edit', toolInput: { file_path: '/x/y.ts' } });
  p.tracker.hook('a1', { event: 'Stop' });
  assert.equal(p.svc.snapshot().records.filter((x) => x.category === 'completed').length, 1);

  p.tracker.hook('a1', { event: 'UserPromptSubmit', prompt: 'hi' });
  p.tracker.hook('a1', { event: 'Stop' });
  assert.equal(p.svc.snapshot().records.filter((x) => x.category === 'completed').length, 1, 'a one-line answer is not an event');

  const { inboxNudgeText } = loadTs('src/shared/hiveNudge.ts');
  p.tracker.hook('god', { event: 'UserPromptSubmit', prompt: inboxNudgeText(['m1']) });
  for (let i = 0; i < 5; i++) p.tracker.hook('god', { event: 'PreToolUse', tool: 'Read', toolInput: {} });
  p.tracker.hook('god', { event: 'Stop' });
  assert.equal(p.svc.snapshot().records.filter((x) => x.agentId === 'god').length, 0, 'Ted answering his inbox is not news');
  p.tracker.hook('god', { event: 'UserPromptSubmit', prompt: 'what is the status?' });
  for (let i = 0; i < 4; i++) p.tracker.hook('god', { event: 'PreToolUse', tool: 'Read', toolInput: {} });
  p.tracker.hook('god', { event: 'Stop' });
  assert.equal(p.svc.snapshot().records.filter((x) => x.agentId === 'god').length, 1, 'but answering a person is');
});

test('a crash raises an intervention with what the process said; a restart closes it', () => {
  const p = pipeline();
  p.tracker.spawn('a1');
  p.tracker.exit('a1', { exitCode: 1, tail: 'Error: out of memory\n' });
  const open = p.svc.openFor('a1');
  assert.equal(open.length, 1);
  assert.equal(open[0].category, 'intervention');
  assert.equal(open[0].priority, 'critical');
  assert.equal(open[0].preview, 'Error: out of memory');
  assert.deepEqual(open[0].actions, ['restart', 'open']);
  p.tracker.spawn('a1');
  assert.equal(p.svc.openFor('a1').length, 0, 'a new process closes the old one\'s crash');
  assert.equal(p.svc.get(open[0].id).resolution.note, 'restarted');
});

test('a clean exit closes any open prompt and is only routine news', () => {
  const p = pipeline();
  p.tracker.hook('a1', { event: 'PreToolUse', tool: 'Bash', toolInput: { command: 'ls' } });
  p.tracker.hook('a1', { event: 'Notification', notificationType: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
  assert.equal(p.svc.openFor('a1').length, 1);
  p.tracker.exit('a1', { exitCode: 0 });
  assert.equal(p.svc.openFor('a1').length, 0);
  assert.equal(p.svc.snapshot().records.filter((x) => x.category === 'intervention').length, 0);
});

test('AskUserQuestion becomes an input notification with its options, and answering clears it', () => {
  const p = pipeline();
  p.tracker.hook('a1', { event: 'PreToolUse', tool: 'AskUserQuestion', toolInput: { questions: [{ question: 'Which database?', options: [{ label: 'Postgres' }, { label: 'SQLite' }], multiSelect: false }] } });
  const open = p.svc.openFor('a1');
  assert.equal(open.length, 1);
  assert.equal(open[0].category, 'input');
  assert.deepEqual(open[0].options, ['Postgres', 'SQLite']);
  assert.deepEqual(open[0].actions, ['option', 'open']);
  assert.equal(open[0].preview, 'Which database?');
  p.tracker.hook('a1', { event: 'PostToolUse', tool: 'AskUserQuestion' });
  assert.equal(p.svc.openFor('a1').length, 0);
});

test('the breaker raises an intervention that clears when the breaker does', () => {
  const p = pipeline();
  p.tracker.hook('a1', { event: 'UserPromptSubmit', prompt: 'x' });
  p.tracker.breaker('a1', 'constrained', 'same tool call 12 times');
  assert.equal(p.svc.openFor('a1').length, 1);
  assert.equal(p.svc.openFor('a1')[0].category, 'intervention');
  p.tracker.breaker('a1', 'healthy');
  assert.equal(p.svc.openFor('a1').length, 0);
});

test('access: one notification per agent and integration however many calls were refused, routed to settings, no secret asked for', () => {
  const r = rig();
  const intent = N.intentFromAccessDenied({ id: 'a1', name: 'Marshall' }, { integrationId: 'github', tool: 'search_issues', reason: 'no access granted' });
  assert.equal(intent.category, 'access');
  assert.deepEqual(intent.actions, ['settings', 'open']);
  assert.ok(!['answer', 'option'].some((a) => intent.actions.includes(a)), 'there is no box to type into');
  assert.ok(!`${intent.title.key} ${intent.body.key} ${intent.preview ?? ''}`.match(/token|password|secret|credential/i), 'nothing in it asks for a credential');
  r.svc.ingest(intent);
  r.svc.ingest(N.intentFromAccessDenied({ id: 'a1', name: 'Marshall' }, { integrationId: 'github', tool: 'create_issue' }));
  assert.equal(r.svc.openFor('a1').length, 1);
  r.svc.ingest(N.intentFromAccessDenied({ id: 'a1', name: 'Marshall' }, { integrationId: 'slack' }));
  assert.equal(r.svc.openFor('a1').length, 2, 'a different integration is a different request');
});

test('a question put through the hive carries its task and conversation, and offers an answer box', () => {
  const intent = N.intentFromHumanAsk({ id: 'god', name: 'Ted' }, { taskId: 't7', conversationId: 'c3', subject: 'Pricing', question: 'Free or paid?', key: 't7:Free or paid?' });
  assert.equal(intent.category, 'input');
  assert.equal(intent.taskId, 't7');
  assert.equal(intent.conversationId, 'c3');
  assert.deepEqual(intent.actions, ['answer', 'open']);
});

test('text is carried as keys and rendered in whichever language the table is', () => {
  const en = { notify: { approval: { title: '{{agent}} needs approval' } } };
  const zh = { notify: { approval: { title: '{{agent}} 需要批准' } } };
  const t = { key: 'notify.approval.title', args: { agent: 'Marshall' } };
  assert.equal(N.renderText(en, t), 'Marshall needs approval');
  assert.equal(N.renderText(zh, t), 'Marshall 需要批准');
  assert.equal(N.renderText({}, t), 'notify.approval.title', 'a missing string shows its key, never nothing');
  assert.equal(N.renderText(en, { key: 'notify.approval.title' }), ' needs approval');
  assert.equal(N.durationText(75_000), '1m 15s');
  assert.equal(N.durationText(3_900_000), '1h 5m');
});
