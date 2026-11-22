// ledger-db.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLedgerDB } = require('./ledger-db');

test('ledger db records events, tasks, and decisions with SQLite WAL mode', () => {
  const tmpDbPath = path.join(os.tmpdir(), `test-ledger-${Date.now()}.db`);
  const ledger = createLedgerDB({ dbPath: tmpDbPath });

  try {
    // 1. Log audit event
    const evt = ledger.logEvent({
      type: 'DISPATCH_START',
      runId: 'run-101',
      payload: { agent: 'claude', branch: 'agent/issue-5' }
    });
    assert.equal(evt.type, 'DISPATCH_START');

    const events = ledger.getEvents({ runId: 'run-101' });
    assert.equal(events.length, 1);
    assert.equal(events[0].payload.agent, 'claude');

    // 2. Save and load tasks
    ledger.saveTask({
      id: 'task-101',
      title: 'Build API Gateway',
      status: 'in_progress',
      assignedTo: 'worker-a',
      dependencies: ['task-100'],
      metadata: { priority: 'high' }
    });

    const tasks = ledger.loadTasks();
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].id, 'task-101');
    assert.deepEqual(tasks[0].dependencies, ['task-100']);

    // 3. Save and load decisions
    ledger.saveDecision({
      id: 'DEC-101',
      title: 'Adopt Node SQLite WAL',
      driver: 'Systems Architect',
      approver: 'Chairman',
      verdict: 'RATIFIED',
      rule: 'Local ledger uses node:sqlite with WAL pragma.'
    });

    const decisions = ledger.loadDecisions();
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].id, 'DEC-101');
    assert.equal(decisions[0].verdict, 'RATIFIED');

    // 4. Save and load direction rules
    ledger.saveDirectionRule({
      id: 'DIR-001',
      scope: 'global',
      targetId: null,
      title: 'Testing Discipline',
      ruleText: 'Require at least 1 test before merging.',
      active: true,
      supersededBy: null
    });

    const dirRules = ledger.loadDirectionRules();
    assert.equal(dirRules.length, 1);
    assert.equal(dirRules[0].id, 'DIR-001');
    assert.equal(dirRules[0].active, true);
    assert.equal(dirRules[0].ruleText, 'Require at least 1 test before merging.');
  } finally {
    ledger.close();
    try {
      fs.unlinkSync(tmpDbPath);
      fs.unlinkSync(`${tmpDbPath}-wal`);
      fs.unlinkSync(`${tmpDbPath}-shm`);
    } catch (_) {}
  }
});
