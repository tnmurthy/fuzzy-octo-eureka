// eval-harness.js - Deterministic Agent Evaluation Harness & Regression Benchmark Suite
// Inspired by AI Team OS (CronusL-1141/AI-company) agent benchmarking.
//
// Evaluates coding accuracy, turn efficiency, speed, and unit economics across
// local Apple Silicon models (Hermes on Ollama) and frontier models (Claude 3.5 Sonnet).

'use strict';

const crypto = require('crypto');

const STANDARD_CHALLENGES = [
  {
    id: 'pure-function-refactor',
    name: 'Pure Function Algorithmic Refactor',
    difficulty: 'low',
    targetAgent: 'hermes',
    description:
      'Refactor an algorithm to O(N) linear time with zero side effects and pure function semantics.',
    targetTurns: 3,
    targetDurationMs: 15000,
    testCommand: 'node --test solution.test.js',
  },
  {
    id: 'security-auth-timing',
    name: 'Constant-Time Authentication Signature Guard',
    difficulty: 'high',
    targetAgent: 'claude',
    description:
      'Remediate timing attack vulnerability in signature verification by utilizing crypto.timingSafeEqual with length checks.',
    targetTurns: 5,
    targetDurationMs: 25000,
    testCommand: 'node --test auth-timing.test.js',
  },
  {
    id: 'sqlite-wal-concurrency',
    name: 'SQLite Concurrent Write Lock Handler',
    difficulty: 'medium',
    targetAgent: 'hermes',
    description:
      'Resolve SQLITE_BUSY concurrency conflicts with WAL pragma and exponential backoff retry wrapper.',
    targetTurns: 4,
    targetDurationMs: 20000,
    testCommand: 'node --test wal-concurrency.test.js',
  },
  {
    id: 'json-prototype-sanitizer',
    name: 'JSON Schema & Prototype Pollution Guard',
    difficulty: 'medium',
    targetAgent: 'claude',
    description:
      'Safely parse deeply nested JSON objects stripping __proto__, constructor, and prototype injection keys.',
    targetTurns: 4,
    targetDurationMs: 18000,
    testCommand: 'node --test sanitizer.test.js',
  },
];

/**
 * Returns all built-in standardized evaluation challenges.
 */
function getStandardChallenges() {
  return STANDARD_CHALLENGES;
}

/**
 * Returns a specific challenge by ID.
 */
function getChallenge(challengeId) {
  return STANDARD_CHALLENGES.find((c) => c.id === challengeId) || null;
}

/**
 * Computes a normalized benchmark score (0 to 100).
 *
 * Weightings:
 * - Pass/Fail: 60% (0 if failed, 60 if passed)
 * - Turn Efficiency: up to 20%
 * - Speed Efficiency: up to 10%
 * - Unit Cost & Economic Efficiency: up to 10%
 */
function scoreBenchmarkRun({
  passed = false,
  turns = 1,
  durationMs = 0,
  costUsd = 0,
  targetTurns = 4,
  targetDurationMs = 20000,
} = {}) {
  // 1. Pass / Fail (60 pts)
  const passScore = passed ? 60 : 0;

  // 2. Turn Efficiency (0 to 20 pts)
  let turnScore = 0;
  if (passed) {
    if (turns <= targetTurns) {
      turnScore = 20;
    } else {
      turnScore = Math.max(0, 20 - (turns - targetTurns) * 4);
    }
  }

  // 3. Speed / Latency Efficiency (0 to 10 pts)
  let speedScore = 0;
  if (passed && durationMs > 0) {
    if (durationMs <= targetDurationMs) {
      speedScore = 10;
    } else {
      const overageRatio = (durationMs - targetDurationMs) / targetDurationMs;
      speedScore = Math.max(0, Math.round(10 - overageRatio * 10));
    }
  }

  // 4. Cost Efficiency (0 to 10 pts)
  let costScore = 0;
  if (passed) {
    if (costUsd === 0) {
      costScore = 10; // Local model tier: 0 token cost!
    } else if (costUsd < 0.05) {
      costScore = 8;
    } else if (costUsd < 0.15) {
      costScore = 5;
    } else {
      costScore = 2;
    }
  }

  const totalScore = Math.min(100, Math.max(0, passScore + turnScore + speedScore + costScore));

  return {
    score: totalScore,
    breakdown: {
      passScore,
      turnScore,
      speedScore,
      costScore,
    },
  };
}

/**
 * Records a benchmark evaluation run in the SQLite WAL ledger and Blackboard.
 */
