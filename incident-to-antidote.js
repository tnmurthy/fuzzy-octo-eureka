// incident-to-antidote.js - Automated Incident-to-Antidote Knowledge Synthesizer
// Inspired by AI Team OS (CronusL-1141/AI-company) Closed-Loop Self-Healing.
//
// Converts git commit reverts, test regressions, and failed agent runs into
// structured Failure Antidotes stored in memory-engine.js and broadcast over the
// cognitive blackboard, turning one-off mistakes into permanent operational guardrails.

'use strict';

const crypto = require('crypto');
const { execFileSync } = require('child_process');

/**
 * Derives scope tags based on touched files or failure text.
 */
function deriveScopes(files = [], text = '') {
  const scopes = new Set();
  const fileList = Array.isArray(files) ? files : [files];
  const str = (fileList.join(' ') + ' ' + text).toLowerCase();

  if (/auth|jwt|token|permission|rebac|rbac|session|access/i.test(str)) scopes.add('auth');
  if (/security|xss|csrf|leak|secret|crypto|credential|token/i.test(str)) scopes.add('security');
  if (/server|route|endpoint|http|api|port|8787|8788/i.test(str)) scopes.add('server');
  if (/git|worktree|branch|commit|hook|repo|lock/i.test(str)) scopes.add('git');
  if (/db|sql|sqlite|wal|table|migration|ledger/i.test(str)) scopes.add('database');
  if (/ui|html|css|cockpit|frontend|dashboard/i.test(str)) scopes.add('ui');
  if (/test|assert|expect|unit/i.test(str)) scopes.add('testing');
  if (/pm2|daemon|process|docker|sandbox|container/i.test(str)) scopes.add('devops');

  if (scopes.size === 0) scopes.add('general');
  return Array.from(scopes);
}

/**
 * Synthesizes a structured Failure Antidote from an incident, commit, or run failure.
 *
 * @param {object} incident
 * @param {string} [incident.commitSha] - Git commit hash if derived from git
 * @param {string} [incident.message] - Git commit message or incident summary
 * @param {string} [incident.errorLog] - Error log or stack trace
 * @param {string} [incident.diff] - Git diff or code change
 * @param {string[]} [incident.files] - Files touched by fix/revert
 * @param {string} [incident.symptom] - Direct symptom override
 * @param {string} [incident.antidote] - Direct antidote override
 * @param {string} [incident.pattern] - Direct pattern override
 * @param {string} [incident.runId] - Agent run ID if derived from run
 * @returns {object} Validated antidote entry
 */
