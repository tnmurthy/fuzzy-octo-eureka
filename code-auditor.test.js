// node --test code-auditor.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { auditDiff } = require('./code-auditor');

test('auditDiff passes clean, standard code diffs with high score', () => {
  const cleanDiff = `
diff --git a/src/math.js b/src/math.js
--- a/src/math.js
+++ b/src/math.js
@@ -1,3 +1,5 @@
 function add(a, b) {
-  return a - b;
+  return a + b;
 }
+module.exports = { add };
  `;

  const report = auditDiff(cleanDiff);
  assert.equal(report.ok, true);
  assert.equal(report.score, 100);
  assert.equal(report.verdict, 'PASSED');
  assert.equal(report.findings.length, 0);
  assert.equal(report.metrics.filesChanged, 1);
});

test('auditDiff detects critical secrets and rejects diff', () => {
  const dirtyDiff = `
diff --git a/config.js b/config.js
+++ b/config.js
@@ -1,2 +1,3 @@
-const token = process.env.GITHUB_TOKEN;
+const token = "ghp_123456789012345678901234567890123456";
  `;

  const report = auditDiff(dirtyDiff);
  assert.equal(report.ok, true);
  assert.equal(report.verdict, 'REJECTED');
  assert.equal(report.findings.some(f => f.rule === 'SECRET_LEAK'), true);
});

test('auditDiff detects dangerous command injection and eval execution', () => {
  const vulnDiff = `
diff --git a/exec.js b/exec.js
+++ b/exec.js
@@ -1,2 +1,4 @@
+const { exec } = require('child_process');
+exec(\`cat \${userInput}\`);
+eval(codeString);
  `;

  const report = auditDiff(vulnDiff);
  assert.equal(report.ok, true);
  assert.equal(report.verdict, 'REJECTED');
  assert.equal(report.findings.some(f => f.rule === 'COMMAND_INJECTION'), true);
  assert.equal(report.findings.some(f => f.rule === 'EVAL_INJECTION'), true);
});

test('auditDiff warns on unsafe innerHTML assignments with template literals', () => {
  const xssDiff = `
diff --git a/ui.js b/ui.js
+++ b/ui.js
@@ -1,2 +1,3 @@
+element.innerHTML = \`<div>\${userName}</div>\`;
  `;

  const report = auditDiff(xssDiff);
  assert.equal(report.ok, true);
  assert.equal(report.verdict, 'PASSED_WITH_WARNINGS');
  assert.equal(report.findings.some(f => f.rule === 'UNSAFE_INNER_HTML'), true);
});
