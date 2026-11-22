// task-wall.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTaskWall } = require('./task-wall');

test('task wall creates tasks and enforces dependency progression', () => {
  const wall = createTaskWall();

  // Task A: Base Schema
  const taskA = wall.createTask({
    id: 'task-A',
    title: 'Design database schema'
  });
  assert.equal(taskA.status, 'pending');

  // Task B: API Endpoints (depends on Task A)
  const taskB = wall.createTask({
    id: 'task-B',
    title: 'Implement API routes',
    dependencies: ['task-A']
  });
  assert.equal(taskB.status, 'blocked');

  // Attempting to claim Task B while Task A is pending fails
  const claimB1 = wall.claimTask('task-B', 'worker-2');
  assert.equal(claimB1.ok, false);
  assert.match(claimB1.error, /blocked by unfinished dependencies/);

  // Claim and finish Task A
  const claimA = wall.claimTask('task-A', 'worker-1');
  assert.equal(claimA.ok, true);

  wall.updateTask('task-A', { status: 'done', result: 'Schema committed' });

  // Now Task B should automatically unblock
  const claimB2 = wall.claimTask('task-B', 'worker-2');
  assert.equal(claimB2.ok, true);
  assert.equal(claimB2.task.status, 'in_progress');

  wall.updateTask('task-B', { status: 'done' });
  const summary = wall.getSummary();
  assert.equal(summary.counts.done, 2);
});

test('task wall watchdog detects circular dependency deadlocks', () => {
  const wall = createTaskWall();

  // Task 1 depends on Task 2
  wall.createTask({
    id: 'T1',
    title: 'Frontend Component',
    dependencies: ['T2']
  });

  // Task 2 depends on Task 1 -> Circular Deadlock
  wall.createTask({
    id: 'T2',
    title: 'Backend Mock',
    dependencies: ['T1']
  });

  const deadlocks = wall.detectDeadlocks();
  assert.equal(deadlocks.hasDeadlock, true);
  assert.ok(deadlocks.cycles.length > 0);
  assert.deepEqual(deadlocks.cycles[0], ['T1', 'T2', 'T1']);
});

test('task wall watchdog checks stalled tasks', () => {
  const wall = createTaskWall();
  const task = wall.createTask({ title: 'Long task' });
  wall.claimTask(task.id, 'worker-slow');

  // Check with small timeout threshold
  const stalled = wall.checkStalls(0); // 0ms threshold immediately flags active tasks
  assert.equal(stalled.length, 1);
  assert.equal(stalled[0].taskId, task.id);
  assert.equal(stalled[0].assignedTo, 'worker-slow');
});