function synthesizeAntidote(incident = {}) {
  const commitSha = incident.commitSha ? incident.commitSha.slice(0, 7) : null;
  const message = String(incident.message || incident.title || '').trim();
  const errorLog = String(incident.errorLog || incident.details || '').trim();
  const files = Array.isArray(incident.files) ? incident.files : [];

  // 1. Synthesize Pattern (Short memorable failure mode)
  let pattern = incident.pattern;
  if (!pattern) {
    if (message) {
      const convMatch = message.match(/^(?:fix|revert|hotfix|patch)\(([^)]+)\):\s*(.+)$/i);
      if (convMatch) {
        pattern = `${convMatch[1].toUpperCase()}: ${convMatch[2].slice(0, 60)}`;
      } else {
        pattern = message.slice(0, 70);
      }
    } else if (errorLog) {
      const errLine = errorLog.split('\n')[0] || '';
      pattern = errLine.slice(0, 70) || 'Unhandled System Exception';
    } else {
      pattern = 'Uncategorized Operational Regression';
    }
  }

  // 2. Synthesize Symptom (The detectable signature / trigger)
  let symptom = incident.symptom;
  if (!symptom) {
    if (errorLog) {
      const lines = errorLog.split('\n').filter(Boolean);
      const errLine = lines.find((l) => /(?:Error:|AssertionError|fatal:|failed|exception|EPERM|EADDRINUSE)/i.test(l)) || lines[0] || '';
      symptom = errLine.replace(/^(?:Error:\s*|fatal:\s*)/i, '').trim().slice(0, 160);
    } else if (message) {
      symptom = `Regression addressed in commit: ${message.slice(0, 140)}`;
    } else {
      symptom = 'Unexpected execution failure during operation';
    }
  }

  // 3. Synthesize Antidote (The actionable resolution directive)
  let antidote = incident.antidote || incident.remedy;
  if (!antidote) {
    if (incident.diff) {
      antidote = `Apply verified fix from commit ${commitSha || 'patch'}: check modified logic across ${files.slice(0, 3).join(', ') || 'affected files'}.`;
    } else if (message) {
      antidote = `Ensure ${message.replace(/^(?:fix|revert|hotfix|patch)(?:\([^)]+\))?:\s*/i, '')}. Verify tests pass before merging.`;
    } else {
      antidote = 'Inspect recent test failures and apply defensive input validation and permission checks.';
    }
  }

  // 4. Derive Scopes
  const scope = Array.isArray(incident.scope) && incident.scope.length > 0
    ? incident.scope
    : deriveScopes(files, `${pattern} ${symptom} ${antidote}`);

  // Generate deterministic ID if commit provided, else random
  const idSuffix = commitSha ? commitSha.toUpperCase() : crypto.randomBytes(3).toString('hex').toUpperCase();
  const id = incident.id || `ANT-${idSuffix}`;

  return {
    id,
    pattern: pattern.trim(),
    symptom: symptom.trim(),
    antidote: antidote.trim(),
    scope,
    source: commitSha ? `commit:${commitSha.toLowerCase()}` : (incident.runId ? `run:${incident.runId}` : 'manual'),
    createdAt: incident.createdAt || new Date().toISOString()
  };
}

/**
 * Mines git repository history for fix/revert commits and synthesizes candidate antidotes.
 *
 * @param {string} [repoDir=process.cwd()]
 * @param {object} [options]
 * @param {number} [options.limit=15]
 * @returns {object[]}
 */
function mineGitCommits(repoDir = process.cwd(), options = {}) {
  const limit = options.limit || 15;
  try {
    const gitLog = execFileSync(
      'git',
      ['-C', repoDir, 'log', `-${limit}`, '--grep=fix\\|revert\\|hotfix\\|patch', '--format=%H|%s'],
      { encoding: 'utf8', timeout: 5000 }
    ).trim();

    if (!gitLog) return [];

    const lines = gitLog.split('\n').filter(Boolean);
    const candidates = [];

    for (const line of lines) {
      const idx = line.indexOf('|');
      if (idx === -1) continue;
      const sha = line.slice(0, idx).trim();
      const message = line.slice(idx + 1).trim();

      // Read touched files for commit
      let files = [];
      try {
        const statOut = execFileSync(
          'git',
          ['-C', repoDir, 'show', sha, '--name-only', '--format='],
          { encoding: 'utf8', timeout: 5000 }
        );
        files = statOut.split('\n').map((f) => f.trim()).filter(Boolean);
      } catch (_) {
        files = [];
      }

      const antidote = synthesizeAntidote({
        commitSha: sha,
        message,
        files
      });

      candidates.push(antidote);
    }

    return candidates;
  } catch (_) {
    return [];
  }
}

/**
 * Mines failed agent runs from runs collection to synthesize failure antidotes.
 *
 * @param {object[]} runs
 * @param {object} [options]
 * @param {number} [options.limit=10]
 * @returns {object[]}
 */
function mineFailedRuns(runs = [], options = {}) {
  const limit = options.limit || 10;
  const failedRuns = (Array.isArray(runs) ? runs : [])
    .filter((r) => r && (r.status === 'failed' || (r.exit_code != null && r.exit_code !== 0)))
    .slice(0, limit);

  return failedRuns.map((r) => {
    return synthesizeAntidote({
      runId: r.id,
      message: `Failed run on ${r.repo || 'repo'}: ${r.task || 'task'}`,
      errorLog: r.error || `Process exited with code ${r.exit_code || 1}`,
      files: r.files || []
    });
  });
}

