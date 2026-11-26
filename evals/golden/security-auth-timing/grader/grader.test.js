'use strict';
// Hidden grader: copied in after the agent finishes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { verifySignature } = require('./verify');

const SECRET = 'k3y';
const sign = (p) => crypto.createHmac('sha256', SECRET).update(p).digest('hex');

test('accepts the right signature, rejects a wrong one', () => {
  assert.equal(verifySignature('hello', sign('hello'), SECRET), true);
  assert.equal(verifySignature('hello', sign('hellp'), SECRET), false);
});

test('wrong length, bad hex or a non-string is false, not a throw', () => {
  assert.equal(verifySignature('hello', sign('hello').slice(0, 10), SECRET), false);
  assert.equal(verifySignature('hello', '', SECRET), false);
  assert.equal(verifySignature('hello', 'zz'.repeat(32), SECRET), false);
  assert.equal(verifySignature('hello', undefined, SECRET), false);
  assert.equal(verifySignature('hello', 12345, SECRET), false);
  assert.equal(verifySignature('hello', { length: 64 }, SECRET), false);
});

test('compares with crypto.timingSafeEqual', () => {
  const src = fs.readFileSync(path.join(__dirname, 'verify.js'), 'utf8');
  assert.match(src, /timingSafeEqual/);
  assert.doesNotMatch(src, /expected\s*===?\s*signature|signature\s*===?\s*expected/);
});
