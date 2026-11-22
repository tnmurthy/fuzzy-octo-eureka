// orchestration/loop-guard.js - TurnEndGuard & Infinite Agentic Loop (IAL) Breaker
// Inspired by AI Team OS (CronusL-1141/AI-company) runtime guards.
//
// Prevents agents from entering infinite retry cycles (e.g. repeating the exact same
// failing bash command or test) and stops agents from declaring completion while
// background test suites or daemons are still active.

'use strict';

function createLoopGuard({ maxRepeatedFailures = 3, maxOscillations = 4 } = {}) {
  // Map of runId -> Array of { tool, inputSignature, exitCode, timestamp }
  const runHistories = new Map();

  function hashInput(tool, input) {
    if (typeof input === 'string') return `${tool}:${input.trim()}`;
    try {
      return `${tool}:${JSON.stringify(input)}`;
    } catch (_) {
      return `${tool}:unknown`;
    }
  }

  /**
   * Records a tool call action and checks if an infinite loop has occurred.
   * @param {object} params
   * @param {string} params.runId
   * @param {string} params.tool
   * @param {any} params.input
   * @param {number} [params.exitCode=0]
   * @param {string} [params.error]
   * @returns {{ tripped: boolean, reason?: string, count?: number }}
   */
  function recordAction({ runId, tool, input, exitCode = 0, error = null }) {
    if (!runId || !tool) return { tripped: false };

    if (!runHistories.has(runId)) {
      runHistories.set(runId, []);
    }
    const history = runHistories.get(runId);
    const signature = hashInput(tool, input);
    const isFailure = exitCode !== 0 || Boolean(error);

    history.push({
      tool,
      signature,
      isFailure,
      exitCode,
      timestamp: Date.now()
    });

    if (history.length > 30) {
      history.shift();
    }

    // 1. Check for consecutive identical failures (e.g., trying the same failing command 3 times)
    if (isFailure && history.length >= maxRepeatedFailures) {
      const recent = history.slice(-maxRepeatedFailures);
      const allSame = recent.every((entry) => entry.signature === signature && entry.isFailure);
      if (allSame) {
        return {
          tripped: true,
          reason: `Infinite Agentic Loop detected: "${signature}" failed ${maxRepeatedFailures} times consecutively without resolution`,
          count: maxRepeatedFailures
        };
      }
    }

    // 2. Check for oscillation loop (A -> B -> A -> B)
    if (history.length >= maxOscillations) {
      const recent = history.slice(-maxOscillations);
      if (
        recent[0].signature === recent[2].signature &&
        recent[1].signature === recent[3].signature &&
        recent[0].signature !== recent[1].signature &&
        recent.some((r) => r.isFailure)
      ) {
        return {
          tripped: true,
          reason: `Oscillation loop detected between "${recent[0].signature}" and "${recent[1].signature}"`,
          count: maxOscillations
        };
      }
    }

    return { tripped: false };
  }

  /**
   * TurnEndGuard: Verifies whether an agent's completion claim is valid.
   * @param {object} params
   * @param {string} params.runId
   * @param {boolean} [params.declaredDone=true]
   * @param {Array} [params.activeProcesses=[]] - List of running background tasks or daemons
   * @param {number} [params.commitsAhead=0]
   * @param {Array} [params.filesModified=[]]
   * @returns {{ canEnd: boolean, reason?: string, warning?: string }}
   */
  function checkTurnEnd({ runId, declaredDone = true, activeProcesses = [], commitsAhead = 0, filesModified = [] }) {
    if (!declaredDone) return { canEnd: true };

    // Rule 1: Cannot declare finished if tests or background processes are still running
    if (Array.isArray(activeProcesses) && activeProcesses.length > 0) {
      return {
        canEnd: false,
        reason: `TurnEndGuard refused completion: ${activeProcesses.length} background process(es) are still running (${activeProcesses.join(', ')}). Await task completion.`
      };
    }

    // Rule 2: Warning if marked done with zero changes
    if (commitsAhead === 0 && (!filesModified || filesModified.length === 0)) {
      return {
        canEnd: true,
        warning: 'Task marked complete with zero file modifications and zero commits.'
      };
    }

    return { canEnd: true };
  }

  function reset(runId) {
    if (runId) runHistories.delete(runId);
    else runHistories.clear();
  }

  return {
    recordAction,
    checkTurnEnd,
    reset
  };
}

module.exports = {
  createLoopGuard
};
