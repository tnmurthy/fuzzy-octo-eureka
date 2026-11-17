// node --test scripts/agents.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { formatAgents, ago } = require('./agents');

const NOW = Date.parse('2026-11-17T11:00:00Z');

const runs = [
  { id: 'r3', agent: 'claude', status: 'running', started_at: '2026-11-17T10:57:30Z', task: 'Review pull request #31 in a/b', log: '/runs/r3.log' },
  { id: 'r2', agent: 'claude', status: 'running', started_at: '2026-11-17T10:50:00Z', task: 'GitHub issue a/b#30: Docs: remove Buzz', log: '/runs/r2.log' },
  { id: 'r1', agent: 'hermes', status: 'done', started_at: '2026-11-17T09:00:00Z', duration_s: 19, commits_ahead: 1, task: 'GitHub issue a/b#12: Fix typo' },
  { id: 'r0', agent: 'claude', status: 'failed', started_at: '2026-11-17T08:00:00Z', duration_s: 3700, task: 'Something long' },
];

test('running runs show agent, age, the issue or PR they serve, and how to follow them live', () => {
  const text = formatAgents({ runs, active: { r2: { number: 30 }, r3: { kind: 'review', pr: 31 } }, cap: { used: 3, cap: 20 }, now: NOW });
  assert.match(text, /Paid agent runs today: 3 of 20\n/);
  assert.match(text, /RUNNING \(2\)/);
  assert.match(text, /claude\s+2m30s {2}review of PR #31 {2}Review pull request #31/);
  assert.match(text, /claude\s+10m00s {2}issue #30 {2}GitHub issue a\/b#30: Docs: remove Buzz/);
  assert.match(text, /live: tail -f \/runs\/r2\.log/);
});

test('finished runs list status, duration, commits and their issue', () => {
  const text = formatAgents({ runs, cap: { used: 0, cap: 20 }, now: NOW });
  assert.match(text, /RECENT \(2\)/);
  assert.match(text, /done\s+hermes\s+19s {2}1 commit\s+#12 GitHub issue/);
  assert.match(text, /failed\s+claude\s+1h01m/);
});

test('the cap line warns when paid dispatches are being refused', () => {
  const text = formatAgents({ runs: [], cap: { used: 20, cap: 20 }, now: NOW });
  assert.match(text, /20 of 20 {2}\(CAP REACHED - paid dispatches refused\)/);
  assert.match(text, /nothing running/);
});

test('durations read naturally', () => {
  assert.equal(ago(5000), '5s');
  assert.equal(ago(125000), '2m05s');
  assert.equal(ago(3 * 3600 * 1000 + 60000), '3h01m');
});
