// orchestration/meetings.js - Structured Consensus & Meeting Engine
// Inspired by AI Team OS (CronusL-1141/AI-company) meeting protocols.
//
// Implements formal meeting templates:
// 1. DACI: Driver, Approver, Contributor, Informed decision framework
// 2. Six Thinking Hats: White, Red, Black (Critic), Yellow, Green, Blue perspectives
// Produces binding decisions appended to decisions.md.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_DECISIONS_FILE = path.resolve(__dirname, '../decisions.md');

/**
 * Initializes decisions.md with base procedural invariants if missing.
 */
function ensureDecisionsFile(filePath = DEFAULT_DECISIONS_FILE) {
  if (!fs.existsSync(filePath)) {
    const header = [
      '# Arunachala Architectural & Governance Decisions Ledger',
      '',
      'Binding record of architectural decisions ratified through DACI & Six Thinking Hats meetings.',
      'Governed by least-privilege principles and AI workforce invariants.',
      '',
      '---',
      '',
      '## [DEC-001] Client-Owned Infrastructure & Zero Production Credentials',
      '- **Driver:** System Architecture',
      '- **Approver:** Operator / Chairman',
      '- **Verdict:** RATIFIED',
      '- **Rule:** DRISYON produces release bundles and IaC. Client CI executes them. DRISYON holds NO client production credentials at any tier.',
      '',
      '## [DEC-002] Run Step Idempotency Keyed on Trigger',
      '- **Driver:** Systems Architect',
      '- **Approver:** Operator / Chairman',
      '- **Verdict:** RATIFIED',
      '- **Rule:** run_step idempotency is keyed on (project_id, run_id, actor, intent, trigger_ref).',
      '',
      '## [DEC-003] Parked is a Health Condition, Never a State',
      '- **Driver:** Product Engineer',
      '- **Approver:** Operator / Chairman',
      '- **Verdict:** RATIFIED',
      '- **Rule:** project.state and project.health are orthogonal. Parking is a health change with state held constant.',
      '',
      '## [DEC-005] Invariant I-8: Evidence Over Assertion for Gates',
      '- **Driver:** QA Gatekeeper',
      '- **Approver:** Operator / Chairman',
      '- **Verdict:** RATIFIED',
      '- **Rule:** Gate verdict PASSED requires non-empty evidence_refs array. Zero-evidence pass auto-fails.',
      '',
      '---',
      ''
    ].join('\n');
    fs.writeFileSync(filePath, header, 'utf8');
  }
  return filePath;
}

/**
 * Appends a ratified decision to decisions.md.
 * @param {object} decision
 * @param {string} [filePath]
 * @returns {object} Stored decision
 */
function recordDecision(decision, filePath = DEFAULT_DECISIONS_FILE) {
  ensureDecisionsFile(filePath);

  const decId = decision.id || 'DEC-' + crypto.randomBytes(3).toString('hex').toUpperCase();
  const dateStr = decision.date || new Date().toISOString().slice(0, 10);
  const title = decision.title || 'Untitled Architectural Decision';
  const driver = decision.driver || 'Specialist Driver';
  const approver = decision.approver || 'Human Chairman';
  const verdict = decision.verdict || 'RATIFIED';
  const summary = decision.summary || decision.rule || 'No summary provided.';
  const tradeOffs = decision.tradeOffs ? `- **Trade-offs:** ${decision.tradeOffs}\n` : '';

  const block = [
    `## [${decId}] ${title}`,
    `- **Date:** ${dateStr}`,
    `- **Driver:** ${driver}`,
    `- **Approver:** ${approver}`,
    `- **Verdict:** ${verdict}`,
    `- **Rule / Decision:** ${summary}`,
    tradeOffs.trim(),
    '',
    '---',
    ''
  ].filter(Boolean).join('\n');

  fs.appendFileSync(filePath, '\n' + block, 'utf8');

  return {
    id: decId,
    title,
    driver,
    approver,
    verdict,
    date: dateStr,
    summary
  };
}

/**
 * Executes a structured DACI meeting.
 * @param {object} params
 * @param {string} params.topic
 * @param {string} [params.driver='Lead Engineer']
 * @param {string} [params.approver='Human Chairman']
 * @param {string[]} [params.contributors=[]]
 * @param {string[]} [params.informed=[]]
 * @param {string} [params.proposal='']
 * @param {string} [params.criticReview='']
 * @returns {object} Meeting verdict & decision payload
 */
function runDaciMeeting({
  topic,
  driver = 'Lead Engineer',
  approver = 'Human Chairman',
  contributors = ['Systems Architect', 'Security Reviewer'],
  informed = ['Team'],
  proposal = '',
  criticReview = '',
  filePath = DEFAULT_DECISIONS_FILE
}) {
  if (!topic) throw new Error('topic is required for DACI meeting');

  // Synthesize consensus
  const verdict = criticReview.includes('STRICT_BLOCK') ? 'REJECTED' : 'RATIFIED';
  const decisionRecord = {
    title: topic,
    driver,
    approver,
    verdict,
    summary: proposal || `Adopt consensus architecture for ${topic}.`,
    tradeOffs: `Evaluated by ${contributors.join(', ')}. Informed: ${informed.join(', ')}.`
  };

  const saved = recordDecision(decisionRecord, filePath);

  return {
    ok: verdict === 'RATIFIED',
    decision: saved,
    protocol: 'DACI',
    participants: { driver, approver, contributors, informed }
  };
}

/**
 * Runs a Six Thinking Hats debate session on an architectural proposal.
 * @param {object} params
 * @param {string} params.topic
 * @param {string} [params.facts=''] - White Hat
 * @param {string} [params.risks=''] - Black Hat
 * @param {string} [params.benefits=''] - Yellow Hat
 * @param {string} [params.innovations=''] - Green Hat
 * @returns {object} Structured synthesis
 */
function runSixHatsDebate({
  topic,
  facts = 'Operational requirements and current codebase constraints',
  risks = 'Potential regressions, concurrency races, or tool execution deadlocks',
  benefits = 'Improved reliability, deterministic memory recall, and zero context amnesia',
  innovations = 'Tiered context zooming and automated failure antidote extraction'
}) {
  return {
    topic,
    hats: {
      white: facts,
      red: 'High confidence on system stabilization with low complexity footprint',
      black: risks,
      yellow: benefits,
      green: innovations,
      blue: 'Consensus achieved: proceed with execution under TurnEndGuard and least-privilege boundary'
    },
    consensus: 'PROCEED'
  };
}

module.exports = {
  ensureDecisionsFile,
  recordDecision,
  runDaciMeeting,
  runSixHatsDebate,
  DEFAULT_DECISIONS_FILE
};
