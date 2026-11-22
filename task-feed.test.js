// node --test task-feed.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { stageOf, myTasks, snapshotOf, diffEvents, carryRunning } = require('./task-feed');

const NOW = Date.parse('2026-11-22T10:00:00Z');
const run = (id, over = {}) => ({ id, status: 'done', task: `task ${id}`, started_at: '2026-11-22T09:00:00Z', ...over });

test('stageOf maps runs to plain-language stages', () => {
  assert.equal(stageOf(run('a', { status: 'running' })).key, 'working');
  assert.equal(stageOf(run('a', { status: 'running' }), [{ runId: 'a', tool: 'Bash' }]).key, 'needs-you');
  assert.equal(stageOf(run('a', { status: 'running' }), [{ runId: 'b', tool: 'Bash' }]).key, 'working');
  assert.equal(stageOf(run('a', { status: 'failed' })).key, 'failed');
  assert.equal(stageOf(run('a', { commits_ahead: 2 })).key, 'review');
  assert.equal(stageOf(run('a')).key, 'done');
  assert.match(stageOf(run('a', { canFollowUp: true })).next, /follow up/);
});

test('myTasks puts needs-you first, then newest, drops runs older than the window', () => {
  const list = myTasks({
    running: [run('r1', { status: 'running', started_at: '2026-11-22T08:00:00Z' }), run('r2', { status: 'running', started_at: '2026-11-22T09:30:00Z' })],
    recent: [run('d1', { started_at: '2026-11-22T09:45:00Z' }), run('old', { started_at: '2026-11-20T09:00:00Z' }), run('r1')],
    approvals: [{ id: 'p', runId: 'r1', tool: 'Bash' }],
    now: NOW,
  });
  assert.deepEqual(list.map((t) => t.run.id), ['r1', 'd1', 'r2']);
  assert.equal(list[0].stage.key, 'needs-you');
});

test('myTasks honours limit', () => {
  const recent = Array.from({ length: 12 }, (_, i) => run(`x${i}`));
  assert.equal(myTasks({ recent, now: NOW, limit: 5 }).length, 5);
});

test('diffEvents announces nothing on first look', () => {
  assert.deepEqual(diffEvents(null, { recent: [run('a')] }), []);
});

test('diffEvents reports finished, failed and follow-up runs', () => {
  const prev = { running: ['a', 'b', 'c'], approvals: [] };
  const ev = diffEvents(prev, {
    running: [],
    recent: [run('a', { commits_ahead: 3 }), run('b', { status: 'failed' }), run('c', { parent: 'a' })],
  });
  assert.deepEqual(ev.map((e) => e.kind), ['done', 'failed', 'followup-done']);
  assert.match(ev[0].body, /3 change\(s\) ready to review/);
  assert.equal(ev[2].title, 'Follow-up finished');
});

test('diffEvents waits when a finished run is not in recent yet', () => {
  assert.deepEqual(diffEvents({ running: ['a'], approvals: [] }, { running: [], recent: [] }), []);
});

test('diffEvents reports each new approval once', () => {
  const approvals = [{ id: 'p1', runId: 'a', tool: 'Bash', repo: 'r', summary: 'npm test' }];
  const first = diffEvents({ running: ['a'], approvals: [] }, { running: [run('a', { status: 'running' })], approvals });
  assert.deepEqual(first.map((e) => e.kind), ['approval']);
  assert.match(first[0].body, /Bash in r: npm test/);
  const again = diffEvents(snapshotOf({ running: [run('a')], approvals }), { running: [run('a', { status: 'running' })], approvals });
  assert.deepEqual(again, []);
});

test('carryRunning keeps unresolved ids and drops resolved ones', () => {
  const kept = carryRunning({ running: ['a', 'b'] }, { running: [run('c')], recent: [run('a')] });
  assert.deepEqual(kept.sort(), ['b', 'c']);
});

test('myTasks shows queued issues first among non-urgent tasks', () => {
  const list = myTasks({ recent: [run('d1')], queued: [{ number: 7, title: 'Fix login', repo: 'o/r', url: 'u' }], now: NOW });
  assert.deepEqual(list.map((x) => x.stage.key), ['queued', 'done']);
  assert.equal(list[0].issue.number, 7);
});