function recordBenchmarkResult(payload = {}, options = {}) {
  const challenge = getChallenge(payload.challengeId) || {};
  const passed = Boolean(payload.passed);
  const turns = Number(payload.turns) || 1;
  const durationMs = Number(payload.durationMs) || 0;
  const costUsd = Number(payload.costUsd) || 0;

  const scoreResult =
    payload.score != null
      ? { score: payload.score }
      : scoreBenchmarkRun({
          passed,
          turns,
          durationMs,
          costUsd,
          targetTurns: challenge.targetTurns || 4,
          targetDurationMs: challenge.targetDurationMs || 20000,
        });

  const record = {
    id: payload.id || 'bm_' + crypto.randomBytes(6).toString('hex'),
    challengeId: payload.challengeId || 'custom',
    agent: payload.agent || 'hermes',
    passed,
    score: scoreResult.score,
    turns,
    durationMs,
    tokens: payload.tokens || {},
    costUsd,
    details: payload.details || {},
    createdAt: payload.createdAt || new Date().toISOString(),
  };

  // 1. Save to SQLite WAL ledger
  if (options.ledgerDB && typeof options.ledgerDB.saveBenchmarkResult === 'function') {
    options.ledgerDB.saveBenchmarkResult(record);
    if (typeof options.ledgerDB.logEvent === 'function') {
      options.ledgerDB.logEvent({
        type: 'EVAL_BENCHMARK_COMPLETED',
        payload: { id: record.id, agent: record.agent, score: record.score, passed: record.passed },
      });
    }
  }

  // 2. Broadcast to Cognitive Blackboard
  if (options.blackboard && typeof options.blackboard.postFact === 'function') {
    options.blackboard.postFact({
      title: `Benchmark Evaluated: ${record.agent} (${record.score}/100)`,
      content: `Challenge '${record.challengeId}' - Passed: ${record.passed} | Turns: ${record.turns} | Cost: $${record.costUsd}`,
      author: 'eval-harness',
      scope: 'benchmarks',
      tags: ['benchmark', 'eval', record.agent, record.challengeId],
    });
  }

  return record;
}

/**
 * Aggregates benchmark history to generate agent leaderboard and comparison metrics.
 */
function compareAgentPerformance(history = []) {
  const agentMap = new Map();

  for (const run of history) {
    const agent = run.agent || 'unknown';
    if (!agentMap.has(agent)) {
      agentMap.set(agent, {
        agent,
        totalRuns: 0,
        passedRuns: 0,
        totalScore: 0,
        totalTurns: 0,
        totalDurationMs: 0,
        totalCostUsd: 0,
      });
    }

    const stat = agentMap.get(agent);
    stat.totalRuns += 1;
    if (run.passed) stat.passedRuns += 1;
    stat.totalScore += Number(run.score) || 0;
    stat.totalTurns += Number(run.turns) || 1;
    stat.totalDurationMs += Number(run.durationMs) || 0;
    stat.totalCostUsd += Number(run.costUsd) || 0;
  }

  const agents = Array.from(agentMap.values())
    .map((s) => ({
      agent: s.agent,
      totalRuns: s.totalRuns,
      passRate: Number(((s.passedRuns / s.totalRuns) * 100).toFixed(1)),
      avgScore: Number((s.totalScore / s.totalRuns).toFixed(1)),
      avgTurns: Number((s.totalTurns / s.totalRuns).toFixed(1)),
      avgDurationMs: Math.round(s.totalDurationMs / s.totalRuns),
      avgCostUsd: Number((s.totalCostUsd / s.totalRuns).toFixed(4)),
      totalCostUsd: Number(s.totalCostUsd.toFixed(4)),
    }))
    .sort((a, b) => b.avgScore - a.avgScore);

  return agents;
}

/**
 * Retrieves leaderboard and recent benchmark history from ledger.
 */
function getLeaderboard(options = {}) {
  const history =
    options.ledgerDB && typeof options.ledgerDB.getBenchmarkResults === 'function'
      ? options.ledgerDB.getBenchmarkResults({ limit: options.limit || 50 })
      : [];

  const agents = compareAgentPerformance(history);

  return {
    agents,
    recentRuns: history.slice(0, 20),
  };
}

// CLI handler
if (require.main === module) {
  const args = process.argv.slice(2);
  const cmd = args[0] || 'list';
  const isJson = args.includes('--json');

  if (cmd === 'list') {
    const challenges = getStandardChallenges();
    if (isJson) {
      process.stdout.write(JSON.stringify(challenges, null, 2));
    } else {
      console.log(
        `[EVAL HARNESS] Available Standard Benchmark Challenges (${challenges.length}):\n`
      );
      for (const c of challenges) {
        console.log(`• ${c.id} [${c.difficulty.toUpperCase()} | Target: ${c.targetAgent}]`);
        console.log(`  ${c.name}: ${c.description}`);
        console.log(`  Target: <= ${c.targetTurns} turns, <= ${c.targetDurationMs / 1000}s\n`);
      }
    }
  } else if (cmd === 'score') {
    const passed = args.includes('--passed');
    const turns = 3;
    const durationMs = 12000;
    const costUsd = 0;
    const res = scoreBenchmarkRun({ passed, turns, durationMs, costUsd });
    if (isJson) {
      process.stdout.write(JSON.stringify(res, null, 2));
    } else {
      console.log(`Calculated Benchmark Score: ${res.score}/100`);
      console.log('Breakdown:', res.breakdown);
    }
  }
}

module.exports = {
  getStandardChallenges,
  getChallenge,
  scoreBenchmarkRun,
  recordBenchmarkResult,
  compareAgentPerformance,
  getLeaderboard,
};
