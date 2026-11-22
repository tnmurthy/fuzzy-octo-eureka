// precompact-preserver.js - Pre-Compact State Preservation & Lossless Scratchpad Rotation
// Inspired by AI Team OS (CronusL-1141/AI-company) PreCompact state preservation.
//
// Solves context amnesia during LLM context compaction or long multi-turn sessions.
// Extracts completed steps, pending items, working hypotheses, files touched, and active failures
// into a compact, deterministic <precompact_state> block (<= 1200 chars) stored in SQLite WAL
// and injected into resumed or compacted sessions.

'use strict';

const fs = require('fs');
const crypto = require('crypto');

const MAX_PRECOMPACT_CHARS = 1200;

/**
 * Normalizes input text from a string, array of steps, or transcript object.
 */
function normalizeTranscriptText(input) {
  if (!input) return '';
  if (typeof input === 'string') return input;
  if (Array.isArray(input)) {
    return input.map((item) => {
      if (typeof item === 'string') return item;
      return item.content || item.summary || item.text || item.message || JSON.stringify(item);
    }).join('\n');
  }
  if (typeof input === 'object') {
    if (Array.isArray(input.steps)) return normalizeTranscriptText(input.steps);
    if (Array.isArray(input.transcript)) return normalizeTranscriptText(input.transcript);
    return JSON.stringify(input);
  }
  return String(input);
}

/**
 * Discovers file paths mentioned in text or tool outputs.
 */
function extractFilesTouched(text) {
  const fileRegex = /\b([a-zA-Z0-9_\-./]+\.(?:js|ts|jsx|tsx|json|sql|html|css|md|sh|yaml|yml|mjs|py))\b/g;
  const files = new Set();
  let match;
  while ((match = fileRegex.exec(text)) !== null) {
    const p = match[1];
    // Filter out obvious noise
    if (!p.startsWith('http') && !p.startsWith('node_modules') && p.length > 2 && p.length < 100) {
      files.add(p);
    }
  }
  return Array.from(files);
}

/**
 * Analyzes trajectory text and extracts structured working state.
 *
 * @param {string|object|Array} transcriptOrText
 * @param {object} [options]
 * @param {string} [options.runId]
 * @param {number} [options.maxChars=1200]
 * @param {object} [options.tokenUsage]
 * @returns {object}
 */
function extractPrecompactState(transcriptOrText, options = {}) {
  const text = normalizeTranscriptText(transcriptOrText);
  const runId = String(options.runId || '').trim();
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

  const completedSteps = [];
  const pendingSteps = [];
  const workingHypotheses = [];
  const activeFailures = [];

  for (const line of lines) {
    // 1. Completed steps
    if (/^(\[main\s+[a-f0-9]+\]|commit(ted)?|✔|tests?\s+pass(ed)?|successfully\s+(wrote|created|updated)|done\b)/i.test(line)) {
      const clean = line.replace(/^[✔\s*-]+/, '').trim().slice(0, 120);
      if (clean && !completedSteps.includes(clean)) completedSteps.push(clean);
    }

    // 2. Pending checklist items
    if (/^(-\s*\[\s*\]|TODO:?|Remaining:?|Next\s+steps?:?)/i.test(line)) {
      const clean = line.replace(/^(?:-\s*\[\s*\]|TODO:?|Remaining:?|Next\s+steps?:?)\s*/i, '').trim().slice(0, 120);
      if (clean && !pendingSteps.includes(clean)) pendingSteps.push(clean);
    }

    // 3. Working hypotheses & diagnoses
    if (/(?:hypothesis|root\s+cause|diagnosis|found\s+issue|invariant|deduction):/i.test(line)) {
      const clean = line.slice(0, 140);
      if (clean && !workingHypotheses.includes(clean)) workingHypotheses.push(clean);
    }

    // 4. Failures & errors
    if (/(?:AssertionError|SyntaxError|TypeError|Error:|failed|exit\s+code\s+[1-9]|fatal:)/i.test(line)) {
      const clean = line.replace(/^(?:Error:\s*|fatal:\s*)/i, '').trim().slice(0, 120);
      if (clean && !activeFailures.includes(clean)) activeFailures.push(clean);
    }
  }

  const filesTouched = extractFilesTouched(text);

  // Generate concise summary
  let summary;
  if (completedSteps.length > 0 || pendingSteps.length > 0) {
    summary = `${completedSteps.length} finished, ${pendingSteps.length} pending`;
  } else if (activeFailures.length > 0) {
    summary = `${activeFailures.length} failure(s) recorded`;
  } else {
    summary = 'active trajectory in progress';
  }

  return {
    id: 'pc_' + crypto.randomBytes(6).toString('hex'),
    runId,
    summary,
    completedSteps: completedSteps.slice(0, 5),
    pendingSteps: pendingSteps.slice(0, 5),
    workingHypotheses: workingHypotheses.slice(0, 4),
    filesTouched: filesTouched.slice(0, 8),
    activeFailures: activeFailures.slice(0, 3),
    tokenUsage: options.tokenUsage || {},
    createdAt: new Date().toISOString()
  };
}

/**
 * Formats a precompact state object into a strict, bounded XML-markdown prompt section.
 *
 * @param {object} state
 * @param {object} [options]
 * @param {number} [options.maxChars=1200]
 * @returns {string}
 */
