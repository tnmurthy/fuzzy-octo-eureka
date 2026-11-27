// eval-runner.js - runs one golden task through the real dispatch script and
// grades the result with hidden tests.
//
//   1. fixture/ -> a fresh git repo in a temp folder (main, one commit)
//   2. orchestration/agent-dispatch.sh <agent> <repo> eval/<id> <prompt> <runId>
//      (same worktree, rules, sandbox and ledger as a real run; its own run
//      log folder, so evals never show up as someone's request)
//   3. grader/ copied over the agent's worktree, then task.testCommand runs
//   4. turns / cost / duration read from the run's files, scored by
//      eval-harness.js and saved to the ledger (leaderboard: /api/eval/leaderboard)
//
// The agent never sees the grader: it is copied in after the run ends, and it
// overwrites any file of the same name the agent wrote.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { evaluateTrajectory } = require('../trajectory-eval');

// EVAL_DISPATCH_SCRIPT: evaluate another checkout's dispatch script (a branch
// under test) with this runner and these tasks.
const DISPATCH_SCRIPT = process.env.EVAL_DISPATCH_SCRIPT || path.join(__dirname, '..', 'orchestration', 'agent-dispatch.sh');
const OUTPUT_TAIL_CHARS = 2000;

function git(cwd, args) {
  const r = spawnSync(
    'git',
    ['-c', 'user.name=Arunachala Eval', '-c', 'user.email=eval@localhost', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args],
    { cwd, encoding: 'utf8' }
  );
  if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${(r.stderr || '').trim()}`);
  return r.stdout;
}

/** fixture/ -> <root>/repo as a git repo on main with one commit. */
function prepareRepo(task, root) {
  const repo = path.join(root, 'repo');
  fs.cpSync(task.fixtureDir, repo, { recursive: true });
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', `eval fixture: ${task.id}`]);
  // agent-dispatch.sh counts commits from origin/HEAD; a temp repo has no
  // remote, so point a local origin/main at the fixture commit.
  git(repo, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  git(repo, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
  return repo;
}

/** Same path rule as agent-dispatch.sh: <repo>--<branch with / as ->. */
function worktreeFor(repo, branch) {
  return `${repo}--${branch.replace(/\//g, '-')}`;
}

/** The last line for runId in runs.jsonl (the end line once it finished). */
function readRunRecord(runsDir, runId) {
  let text;
  try { text = fs.readFileSync(path.join(runsDir, 'runs.jsonl'), 'utf8'); } catch (_) { return null; }
  let merged = null;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch (_) { continue; }
    if (rec.id === runId) merged = { ...(merged || {}), ...rec };
  }
  return merged;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

/** Tool steps in a run log (stream-log.js lines "hh:mm:ss 🔧 Tool args"). */
function countToolSteps(logText) {
  return (String(logText).match(/^\d\d:\d\d:\d\d 🔧 /gmu) || []).length;
}

/**
 * Turns, cost, tokens from the run's files. claude saves num_turns and
 * total_cost_usd; hermes saves tokens only, so its turns are its tool steps.
 */
function readRunMetrics(runsDir, runId, worktree = '') {
  const claude = readJson(path.join(runsDir, `${runId}.claude.json`));
  const hermes = readJson(path.join(runsDir, `${runId}.hermes.json`));
  let logText = '';
  try { logText = fs.readFileSync(path.join(runsDir, `${runId}.log`), 'utf8'); } catch (_) { /* no log */ }
  const steps = countToolSteps(logText);
  const trajectory = evaluateTrajectory(logText, { worktree });
  const turns = Number(claude && claude.num_turns) || steps || 1;
  const costUsd = Number(claude && claude.total_cost_usd) || 0;
  const tokens = (claude && claude.usage) || (hermes && hermes.tokens) || {};
  return { turns, toolSteps: steps, costUsd, tokens, isError: Boolean((claude || hermes || {}).is_error), trajectory };
}

/** Runs the dispatch script; resolves with its exit code (never rejects). */
function dispatchWithScript({ script = DISPATCH_SCRIPT, agent, repo, branch, promptFile, runId, env }) {
  return new Promise((resolve) => {
    const child = spawn('bash', [script, agent, repo, branch, promptFile, runId], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const keep = (d) => { out = (out + d).slice(-OUTPUT_TAIL_CHARS); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('error', (err) => resolve({ code: 127, output: String(err.message) }));
    child.on('close', (code) => resolve({ code: code == null ? 1 : code, output: out }));
  });
}

function runTestCommand(cmd, cwd, timeoutMs) {
  // A grader started from inside a node test run must not report to it.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync('bash', ['-c', cmd], { cwd, env, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
  const output = `${r.stdout || ''}${r.stderr || ''}`;
  return { passed: r.status === 0, timedOut: Boolean(r.error && r.error.code === 'ETIMEDOUT'), output };
}

/**
 * @param {object} task  from golden-tasks.js
 * @param {object} o
 * @param {string} o.agent           claude | hermes | auto | noop ...
 * @param {string} o.runsDir         run log folder for eval runs
 * @param {string} [o.workRoot]      where temp repos go (default: OS temp)
 * @param {object} [o.env]           base env for the dispatch (default process.env)
 * @param {Function} [o.dispatch]    replaces dispatchWithScript (tests)
 * @param {boolean} [o.keep]         keep the temp folder even when the task passed
 * @param {Function} [o.now]
 */
async function runTask(task, o) {
  const now = o.now || Date.now;
  const workRoot = o.workRoot || path.join(os.tmpdir(), 'arunachala-eval');
  fs.mkdirSync(workRoot, { recursive: true });
  fs.mkdirSync(o.runsDir, { recursive: true });
  const root = fs.mkdtempSync(path.join(workRoot, `${task.id}-`));
  const repo = prepareRepo(task, root);
  const promptFile = path.join(root, 'prompt.md');
  fs.writeFileSync(promptFile, task.prompt);
  const runId = `eval-${task.id}-${o.agent}-${now()}`;
  const branch = `eval/${task.id}`;
  const worktree = worktreeFor(repo, branch);

  const started = now();
  const env = {
    ...(o.env || process.env),
    AGENT_RUNS_DIR: o.runsDir,
    AGENT_TASK_TITLE: `[eval] ${task.name}`,
    AGENT_KIND: 'eval',
  };
  const dispatched = await (o.dispatch || dispatchWithScript)({
    agent: o.agent, repo, branch, promptFile, runId, env,
  });
  const wallMs = now() - started;

  const record = readRunRecord(o.runsDir, runId) || {};
  const metrics = readRunMetrics(o.runsDir, runId, worktree);
  const hasWorktree = fs.existsSync(worktree);
  let test = { passed: false, timedOut: false, output: 'no worktree: the dispatch did not start' };
  if (hasWorktree) {
    fs.cpSync(task.graderDir, worktree, { recursive: true, force: true });
    test = runTestCommand(task.testCommand, worktree, task.testTimeoutMs);
  }

  const removeAfter = test.passed && !o.keep;
  const result = {
    challengeId: task.id,
    agent: o.agent,
    passed: test.passed,
    turns: metrics.turns,
    durationMs: Number.isFinite(record.duration_s) ? record.duration_s * 1000 : wallMs,
    costUsd: metrics.costUsd,
    tokens: metrics.tokens,
    details: {
      runId,
      status: record.status || 'not-recorded',
      exitCode: dispatched.code,
      commits: Number(record.commits_ahead) || 0,
      toolSteps: metrics.toolSteps,
      trajectory: { ok: metrics.trajectory.ok, flags: metrics.trajectory.flags },
      escalated: record.escalated,
      fallback: record.fallback,
      testTimedOut: test.timedOut,
      testOutputTail: test.output.slice(-OUTPUT_TAIL_CHARS),
      kept: removeAfter ? undefined : root,
    },
  };

  if (removeAfter) fs.rmSync(root, { recursive: true, force: true });
  return result;
}

module.exports = {
  runTask,
  prepareRepo,
  worktreeFor,
  readRunRecord,
  readRunMetrics,
  countToolSteps,
  runTestCommand,
  dispatchWithScript,
  DISPATCH_SCRIPT,
};
