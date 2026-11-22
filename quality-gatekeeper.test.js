// quality-gatekeeper.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { createQualityGatekeeper, checkInvariants } = require('./quality-gatekeeper');

test('clean changes with passing tests and new unit tests receive high passing score', () => {
  const gatekeeper = createQualityGatekeeper();

  const cleanDiff = `
diff --git a/math.js b/math.js
new file mode 100644
--- /dev/null
+++ b/math.js
@@ -0,0 +1,5 @@
+function add(a, b) {
+  return a + b;
+}
+module.exports = { add };
`;

  const report = gatekeeper.evaluate({
    diffText: cleanDiff,
    touchedFiles: ['math.js', 'math.test.js'],
    testResults: {
      ran: true,
      passed: true,
      passCount: 2,
      failCount: 0,
      newTestsAdded: true
    }
  });

  assert.equal(report.verdict, 'PASSED');
  assert.ok(report.totalScore >= 95, `Expected score >= 95, got ${report.totalScore}`);
  assert.equal(report.dimensions.security.score, 35);
  assert.equal(report.dimensions.invariants.score, 25);
  assert.equal(report.dimensions.verification.score, 25);
  assert.equal(report.dimensions.blastRadius.score, 15);
});

test('critical secret leak causes security failure and gate rejection', () => {
  const gatekeeper = createQualityGatekeeper();

  const leakDiff = `
diff --git a/config.js b/config.js
--- a/config.js
+++ b/config.js
@@ -1,2 +1,3 @@
 const api = "https://api.internal";
+const token = "ghp_111122223333444455556666777788889999";
`;

  const report = gatekeeper.evaluate({
    diffText: leakDiff,
    touchedFiles: ['config.js'],
    testResults: { ran: true, passed: true, passCount: 1, failCount: 0, newTestsAdded: false }
  });

  assert.equal(report.verdict, 'REJECTED');
  assert.equal(report.ok, false);
  assert.ok(report.dimensions.security.findings.length > 0);
});

test('invariant DEC-001 prohibits client production secrets', () => {
  const gatekeeper = createQualityGatekeeper();

  const prodSecretDiff = `
diff --git a/client-auth.js b/client-auth.js
--- a/client-auth.js
+++ b/client-auth.js
@@ -1,2 +1,3 @@
+const CLIENT_SECRET = "client-live-key-xyz";
`;

  const report = gatekeeper.evaluate({
    diffText: prodSecretDiff,
    touchedFiles: ['client-auth.js'],
    testResults: { ran: true, passed: true, passCount: 1, failCount: 0, newTestsAdded: true }
  });

  assert.equal(report.verdict, 'REJECTED');
  assert.equal(report.dimensions.invariants.violations[0].decision, 'DEC-001');
});

test('invariant DEC-005 rejects gates without evidence refs when required', () => {
  const gatekeeper = createQualityGatekeeper();

  const report = gatekeeper.evaluate({
    diffText: '',
    touchedFiles: ['readme.md'],
    testResults: { ran: true, passed: true, passCount: 1, failCount: 0, newTestsAdded: true },
    context: { evidenceRequired: true, evidenceRefs: [] }
  });

  assert.equal(report.verdict, 'REJECTED');
  assert.equal(report.dimensions.invariants.violations[0].decision, 'DEC-005');
});

test('failing test execution causes immediate rejection', () => {
  const gatekeeper = createQualityGatekeeper();

  const report = gatekeeper.evaluate({
    diffText: '',
    touchedFiles: ['utils.js'],
    testResults: { ran: true, passed: false, passCount: 5, failCount: 1, newTestsAdded: true }
  });

  assert.equal(report.verdict, 'REJECTED');
  assert.equal(report.dimensions.verification.score, 0);
});

test('sensitive file alteration triggers blast radius alert', () => {
  const gatekeeper = createQualityGatekeeper();

  const report = gatekeeper.evaluate({
    diffText: '',
    touchedFiles: ['.env.production'],
    testResults: { ran: true, passed: true, passCount: 1, failCount: 0, newTestsAdded: true }
  });

  assert.equal(report.verdict, 'REJECTED');
  assert.equal(report.dimensions.blastRadius.score, 0);
});

test('formatRubricMarkdown renders comprehensive markdown scorecard', () => {
  const gatekeeper = createQualityGatekeeper();
  const report = gatekeeper.evaluate({
    diffText: '',
    touchedFiles: ['index.js'],
    testResults: { ran: true, passed: true, passCount: 2, failCount: 0, newTestsAdded: true }
  });

  const md = gatekeeper.formatRubricMarkdown(report);
  assert.match(md, /### Quality Gatekeeper Scorecard: \*\*PASSED\*\*/);
  assert.match(md, /Security & Leak Defense:/);
  assert.match(md, /Governance Invariants:/);
});