function formatPrecompactPrompt(state, options = {}) {
  if (!state || typeof state !== 'object') return '';
  const maxChars = options.maxChars || MAX_PRECOMPACT_CHARS;

  const parts = [
    '<precompact_state>',
    'Trajectory Checkpoint (Pre-Compact State Preservation):',
    `- Run: ${state.runId || 'current'} (${state.summary || 'active'})`
  ];

  if (Array.isArray(state.completedSteps) && state.completedSteps.length > 0) {
    parts.push(`- Completed Steps:\n  * ${state.completedSteps.join('\n  * ')}`);
  }

  if (Array.isArray(state.pendingSteps) && state.pendingSteps.length > 0) {
    parts.push(`- Pending Steps:\n  * ${state.pendingSteps.join('\n  * ')}`);
  }

  if (Array.isArray(state.filesTouched) && state.filesTouched.length > 0) {
    parts.push(`- Files Touched: ${state.filesTouched.join(', ')}`);
  }

  if (Array.isArray(state.activeFailures) && state.activeFailures.length > 0) {
    parts.push(`- Active Failures to Avoid:\n  * ${state.activeFailures.join('\n  * ')}`);
  }

  if (Array.isArray(state.workingHypotheses) && state.workingHypotheses.length > 0) {
    parts.push(`- Working Hypotheses & Diagnoses:\n  * ${state.workingHypotheses.join('\n  * ')}`);
  }

  parts.push('Directive: Continue directly from pending steps. Do NOT repeat completed work or known failures.');
  parts.push('</precompact_state>');

  const formatted = parts.join('\n');
  if (formatted.length <= maxChars) {
    return formatted;
  }

  // Clip content if exceeding character bounds while preserving valid tags
  const suffix = '\n[...]\n</precompact_state>';
  const cutPoint = Math.max(0, maxChars - suffix.length);
  const clipped = formatted.slice(0, cutPoint);
  return `${clipped}${suffix}`;
}

/**
 * Evaluates whether an execution trajectory has reached compaction thresholds.
 *
 * @param {object} metrics
 * @param {number} [metrics.turnCount=0]
 * @param {number} [metrics.maxTurns=40]
 * @param {number} [metrics.tokenUsagePercent=0]
 * @param {boolean} [metrics.forceCompact=false]
 * @returns {boolean}
 */
function shouldTriggerPrecompact(metrics = {}) {
  if (metrics.forceCompact) return true;
  const turns = Number(metrics.turnCount) || 0;
  const maxTurns = Number(metrics.maxTurns) || 40;
  const tokenPct = Number(metrics.tokenUsagePercent) || 0;

  if (turns >= 15 || turns >= Math.floor(maxTurns * 0.6)) return true;
  if (tokenPct >= 70) return true;
  return false;
}

/**
 * Persists precompact state to SQLite WAL ledger and team memory.
 */
function savePrecompactCheckpoint(runId, stateOrTranscript, options = {}) {
  const state = (stateOrTranscript && typeof stateOrTranscript === 'object' && stateOrTranscript.completedSteps)
    ? stateOrTranscript
    : extractPrecompactState(stateOrTranscript, { runId, ...options });

  state.runId = runId || state.runId;

  // 1. Save to SQLite WAL ledger
  if (options.ledgerDB && typeof options.ledgerDB.savePrecompactCheckpoint === 'function') {
    options.ledgerDB.savePrecompactCheckpoint(state);
    if (typeof options.ledgerDB.logEvent === 'function') {
      options.ledgerDB.logEvent({
        type: 'PRECOMPACT_CHECKPOINT_SAVED',
        runId: state.runId,
        payload: { summary: state.summary, completedCount: state.completedSteps.length }
      });
    }
  }

  // 2. Sync to memory engine for multi-agent federation
  if (options.memoryEngine && typeof options.memoryEngine.storeMemory === 'function') {
    options.memoryEngine.storeMemory({
      category: 'trajectory_checkpoint',
      title: `PreCompact Checkpoint: ${state.runId}`,
      content: formatPrecompactPrompt(state),
      tags: ['precompact', 'checkpoint', 'trajectory', state.runId].filter(Boolean)
    });
  }

  return state;
}

/**
 * Retrieves precompact checkpoint from SQLite WAL ledger.
 */
function getPrecompactCheckpoint(runId, options = {}) {
  if (!runId || !options.ledgerDB || typeof options.ledgerDB.getPrecompactCheckpoint !== 'function') {
    return null;
  }
  return options.ledgerDB.getPrecompactCheckpoint(runId);
}

// CLI handler
if (require.main === module) {
  const args = process.argv.slice(2);
  const cmd = args[0] || 'extract';
  const targetFile = args[1] || '';
  const runId = args[2] || '';
  const isJson = args.includes('--json');

  let content = targetFile;
  if (targetFile && fs.existsSync(targetFile)) {
    try { content = fs.readFileSync(targetFile, 'utf8'); } catch (_) {}
  }

  const state = extractPrecompactState(content, { runId });

  if (cmd === 'format') {
    process.stdout.write(formatPrecompactPrompt(state));
  } else if (isJson) {
    process.stdout.write(JSON.stringify(state, null, 2));
  } else {
    console.log(`[PRECOMPACT] Run: ${state.runId || 'unassigned'} | Summary: ${state.summary}`);
    console.log(`Completed: ${state.completedSteps.length} | Pending: ${state.pendingSteps.length} | Files: ${state.filesTouched.join(', ')}`);
    console.log('\n--- Formatted Prompt ---');
    console.log(formatPrecompactPrompt(state));
  }
}

module.exports = {
  extractPrecompactState,
  formatPrecompactPrompt,
  shouldTriggerPrecompact,
  savePrecompactCheckpoint,
  getPrecompactCheckpoint,
  extractFilesTouched,
  MAX_PRECOMPACT_CHARS
};
