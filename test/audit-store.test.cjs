'use strict';

/**
 * F5 — the durable audit trail.
 *
 * What is pinned here: records survive a restart and chain onward; the chain notices an
 * edited, deleted, reordered or invented record (with an HMAC key, even one rewritten
 * wholesale); rotation keeps the newest files and the chain stays checkable; nothing that
 * looks like a credential reaches the file whichever field it was offered in; only fixed
 * fields are ever written; and a store that cannot write drops records without throwing.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { AuditStore, verifyAuditDir, scrubText } = loadTs('src/main/broker/audit-store.ts');

const KEY = Buffer.from('k'.repeat(32));
const tmp = (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mosbius-audit-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};
const filesOf = (d) => fs.readdirSync(d).filter((n) => /^audit-\d{6}\.jsonl$/.test(n)).sort();
const readLines = (d, f) => fs.readFileSync(path.join(d, f), 'utf8').split('\n').filter(Boolean);
const allText = (d) => filesOf(d).map((f) => fs.readFileSync(path.join(d, f), 'utf8')).join('');
const fill = (s, n) => { for (let i = 0; i < n; i++) s.append({ kind: 'mcp', actor: 'agent:a1', agentId: 'a1', integrationId: 'time', action: `tool_${i}`, decision: i % 2 ? 'allow' : 'deny' }); };

test('records are written, chained, and verify — keyed and unkeyed', (t) => {
  for (const key of [KEY, undefined]) {
    const dir = tmp(t);
    const s = new AuditStore({ dir, key });
    fill(s, 5);
    s.close();
    const v = verifyAuditDir(dir, key);
    assert.deepEqual(v, { ok: true, records: 5, files: 1, keyed: key !== undefined, anchored: true });
    assert.equal(s.keyed(), key !== undefined);
  }
});

test('a restart carries on from the last record: sequence and chain continue', (t) => {
  const dir = tmp(t);
  const a = new AuditStore({ dir, key: KEY });
  fill(a, 3);
  a.close();
  const b = new AuditStore({ dir, key: KEY });
  fill(b, 4);
  b.close();
  assert.deepEqual(verifyAuditDir(dir, KEY), { ok: true, records: 7, files: 1, keyed: true, anchored: true });
  const seqs = readLines(dir, filesOf(dir)[0]).map((l) => JSON.parse(l.replace(/,"h":"[0-9a-f]+"\}$/, '}')).seq);
  assert.deepEqual(seqs, [1, 2, 3, 4, 5, 6, 7]);
});

test('an edited record is caught', (t) => {
  const dir = tmp(t);
  const s = new AuditStore({ dir, key: KEY });
  fill(s, 6);
  s.close();
  const f = path.join(dir, filesOf(dir)[0]);
  const lines = readLines(dir, filesOf(dir)[0]);
  lines[2] = lines[2].replace('"deny"', '"allow"').replace('tool_2', 'tool_X');
  fs.writeFileSync(f, lines.join('\n') + '\n');
  const v = verifyAuditDir(dir, KEY);
  assert.equal(v.ok, false);
  assert.equal(v.line, 3);
  assert.equal(v.reason, 'tag-mismatch');
});

test('a deleted record is caught', (t) => {
  const dir = tmp(t);
  const s = new AuditStore({ dir, key: KEY });
  fill(s, 6);
  s.close();
  const f = path.join(dir, filesOf(dir)[0]);
  const lines = readLines(dir, filesOf(dir)[0]);
  lines.splice(3, 1);
  fs.writeFileSync(f, lines.join('\n') + '\n');
  const v = verifyAuditDir(dir, KEY);
  assert.equal(v.ok, false);
  assert.equal(v.line, 4);
  assert.match(v.reason, /chain-broken|sequence-gap/);
});

test('two swapped records are caught', (t) => {
  const dir = tmp(t);
  const s = new AuditStore({ dir, key: KEY });
  fill(s, 6);
  s.close();
  const f = path.join(dir, filesOf(dir)[0]);
  const lines = readLines(dir, filesOf(dir)[0]);
  [lines[1], lines[2]] = [lines[2], lines[1]];
  fs.writeFileSync(f, lines.join('\n') + '\n');
  assert.equal(verifyAuditDir(dir, KEY).ok, false);
});

test('an invented record is caught, and with a key a rewritten chain is too', (t) => {
  const dir = tmp(t);
  const s = new AuditStore({ dir, key: KEY });
  fill(s, 4);
  s.close();
  // someone with write access but no key rebuilds the whole file with a plain SHA-256 chain
  const forgedDir = tmp(t);
  const plain = new AuditStore({ dir: forgedDir });
  fill(plain, 4);
  plain.close();
  assert.equal(verifyAuditDir(forgedDir, undefined).ok, true, 'an unkeyed chain can be recomputed by anyone who can write the file');
  const swapped = path.join(dir, filesOf(dir)[0]);
  fs.copyFileSync(path.join(forgedDir, filesOf(forgedDir)[0]), swapped);
  const v = verifyAuditDir(dir, KEY);
  assert.equal(v.ok, false, 'but it does not verify under the real key');
  assert.equal(v.reason, 'tag-mismatch');
});

test('rotation keeps the newest files and the chain stays checkable', (t) => {
  const dir = tmp(t);
  const s = new AuditStore({ dir, key: KEY, maxFileBytes: 1500, maxFiles: 3 });
  fill(s, 60);
  s.close();
  const files = filesOf(dir);
  assert.equal(files.length, 3, 'only the newest three are kept');
  assert.ok(Number(files[0].slice(6, 12)) > 1, 'older ones were pruned');
  for (const f of files) assert.ok(fs.statSync(path.join(dir, f)).size <= 1500 + 400, `${f} grew far past its limit`);
  const v = verifyAuditDir(dir, KEY);
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.ok(v.records > 0 && v.records < 60);
});

test('the chain carries across a rotation: the first record of a new file continues the old one', (t) => {
  const dir = tmp(t);
  const s = new AuditStore({ dir, key: KEY, maxFileBytes: 1200, maxFiles: 10 });
  fill(s, 20);
  s.close();
  const files = filesOf(dir);
  assert.ok(files.length >= 2);
  const lastOfFirst = readLines(dir, files[0]).pop();
  const firstOfSecond = readLines(dir, files[1])[0];
  const tag = /"h":"([0-9a-f]{32})"\}$/.exec(lastOfFirst)[1];
  assert.match(firstOfSecond, new RegExp(`"prev":"${tag}"`));
  assert.equal(verifyAuditDir(dir, KEY).ok, true);
});

test('a torn tail is reported by verify, and the store starts a fresh, marked chain and keeps logging', (t) => {
  const dir = tmp(t);
  const a = new AuditStore({ dir, key: KEY });
  fill(a, 3);
  a.close();
  fs.appendFileSync(path.join(dir, filesOf(dir)[0]), '{"v":1,"seq":4,"at":1,"ki'); // power cut mid-write
  const b = new AuditStore({ dir, key: KEY });
  b.append({ kind: 'grant', actor: 'user', action: 'read', integrationId: 'time' });
  b.close();
  assert.equal(filesOf(dir).length, 2, 'a new file was started');
  const marker = readLines(dir, filesOf(dir)[1])[0];
  assert.match(marker, /"action":"chain-reset"/);
  assert.equal(verifyAuditDir(dir, KEY).ok, false, 'the damaged file is still reported, not hidden');
  assert.equal(b.recent({ kind: 'grant' }).length, 1, 'and new records are readable');
});

test('only fixed fields are written: an extra property, a body, a header never reaches the file', (t) => {
  const dir = tmp(t);
  const s = new AuditStore({ dir, key: KEY });
  s.append({
    kind: 'mcp', actor: 'agent:a1', integrationId: 'time', action: 'get_current_time', decision: 'allow',
    body: 'PLANTED-BODY-CONTENT', headers: { authorization: 'PLANTED-HEADER' }, arguments: { q: 'PLANTED-ARGUMENT' }
  });
  s.close();
  const text = allText(dir);
  for (const c of ['PLANTED-BODY-CONTENT', 'PLANTED-HEADER', 'PLANTED-ARGUMENT']) assert.equal(text.includes(c), false, c);
  assert.match(text, /"action":"get_current_time"/);
});

test('credential shapes are scrubbed from every field, and control characters and length are bounded', (t) => {
  const dir = tmp(t);
  const s = new AuditStore({ dir, key: KEY });
  // Invented credentials in the shapes the scrubber must catch. Split where a scanner would read the whole literal as a real
  // one (GitHub push protection does, even for a made-up token), as test/voice-messages.test.cjs does for its Slack token.
  const canaries = [
    'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8', 'xoxb-' + '1234567890-abcdefghijklmnop', 'sk-ant-api03-ZZZZZZZZZZZZZZZZZZZZ',
    'AIzaSyD-abcdefghijklmnopqrstuvwxyz12345', 'ya29.a0AbCdEfGhIjKlMnOpQrStUv', 'ntn_abcdefghijklmnopqrstuvwxyz0123',
    'github_pat_11ABCDEFG0abcdefghijklmnop', 'f'.repeat(64)
  ];
  for (const c of canaries) {
    s.append({ kind: 'mcp', actor: `agent:${c}`, agentId: c, integrationId: 'x', action: `call ${c}`, reason: `Bearer ${c}`, detail: `see ${c} here` });
  }
  s.append({ kind: 'mcp', action: 'line1\nline2\u0007bell', reason: 'z'.repeat(5000) });
  s.close();
  const text = allText(dir);
  for (const c of canaries) assert.equal(text.includes(c), false, `${c.slice(0, 8)}… reached the file`);
  assert.equal(text.includes('\u0007'), false);
  for (const l of text.split('\n').filter(Boolean)) assert.ok(l.length < 1200, 'a record is bounded');
  assert.match(text, /\[redacted\]/);
  assert.equal(verifyAuditDir(dir, KEY).ok, true, 'and the scrubbed records still chain');
});

test('scrubText keeps ordinary names and codes intact', () => {
  assert.equal(scrubText('get_current_time'), 'get_current_time');
  assert.equal(scrubText('tools/call'), 'tools/call');
  assert.equal(scrubText('integration not in this agent capability'), 'integration not in this agent capability');
  assert.equal(scrubText(42), undefined);
  assert.equal(scrubText('   '), undefined);
});

test('a store that cannot write drops records, counts them, and never throws', (t) => {
  const dir = tmp(t);
  const blocker = path.join(dir, 'not-a-folder');
  fs.writeFileSync(blocker, 'x');
  const s = new AuditStore({ dir: path.join(blocker, 'audit') });
  assert.doesNotThrow(() => fill(s, 3));
  assert.equal(s.droppedCount(), 3);
  assert.deepEqual(s.recent(), []);
});

test('files are owner-only', { skip: process.platform === 'win32' }, (t) => {
  const dir = path.join(tmp(t), 'audit');
  const s = new AuditStore({ dir, key: KEY });
  fill(s, 2);
  s.close();
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(dir, filesOf(dir)[0])).mode & 0o777, 0o600);
});

test('recent() filters by integration and kind, newest first, and never returns the chain fields', (t) => {
  const dir = tmp(t);
  const s = new AuditStore({ dir, key: KEY });
  s.append({ kind: 'mcp', integrationId: 'time', action: 'a' });
  s.append({ kind: 'grant', integrationId: 'fetch', action: 'read', actor: 'user' });
  s.append({ kind: 'mcp', integrationId: 'time', action: 'b' });
  assert.deepEqual(s.recent({ integrationId: 'time' }).map((r) => r.action), ['b', 'a']);
  assert.deepEqual(s.recent({ kind: 'grant' }).map((r) => r.integrationId), ['fetch']);
  for (const r of s.recent()) assert.equal('prev' in r || 'h' in r, false);
  s.close();
});

// ─── the anchor: truncation, deleted files and rollback ──────────────────────

const { ANCHOR_EVERY } = loadTs('src/main/broker/audit-store.ts');

/** An anchor store that lives somewhere an editor of the log folder cannot reach (a Map here, the vault in the app). */
const vaultAnchor = () => { const box = { v: undefined }; return { box, read: () => box.v, write: (x) => { box.v = x; return true; } }; };

