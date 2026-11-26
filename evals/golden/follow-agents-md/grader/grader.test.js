'use strict';
// Hidden grader: copied in after the agent finishes.
const test = require('node:test');
const assert = require('node:assert/strict');
const { addGst, formatINR } = require('./money');

test('integer paise in, integer paise out, rounded half up', () => {
  assert.equal(addGst(10000, 18), 11800);
  assert.equal(addGst(99, 18), 117); // 17.82 -> 18
  assert.equal(addGst(25, 2), 26);   // 0.5 -> 1
  assert.equal(addGst(0, 18), 0);
  assert.ok(Number.isInteger(addGst(12345, 12.5)));
});
test('bad input throws TypeError', () => {
  for (const a of [10.5, -1, '100', NaN]) assert.throws(() => addGst(a, 18), TypeError, String(a));
  for (const r of [-1, NaN, Infinity, '18']) assert.throws(() => addGst(100, r), TypeError, String(r));
});
test('existing helpers still exported', () => {
  assert.equal(formatINR(11800), '₹118.00');
});
