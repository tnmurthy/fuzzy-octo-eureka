// orchestration/checkpoint-hooks.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  savePreCompactCheckpoint,
  loadPostCompactCheckpoint,
  formatPostCompactPrompt,
  cleanCheckpoint
} = require('./checkpoint-hooks');

test('checkpoint hooks save, load, and format state after compaction', () => {
  const tmpDir = path.join(os.tmpdir(), `checkpoints-test-${Date.now()}`);
  const runId = 'run-test-compact-01';

  // 1. Save state before compaction
  const cp = savePreCompactCheckpoint({
    runId,
    branch: 'agent/issue-42-test',
    task: 'Refactor auth routes',
    filesModified: ['server.js', 'auth.js'],
    completedSteps: ['Wrote unit tests', 'Exported helper'],
    pendingSteps: ['Update server middleware'],
    storageDir: tmpDir
  });

  assert.equal(cp.runId, runId);
  assert.equal(cp.branch, 'agent/issue-42-test');
  assert.equal(cp.filesModified.length, 2);

  // 2. Load state after compaction
  const loaded = loadPostCompactCheckpoint(runId, tmpDir);
  assert.ok(loaded);
  assert.equal(loaded.runId, runId);
  assert.deepEqual(loaded.completedSteps, ['Wrote unit tests', 'Exported helper']);

  // 3. Format restored prompt
  const restoredPrompt = formatPostCompactPrompt('Proceed with next step', loaded);
  assert.match(restoredPrompt, /STATE RESTORED AFTER CONTEXT COMPACTION/);
  assert.match(restoredPrompt, /Run ID: run-test-compact-01/);
  assert.match(restoredPrompt, /Modified Files: server\.js, auth\.js/);
  assert.match(restoredPrompt, /Next Focus: Update server middleware/);
  assert.match(restoredPrompt, /Proceed with next step$/);

  // 4. Clean checkpoint
  assert.equal(cleanCheckpoint(runId, tmpDir), true);
  assert.equal(loadPostCompactCheckpoint(runId, tmpDir), null);

  // Cleanup tmp dir
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
});
