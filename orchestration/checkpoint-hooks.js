// orchestration/checkpoint-hooks.js - PreCompact & PostCompact State Preservation
// Inspired by AI Team OS (CronusL-1141/AI-company) lifecycle hooks.
//
// When an agent session approaches the host model's context threshold and undergoes
// history compaction, this hook freezes the in-flight "battle state" (branch, modified files,
// completed subtasks, next actions) so the agent continues seamlessly post-compaction
// without amnesia or repeating previously finished work.

const fs = require('fs');
const path = require('path');

const DEFAULT_CHECKPOINTS_DIR = path.resolve(__dirname, '../logs/checkpoints');

/**
 * Ensures checkpoint storage directory exists.
 */
function ensureCheckpointsDir(dirPath = DEFAULT_CHECKPOINTS_DIR) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
  return dirPath;
}

/**
 * Saves in-flight execution state before context compaction.
 * @param {object} params
 * @param {string} params.runId - Unique run identifier
 * @param {string} [params.branch] - Active git branch
 * @param {string} [params.task] - Original task / goal
 * @param {string[]} [params.filesModified] - Files modified so far
 * @param {string[]} [params.completedSteps] - Completed steps or checklist items
 * @param {string[]} [params.pendingSteps] - Remaining steps
 * @param {object} [params.metadata] - Arbitrary state flags
 * @param {string} [params.storageDir] - Custom directory for tests/overrides
 * @returns {object} Checkpoint record
 */
function savePreCompactCheckpoint(params) {
  if (!params || !params.runId) {
    throw new Error('runId is required for saving pre-compact checkpoint');
  }

  const dir = ensureCheckpointsDir(params.storageDir);
  const filePath = path.join(dir, `${params.runId}.json`);

  const checkpoint = {
    runId: params.runId,
    timestamp: new Date().toISOString(),
    branch: params.branch || null,
    task: params.task || null,
    filesModified: Array.isArray(params.filesModified) ? Array.from(new Set(params.filesModified)) : [],
    completedSteps: Array.isArray(params.completedSteps) ? params.completedSteps : [],
    pendingSteps: Array.isArray(params.pendingSteps) ? params.pendingSteps : [],
    metadata: params.metadata || {}
  };

  fs.writeFileSync(filePath, JSON.stringify(checkpoint, null, 2), 'utf8');
  return checkpoint;
}

/**
 * Loads a saved checkpoint after context compaction.
 * @param {string} runId
 * @param {string} [storageDir]
 * @returns {object|null}
 */
function loadPostCompactCheckpoint(runId, storageDir = DEFAULT_CHECKPOINTS_DIR) {
  if (!runId) return null;
  const filePath = path.join(storageDir, `${runId}.json`);
  if (!fs.existsSync(filePath)) return null;

  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

/**
 * Formats a restored checkpoint into a prompt re-injection header.
 * @param {string} basePrompt
 * @param {object} checkpoint
 * @returns {string}
 */
function formatPostCompactPrompt(basePrompt, checkpoint) {
  if (!checkpoint || !checkpoint.runId) return basePrompt;

  const header = '\n\n---\n[STATE RESTORED AFTER CONTEXT COMPACTION]\n';
  const lines = [
    `- Run ID: ${checkpoint.runId}`,
    checkpoint.branch ? `- Branch: ${checkpoint.branch}` : null,
    checkpoint.filesModified?.length ? `- Modified Files: ${checkpoint.filesModified.join(', ')}` : null,
    checkpoint.completedSteps?.length ? `- Completed: ${checkpoint.completedSteps.join(' · ')}` : null,
    checkpoint.pendingSteps?.length ? `- Next Focus: ${checkpoint.pendingSteps.join(' · ')}` : null
  ].filter(Boolean);

  const block = lines.join('\n') + '\n---\n\n';
  return `${header}${block}${basePrompt}`;
}

/**
 * Removes a checkpoint once the run concludes.
 * @param {string} runId
 * @param {string} [storageDir]
 * @returns {boolean}
 */
function cleanCheckpoint(runId, storageDir = DEFAULT_CHECKPOINTS_DIR) {
  if (!runId) return false;
  const filePath = path.join(storageDir, `${runId}.json`);
  if (fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
      return true;
    } catch (_) {
      return false;
    }
  }
  return false;
}

module.exports = {
  savePreCompactCheckpoint,
  loadPostCompactCheckpoint,
  formatPostCompactPrompt,
  cleanCheckpoint,
  DEFAULT_CHECKPOINTS_DIR
};
