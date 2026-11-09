// node --test orchestration/patrol-runner.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  PatrolDaemon,
  evaluateSchedules,
  readJsonFile,
  writeJsonFile
} = require('./patrol-runner');

test('evaluateSchedules flags Mantis sweep when never run or when interval elapsed', () => {
  const now = 1731140000000;
  const intervalMs = 6 * 60 * 60 * 1000; // 6 hours

  // Never run
  const fresh = evaluateSchedules({
    nowMs: now,
    state: {},
    intervalMs,
    isDigestDueFn: () => false
  });
  assert.equal(fresh.isMantisDue, true);
  assert.equal(fresh.isHealthDue, true);
  assert.equal(fresh.isWeeklyDigestDue, false);

  // Run 1 hour ago (not due)
  const recent = evaluateSchedules({
    nowMs: now,
    state: {
      lastMantisSweep: new Date(now - 1 * 60 * 60 * 1000).toISOString(),
      lastHealthCheck: new Date(now - 60 * 1000).toISOString()
    },
    intervalMs,
    healthIntervalMs: 5 * 60 * 1000,
    isDigestDueFn: () => false
  });
  assert.equal(recent.isMantisDue, false);
  assert.equal(recent.isHealthDue, false);
  assert.equal(recent.nextMantisDueMs, now + 5 * 60 * 60 * 1000);

  // Run 7 hours ago (overdue)
  const overdue = evaluateSchedules({
    nowMs: now,
    state: {
      lastMantisSweep: new Date(now - 7 * 60 * 60 * 1000).toISOString()
    },
    intervalMs,
    isDigestDueFn: () => true
  });
  assert.equal(overdue.isMantisDue, true);
  assert.equal(overdue.isWeeklyDigestDue, true);
});

test('readJsonFile and writeJsonFile safely persist daemon state', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'patrol-test-'));
  const testFile = path.join(tmpDir, 'state.json');

  // Non-existent fallback
  const fallback = { fallback: true };
  assert.deepEqual(readJsonFile(testFile, fallback), fallback);

  // Write and read
  const payload = {
    status: 'online',
    lastMantisSweep: '2026-11-09T08:00:00.000Z',
    ticks: 5
  };
  writeJsonFile(testFile, payload);
  const readBack = readJsonFile(testFile);
  assert.equal(readBack.status, 'online');
  assert.equal(readBack.ticks, 5);
  assert.equal(readBack.lastMantisSweep, '2026-11-09T08:00:00.000Z');

  // Cleanup
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('PatrolDaemon tracks state transitions and persists daemon metadata', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'patrol-daemon-'));
  const testFile = path.join(tmpDir, 'daemon-state.json');

  const daemon = new PatrolDaemon({
    port: 8787,
    intervalMs: 3600000,
    stateFile: testFile
  });

  const state1 = daemon.getState();
  assert.equal(state1.status, 'initialized');

  const state2 = daemon.saveState({
    status: 'online',
    lastMantisRunId: 'mantis-run-123'
  });
  assert.equal(state2.status, 'online');
  assert.equal(state2.lastMantisRunId, 'mantis-run-123');
  assert.ok(state2.updatedAt);

  const onDisk = readJsonFile(testFile);
  assert.equal(onDisk.status, 'online');
  assert.equal(onDisk.lastMantisRunId, 'mantis-run-123');

  // Cleanup
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
