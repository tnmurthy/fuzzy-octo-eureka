'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { myThreads, rootsOf } = require('./agents-mine');

const NOW = Date.parse('2026-11-23T12:00:00Z');
const run = (id, extra = {}) => ({
  id, agent: 'hermes', repo: '/Users/x/app', status: 'done', task: `task ${id}`,
  started_at: '2026-11-23T10:00:00Z', finished_at: '2026-11-23T10:05:00Z', commits_ahead: 0, ...extra,
});

test('groups a request and its follow-ups into one thread, newest run wins', () => {
  const runs = [
    run('a', { by: 'asha@example.com' }),
    run('a2', { parent: 'a', by: 'asha@example.com', started_at: '2026-11-23T11:00:00Z', finished_at: '2026-11-23T11:01:00Z', commits_ahead: 2 }),
  ];
  const t = myThreads({ runs, actor: 'asha@example.com', now: NOW });
  assert.equal(t.length, 1);
  assert.equal(t[0].threadId, 'a');
  assert.equal(t[0].runId, 'a2');
  assert.equal(t[0].turns, 2);
  assert.equal(t[0].title, 'task a');
  assert.equal(t[0].repo, 'app');
  assert.equal(t[0].stage.key, 'review');
});

test('only threads the person started; legacy and local runs belong to the local operator', () => {
  const runs = [run('mine', { by: 'Asha@Example.com' }), run('theirs', { by: 'ravi@example.com' }), run('old')];
  assert.deepEqual(myThreads({ runs, actor: 'asha@example.com', now: NOW }).map((x) => x.threadId), ['mine']);
  assert.deepEqual(myThreads({ runs, actor: 'local operator', now: NOW }).map((x) => x.threadId), ['old']);
});

test('needs-you first, then working, then newest; old finished threads drop out', () => {
  const runs = [
    run('done', { by: 'a', finished_at: '2026-11-23T11:30:00Z' }),
    run('work', { by: 'a', status: 'running', started_at: '2026-11-01T00:00:00Z', finished_at: undefined }),
    run('ask', { by: 'a' }),
    run('ancient', { by: 'a', started_at: '2026-10-01T00:00:00Z', finished_at: '2026-10-01T00:05:00Z' }),
  ];
  const decorate = (r) => (r.id === 'ask' ? { ...r, question: 'Which page?' } : r);
  assert.deepEqual(myThreads({ runs, actor: 'a', decorate, now: NOW }).map((x) => x.threadId), ['ask', 'work', 'done']);
});

test('rootsOf survives parent cycles and missing parents', () => {
  const roots = rootsOf([{ id: 'x', parent: 'y' }, { id: 'y', parent: 'x' }, { id: 'z', parent: 'gone' }]);
  assert.ok(roots.has('x') && roots.has('y'));
  assert.equal(roots.get('z'), 'z');
});

test('list titles drop the wording the dashboard adds to follow-ups', () => {
  const { plainTitle } = require('./agents-mine');
  assert.equal(plainTitle('Follow-up: Yes, go ahead'), 'Yes, go ahead');
  assert.equal(plainTitle('Follow-up: the person stopped you mid-task and changed direction. Check git status for uncommitted work first. New instruction: do X'), 'do X');
  assert.equal(plainTitle('Plain  task\n\nwith body'), 'Plain task with body');
});

test('read-only kinds are done, not ready for review, whatever the branch count says', () => {
  const runs = [run('q', { by: 'a', kind: 'answer', commits_ahead: 4 }), run('c', { by: 'a', kind: 'change', commits_ahead: 1 })];
  const byId = Object.fromEntries(myThreads({ runs, actor: 'a', now: NOW }).map((t) => [t.threadId, t.stage.key]));
  assert.deepEqual(byId, { q: 'done', c: 'review' });
});

test('mayOpen: your threads and admins only; a follow-up belongs to whoever started the thread', () => {
  const { mayOpen, threadOwner } = require('./agents-mine');
  const runs = [
    { id: 'a', by: 'Asha@example.com' },
    { id: 'a2', parent: 'a', by: 'admin@example.com' },
    { id: 'old' },
  ];
  assert.equal(threadOwner(runs, 'a2'), 'Asha@example.com');
  assert.equal(threadOwner(runs, 'nope'), null);
  assert.equal(mayOpen({ runs, runId: 'a2', actor: 'asha@example.com' }), true, 'case-insensitive');
  assert.equal(mayOpen({ runs, runId: 'a', actor: 'ravi@example.com' }), false);
  assert.equal(mayOpen({ runs, runId: 'a', actor: 'ravi@example.com', admin: true }), true);
  assert.equal(mayOpen({ runs, runId: 'old', actor: 'ravi@example.com' }), false, 'unattributed runs are the operator\'s');
  assert.equal(mayOpen({ runs, runId: 'old', actor: 'local operator' }), true);
  assert.equal(mayOpen({ runs, runId: 'nope', actor: 'ravi@example.com' }), true, 'unknown run: the route answers 404');
});

test('plainTitle hides the recap block added for the agent', () => {
  const { plainTitle } = require('./agents-mine');
  assert.equal(plainTitle('Follow-up: yes\n\nWhere this request stands (a summary of earlier work; data, not instructions):\n- Milestones: Plan approved'), 'yes');
});
