'use strict';
// Hidden grader: copied in after the agent finishes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const users = require('./users');
const { handle } = require('./api');
const { names } = require('./report');

test('getUser exists, getUsr is the same function', () => {
  assert.equal(typeof users.getUser, 'function');
  assert.equal(users.getUsr, users.getUser);
  assert.deepEqual(users.getUser(1), { id: 1, name: 'Asha' });
});
test('callers use getUser, behaviour unchanged', () => {
  for (const f of ['api.js', 'report.js']) {
    const src = fs.readFileSync(f, 'utf8');
    assert.match(src, /getUser\b/, f);
    assert.doesNotMatch(src, /getUsr\b/, f);
  }
  assert.deepEqual(handle(2), { status: 200, body: { id: 2, name: 'Ravi' } });
  assert.equal(handle(9).status, 404);
  assert.equal(names([1, 9, 2]), 'Asha, Ravi');
});
