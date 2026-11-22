// orchestration/loop-guard.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { createLoopGuard } = require('./loop-guard');

test('loop guard detects consecutive identical failures', () => {
  const guard = createLoopGuard({ maxRepeatedFailures: 3 });
  const runId = 'run-loop-01';

  // 1. First failure
  const r1 = guard.recordAction({ runId, tool: 'Bash', input: 'npm test', exitCode: 1 });
  assert.equal(r1.tripped, false);

  // 2. Second failure
  const r2 = guard.recordAction({ runId, tool: 'Bash', input: 'npm test', exitCode: 1 });
  assert.equal(r2.tripped, false);

  // 3. Third identical failure -> Tripped
  const r3 = guard.recordAction({ runId, tool: 'Bash', input: 'npm test', exitCode: 1 });
  assert.equal(r3.tripped, true);
  assert.match(r3.reason, /Infinite Agentic Loop detected/);
  assert.equal(r3.count, 3);
});

test('loop guard detects alternating oscillation loops', () => {
  const guard = createLoopGuard({ maxOscillations: 4 });
  const runId = 'run-osc-02';

  // A -> B -> A -> B
  guard.recordAction({ runId, tool: 'Edit', input: 'fileA.js', exitCode: 0 });
  guard.recordAction({ runId, tool: 'Bash', input: 'npm test', exitCode: 1 });
  guard.recordAction({ runId, tool: 'Edit', input: 'fileA.js', exitCode: 0 });
  const r4 = guard.recordAction({ runId, tool: 'Bash', input: 'npm test', exitCode: 1 });

  assert.equal(r4.tripped, true);
  assert.match(r4.reason, /Oscillation loop detected/);
});

test('TurnEndGuard refuses completion when background processes are still running', () => {
  const guard = createLoopGuard();
  const runId = 'run-guard-03';

  // Background test running
  const res = guard.checkTurnEnd({
    runId,
    declaredDone: true,
    activeProcesses: ['npm test (pid 4512)'],
    commitsAhead: 1
  });

  assert.equal(res.canEnd, false);
  assert.match(res.reason, /TurnEndGuard refused completion.*background process/);

  // Processes finished -> Allowed to complete
  const resDone = guard.checkTurnEnd({
    runId,
    declaredDone: true,
    activeProcesses: [],
    commitsAhead: 1,
    filesModified: ['src/index.js']
  });

  assert.equal(resDone.canEnd, true);
});
