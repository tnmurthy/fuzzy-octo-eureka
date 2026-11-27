'use strict';
// Hidden grader: copied in after the agent finishes.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createLimiter } = require('./limiter');

test('allows up to limit in a window, then denies', () => {
  let t = 0;
  const l = createLimiter({ limit: 2, windowMs: 1000, now: () => t });
  assert.equal(l.allow('a'), true);
  assert.equal(l.allow('a'), true);
  assert.equal(l.allow('a'), false);
  t = 999;
  assert.equal(l.allow('a'), false);
  t = 1000;
  assert.equal(l.allow('a'), true, 'the first call left the window');
});
test('sliding, not fixed, window; denied calls are not counted', () => {
  let t = 0;
  const l = createLimiter({ limit: 2, windowMs: 100, now: () => t });
  l.allow('k'); t = 50; l.allow('k'); t = 60;
  for (let i = 0; i < 5; i++) assert.equal(l.allow('k'), false);
  t = 100;
  assert.equal(l.allow('k'), true);
  assert.equal(l.allow('k'), false);
});
test('keys are independent', () => {
  const l = createLimiter({ limit: 1, windowMs: 1000, now: () => 0 });
  assert.equal(l.allow('x'), true);
  assert.equal(l.allow('y'), true);
  assert.equal(l.allow('x'), false);
});
test('memory does not grow without bound', () => {
  let t = 0;
  const l = createLimiter({ limit: 3, windowMs: 10, now: () => t });
  for (let i = 0; i < 20000; i++) { t += 5; l.allow('k'); }
  const used = process.memoryUsage().heapUsed;
  assert.ok(used < 200 * 1024 * 1024);
});
