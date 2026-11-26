// eval-runner.test.js - golden tasks, the runner, and scripts/eval.js.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { loadGoldenTasks, validateTask } = require('./golden-tasks');
const runner = require('./eval-runner');
const { getStandardChallenges } = require('../eval-harness');
const { parseArgs, selectTasks, makePaidGuard } = require('../scripts/eval');
const { checkDispatchCap, PAID_AGENTS } = require('../dispatch-cap');

const TASKS = loadGoldenTasks();
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

function gradeIn(task, layers) {
  const dir = tmp(`grade-${task.id}-`);
  for (const layer of [...layers, task.graderDir]) fs.cpSync(layer, dir, { recursive: true, force: true });
  const r = runner.runTestCommand(task.testCommand, dir, task.testTimeoutMs);
  fs.rmSync(dir, { recursive: true, force: true });
  return r;
}

test('golden tasks: loaded, valid, every harness catalog challenge has one', () => {
  assert.ok(TASKS.length >= 12);
  const ids = new Set(TASKS.map((t) => t.id));
  for (const c of getStandardChallenges()) assert.ok(ids.has(c.id), `catalog challenge ${c.id} has no golden task`);
  for (const t of TASKS) assert.ok(fs.existsSync(t.solutionDir), `${t.id} has no reference solution`);
});

test('golden tasks: a bad task.json is refused', () => {
  assert.throws(() => validateTask({ id: 'x', name: 'n', prompt: 'p', testCommand: 't' }, 'x'), /bad id/);
  assert.throws(() => validateTask({ id: 'abc', name: 'n', prompt: '', testCommand: 't' }, 'abc'), /prompt/);
  assert.throws(() => validateTask({ id: 'abc', name: 'n', prompt: 'p', testCommand: 't' }, 'abd'), /match its folder/);
});

for (const task of TASKS) {
  test(`grader ${task.id}: fails the starting code, passes the reference solution`, () => {
    assert.equal(gradeIn(task, [task.fixtureDir]).passed, false, 'grader passes the unfixed fixture');
    // solution/ holds only the changed files: lay it over the fixture.
    const r = gradeIn(task, [task.fixtureDir, task.solutionDir]);
    assert.equal(r.passed, true, r.output.slice(-1500));
  });
}

test('countToolSteps counts only tool lines', () => {
  const log = '10:00:00 == claude started\n10:00:01 🔧 Read a.js\n10:00:02 💬 hi\n10:00:03 🔧 Bash node --test\n';
  assert.equal(runner.countToolSteps(log), 2);
});

test('readRunMetrics: claude turns + cost; hermes falls back to tool steps', () => {
  const dir = tmp('metrics-');
  fs.writeFileSync(path.join(dir, 'a.claude.json'), JSON.stringify({ num_turns: 6, total_cost_usd: 0.12, usage: { output_tokens: 9 } }));
  fs.writeFileSync(path.join(dir, 'a.log'), '10:00:01 🔧 Read x\n');
  const a = runner.readRunMetrics(dir, 'a');
  assert.deepEqual({ ...a, trajectory: undefined }, { turns: 6, toolSteps: 1, costUsd: 0.12, tokens: { output_tokens: 9 }, isError: false, trajectory: undefined });
  assert.equal(a.trajectory.steps, 1);
  fs.writeFileSync(path.join(dir, 'b.hermes.json'), JSON.stringify({ tokens: { total: 50 } }));
  fs.writeFileSync(path.join(dir, 'b.log'), '10:00:01 🔧 read_file x\n10:00:02 🔧 patch x\n10:00:03 🔧 terminal y\n');
  const m = runner.readRunMetrics(dir, 'b');
  assert.equal(m.turns, 3);
  assert.equal(m.costUsd, 0);
  assert.deepEqual(m.tokens, { total: 50 });
});

// A fake dispatch that behaves like agent-dispatch.sh: worktree, edits, run lines.
function fakeDispatch(apply) {
  return async ({ repo, branch, runId, env }) => {
    const wt = runner.worktreeFor(repo, branch);
    spawnSync('git', ['-C', repo, 'worktree', 'add', '-q', '-b', branch, wt]);
    apply(wt);
    const runs = path.join(env.AGENT_RUNS_DIR, 'runs.jsonl');
    fs.appendFileSync(runs, JSON.stringify({ id: runId, agent: 'claude', status: 'running' }) + '\n');
    fs.appendFileSync(runs, JSON.stringify({ id: runId, status: 'done', duration_s: 12, commits_ahead: 1 }) + '\n');
    fs.writeFileSync(path.join(env.AGENT_RUNS_DIR, `${runId}.claude.json`), JSON.stringify({ num_turns: 3, total_cost_usd: 0.04 }));
    return { code: 0, output: '' };
  };
}

test('runTask: a correct fix passes, metrics come from the run, temp folder removed', async () => {
  const task = TASKS.find((t) => t.id === 'security-auth-timing');
  const work = tmp('evalwork-');
  const r = await runner.runTask(task, {
    agent: 'claude', runsDir: path.join(work, 'runs'), workRoot: work,
    dispatch: fakeDispatch((wt) => fs.cpSync(task.solutionDir, wt, { recursive: true, force: true })),
  });
  assert.equal(r.passed, true, r.details.testOutputTail);
  assert.equal(r.turns, 3);
  assert.equal(r.costUsd, 0.04);
  assert.equal(r.durationMs, 12000);
  assert.equal(r.details.status, 'done');
  assert.equal(r.details.commits, 1);
  assert.equal(r.details.kept, undefined);
  assert.deepEqual(fs.readdirSync(work).filter((f) => f !== 'runs'), []);
});

