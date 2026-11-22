// quality-gatekeeper.js - Adaptive Quality Gatekeeper & Auto-Review Rubric
// Inspired by AI Team OS (CronusL-1141/AI-company) Maker/Checker architecture
// and Arunachala Governance Invariants (DEC-001 through DEC-009).
//
// Evaluates diffs, test evidence, and architectural invariant compliance
// to produce a four-dimensional, weighted scorecard (0-100) and gate verdict.

'use strict';

const { auditDiff } = require('./code-auditor');

const WEIGHTS = {
  security: 35,
  invariants: 25,
  verification: 25,
  blastRadius: 15
};

const PASSING_THRESHOLD = 80;
const WARNING_THRESHOLD = 60;

/**
 * Checks compliance against ratified architectural decisions (DEC-001 to DEC-009).
 */
function checkInvariants(diffText, context = {}) {
  const violations = [];
  const text = String(diffText || '');

  // DEC-001: Client production credentials check
  if (/(?:PROD_KEY|PRODUCTION_SECRET|CLIENT_SECRET|AWS_PROD_)\s*=/i.test(text)) {
    violations.push({
      decision: 'DEC-001',
      severity: 'critical',
      rule: 'Client-Owned Infrastructure & Zero Production Credentials',
      message: 'Detected client production secret definition in diff.'
    });
  }

  // DEC-005 (Invariant I-8): Evidence Over Assertion
  if (context.evidenceRequired && (!context.evidenceRefs || context.evidenceRefs.length === 0)) {
    violations.push({
      decision: 'DEC-005',
      severity: 'critical',
      rule: 'Invariant I-8: Evidence Over Assertion',
      message: 'Gate evaluation requires non-empty evidence_refs array.'
    });
  }

  // DEC-009: Budgeted Direction Layer Entry Cap
  if (context.newDirectionRule && String(context.newDirectionRule.ruleText || '').length > 400) {
    violations.push({
      decision: 'DEC-009',
      severity: 'warning',
      rule: 'Budgeted Direction & Intent Layer',
      message: 'New direction rule exceeds 400 character entry budget.'
    });
  }

  return violations;
}

/**
 * Evaluates blast radius and scope isolation.
 */
function evaluateBlastRadius(metrics = {}, touchedFiles = []) {
  const filesCount = metrics.filesChanged || (touchedFiles ? touchedFiles.length : 0);
  const totalLines = (metrics.linesAdded || 0) + (metrics.linesDeleted || 0);

  const notices = [];
  let score = WEIGHTS.blastRadius; // 15 pts

  // Check critical/protected files
  for (const f of touchedFiles) {
    if (f.startsWith('.env') || f.includes('id_rsa') || f.includes('.pem')) {
      score = 0;
      notices.push({
        severity: 'critical',
        message: `Modification of sensitive environment or credential file: ${f}`
      });
      return { score, notices, filesCount, totalLines };
    }
  }

  if (filesCount > 25 || totalLines > 1500) {
    score -= 10;
    notices.push({
      severity: 'warning',
      message: `High blast radius: ${filesCount} files changed, ${totalLines} total lines.`
    });
  } else if (filesCount > 12 || totalLines > 600) {
    score -= 5;
    notices.push({
      severity: 'advisory',
      message: `Moderate blast radius: ${filesCount} files changed, ${totalLines} total lines.`
    });
  }

  return {
    score: Math.max(0, score),
    notices,
    filesCount,
    totalLines
  };
}

/**
 * Evaluates test verification rigor.
 */
function evaluateVerification(testResults = {}) {
  let score = WEIGHTS.verification; // 25 pts
  const notices = [];

  if (testResults.ran === false) {
    score = 5;
    notices.push({
      severity: 'warning',
      message: 'No automated tests were executed during this change.'
    });
    return { score, notices };
  }

  if (testResults.failCount > 0 || testResults.passed === false) {
    score = 0;
    notices.push({
      severity: 'critical',
      message: `Test suite execution failed: ${testResults.failCount || 'some'} tests failing.`
    });
    return { score, notices };
  }

  if (testResults.passCount > 0) {
    if (!testResults.newTestsAdded) {
      score -= 5;
      notices.push({
        severity: 'advisory',
        message: 'Existing tests passed, but no new unit tests were added for newly authored features.'
      });
    }
  } else {
    score = 10;
    notices.push({
      severity: 'advisory',
      message: 'Test command executed but reported zero active test suites.'
    });
  }

  return {
    score: Math.max(0, score),
    notices
  };
}

/**
 * Creates an Adaptive Quality Gatekeeper.
 */
