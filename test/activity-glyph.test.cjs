'use strict';

/** The office floor's symbols for the states the main process reports: compatible with what the floor already drew. */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const G = loadTs('src/renderer/src/scene/office/activityStates.ts');
const { AGENT_STATES } = loadTs('src/shared/agentActivity.ts');

test('only the states the floor had no symbol for get a new one; the rest are left to the floor as it was', () => {
  const att = Object.fromEntries(AGENT_STATES.map((s) => [s, G.floorAttention(s)]));
  assert.deepEqual(att, { idle: null, working: null, researching: null, waiting: null, completed: null, 'needs-input': 'input', 'needs-approval': 'approval', error: 'error', paused: 'paused', stopped: null });
  assert.equal(G.floorAttention(undefined), null);
});

test('an approval keeps the red "!" the floor always used for "needs you"; the others have their own symbol', () => {
  assert.equal(G.glyphFor('approval'), 'blocked');
  assert.equal(G.glyphFor('input'), 'question');
  assert.equal(G.glyphFor('error'), 'error');
  assert.equal(G.glyphFor('paused'), 'paused');
});

test('only an agent that needs a person\'s decision walks to the door', () => {
  assert.deepEqual(['input', 'approval', 'error', 'paused', null].map(G.walksToDoor), [true, true, false, false, false]);
});

test('the map tells listeners only when something changed, and forgets agents that are gone', () => {
  let calls = 0;
  const off = G.onActivityStates(() => { calls += 1; });
  G.setActivityStates([{ id: 'a', state: 'idle' }, { id: 'b', state: 'working' }]);
  assert.equal(calls, 1);
  G.setActivityStates([{ id: 'a', state: 'idle' }, { id: 'b', state: 'working' }]);
  assert.equal(calls, 1, 'the same answer again changes nothing');
  G.setActivityStates([{ id: 'a', state: 'needs-input' }, { id: 'b', state: 'working' }]);
  assert.equal(calls, 2);
  assert.equal(G.activityStateOf('a'), 'needs-input');
  G.setActivityStates([{ id: 'b', state: 'working' }]);
  assert.equal(calls, 3);
  assert.equal(G.activityStateOf('a'), undefined);
  off();
  G.setActivityStates([]);
  assert.equal(calls, 3, 'an unsubscribed listener hears nothing');
});

test('the character can draw every symbol the floor now uses', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/src/scene/office/Character.ts'), 'utf8');
  for (const glyph of ['blocked', 'question', 'error', 'paused']) assert.match(src, new RegExp(`statusGlyph === '${glyph}'`), glyph);
  assert.match(src, /StatusGlyph = [^;]*'question'[^;]*'error'[^;]*'paused'/);
});
