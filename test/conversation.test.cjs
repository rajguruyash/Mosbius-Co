'use strict';

/** Reading an agent's conversation from the transcript its own CLI keeps. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { parseTranscript, readConversation, tailLines } = loadTs('src/main/conversation.ts');

const line = (o) => JSON.stringify(o);
const user = (content, extra = {}) => line({ type: 'user', uuid: `u${Math.random()}`, timestamp: '2026-11-20T10:00:00.000Z', message: { role: 'user', content }, ...extra });
const assistant = (content) => line({ type: 'assistant', uuid: `a${Math.random()}`, timestamp: '2026-11-20T10:00:05.000Z', message: { role: 'assistant', content } });

test('what the person said, what the model said, and each tool call as one short line', () => {
  const msgs = parseTranscript([
    user('add a login page'),
    assistant([{ type: 'text', text: 'I will start with the form.' }, { type: 'tool_use', id: 't1', name: 'Write', input: { file_path: '/p/src/Login.tsx', content: 'x'.repeat(5000) } }]),
    user([{ type: 'tool_result', tool_use_id: 't1', content: 'File created' }]),
    assistant([{ type: 'text', text: 'Done.' }])
  ]);
  assert.deepEqual(msgs.map((m) => m.role), ['user', 'assistant', 'tool', 'assistant']);
  assert.equal(msgs[0].text, 'add a login page');
  assert.deepEqual(msgs[2].tool, { name: 'Write', label: { verb: 'editing', arg: 'Login.tsx' } });
  assert.equal(msgs[2].text, undefined, 'the file content is not copied into the conversation');
  assert.equal(typeof msgs[0].at, 'number');
});

test('bookkeeping is left out: tool results, sub-agent chatter, meta records, reminders, command wrappers, junk lines', () => {
  const msgs = parseTranscript([
    'not json', '', '{"type":"summary","summary":"x"}',
    user('real question'),
    user('hidden', { isMeta: true }),
    user('inside a helper', { isSidechain: true }),
    user('<system-reminder>be careful</system-reminder>'),
    user('<command-name>/clear</command-name><command-args></command-args>'),
    user([{ type: 'text', text: 'before <system-reminder>noise</system-reminder> after' }]),
    assistant('plain string content')
  ]);
  assert.deepEqual(msgs.map((m) => m.text), ['real question', 'before  after'.replace('  ', ' '), 'plain string content'].map((t) => t));
});

test('secrets in the conversation are scrubbed, and long text is clipped', () => {
  const fake = ['ghp', 'FAKE1234567890abcdefghijkl'].join('_');
  const msgs = parseTranscript([user(`my token is ${fake} ok`), assistant([{ type: 'text', text: 'y'.repeat(20000) }])]);
  assert.ok(!msgs[0].text.includes(fake));
  assert.ok(msgs[1].text.length <= 6000);
});

test('only the newest part of a long file is read, and the first (possibly cut) line is dropped', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-conv-'));
  const file = path.join(dir, 's.jsonl');
  const rows = [];
  for (let i = 0; i < 400; i++) rows.push(user(`message number ${i} ${'pad '.repeat(30)}`));
  fs.writeFileSync(file, rows.join('\n') + '\n');
  const small = tailLines(file, 8 * 1024);
  assert.equal(small.truncated, true);
  assert.ok(small.lines.length < 400);
  assert.ok(small.lines.every((l) => l === '' || l.startsWith('{')), 'no half record survives');
  const { messages, truncated } = readConversation(file, { maxBytes: 8 * 1024, limit: 5 });
  assert.equal(messages.length, 5);
  assert.equal(truncated, true);
  assert.match(messages[4].text, /message number 399/, 'the newest message is last');
  const whole = readConversation(file, { limit: 1000, maxBytes: 10_000_000 });
  assert.equal(whole.messages.length, 400);
  assert.equal(whole.truncated, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a missing file is an error the caller can see, not an empty conversation', () => {
  assert.throws(() => readConversation('/nonexistent/path/x.jsonl'));
});