test('TRUNCATION: cutting records off the end is detected, which the chain alone could not do', (t) => {
  const dir = tmp(t);
  const s = new AuditStore({ dir, key: KEY, anchor: vaultAnchor() });
  fill(s, 12);
  s.close();
  const f = path.join(dir, filesOf(dir)[0]);
  const lines = readLines(dir, filesOf(dir)[0]);
  fs.writeFileSync(f, lines.slice(0, 6).join('\n') + '\n');
  const v = verifyAuditDir(dir, KEY);
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'truncated');
});

test('DELETION: removing the newest file, or all of them, is detected', (t) => {
  const dir = tmp(t);
  const s = new AuditStore({ dir, key: KEY, maxFileBytes: 1300, maxFiles: 10 });
  fill(s, 40);
  s.close();
  const files = filesOf(dir);
  assert.ok(files.length >= 3);
  fs.rmSync(path.join(dir, files[files.length - 1]));
  assert.equal(verifyAuditDir(dir, KEY).reason, 'truncated', 'the newest file is gone');
  for (const f of filesOf(dir)) fs.rmSync(path.join(dir, f));
  assert.equal(verifyAuditDir(dir, KEY).reason, 'truncated', 'every file is gone but the anchor remembers');
});

test('DELETION of the OLDEST file is detected as removed files, while the app\'s own pruning is not', (t) => {
  const dir = tmp(t);
  const pruning = new AuditStore({ dir, key: KEY, maxFileBytes: 1300, maxFiles: 3 });
  fill(pruning, 60);
  pruning.close();
  assert.equal(verifyAuditDir(dir, KEY).ok, true, 'pruning old files is the store\'s own act and the anchor says so');

  const dir2 = tmp(t);
  const keep = new AuditStore({ dir: dir2, key: KEY, maxFileBytes: 1300, maxFiles: 10 });
  fill(keep, 40);
  keep.close();
  fs.rmSync(path.join(dir2, filesOf(dir2)[0]));
  const v = verifyAuditDir(dir2, KEY);
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'files-removed', 'somebody else removed the front of the log');
});

