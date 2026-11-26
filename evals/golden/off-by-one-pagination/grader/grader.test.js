'use strict';
// Hidden grader: copied in after the agent finishes.
const test = require('node:test');
const assert = require('node:assert/strict');
const { paginate } = require('./page');
const xs = [1, 2, 3, 4, 5, 6, 7];

test('page 1 starts at the first item', () => {
  assert.deepEqual(paginate(xs, 1, 3).items, [1, 2, 3]);
  assert.deepEqual(paginate(xs, 2, 3).items, [4, 5, 6]);
});
test('the last partial page is counted and returned', () => {
  assert.equal(paginate(xs, 1, 3).totalPages, 3);
  assert.deepEqual(paginate(xs, 3, 3).items, [7]);
  assert.equal(paginate(xs, 1, 7).totalPages, 1);
});
test('empty list has one page; past the end is empty', () => {
  assert.equal(paginate([], 1, 5).totalPages, 1);
  assert.deepEqual(paginate(xs, 9, 3).items, []);
  assert.equal(paginate(xs, 2, 3).page, 2);
});