function createQualityGatekeeper({ ledgerDB = null } = {}) {
  /**
   * Evaluates a complete change submission against the 4-tier rubric.
   */
  function evaluate({
    diffText = '',
    touchedFiles = [],
    testResults = {},
    context = {}
  } = {}) {
    // 1. Dimension A: Security Audit
    const audit = auditDiff(diffText);
    let secScore = WEIGHTS.security; // 35 pts
    const secFindings = audit.findings || [];

    for (const f of secFindings) {
      if (f.severity === 'critical') secScore -= 20;
      else if (f.severity === 'warning') secScore -= 5;
    }
    secScore = Math.max(0, secScore);

    // 2. Dimension B: Invariants Compliance
    const invariantViolations = checkInvariants(diffText, context);
    let invScore = WEIGHTS.invariants; // 25 pts
    for (const v of invariantViolations) {
      if (v.severity === 'critical') invScore -= 20;
      else invScore -= 5;
    }
    invScore = Math.max(0, invScore);

    // 3. Dimension C: Verification Rigor
    const verResult = evaluateVerification(testResults);

    // 4. Dimension D: Blast Radius & Isolation
    const blastResult = evaluateBlastRadius(audit.metrics, touchedFiles);

    // Total Score
    const totalScore = secScore + invScore + verResult.score + blastResult.score;

    // Check critical blockers
    const hasCriticalSec = secFindings.some((f) => f.severity === 'critical');
    const hasCriticalInv = invariantViolations.some((v) => v.severity === 'critical');
    const hasFailedTests = testResults.failCount > 0 || testResults.passed === false;
    const hasCriticalBlast = blastResult.notices.some((n) => n.severity === 'critical');

    let verdict = 'PASSED';
    if (
      totalScore < WARNING_THRESHOLD ||
      hasCriticalSec ||
      hasCriticalInv ||
      hasFailedTests ||
      hasCriticalBlast
    ) {
      verdict = 'REJECTED';
    } else if (totalScore < PASSING_THRESHOLD || secFindings.length > 0 || invariantViolations.length > 0) {
      verdict = 'PASSED_WITH_WARNINGS';
    }

    const report = {
      ok: verdict !== 'REJECTED',
      verdict,
      totalScore,
      thresholds: { pass: PASSING_THRESHOLD, warning: WARNING_THRESHOLD },
      dimensions: {
        security: { score: secScore, max: WEIGHTS.security, findings: secFindings },
        invariants: { score: invScore, max: WEIGHTS.invariants, violations: invariantViolations },
        verification: { score: verResult.score, max: WEIGHTS.verification, notices: verResult.notices },
        blastRadius: { score: blastResult.score, max: WEIGHTS.blastRadius, notices: blastResult.notices }
      },
      metrics: {
        ...audit.metrics,
        filesTouched: blastResult.filesCount,
        linesTotal: blastResult.totalLines
      },
      timestamp: new Date().toISOString()
    };

    if (ledgerDB && typeof ledgerDB.logEvent === 'function') {
      ledgerDB.logEvent({
        type: 'QUALITY_GATE_EVALUATION',
        payload: {
          verdict: report.verdict,
          score: report.totalScore,
          filesChanged: report.metrics.filesChanged
        }
      });
    }

    return report;
  }

  /**
   * Formats a markdown evaluation badge and summary.
   */
  function formatRubricMarkdown(report) {
    const badgeColor = report.verdict === 'PASSED' ? 'green' : report.verdict === 'PASSED_WITH_WARNINGS' ? 'orange' : 'red';
    return [
      `### Quality Gatekeeper Scorecard: **${report.verdict}** (${report.totalScore}/100)`,
      `- **Security & Leak Defense:** ${report.dimensions.security.score}/${WEIGHTS.security}`,
      `- **Governance Invariants:** ${report.dimensions.invariants.score}/${WEIGHTS.invariants}`,
      `- **Verification & Test Rigor:** ${report.dimensions.verification.score}/${WEIGHTS.verification}`,
      `- **Blast Radius & Isolation:** ${report.dimensions.blastRadius.score}/${WEIGHTS.blastRadius}`,
      '',
      report.verdict === 'REJECTED'
        ? `⚠️ **Gate Refused:** Critical violations or tests failing. Changes cannot be merged.`
        : `✅ **Gate Approved:** Complies with AI workforce invariants.`
    ].join('\n');
  }

  return {
    evaluate,
    formatRubricMarkdown,
    WEIGHTS,
    PASSING_THRESHOLD
  };
}

module.exports = {
  createQualityGatekeeper,
  checkInvariants,
  evaluateBlastRadius,
  evaluateVerification,
  WEIGHTS
};
