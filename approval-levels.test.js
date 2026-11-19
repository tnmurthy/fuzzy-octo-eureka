// node --test approval-levels.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { LEVELS, toolsFor, parseLevel, effectiveLevel } = require('./approval-levels');

test('a review reads by exact tool name only: no shell, no edits, never asks', () => {
  const t = toolsFor('review');
  assert.equal(t.allowed, 'Read Glob Grep');
  for (const denied of ['Edit', 'Write', 'NotebookEdit', 'Bash', 'WebFetch', 'WebSearch']) {
    assert.ok(t.denied.split(' ').includes(denied), denied);
  }
  assert.equal(t.asks, false);
  assert.ok(!/Bash\(/.test(t.allowed), 'no shell pattern is pre-allowed');
});

test('push and gh are denied at every level', () => {
  for (const level of LEVELS) {
    const t = toolsFor(level);
    assert.ok(t.denied.includes('Bash(git push:*)'), level);
    assert.ok(t.denied.includes('Bash(gh:*)'), level);
  }
});

test('levels grow in what they pre-allow', () => {
  assert.equal(toolsFor('ask').permissionMode, 'default');
  assert.ok(!toolsFor('ask').allowed.includes('Edit'));
  assert.ok(toolsFor('edits').allowed.includes('Edit'));
  assert.ok(!toolsFor('edits').allowed.includes('Bash'));
  assert.ok(toolsFor('auto', { scriptsDir: '/x' }).allowed.includes('Bash(/x/db-lock.sh:*)'));
});

test('there is no full-access level', () => {
  assert.equal(parseLevel('full'), null);
  assert.throws(() => toolsFor('full'));
});

test('a review is always review, whatever was asked', () => {
  assert.equal(effectiveLevel({ requested: 'auto', readOnly: true }), 'review');
});

test('a level only flows down: a follow-up never gets more than its parent', () => {
  assert.equal(effectiveLevel({ requested: 'auto', parentLevel: 'edits' }), 'edits');
  assert.equal(effectiveLevel({ requested: 'ask', parentLevel: 'auto' }), 'ask');
  assert.equal(effectiveLevel({ requested: 'auto', parentLevel: 'review' }), 'ask');
});

test('unknown or missing levels fall back to auto (today\'s behaviour)', () => {
  assert.equal(effectiveLevel({ requested: 'everything' }), 'auto');
  assert.equal(effectiveLevel({}), 'auto');
  assert.equal(effectiveLevel({ requested: undefined, fallback: 'ask' }), 'ask');
});
