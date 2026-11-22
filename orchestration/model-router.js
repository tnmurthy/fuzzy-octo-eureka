// orchestration/model-router.js - Dynamic Task Difficulty Router
// Optimizes unit economics and latency across local Apple Silicon models (Hermes on Ollama)
// and frontier models (Claude 3.5 Sonnet).
//
// Heuristics:
// - Low / Routine (Score < 40): Docs, formatting, typos, simple pure-function tests, version bumps.
//   -> Route to local Hermes (0 token cost, sub-second dispatch).
// - Medium (Score 40-64): Standard feature additions, moderate bug fixes.
//   -> In 'auto' mode, attempted on local first; tests verify correctness; escalates if failed.
// - High / Complex (Score >= 65): Security, auth/ReBAC, cryptography, multi-file architecture refactor,
//   database migrations, race conditions, distributed state.
//   -> Route directly to frontier Claude, skipping local execution to eliminate wasted compute and 5-10m delay.

'use strict';

const fs = require('fs');
const { execFileSync } = require('child_process');

const HIGH_DIFFICULTY_KEYWORDS = [
  // Security & Authentication
  { pattern: /\b(security|vulnerabilit(y|ies)|cve|owasp|cwe|exploit|penetration)\b/i, weight: 35, factor: 'security_audit' },
  { pattern: /\b(auth|authentication|authorization|rebac|rbac|jwt|bearer|oauth|saml|sso|session[ _-]?hijack)\b/i, weight: 30, factor: 'auth_boundary' },
  { pattern: /\b(crypto|cryptograph(y|ic)|cipher|encrypt(ion)?|decrypt(ion)?|hash(ing)?|signature|hmac)\b/i, weight: 30, factor: 'cryptography' },
  { pattern: /\b(xss|csrf|sql[ _-]?injection|nosql[ _-]?injection|ssrf|rce|injection[ _-]?vector|sandbox[ _-]?escape|prompt[ _-]?injection)\b/i, weight: 35, factor: 'injection_vulnerability' },
  { pattern: /\b(secret|credential|api[ _-]?key|private[ _-]?key|token[ _-]?leak)\b/i, weight: 25, factor: 'secret_management' },

  // Architecture & Refactoring
  { pattern: /\b(refactor(ing)?|architectur(e|al)|redesign|decompose|monolith|decouple)\b/i, weight: 25, factor: 'architecture_refactor' },
  { pattern: /\b(concurren(t|cy)|race[ _-]?condition|mutex|deadlock|thread[ _-]?safety|atomic(ity)?)\b/i, weight: 30, factor: 'concurrency_race_condition' },
  { pattern: /\b(distributed|consensus|raft|paxos|replication|sharding|cqrs|event[ _-]?sourcing)\b/i, weight: 30, factor: 'distributed_systems' },
  { pattern: /\b(migration|schema[ _-]?migration|database[ _-]?migration|ddl|alter[ _-]?table|breaking[ _-]?change)\b/i, weight: 25, factor: 'schema_migration' },
  { pattern: /\b(ast|abstract[ _-]?syntax[ _-]?tree|parser|compiler|lexer|babel|swc)\b/i, weight: 25, factor: 'ast_transformation' },
  { pattern: /\b(memory[ _-]?leak|profil(e|ing)|flamegraph|bottleneck|zero[ _-]?downtime)\b/i, weight: 20, factor: 'performance_profiling' }
];

const LOW_DIFFICULTY_KEYWORDS = [
  // Documentation & Text
  { pattern: /\b(readme|docs|documentation|comment(s)?|docstring(s)?|jsdoc|markdown)\b/i, weight: -25, factor: 'documentation' },
  { pattern: /\b(typo(s)?|spelling|grammar|wording|copywrite|phrasing)\b/i, weight: -25, factor: 'typo_fix' },
  
  // Formatting & Linting
  { pattern: /\b(format(ting)?|prettier|beautify|indent(ation)?|whitespace)\b/i, weight: -20, factor: 'code_formatting' },
  { pattern: /\b(lint(ing|er)?|eslint|styleguide|unused[ _-]?imports?)\b/i, weight: -20, factor: 'linting' },

  // Chores & Housekeeping
  { pattern: /\b(bump[ _-]?version|package[ _-]?version|version[ _-]?bump|changelog|gitignore|npm[ _-]?audit|license)\b/i, weight: -25, factor: 'project_chore' },
  { pattern: /\b(clean[ _-]?up|remove[ _-]?dead[ _-]?code|renam(e|ing)|deprecat(e|ed))\b/i, weight: -15, factor: 'cleanup' },

  // Simple test coverage
  { pattern: /\b(unit[ _-]?test[ _-]?for|test[ _-]?coverage[ _-]?for|snapshot[ _-]?test)\b/i, weight: -15, factor: 'simple_test' }
];

