// cockpit-engine.js - Decision Cockpit & Traceability Timeline Engine
// Inspired by AI Team OS (CronusL-1141/AI-company) Decision Cockpit & Intent Inspection.
//
// Cross-references and links:
// 1. Ratified Decisions from decisions.md (DACI consensus & invariants)
// 2. Dynamic Task Wall state & dependencies (task-wall.js)
// 3. Multi-Host Federation Handoffs (logs/handoffs/*.json)
// 4. Closed-loop Failure Antidotes (memory-engine.js)
// 5. Agent Runs & Verification Evidence (runs.jsonl)
//
// Provides a unified traceability timeline and pipeline stage visualization.

'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_DECISIONS_FILE = path.resolve(__dirname, 'decisions.md');
const DEFAULT_HANDOFFS_DIR = path.resolve(__dirname, 'logs/handoffs');

/**
 * Parses decisions from decisions.md.
 */
function parseDecisionsFile(filePath = DEFAULT_DECISIONS_FILE) {
  if (!fs.existsSync(filePath)) return [];

  const text = fs.readFileSync(filePath, 'utf8');
  const sections = text.split(/\n(?=##\s+\[DEC-)/);
  const decisions = [];

  for (const sec of sections) {
    const match = sec.match(/##\s+\[(DEC-\w+)\]\s*(.+)/);
    if (!match) continue;

    const id = match[1];
    const title = match[2].trim();
    const driverMatch = sec.match(/-\s+\*\*Driver:\*\*\s*(.+)/i);
    const approverMatch = sec.match(/-\s+\*\*Approver:\*\*\s*(.+)/i);
    const verdictMatch = sec.match(/-\s+\*\*Verdict:\*\*\s*(.+)/i);
    const dateMatch = sec.match(/-\s+\*\*Date:\*\*\s*(.+)/i);
    const ruleMatch = sec.match(/-\s+\*\*(?:Rule \/ Decision|Rule):\*\*\s*(.+)/i);

    decisions.push({
      id,
      title,
      driver: driverMatch ? driverMatch[1].trim() : 'Specialist',
      approver: approverMatch ? approverMatch[1].trim() : 'Chairman',
      verdict: verdictMatch ? verdictMatch[1].trim() : 'RATIFIED',
      date: dateMatch ? dateMatch[1].trim() : null,
      rule: ruleMatch ? ruleMatch[1].trim() : ''
    });
  }

  return decisions;
}

/**
 * Loads federation handoff records from disk.
 */
function loadHandoffs(dirPath = DEFAULT_HANDOFFS_DIR) {
  if (!fs.existsSync(dirPath)) return [];

  const files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.json'));
  const handoffs = [];

  for (const f of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dirPath, f), 'utf8'));
      handoffs.push(data);
    } catch (_) {}
  }

  return handoffs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
}

/**
 * Resolves a 5-stage lifecycle badge for an agent run or task.
 * Stages: Triage -> Consensus -> Implementation -> Verification -> Completed
 */
function computeStageBadge(item) {
  if (!item) return { stage: 'Triage', index: 1, color: 'blue' };

  if (item.status === 'done' || item.status === 'merged') {
    return { stage: 'Completed', index: 5, color: 'green' };
  }
  if (item.status === 'review' || item.status === 'agent:review') {
    return { stage: 'Verification', index: 4, color: 'amber' };
  }
  if (item.status === 'in_progress' || item.status === 'running') {
    return { stage: 'Implementation', index: 3, color: 'purple' };
  }
  if (item.status === 'blocked' || item.status === 'meeting') {
    return { stage: 'Consensus', index: 2, color: 'amber' };
  }

  return { stage: 'Triage', index: 1, color: 'blue' };
}

/**
 * Creates the Decision Cockpit Engine.
 */