test('MODIFICATION of the anchor itself is detected, and so is an anchor from another key', (t) => {
  const dir = tmp(t);
  const s = new AuditStore({ dir, key: KEY });
  fill(s, 12);
  s.close();
  const head = path.join(dir, 'head.json');
  const a = JSON.parse(fs.readFileSync(head, 'utf8'));
  fs.writeFileSync(head, JSON.stringify({ ...a, seq: 3 }));
  assert.equal(verifyAuditDir(dir, KEY).reason, 'anchor-invalid', 'lowering the sequence to hide a truncation');
  fs.writeFileSync(head, JSON.stringify(a));
  assert.equal(verifyAuditDir(dir, KEY).ok, true, 'put back, it verifies again');
  const other = verifyAuditDir(dir, Buffer.from('z'.repeat(32)));
  assert.equal(other.ok, false, 'and nothing verifies under another key');
  assert.match(other.reason, /^(tag-mismatch|anchor-invalid)$/, 'the records fail first, the anchor would too');
});

test('A CHANGED HISTORY behind the anchor is detected even when the chain is rebuilt', (t) => {
  const dir = tmp(t);
  const s = new AuditStore({ dir, key: KEY });
  fill(s, 12);
  s.close();
  // a person with the folder but without the key swaps in a perfectly consistent unkeyed chain of the same length
  const forged = tmp(t);
  const f = new AuditStore({ dir: forged });
  fill(f, 12);
  f.close();
  fs.copyFileSync(path.join(forged, filesOf(forged)[0]), path.join(dir, filesOf(dir)[0]));
  assert.equal(verifyAuditDir(dir, KEY).ok, false, 'it does not verify under the real key');
  // and with no key at all (an unkeyed trail) the anchor still catches a different history of the same length
  const dirA = tmp(t);
  const a = new AuditStore({ dir: dirA });
  fill(a, 12);
  a.close();
  const dirB = tmp(t);
  const b = new AuditStore({ dir: dirB });
  for (let i = 0; i < 12; i++) b.append({ kind: 'grant', actor: 'user', action: `other_${i}` });
  b.close();
  fs.copyFileSync(path.join(dirB, filesOf(dirB)[0]), path.join(dirA, filesOf(dirA)[0]));
  assert.equal(verifyAuditDir(dirA).reason, 'anchor-mismatch');
});

