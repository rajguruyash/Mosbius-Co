'use strict';

/**
 * PKCE (S256) and the single-use values around it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const loadTs = require('./load-ts.cjs');

const { newCodeVerifier, challengeS256, verifyS256, newState, constantTimeEqual, fingerprint } = loadTs('src/main/oauth/pkce.ts');

test('RFC 7636 appendix B: the published verifier produces the published challenge', () => {
  assert.equal(
    challengeS256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'),
    'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
  );
});

test('a verifier is 43 characters of the unreserved set and its challenge verifies', () => {
  for (let i = 0; i < 200; i++) {
    const v = newCodeVerifier();
    assert.match(v, /^[A-Za-z0-9\-._~]{43}$/);
    const c = challengeS256(v);
    assert.match(c, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(verifyS256(v, c), true);
  }
});

test('verifiers and states are never repeated', () => {
  const verifiers = new Set();
  const states = new Set();
  for (let i = 0; i < 5000; i++) { verifiers.add(newCodeVerifier()); states.add(newState()); }
  assert.equal(verifiers.size, 5000);
  assert.equal(states.size, 5000);
  assert.match(newState(), /^[A-Za-z0-9_-]{43}$/, '256 bits, base64url');
});

test('the challenge is S256 of the verifier, not the verifier and not a different hash', () => {
  const v = newCodeVerifier();
  const c = challengeS256(v);
  assert.notEqual(c, v, '"plain" would send the verifier itself');
  assert.equal(c, crypto.createHash('sha256').update(v, 'ascii').digest().toString('base64url'));
  assert.notEqual(c, crypto.createHash('sha512').update(v, 'ascii').digest().toString('base64url').slice(0, 43));
});

test('PKCE MISMATCH: a challenge made from another verifier does not verify', () => {
  const a = newCodeVerifier();
  const b = newCodeVerifier();
  assert.equal(verifyS256(a, challengeS256(b)), false);
  // one character different anywhere
  const c = challengeS256(a);
  for (let i = 0; i < c.length; i++) {
    const flipped = c.slice(0, i) + (c[i] === 'A' ? 'B' : 'A') + c.slice(i + 1);
    assert.equal(verifyS256(a, flipped), false, `position ${i}`);
  }
});

test('anything malformed fails verification and never throws', () => {
  const v = newCodeVerifier();
  const c = challengeS256(v);
  for (const bad of [undefined, null, 5, {}, [], '', 'short', 'x'.repeat(42), 'x'.repeat(129), 'has space ' + 'x'.repeat(40), 'x'.repeat(43) + '\n']) {
    assert.equal(verifyS256(bad, c), false, JSON.stringify(bad));
    assert.equal(verifyS256(v, bad), false, JSON.stringify(bad));
  }
  assert.throws(() => challengeS256('short'), /invalid code_verifier/);
});

test('constantTimeEqual: equal only for equal strings, whatever their length', () => {
  assert.equal(constantTimeEqual('abc', 'abc'), true);
  assert.equal(constantTimeEqual('abc', 'abd'), false);
  assert.equal(constantTimeEqual('abc', 'abcd'), false);
  assert.equal(constantTimeEqual('', ''), true);
  assert.equal(constantTimeEqual('', 'a'), false);
});

test('a fingerprint remembers a value without keeping it', () => {
  const code = '4/0AVeryRealLookingAuthorizationCode';
  const fp = fingerprint(code);
  assert.equal(fp.includes(code), false);
  assert.match(fp, /^[0-9a-f]{32}$/);
  assert.equal(fingerprint(code), fp);
  assert.notEqual(fingerprint(code + 'x'), fp);
});