/**
 * Registers an antidote into Memory Engine, SQLite WAL ledger, and Cognitive Blackboard.
 *
 * @param {object} antidote
 * @param {object} [options]
 * @param {object} [options.memoryEngine]
 * @param {object} [options.ledgerDB]
 * @param {object} [options.blackboard]
 * @returns {object}
 */
function registerAntidote(antidote, options = {}) {
  const entry = synthesizeAntidote(antidote);

  // 1. Store in Memory Engine (and persist to disk / Supabase sync)
  if (options.memoryEngine && typeof options.memoryEngine.storeAntidote === 'function') {
    options.memoryEngine.storeAntidote(entry);
  }

  // 2. Log audit event to SQLite WAL ledger
  if (options.ledgerDB && typeof options.ledgerDB.logEvent === 'function') {
    options.ledgerDB.logEvent({
      type: 'ANTIDOTE_REGISTERED',
      payload: { id: entry.id, pattern: entry.pattern, scope: entry.scope, source: entry.source }
    });
  }

  // 3. Broadcast real-time signal across Cognitive Blackboard
  if (options.blackboard && typeof options.blackboard.postFact === 'function') {
    options.blackboard.postFact({
      title: `Antidote Created [${entry.id}]: ${entry.pattern}`,
      content: `${entry.symptom} -> ${entry.antidote}`,
      author: 'antidote-synthesizer',
      scope: entry.scope[0] || 'global',
      tags: ['antidote', ...entry.scope]
    });
  }

  return entry;
}

/**
 * Batch registers multiple antidotes avoiding duplicate patterns or symptoms.
 */
function batchRegister(antidotes = [], options = {}) {
  const existingAntidotes = (options.memoryEngine && typeof options.memoryEngine.getAntidotes === 'function')
    ? options.memoryEngine.getAntidotes()
    : [];

  const existingSymptoms = new Set(existingAntidotes.map((a) => (a.symptom || '').toLowerCase().trim()));
  const existingIds = new Set(existingAntidotes.map((a) => a.id));

  let addedCount = 0;
  const registered = [];

  for (const item of antidotes) {
    const candidate = synthesizeAntidote(item);
    const symKey = (candidate.symptom || '').toLowerCase().trim();

    if (existingIds.has(candidate.id) || (symKey && existingSymptoms.has(symKey))) {
      continue;
    }

    const saved = registerAntidote(candidate, options);
    registered.push(saved);
    existingIds.add(saved.id);
    if (symKey) existingSymptoms.add(symKey);
    addedCount++;
  }

  return { added: addedCount, registered };
}

// CLI handler
if (require.main === module) {
  const args = process.argv.slice(2);
  const cmd = args[0] || 'mine-git';
  const repoDir = args[1] && !args[1].startsWith('--') ? args[1] : process.cwd();
  const isJson = args.includes('--json');

  if (cmd === 'mine-git') {
    const results = mineGitCommits(repoDir, { limit: 10 });
    if (isJson) {
      process.stdout.write(JSON.stringify(results, null, 2));
    } else {
      console.log(`[ANTIDOTE SYNTHESIZER] Mined ${results.length} candidate antidotes from git history:\n`);
      for (const a of results) {
        console.log(`[${a.id}] ${a.pattern}`);
        console.log(`  Symptom:  ${a.symptom}`);
        console.log(`  Antidote: ${a.antidote}`);
        console.log(`  Scope:    ${a.scope.join(', ')}\n`);
      }
    }
  } else if (cmd === 'synthesize') {
    const msg = args[1] || 'fix(auth): prevent token leak in response payload';
    const result = synthesizeAntidote({ message: msg });
    if (isJson) {
      process.stdout.write(JSON.stringify(result, null, 2));
    } else {
      console.log(`Synthesized Antidote [${result.id}]:`);
      console.log(`  Pattern:  ${result.pattern}`);
      console.log(`  Symptom:  ${result.symptom}`);
      console.log(`  Antidote: ${result.antidote}`);
      console.log(`  Scope:    ${result.scope.join(', ')}`);
    }
  }
}

module.exports = {
  synthesizeAntidote,
  mineGitCommits,
  mineFailedRuns,
  registerAntidote,
  batchRegister,
  deriveScopes
};
