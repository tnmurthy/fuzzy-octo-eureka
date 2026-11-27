'use strict';
// Hidden grader: copied in after the agent finishes.
const test = require('node:test');
const assert = require('node:assert/strict');
const { hasPairWithSum } = require('./pairs');

test('finds pairs at different positions', () => {
  assert.equal(hasPairWithSum([1, 4, 6, 9], 10), true);
  assert.equal(hasPairWithSum([5, 5], 10), true);
  assert.equal(hasPairWithSum([-3, 8, 2], 5), true);
});

test('does not pair a number with itself', () => {
  assert.equal(hasPairWithSum([5], 10), false);
  assert.equal(hasPairWithSum([1, 5, 2], 10), false);
  assert.equal(hasPairWithSum([], 0), false);
});

test('does not change the input array', () => {
  const nums = [9, 1, 7, 3];
  hasPairWithSum(nums, 100);
  assert.deepEqual(nums, [9, 1, 7, 3]);
});

test('runs in linear time on 100k numbers', { timeout: 30000 }, () => {
  const nums = Array.from({ length: 100000 }, (_, i) => i * 2);
  const t0 = Date.now();
  assert.equal(hasPairWithSum(nums, -1), false);
  assert.ok(Date.now() - t0 < 200, 'took ' + (Date.now() - t0) + ' ms');
});
