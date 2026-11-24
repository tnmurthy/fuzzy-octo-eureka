'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { limitOf } = require('./claude-limit');

test('limitOf: usage, rate and credit limits on an error result', () => {
  assert.equal(limitOf({ is_error: true, result: "You've hit your 5-hour limit · resets 12:30pm (Asia/Calcutta)" }),
    "You've hit your 5-hour limit · resets 12:30pm (Asia/Calcutta)");
  assert.ok(limitOf({ is_error: true, result: 'Claude AI usage limit reached|1764000000' }));
  assert.ok(limitOf({ is_error: true, result: 'API Error: 429 rate_limit_error' }));
  assert.ok(limitOf({ is_error: true, result: 'Credit balance is too low' }));
  assert.ok(limitOf({ subtype: 'error_during_execution', result: "You've hit your weekly limit" }));
});

test('limitOf: other failures and successful answers are not limits', () => {
  assert.equal(limitOf({ is_error: true, subtype: 'error_max_turns', result: '' }), null);
  assert.equal(limitOf({ is_error: false, result: 'I added a rate limit to the login route' }), null);
  assert.equal(limitOf(null), null);
  assert.equal(limitOf('x'), null);
});