test('ROLLBACK: restoring an older head.json together with a truncated log is caught by the second, protected anchor', (t) => {
  const dir = tmp(t);
  const second = vaultAnchor();
  const s = new AuditStore({ dir, key: KEY, anchor: second });
  fill(s, ANCHOR_EVERY);                                    // anchor refreshed here
  const oldHead = fs.readFileSync(path.join(dir, 'head.json'), 'utf8');
  const oldSeq = JSON.parse(oldHead).seq;
  fill(s, ANCHOR_EVERY * 2);
  s.close();
  // the editor truncates the log back to where the OLD anchor vouched and restores the old head.json
  const f = path.join(dir, filesOf(dir)[0]);
  fs.writeFileSync(f, readLines(dir, filesOf(dir)[0]).slice(0, oldSeq).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'head.json'), oldHead);
  assert.equal(verifyAuditDir(dir, KEY).ok, true, 'the folder alone cannot tell: this is the limit of a file-only anchor');
  const v = verifyAuditDir(dir, KEY, [second]);
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'truncated', 'the anchor kept out of the folder remembers more');
});

test('DELETING head.json does not hide a truncation when the protected anchor exists', (t) => {
  const dir = tmp(t);
  const second = vaultAnchor();
  const s = new AuditStore({ dir, key: KEY, anchor: second });
  fill(s, 15);
  s.close();
  fs.rmSync(path.join(dir, 'head.json'));
  fs.writeFileSync(path.join(dir, filesOf(dir)[0]), readLines(dir, filesOf(dir)[0]).slice(0, 5).join('\n') + '\n');
  assert.equal(verifyAuditDir(dir, KEY, [second]).reason, 'truncated');
  assert.equal(verifyAuditDir(dir, KEY).ok, true, 'with no anchor anywhere there is nothing to compare against');
  assert.equal(verifyAuditDir(dir, KEY).anchored, false, 'and the result says so rather than claiming it was checked');
});

