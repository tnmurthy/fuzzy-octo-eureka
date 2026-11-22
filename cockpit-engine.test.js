// cockpit-engine.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createCockpitEngine,
  parseDecisionsFile,
  computeStageBadge
} = require('./cockpit-engine');

test('cockpit engine computes stage badges accurately', () => {
  assert.equal(computeStageBadge({ status: 'done' }).stage, 'Completed');
  assert.equal(computeStageBadge({ status: 'review' }).stage, 'Verification');
  assert.equal(computeStageBadge({ status: 'in_progress' }).stage, 'Implementation');
  assert.equal(computeStageBadge({ status: 'blocked' }).stage, 'Consensus');
  assert.equal(computeStageBadge({ status: 'pending' }).stage, 'Triage');
  assert.equal(computeStageBadge(null).stage, 'Triage');
});

test('cockpit engine parses decisions and compiles traceability timeline', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-test-'));
  const decisionsPath = path.join(tmpDir, 'decisions.md');
  const handoffsDir = path.join(tmpDir, 'handoffs');
  fs.mkdirSync(handoffsDir);

  // 1. Create mock decisions file
  fs.writeFileSync(decisionsPath, [
    '# Decisions Ledger',
    '',
    '## [DEC-001] Zero Credentials Rule',
    '- **Date:** 2026-11-20',
    '- **Driver:** Systems Architect',
    '- **Approver:** Chairman',
    '- **Verdict:** RATIFIED',
    '- **Rule:** Zero production credentials on server.',
    '',
    '## [DEC-007] Multi-Host Agent Federation Protocol',
    '- **Date:** 2026-11-22',
    '- **Driver:** Systems Architect',
    '- **Approver:** Chairman',
    '- **Verdict:** RATIFIED',
    '- **Rule:** Handoff packet preserves local attempt.',
    ''
  ].join('\n'));

  // 2. Create mock handoff packet
  fs.writeFileSync(path.join(handoffsDir, 'run-1.json'), JSON.stringify({
    handoffId: 'hnd_run-1_123',
    runId: 'run-1',
    timestamp: '2026-11-22T09:00:00.000Z',
    source: { agent: 'hermes' },
    target: { agent: 'claude' },
    reason: 'TESTS_FAILED',
    status: 'RESOLVED',
    diagnostics: { exitCode: 1, testCommand: 'npm test' }
  }));

  const mockRuns = [
    { id: 'run-1', task: 'Fix auth bug with DEC-007', escalated: true, status: 'done' },
    { id: 'run-2', task: 'Audit DEC-001 compliance', escalated: false, status: 'done' }
  ];

  const engine = createCockpitEngine({
    decisionsPath,
    handoffsDir,
    loadRuns: () => mockRuns
  });

  // 3. Test decisions parsed
  const decisions = engine.getDecisions();
  assert.equal(decisions.length, 2);
  assert.equal(decisions[0].id, 'DEC-001');
  assert.equal(decisions[1].id, 'DEC-007');

  // 4. Test traceability matrix
  const matrix = engine.getTraceabilityMatrix();
  assert.equal(matrix.length, 2);
  assert.equal(matrix[0].compliance, 'ENFORCED');
  assert.equal(matrix[0].linkedRunsCount, 1);
  assert.equal(matrix[1].linkedRunsCount, 1);

  // 5. Test timeline
  const timeline = engine.getTimeline();
  assert.ok(timeline.totalEvents >= 3);
  assert.equal(timeline.metrics.decisionsCount, 2);
  assert.equal(timeline.metrics.handoffsCount, 1);

  // Cleanup
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
});
