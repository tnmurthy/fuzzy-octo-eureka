// node --test run-steps.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseLine, parseSteps, summary } = require('./run-steps');

const LOG = [
  '== auto: no tests',
  '12:00:00 == claude started (model sonnet)',
  "12:00:01 💬 I'll read the auth module first.",
  '12:00:02 🔧 Read /Users/me/code/app--agent-run-x/src/lib/auth.js',
  '12:00:03 🔧 Edit /Users/me/code/app--agent-run-x/src/lib/auth.js',
  '12:00:04 🔧 Bash npm test',
  '12:00:05    ↳ error: 2 tests failed',
  '12:00:06 🔧 Grep validateEmail',
  '12:00:07 🔧 mcp__arunachala_approvals__approve',
  '12:00:08 == claude finished: success · 4 turns · $0.0100',
  '== result',
].join('\n');

test('parseLine turns tool lines into plain-language steps', () => {
  assert.deepEqual(parseLine('12:00:02 🔧 Read /Users/me/code/app--agent-run-x/src/lib/auth.js'),
    { t: '12:00:02', kind: 'read', icon: '📖', text: 'Reading …/src/lib/auth.js' });
  assert.equal(parseLine('12:00:04 🔧 Bash npm test').text, 'Running npm test');
  assert.equal(parseLine('12:00:06 🔧 Grep validateEmail').kind, 'search');
  assert.equal(parseLine('12:00:05    ↳ error: boom').kind, 'error');
  assert.equal(parseLine('12:00:08 == claude finished: error_max_turns · 40 turns').text, 'Agent stopped (error max turns)');
  assert.equal(parseLine('== result'), null);
  assert.equal(parseLine('random output'), null);
});

test('parseSteps keeps order and the newest `limit`', () => {
  const all = parseSteps(LOG, Infinity);
  assert.equal(all.length, 9);
  assert.equal(all[0].text, 'Agent started');
  assert.equal(all[all.length - 1].text, 'Agent finished');
  assert.deepEqual(parseSteps(LOG, 2).map((s) => s.t), ['12:00:07', '12:00:08']);
});

test('summary counts reads, edits, commands and errors', () => {
  assert.equal(summary(LOG), '9 steps · 1 read · 1 edits · 1 commands · 1 errors');
  assert.equal(summary(''), '0 steps');
});