test('THE WINDOW: at most the newest ANCHOR_EVERY records are not yet vouched for, and a pause or close closes it', (t) => {
  const dir = tmp(t);
  const s = new AuditStore({ dir, key: KEY });
  fill(s, ANCHOR_EVERY + 4);                               // anchor covers the first ANCHOR_EVERY, 4 are in the window
  const lines = readLines(dir, filesOf(dir)[0]);
  fs.writeFileSync(path.join(dir, filesOf(dir)[0]), lines.slice(0, lines.length - 4).join('\n') + '\n');
  assert.equal(verifyAuditDir(dir, KEY).ok, true, 'cutting only what the anchor has not seen yet is undetectable: the documented limit');
  s.close();
  const t2 = tmp(t);
  const s2 = new AuditStore({ dir: t2, key: KEY });
  fill(s2, ANCHOR_EVERY + 4);
  s2.close();                                              // flushes: now everything is vouched for
  const l2 = readLines(t2, filesOf(t2)[0]);
  fs.writeFileSync(path.join(t2, filesOf(t2)[0]), l2.slice(0, l2.length - 4).join('\n') + '\n');
  assert.equal(verifyAuditDir(t2, KEY).reason, 'truncated', 'after a close nothing is in the window');
});

test('the anchor is refreshed after a quiet moment without anyone calling close', async (t) => {
  const dir = tmp(t);
  const s = new AuditStore({ dir, key: KEY });
  fill(s, 3);
  assert.equal(fs.existsSync(path.join(dir, 'head.json')), false, 'not written for every record');
  await new Promise((r) => setTimeout(r, 1300));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'head.json'), 'utf8')).seq, 3);
  s.close();
});

test('rotation keeps the anchor honest: after pruning, verification still passes and names the oldest record held', (t) => {
  const dir = tmp(t);
  const second = vaultAnchor();
  const s = new AuditStore({ dir, key: KEY, maxFileBytes: 1300, maxFiles: 3, anchor: second });
  fill(s, 80);
  s.close();
  const v = s.verify();
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.equal(v.anchored, true);
  const head = JSON.parse(fs.readFileSync(path.join(dir, 'head.json'), 'utf8'));
  assert.ok(head.first > 1, 'the anchor records that the front of the log was pruned');
  assert.equal(JSON.parse(second.box.v).first, head.first);
});

test('an unreadable tail starts a fresh chain AND replaces the anchor, so the next verify names the damage rather than a false truncation', (t) => {
  const dir = tmp(t);
  const a = new AuditStore({ dir, key: KEY });
  fill(a, 12);
  a.close();
  fs.appendFileSync(path.join(dir, filesOf(dir)[0]), '{"v":1,"seq":13,"at":1,"ki');
  const b = new AuditStore({ dir, key: KEY });
  b.append({ kind: 'grant', actor: 'user', action: 'read' });
  b.close();
  const v = verifyAuditDir(dir, KEY);
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'malformed', 'the damaged file, not "truncated"');
});
