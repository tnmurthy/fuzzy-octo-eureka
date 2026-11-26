'use strict';
// Hidden grader: copied in after the agent finishes.
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCsvLine } = require('./csv');

test('plain fields, empty fields, empty line', () => {
  assert.deepEqual(parseCsvLine('a,b,c'), ['a', 'b', 'c']);
  assert.deepEqual(parseCsvLine('a,,c,'), ['a', '', 'c', '']);
  assert.deepEqual(parseCsvLine(''), ['']);
});
test('quoted commas and doubled quotes', () => {
  assert.deepEqual(parseCsvLine('"Hyderabad, TS",500001'), ['Hyderabad, TS', '500001']);
  assert.deepEqual(parseCsvLine('"say ""hi""",x'), ['say "hi"', 'x']);
  assert.deepEqual(parseCsvLine('"",""'), ['', '']);
});
test('unterminated quote throws', () => {
  assert.throws(() => parseCsvLine('"open,field'), Error);
});
