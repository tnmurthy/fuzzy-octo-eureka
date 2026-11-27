'use strict';
// Hidden grader: copied in after the agent finishes.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { resolveSafe } = require('./files');
const ROOT = path.resolve('/srv/data');
const code = (fn) => { try { fn(); return 'none'; } catch (e) { return e.code; } };

test('paths inside root resolve', () => {
  assert.equal(resolveSafe(ROOT, 'a/b.txt'), path.join(ROOT, 'a/b.txt'));
  assert.equal(resolveSafe(ROOT, 'a/../b.txt'), path.join(ROOT, 'b.txt'));
  assert.equal(resolveSafe(ROOT, ''), ROOT);
  assert.equal(resolveSafe(ROOT, path.join(ROOT, 'x')), path.join(ROOT, 'x'));
});
test('escapes are EOUTSIDE', () => {
  for (const p of ['../etc/passwd', 'a/../../x', '/etc/passwd', '../data-old/secret', '..']) {
    assert.equal(code(() => resolveSafe(ROOT, p)), 'EOUTSIDE', p);
  }
});
test('bad input is EBADPATH', () => {
  assert.equal(code(() => resolveSafe(ROOT, 'a\0b')), 'EBADPATH');
  assert.equal(code(() => resolveSafe(ROOT, null)), 'EBADPATH');
  assert.equal(code(() => resolveSafe(ROOT, 42)), 'EBADPATH');
});