function createCockpitEngine(options = {}) {
  const decisionsPath = options.decisionsPath || DEFAULT_DECISIONS_FILE;
  const handoffsDir = options.handoffsDir || DEFAULT_HANDOFFS_DIR;
  const loadRunsFn = options.loadRuns || (() => []);
  const memoryEngine = options.memoryEngine || null;
  const taskWall = options.taskWall || null;

  function getDecisions() {
    return parseDecisionsFile(decisionsPath);
  }

  function getHandoffs() {
    return loadHandoffs(handoffsDir);
  }

  function getAntidotes() {
    if (memoryEngine && typeof memoryEngine.getAntidotes === 'function') {
      return memoryEngine.getAntidotes();
    }
    return [];
  }

  function getTasks() {
    if (taskWall && typeof taskWall.getTasks === 'function') {
      return taskWall.getTasks();
    }
    return [];
  }

  /**
   * Builds the Traceability Matrix linking decisions to active/past runs.
   */
  function getTraceabilityMatrix() {
    const decisions = getDecisions();
    const runs = loadRunsFn();
    const matrix = [];

    for (const dec of decisions) {
      // Find runs that explicitly referenced or complied with this decision
      const matchingRuns = runs.filter((r) => {
        const text = `${r.task || ''} ${r.agent || ''} ${r.id || ''}`;
        return text.includes(dec.id) || (dec.id === 'DEC-007' && r.escalated);
      });

      matrix.push({
        decision: dec,
        compliance: dec.verdict === 'RATIFIED' ? 'ENFORCED' : 'PENDING',
        linkedRunsCount: matchingRuns.length,
        linkedRuns: matchingRuns.slice(0, 5).map((r) => ({
          id: r.id,
          task: (r.task || '').slice(0, 80),
          agent: r.agent,
          status: r.status
        }))
      });
    }

    return matrix;
  }

  /**
   * Synthesizes an interactive chronology of decisions, handoffs, and task events.
   */
  function getTimeline(limit = 40) {
    const decisions = getDecisions().map((d) => ({
      kind: 'DECISION',
      timestamp: d.date || '2026-11-22T08:00:00.000Z',
      id: d.id,
      title: `${d.id}: ${d.title}`,
      subtitle: `Driver: ${d.driver} · Approver: ${d.approver} · Verdict: ${d.verdict}`,
      badge: { label: d.verdict, color: d.verdict === 'RATIFIED' ? 'green' : 'amber' }
    }));

    const handoffs = getHandoffs().map((h) => ({
      kind: 'FEDERATION_HANDOFF',
      timestamp: h.timestamp,
      id: h.handoffId,
      title: `Federation: ${h.source?.agent || 'Hermes'} → ${h.target?.agent || 'Claude'}`,
      subtitle: `Reason: ${h.reason} (exit code ${h.diagnostics?.exitCode ?? 1})`,
      badge: { label: h.status, color: h.status === 'RESOLVED' ? 'green' : 'purple' },
      details: h.diagnostics?.testCommand || null
    }));

    const tasks = getTasks().map((t) => ({
      kind: 'TASK',
      timestamp: t.updatedAt || t.createdAt,
      id: t.id,
      title: t.title,
      subtitle: t.assignedTo ? `Assigned to: ${t.assignedTo}` : 'Unassigned',
      badge: computeStageBadge(t)
    }));

    const merged = [...decisions, ...handoffs, ...tasks]
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, limit);

    return {
      totalEvents: merged.length,
      events: merged,
      metrics: {
        decisionsCount: decisions.length,
        handoffsCount: handoffs.length,
        tasksCount: tasks.length,
        antidotesCount: getAntidotes().length
      }
    };
  }

  return {
    getDecisions,
    getHandoffs,
    getAntidotes,
    getTasks,
    getTraceabilityMatrix,
    getTimeline,
    computeStageBadge
  };
}

module.exports = {
  createCockpitEngine,
  parseDecisionsFile,
  loadHandoffs,
  computeStageBadge
};
