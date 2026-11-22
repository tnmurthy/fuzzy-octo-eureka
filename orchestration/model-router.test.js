// orchestration/model-router.test.js - Unit tests for Dynamic Task Difficulty Router
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  classifyTaskDifficulty,
  routeTask,
  evaluateFileImpact
} = require('./model-router');

test('model-router: classifies routine documentation and typo tasks as local tier (hermes)', () => {
  const result = classifyTaskDifficulty('Fix typo in README documentation and polish markdown formatting');
  assert.equal(result.difficulty, 'low');
  assert.equal(result.tier, 'local');
  assert.equal(result.agent, 'hermes');
  assert.equal(result.shouldSkipLocal, false);
  assert.ok(result.score < 40, `Expected score < 40, got ${result.score}`);
  assert.ok(result.factors.includes('documentation'));
  assert.ok(result.factors.includes('typo_fix'));
  assert.ok(result.costPrediction.potentialSavingsUsd > 0);
});

test('model-router: classifies formatting and chore tasks as local tier (hermes)', () => {
  const result = classifyTaskDifficulty('Run prettier formatting and bump package version in changelog');
  assert.equal(result.difficulty, 'low');
  assert.equal(result.tier, 'local');
  assert.equal(result.agent, 'hermes');
  assert.ok(result.factors.includes('code_formatting') || result.factors.includes('project_chore'));
});

test('model-router: classifies high-difficulty security and auth tasks as frontier tier (claude)', () => {
  const result = classifyTaskDifficulty('Perform security audit on auth endpoints to prevent JWT token leaks and SQL injection');
  assert.equal(result.difficulty, 'high');
  assert.equal(result.tier, 'frontier');
  assert.equal(result.agent, 'claude');
  assert.equal(result.shouldSkipLocal, true);
  assert.ok(result.score >= 65, `Expected score >= 65, got ${result.score}`);
  assert.ok(result.factors.includes('security_audit'));
  assert.ok(result.factors.includes('auth_boundary'));
  assert.ok(result.factors.includes('injection_vulnerability'));
});

test('model-router: classifies architecture refactoring and race condition tasks as frontier tier', () => {
  const result = classifyTaskDifficulty('Refactor distributed consensus architecture to resolve thread concurrency race conditions and deadlocks');
  assert.equal(result.difficulty, 'high');
  assert.equal(result.tier, 'frontier');
  assert.equal(result.agent, 'claude');
  assert.equal(result.shouldSkipLocal, true);
  assert.ok(result.score >= 65);
  assert.ok(result.factors.includes('architecture_refactor'));
  assert.ok(result.factors.includes('concurrency_race_condition'));
});

test('model-router: evaluateFileImpact scores blast radius and sensitive files properly', () => {
  // Sensitive files
  const sensitiveImpact = evaluateFileImpact(['server.js', 'ledger-db.js']);
  assert.ok(sensitiveImpact.scoreDelta > 0);
  assert.equal(sensitiveImpact.sensitiveCount, 2);
  assert.ok(sensitiveImpact.factors.some(f => f.startsWith('sensitive_paths_touched')));

  // Trivial files only
  const trivialImpact = evaluateFileImpact(['README.md', 'docs/api.md']);
  assert.ok(trivialImpact.scoreDelta < 0);
  assert.equal(trivialImpact.trivialOnly, true);
  assert.ok(trivialImpact.factors.includes('trivial_file_extensions_only'));

  // Large blast radius
  const broadImpact = evaluateFileImpact(['a.js', 'b.js', 'c.js', 'd.js', 'e.js', 'f.js', 'g.js', 'h.js', 'i.js']);
  assert.ok(broadImpact.scoreDelta >= 30);
  assert.ok(broadImpact.factors.some(f => f.startsWith('broad_blast_radius')));
});

test('model-router: file impacts elevate moderate task into high difficulty', () => {
  const moderateTask = 'Update data aggregation and synchronize helper methods';
  const baseline = classifyTaskDifficulty(moderateTask);
  assert.notEqual(baseline.difficulty, 'high');

  const withSensitiveFiles = classifyTaskDifficulty(moderateTask, {
    files: ['server.js', 'quality-gatekeeper.js', 'auth.js', 'schema.sql']
  });
  assert.equal(withSensitiveFiles.difficulty, 'high');
  assert.equal(withSensitiveFiles.tier, 'frontier');
  assert.equal(withSensitiveFiles.agent, 'claude');
  assert.equal(withSensitiveFiles.shouldSkipLocal, true);
});

test('model-router: routeTask returns expected summary structure', () => {
  const route = routeTask('Fix typo in docstrings');
  assert.equal(route.agent, 'hermes');
  assert.equal(route.tier, 'local');
  assert.equal(route.difficulty, 'low');
  assert.equal(route.shouldSkipLocal, false);
  assert.ok(typeof route.reason === 'string');
});

test('model-router: handles edge cases (empty strings, null, long strings) safely', () => {
  const empty = classifyTaskDifficulty('');
  assert.ok(empty.score >= 0 && empty.score <= 100);
  assert.equal(typeof empty.reason, 'string');

  const nullVal = classifyTaskDifficulty(null);
  assert.ok(nullVal.score >= 0);

  const verbose = classifyTaskDifficulty('A'.repeat(3000));
  assert.ok(verbose.factors.includes('verbose_complex_spec'));
});

test('model-router: CLI execution produces valid short, json, and formatted outputs', () => {
  const scriptPath = path.join(__dirname, 'model-router.js');

  // Short output
  const shortLocal = execFileSync(process.execPath, [scriptPath, 'classify', 'Fix typo in documentation', '--short'], { encoding: 'utf8' });
  assert.equal(shortLocal.trim(), 'hermes');

  const shortFrontier = execFileSync(process.execPath, [scriptPath, 'classify', 'Audit auth endpoints for security CVE and SQL injection', '--short'], { encoding: 'utf8' });
  assert.equal(shortFrontier.trim(), 'claude');

  // JSON output
  const jsonOut = execFileSync(process.execPath, [scriptPath, 'classify', 'Refactor database migration schema', '--json'], { encoding: 'utf8' });
  const parsed = JSON.parse(jsonOut);
  assert.ok(typeof parsed.score === 'number');
  assert.ok(['local', 'frontier'].includes(parsed.tier));
  assert.ok(['hermes', 'claude'].includes(parsed.agent));
});