test('runTask: an agent that writes its own grader.test.js is overruled by the hidden one', async () => {
  const task = TASKS.find((t) => t.id === 'json-prototype-sanitizer');
  const work = tmp('evalwork-');
  const r = await runner.runTask(task, {
    agent: 'claude', runsDir: path.join(work, 'runs'), workRoot: work,
    dispatch: fakeDispatch((wt) => fs.writeFileSync(path.join(wt, 'grader.test.js'), "require('node:test')('ok', () => {});\n")),
  });
  assert.equal(r.passed, false);
  assert.ok(r.details.kept && fs.existsSync(r.details.kept), 'a failed task keeps its folder for inspection');
});

test('runTask: a dispatch that never started fails cleanly', async () => {
  const task = TASKS[0];
  const work = tmp('evalwork-');
  const r = await runner.runTask(task, {
    agent: 'hermes', runsDir: path.join(work, 'runs'), workRoot: work,
    dispatch: async () => ({ code: 2, output: 'hermes not found' }),
  });
  assert.equal(r.passed, false);
  assert.equal(r.details.status, 'not-recorded');
  assert.equal(r.details.exitCode, 2);
  assert.match(r.details.testOutputTail, /did not start/);
});

test('runTask end to end: the real dispatch script with a stub claude on PATH', async () => {
  const task = TASKS.find((t) => t.id === 'pure-function-refactor');
  const work = tmp('evalwork-');
  const bin = path.join(work, 'bin');
  fs.mkdirSync(bin);
  // The stub "agent": copies the reference fix into its cwd (the worktree),
  // commits, and prints claude's stream-json events.
  fs.writeFileSync(path.join(bin, 'claude'), `#!/usr/bin/env bash
cp "$EVAL_SOLUTION"/* . ; git add -A; git -c user.email=t@t -c user.name=t commit -qm fix
echo '{"type":"system","subtype":"init","model":"claude-stub"}'
echo '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Edit","input":{"file_path":"pairs.js"}}]}}'
echo '{"type":"result","subtype":"success","result":"done","is_error":false,"total_cost_usd":0.03,"duration_ms":900,"num_turns":2,"usage":{"input_tokens":1,"output_tokens":2}}'
`, { mode: 0o755 });
  const r = await runner.runTask(task, {
    agent: 'claude', runsDir: path.join(work, 'runs'), workRoot: path.join(work, 'w'),
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      EVAL_SOLUTION: task.solutionDir,
      AI_CALLS_FILE: path.join(work, 'ai-calls.jsonl'),
    },
  });
  assert.equal(r.passed, true, r.details.testOutputTail);
  assert.equal(r.details.status, 'done');
  assert.equal(r.details.commits, 1);
  assert.equal(r.turns, 2);
  assert.equal(r.costUsd, 0.03);
  // The stub edits and never runs a test: the trajectory check says so.
  assert.deepEqual(r.details.trajectory.flags.map((f) => f.type), ['unverified-edit']);
  const start = JSON.parse(fs.readFileSync(path.join(work, 'runs', 'runs.jsonl'), 'utf8').split('\n')[0]);
  assert.equal(start.kind, 'eval');
  assert.match(start.task, /^\[eval\] /);
});

test('scripts/eval.js: flags and task selection', () => {
  assert.deepEqual(parseArgs(['--agent', 'claude', '--task', 'a,b', '--task', 'c', '--allow-paid', '--no-record']), {
    agent: 'claude', tasks: ['a', 'b', 'c'], allowPaid: true, keep: false, record: false, json: false, list: false,
  });
  assert.throws(() => parseArgs(['--agent', '../x']), /--agent/);
  assert.throws(() => parseArgs(['--rm']), /unknown flag/);
  assert.equal(selectTasks(TASKS, []).length, TASKS.length);
  assert.throws(() => selectTasks(TASKS, ['nope']), /unknown task: nope/);
});

test('scripts/eval.js: paid agents need --allow-paid and respect the daily cap', () => {
  const dir = tmp('paid-');
  const runsFile = path.join(dir, 'runs.jsonl');
  const today = new Date().toISOString();
  fs.writeFileSync(runsFile, [1, 2].map((i) => JSON.stringify({ id: `r${i}`, agent: 'claude', status: 'done', started_at: today })).join('\n') + '\n');
  const deps = { runFiles: [runsFile, path.join(dir, 'missing.jsonl')], PAID_AGENTS, checkDispatchCap, readRuns: require('../runs-reader').readRuns };
  assert.equal(makePaidGuard({ ...deps, agent: 'hermes', allowPaid: false, cap: 0 })().ok, true);
  assert.match(makePaidGuard({ ...deps, agent: 'claude', allowPaid: false, cap: 20 })().error, /--allow-paid/);
  assert.equal(makePaidGuard({ ...deps, agent: 'claude', allowPaid: true, cap: 3 })().ok, true);
  assert.match(makePaidGuard({ ...deps, agent: 'claude', allowPaid: true, cap: 2 })().error, /Daily cap reached/);
});