const SENSITIVE_FILE_PATTERNS = [
  /auth/i,
  /rebac/i,
  /security/i,
  /crypto/i,
  /secret/i,
  /server\.js$/,
  /ledger-db\.js$/,
  /quality-gatekeeper\.js$/,
  /\.sql$/,
  /migration/i,
  /firewall/i
];

const TRIVIAL_FILE_PATTERNS = [
  /\.md$/i,
  /\.txt$/i,
  /\.json$/i,
  /\.css$/i,
  /\.svg$/i,
  /^docs\//i,
  /\.github\//i,
  /\.gitignore$/i,
  /LICENSE$/i
];

/**
 * Inspects a git repository worktree to discover modified or touched files.
 */
function inspectWorktreeFiles(worktreeDir) {
  if (!worktreeDir || !fs.existsSync(worktreeDir)) return [];
  try {
    const statusOut = execFileSync('git', ['-C', worktreeDir, 'status', '--porcelain'], { encoding: 'utf8', timeout: 5000 });
    return statusOut
      .split('\n')
      .map((l) => l.slice(3).trim())
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

/**
 * Analyzes file impact, blast radius, and sensitive path involvement.
 */
function evaluateFileImpact(fileList) {
  const files = Array.isArray(fileList) ? fileList : (fileList ? [String(fileList)] : []);
  if (files.length === 0) {
    return { scoreDelta: 0, factors: [], sensitiveCount: 0, trivialOnly: false };
  }

  let delta = 0;
  const factors = [];
  const sensitiveFiles = files.filter((f) => SENSITIVE_FILE_PATTERNS.some((p) => p.test(f)));
  const trivialFiles = files.filter((f) => TRIVIAL_FILE_PATTERNS.some((p) => p.test(f)));

  // File count scaling
  if (files.length <= 1) {
    delta -= 10;
    factors.push('single_file_scope');
  } else if (files.length >= 8) {
    delta += 30;
    factors.push(`broad_blast_radius_${files.length}_files`);
  } else if (files.length >= 4) {
    delta += 15;
    factors.push(`multi_file_impact_${files.length}_files`);
  }

  // Sensitive paths
  if (sensitiveFiles.length > 0) {
    delta += 25;
    factors.push(`sensitive_paths_touched(${sensitiveFiles.slice(0, 3).join(', ')})`);
  }

  // Trivial files exclusively
  const trivialOnly = files.length > 0 && trivialFiles.length === files.length;
  if (trivialOnly) {
    delta -= 20;
    factors.push('trivial_file_extensions_only');
  }

  return {
    scoreDelta: delta,
    factors,
    sensitiveCount: sensitiveFiles.length,
    trivialOnly
  };
}

/**
 * Classifies task difficulty and routes to the optimal model tier.
 *
 * @param {string} task - The prompt or task specification.
 * @param {object} [options]
 * @param {string[]|string} [options.files] - List of touched or targeted files.
 * @param {string} [options.worktree] - Working tree to inspect if files not supplied.
 * @param {object} [options.context] - Additional context signals.
 * @param {number} [options.lowThreshold=40] - Cutoff below which task is considered routine/local.
 * @param {number} [options.highThreshold=65] - Cutoff at or above which task routes to frontier.
 */
function classifyTaskDifficulty(task, options = {}) {
  const rawTask = String(task || '').trim();
  const lowThreshold = typeof options.lowThreshold === 'number' ? options.lowThreshold : 40;
  const highThreshold = typeof options.highThreshold === 'number' ? options.highThreshold : 65;

  let score = 30; // Moderate baseline
  const factors = [];
  let signalCount = 0;

  // 1. Text keyword heuristics
  for (const { pattern, weight, factor } of HIGH_DIFFICULTY_KEYWORDS) {
    if (pattern.test(rawTask)) {
      score += weight;
      factors.push(factor);
      signalCount++;
    }
  }

  for (const { pattern, weight, factor } of LOW_DIFFICULTY_KEYWORDS) {
    if (pattern.test(rawTask)) {
      score += weight;
      factors.push(factor);
      signalCount++;
    }
  }

  // 2. Prompt length impact
  if (rawTask.length > 2500) {
    score += 10;
    factors.push('verbose_complex_spec');
    signalCount++;
  } else if (rawTask.length > 0 && rawTask.length < 120 && factors.some((f) => ['documentation', 'typo_fix', 'code_formatting'].includes(f))) {
    score -= 10;
    factors.push('concise_routine_spec');
    signalCount++;
  }

  // 3. File blast radius & sensitivity
  let files = options.files;
  if (!files && options.worktree) {
    files = inspectWorktreeFiles(options.worktree);
  }
  const fileImpact = evaluateFileImpact(files);
  score += fileImpact.scoreDelta;
  factors.push(...fileImpact.factors);
  if (fileImpact.factors.length > 0) signalCount++;

  // Normalize score between 0 and 100
  score = Math.max(0, Math.min(100, Math.round(score)));

  // Tier & Agent selection
  let difficulty;
  let tier;
  let agent;
  let shouldSkipLocal;

  if (score >= highThreshold) {
    difficulty = 'high';
    tier = 'frontier';
    agent = 'claude';
    shouldSkipLocal = true;
  } else if (score < lowThreshold) {
    difficulty = 'low';
    tier = 'local';
    agent = 'hermes';
    shouldSkipLocal = false;
  } else {
    difficulty = 'medium';
    tier = 'local';
    agent = 'hermes';
    shouldSkipLocal = false;
  }

  // Confidence computation (0.5 to 0.95 based on evidence)
  const confidence = Math.min(0.95, Math.max(0.50, 0.50 + (signalCount * 0.1)));

  // Cost and Token estimation
  const costPrediction = tier === 'local'
    ? {
        tier: 'local',
        estimatedTokens: Math.max(800, Math.min(4000, rawTask.length * 2)),
        estimatedCostUsd: 0.00,
        potentialSavingsUsd: Number(((Math.max(2000, rawTask.length * 4) / 1000000) * 9.0).toFixed(4)) // Based on Sonnet input/output blend
      }
    : {
        tier: 'frontier',
        estimatedTokens: Math.max(4000, Math.min(30000, rawTask.length * 8)),
        estimatedCostUsd: Number(((Math.max(8000, rawTask.length * 8) / 1000000) * 12.0).toFixed(4)),
        potentialSavingsUsd: 0.00
      };

  // Human-readable reason
  let reason;
  if (difficulty === 'high') {
    reason = `High complexity task (score ${score}/100): ${factors.slice(0, 3).join(', ')}. Directing to frontier model.`;
  } else if (difficulty === 'low') {
    reason = `Routine task (score ${score}/100): ${factors.slice(0, 3).join(', ')}. Optimal for 0-cost local model.`;
  } else {
    reason = `Moderate complexity task (score ${score}/100): eligible for local-first execution with automated verification.`;
  }

  return {
    score,
    difficulty,
    tier,
    agent,
    recommendedAgent: agent,
    shouldSkipLocal,
    confidence: Number(confidence.toFixed(2)),
    factors,
    reason,
    costPrediction
  };
}

/**
 * Convenience wrapper returning decision summary for CLI or dispatch.
 */
function routeTask(task, options = {}) {
  const result = classifyTaskDifficulty(task, options);
  return {
    agent: result.agent,
    tier: result.tier,
    difficulty: result.difficulty,
    shouldSkipLocal: result.shouldSkipLocal,
    score: result.score,
    reason: result.reason,
    result
  };
}

// CLI handler for agent-dispatch.sh and terminal inspection
if (require.main === module) {
  const args = process.argv.slice(2);
  const target = args[1] || args[0] || '';
  const worktree = args[2] && !args[2].startsWith('--') ? args[2] : '';
  const isJson = args.includes('--json');
  const isShort = args.includes('--short');

  let taskText = target;
  if (target && fs.existsSync(target)) {
    try {
      taskText = fs.readFileSync(target, 'utf8');
    } catch (_) {
      taskText = target;
    }
  }

  const decision = classifyTaskDifficulty(taskText, { worktree });

  if (isShort) {
    process.stdout.write(decision.agent);
  } else if (isJson) {
    process.stdout.write(JSON.stringify(decision, null, 2));
  } else {
    console.log(`[MODEL ROUTER] Score: ${decision.score}/100 | Difficulty: ${decision.difficulty.toUpperCase()} | Tier: ${decision.tier.toUpperCase()}`);
    console.log(`Recommended Agent: ${decision.agent} (skip local: ${decision.shouldSkipLocal})`);
    console.log(`Reason: ${decision.reason}`);
    console.log(`Factors: ${decision.factors.join(', ') || 'none'}`);
    if (decision.costPrediction.potentialSavingsUsd > 0) {
      console.log(`Estimated Savings: $${decision.costPrediction.potentialSavingsUsd} USD`);
    }
  }
}

module.exports = {
  classifyTaskDifficulty,
  routeTask,
  evaluateFileImpact,
  HIGH_DIFFICULTY_KEYWORDS,
  LOW_DIFFICULTY_KEYWORDS,
  SENSITIVE_FILE_PATTERNS,
  TRIVIAL_FILE_PATTERNS
};
