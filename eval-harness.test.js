// eval-harness.test.js - Unit tests for Agent Evaluation Harness
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  getStandardChallenges,
  getChallenge,
  scoreBenchmarkRun,
  recordBenchmarkResult,
  compareAgentPerformance,
  getLeaderboard,
} = require('./eval-harness');

test('eval-harness: standard challenges catalog is defined and accessible', () => {
  const challenges = getStandardChallenges();
  assert.ok(Array.isArray(challenges));
  assert.ok(challenges.length >= 4);

  const refactor = getChallenge('pure-function-refactor');
  assert.ok(refactor);
  assert.equal(refactor.difficulty, 'low');
  assert.equal(refactor.targetAgent, 'hermes');
  assert.ok(refactor.targetTurns > 0);

  const sec = getChallenge('security-auth-timing');
  assert.ok(sec);
  assert.equal(sec.difficulty, 'high');
  assert.equal(sec.targetAgent, 'claude');
});

test('eval-harness: scoreBenchmarkRun computes deterministic scores', () => {
  // 1. Perfect local run
  const perfectLocal = scoreBenchmarkRun({
    passed: true,
    turns: 2,
    durationMs: 10000,
    costUsd: 0,
    targetTurns: 3,
    targetDurationMs: 15000,
  });
  assert.equal(perfectLocal.score, 100);
  assert.equal(perfectLocal.breakdown.passScore, 60);
  assert.equal(perfectLocal.breakdown.turnScore, 20);
  assert.equal(perfectLocal.breakdown.speedScore, 10);
  assert.equal(perfectLocal.breakdown.costScore, 10);

  // 2. Failed run gets 0
  const failedRun = scoreBenchmarkRun({
    passed: false,
    turns: 10,
    durationMs: 40000,
  });
  assert.equal(failedRun.score, 0);

  // 3. Passed run with high turn count
  const slowRun = scoreBenchmarkRun({
    passed: true,
    turns: 8,
    durationMs: 30000,
    costUsd: 0.08,
    targetTurns: 4,
    targetDurationMs: 20000,
  });
  assert.ok(slowRun.score >= 60 && slowRun.score < 90);
  assert.ok(slowRun.breakdown.turnScore < 20);
});

test('eval-harness: records benchmark result and logs to ledger and blackboard', () => {
  let savedRecord = null;
  const mockLedger = {
    saveBenchmarkResult(r) {
      savedRecord = r;
      return r;
    },
    getBenchmarkResults() {
      return savedRecord ? [savedRecord] : [];
    },
    logEvent() {},
  };

  let postedFact = null;
  const mockBlackboard = {
    postFact(f) {
      postedFact = f;
      return f;
    },
  };

  const run = recordBenchmarkResult(
    {
      challengeId: 'pure-function-refactor',
      agent: 'hermes',
      passed: true,
      turns: 2,
      durationMs: 8000,
      costUsd: 0,
    },
    {
      ledgerDB: mockLedger,
      blackboard: mockBlackboard,
    }
  );

  assert.ok(run.id);
  assert.equal(run.agent, 'hermes');
  assert.equal(run.score, 100);
  assert.equal(savedRecord.id, run.id);
  assert.match(postedFact.title, /Benchmark Evaluated/);
  assert.ok(postedFact.tags.includes('benchmark'));

  // Leaderboard retrieval
  const board = getLeaderboard({ ledgerDB: mockLedger });
  assert.equal(board.agents.length, 1);
  assert.equal(board.agents[0].agent, 'hermes');
  assert.equal(board.agents[0].passRate, 100);
});

test('eval-harness: compareAgentPerformance aggregates multi-agent statistics', () => {
  const history = [
    { agent: 'hermes', passed: true, score: 95, turns: 2, durationMs: 9000, costUsd: 0 },
    { agent: 'hermes', passed: true, score: 90, turns: 3, durationMs: 11000, costUsd: 0 },
    { agent: 'hermes', passed: false, score: 0, turns: 6, durationMs: 20000, costUsd: 0 },
    { agent: 'claude', passed: true, score: 92, turns: 3, durationMs: 14000, costUsd: 0.06 },
    { agent: 'claude', passed: true, score: 98, turns: 2, durationMs: 12000, costUsd: 0.04 },
  ];

  const comparison = compareAgentPerformance(history);
  assert.equal(comparison.length, 2);

  const claudeStat = comparison.find((a) => a.agent === 'claude');
  assert.equal(claudeStat.totalRuns, 2);
  assert.equal(claudeStat.passRate, 100);
  assert.equal(claudeStat.avgScore, 95);
  assert.equal(claudeStat.totalCostUsd, 0.1);

  const hermesStat = comparison.find((a) => a.agent === 'hermes');
  assert.equal(hermesStat.totalRuns, 3);
  assert.equal(hermesStat.passRate, 66.7);
  assert.equal(hermesStat.totalCostUsd, 0);
});

test('eval-harness: CLI list outputs standard challenges in JSON', () => {
  const scriptPath = path.join(__dirname, 'eval-harness.js');

  const out = execFileSync(process.execPath, [scriptPath, 'list', '--json'], { encoding: 'utf8' });
  const parsed = JSON.parse(out);
  assert.ok(Array.isArray(parsed));
  assert.ok(parsed.length >= 4);
  assert.ok(parsed.some((c) => c.id === 'pure-function-refactor'));
});
