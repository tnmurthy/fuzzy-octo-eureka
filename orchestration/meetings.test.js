// orchestration/meetings.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  ensureDecisionsFile,
  recordDecision,
  runDaciMeeting,
  runSixHatsDebate
} = require('./meetings');

test('meetings engine initializes decisions.md and appends ratified decisions', () => {
  const tmpFile = path.join(os.tmpdir(), `test-decisions-${Date.now()}.md`);

  // 1. Ensure file initialization
  ensureDecisionsFile(tmpFile);
  const content = fs.readFileSync(tmpFile, 'utf8');
  assert.match(content, /Architectural & Governance Decisions Ledger/);
  assert.match(content, /DEC-001/);

  // 2. Record individual decision
  const dec = recordDecision({
    id: 'DEC-099',
    title: 'Adopt L0/L1/L2 Context Zooming',
    driver: 'Systems Architect',
    approver: 'Chairman',
    verdict: 'RATIFIED',
    summary: 'Memory engine exposes tiered zooming to reduce prompt token footprint.'
  }, tmpFile);

  assert.equal(dec.id, 'DEC-099');
  const updated = fs.readFileSync(tmpFile, 'utf8');
  assert.match(updated, /DEC-099/);
  assert.match(updated, /Adopt L0\/L1\/L2 Context Zooming/);

  // 3. Run full DACI meeting
  const daciRes = runDaciMeeting({
    topic: 'Automated Antidote Feedback Loop',
    driver: 'AI Leader',
    approver: 'Chairman',
    contributors: ['QA', 'Security'],
    proposal: 'Failed runs automatically extract antidotes into memory.',
    filePath: tmpFile
  });

  assert.equal(daciRes.ok, true);
  assert.equal(daciRes.protocol, 'DACI');
  assert.match(daciRes.decision.title, /Automated Antidote Feedback Loop/);

  // 4. Run Six Hats Debate
  const sixHats = runSixHatsDebate({
    topic: 'Task Wall Deadlock Detection'
  });
  assert.equal(sixHats.consensus, 'PROCEED');
  assert.ok(sixHats.hats.black.length > 0);
  assert.ok(sixHats.hats.yellow.length > 0);

  // Cleanup
  try { fs.unlinkSync(tmpFile); } catch (_) {}
});
