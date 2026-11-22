'use strict';

/**
 * How the app's sounds share one pair of speakers (src/shared/soundPolicy.ts): who outranks whom, that two sounds
 * never play over each other, that a burst of the same event rings once, that a routine cue gives way to everything,
 * that a preview always sounds, and that the volume slider's curve is monotonic.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { SoundGate, SOUND_META, volumeToGain } = loadTs('src/shared/soundPolicy.ts');
const { SOUND_KINDS } = loadTs('src/shared/notifications.ts');

test('every sound has a place in the order: the more a person is needed, the higher it ranks, and only the start sound is routine', () => {
  assert.deepEqual(Object.keys(SOUND_META).sort(), [...SOUND_KINDS].sort());
  const order = ['critical', 'intervention', 'access', 'approval', 'input', 'completed', 'started', 'signature'];
  for (let i = 1; i < order.length; i++) assert.ok(SOUND_META[order[i - 1]].priority > SOUND_META[order[i]].priority, `${order[i - 1]} outranks ${order[i]}`);
  assert.deepEqual(SOUND_KINDS.filter((k) => SOUND_META[k].routine), ['started']);
  for (const k of SOUND_KINDS) assert.ok(SOUND_META[k].ms > 0 && SOUND_META[k].cooldownMs >= 0, k);
});

test('the speakers are free at first, and a cue holds them for its own length', () => {
  const g = new SoundGate();
  assert.deepEqual(g.request('approval', 1000), { verdict: 'play', interrupt: false });
  const end = 1000 + SOUND_META.approval.ms;
  assert.deepEqual(g.request('input', end - 1), { verdict: 'dropped', why: 'busy' }, 'still sounding, and lower');
  assert.deepEqual(g.request('input', end), { verdict: 'play', interrupt: false }, 'ended: anything may play, and nothing is interrupted');
});

test('the same cue twice in a breath is one cue; after its cooldown it rings again', () => {
  const g = new SoundGate();
  assert.equal(g.request('approval', 0).verdict, 'play');
  assert.deepEqual(g.request('approval', 500), { verdict: 'dropped', why: 'repeat' });
  assert.equal(g.request('approval', SOUND_META.approval.cooldownMs + 100).verdict, 'play');
});

test('a lower or equal cue never rings over one that is sounding, and a higher one takes over at once', () => {
  const g = new SoundGate();
  assert.equal(g.request('input', 0).verdict, 'play');
  assert.deepEqual(g.request('completed', 100), { verdict: 'dropped', why: 'busy' }, 'lower');
  assert.deepEqual(g.request('approval', 300), { verdict: 'play', interrupt: true }, 'higher takes over');
  assert.deepEqual(g.request('access', 400), { verdict: 'play', interrupt: true }, 'and higher still takes over from that');
  assert.deepEqual(g.request('completed', 500), { verdict: 'dropped', why: 'busy' });
  assert.deepEqual(g.request('critical', 600), { verdict: 'play', interrupt: true });
  assert.deepEqual(g.request('intervention', 700), { verdict: 'dropped', why: 'busy' }, 'a crash is not talked over by anything else');
});

test('a burst of the same event rings once; something that needs a person in the middle of it takes over', () => {
  const g = new SoundGate();
  const verdicts = [0, 100, 200, 300, 400].map((t) => g.request('completed', t).verdict);
  assert.deepEqual(verdicts, ['play', 'dropped', 'dropped', 'dropped', 'dropped'], 'five agents finishing together ring once');
  assert.deepEqual(g.request('approval', 500), { verdict: 'play', interrupt: true });
});

test('a routine cue gives way: dropped while anything sounds and for a moment after, never taking over, and rare', () => {
  const g = new SoundGate();
  g.request('completed', 0);                                   // sounds until 1200
  assert.deepEqual(g.request('started', 100), { verdict: 'dropped', why: 'routine' });
  assert.deepEqual(g.request('started', SOUND_META.completed.ms + 100), { verdict: 'dropped', why: 'routine' }, 'right after another sound');
  assert.deepEqual(g.request('started', SOUND_META.completed.ms + 1600), { verdict: 'play', interrupt: false }, 'after a quiet moment');
  // a real notification takes over from it
  assert.deepEqual(g.request('input', SOUND_META.completed.ms + 1700), { verdict: 'play', interrupt: true });
  assert.deepEqual(g.request('started', SOUND_META.completed.ms + 3000), { verdict: 'dropped', why: 'repeat' }, 'and the start cue is not heard again for a while');
  // and a routine cue never takes over from anything, however long ago the last one was
  const h = new SoundGate();
  h.request('signature', 0);
  assert.deepEqual(h.request('started', 10), { verdict: 'dropped', why: 'routine' });
});

test('a sound that could not be played does not hold the speakers or count as a repeat', () => {
  const g = new SoundGate();
  assert.equal(g.request('approval', 0).verdict, 'play');
  g.abort('approval');
  assert.deepEqual(g.request('approval', 10), { verdict: 'play', interrupt: false });
});

test('a preview always sounds, takes over from whatever is sounding, and then holds the speakers like any other sound', () => {
  const g = new SoundGate();
  assert.deepEqual(g.preview('signature', 0), { interrupt: false });
  assert.deepEqual(g.preview('signature', 100), { interrupt: true }, 'the same one again, at once');
  assert.deepEqual(g.preview('input', 150), { interrupt: true }, 'another one: that one plays');
  assert.deepEqual(g.preview('critical', 5000), { interrupt: false }, 'once the last one is over');
  assert.deepEqual(g.request('completed', 5100), { verdict: 'dropped', why: 'busy' }, 'a notification of a lower rank waits its turn out');
});

test('the volume slider is a gentle curve: zero is silence, full is full, and it only ever goes up', () => {
  assert.equal(volumeToGain(0), 0);
  assert.equal(volumeToGain(1), 1);
  assert.equal(volumeToGain(0.5), 0.25);
  assert.equal(volumeToGain(-3), 0);
  assert.equal(volumeToGain(7), 1);
  assert.equal(volumeToGain(Number.NaN), 0);
  let last = -1;
  for (let v = 0; v <= 1.0001; v += 0.05) { const g = volumeToGain(v); assert.ok(g > last || v === 0, `monotonic at ${v}`); last = g; }
});

test('a stand-in longer than the app\'s own sound for that cue (a person\'s own file, or the one that ships) holds the speakers for its real length, and the pause after it stays as long as it was', () => {
  const g = new SoundGate();
  assert.equal(g.request('completed', 0, 7000).verdict, 'play');
  assert.deepEqual(g.request('started', 3400), { verdict: 'dropped', why: 'routine' }, 'the app\'s own would be over by now; this one is not');
  assert.deepEqual(g.request('completed', 6500), { verdict: 'dropped', why: 'repeat' }, 'the same news while it is still sounding');
  assert.deepEqual(g.request('completed', 9000), { verdict: 'dropped', why: 'repeat' }, 'and after it has ended: the pause is the cue\'s own six seconds plus how much longer the stand-in is (3.65 s)');
  assert.equal(g.request('completed', 9700, 7000).verdict, 'play', '9.65 s after it began');
  assert.deepEqual(g.preview('input', 9800, 5000), { interrupt: true }, 'a preview of a long one is held for as long, and takes over from what sounds');
  assert.deepEqual(g.request('completed', 30_000, 7000).verdict, 'play');
});

test('a stand-in that is as long as the app\'s own, or shorter, changes nothing: the cooldown is the cue\'s own', () => {
  for (const ms of [undefined, SOUND_META.completed.ms, 900]) {
    const g = new SoundGate();
    assert.equal(g.request('completed', 0, ms).verdict, 'play');
    assert.deepEqual(g.request('completed', SOUND_META.completed.cooldownMs - 1), { verdict: 'dropped', why: 'repeat' }, `${ms}: inside six seconds`);
    assert.equal(g.request('completed', SOUND_META.completed.cooldownMs, ms).verdict, 'play', `${ms}: at six seconds`);
  }
});
