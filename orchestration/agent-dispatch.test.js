// node --test orchestration/agent-dispatch.test.js
// Drives agent-dispatch.sh's `auto` mode end to end against a throwaway git
// repo, with stub hermes and claude scripts standing in for the real CLIs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const BASH = process.env.DISPATCH_BASH_BIN || (process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : 'bash');
const SCRIPT = path.join(__dirname, 'agent-dispatch.sh');
const posix = (p) => p.replace(/\\/g, '/');

const HERMES_STUB = `#!/usr/bin/env bash
wt="$2"
case "$STUB_LOCAL" in
  fix)  echo local > "$wt/fixed"; git -C "$wt" add -A; git -C "$wt" -c user.email=t@t -c user.name=t commit -qm local ;;
  junk) echo junk > "$wt/junk.txt" ;;
  fail) exit 3 ;;
esac
`;
const CLAUDE_STUB = `#!/usr/bin/env bash
echo claude > fixed; git add -A; git -c user.email=t@t -c user.name=t commit -qm claude
touch "$CLAUDE_MARK"
echo '{"type":"system","subtype":"init","model":"claude-sonnet-test"}'
echo '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Edit","input":{"file_path":"fixed","new_string":"SECRET-CONTENT"}}]}}'
echo '{"type":"result","subtype":"success","result":"done","is_error":false,"total_cost_usd":0.05,"duration_ms":1000,"num_turns":2,"usage":{"input_tokens":10,"cache_creation_input_tokens":100,"cache_read_input_tokens":0,"output_tokens":20},"modelUsage":{"claude-sonnet-test":{}}}'
`;

function setup({ withTests }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-'));
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  const git = (...a) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'README.md'), 'x\n');
  if (withTests) fs.writeFileSync(path.join(repo, '.arunachala-test'), 'test -f fixed\n');
  git('add', '-A');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'hermes-stub'), HERMES_STUB, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'claude'), CLAUDE_STUB, { mode: 0o755 });
  const prompt = path.join(dir, 'prompt.txt');
  fs.writeFileSync(prompt, 'make the tests pass');
  return { dir, repo, bin, prompt, runs: path.join(dir, 'runs') };
}

function dispatch(t, stubLocal) {
  const mark = path.join(t.dir, 'claude-ran');
  const ledger = path.join(t.dir, 'ai-calls.jsonl');
  const res = spawnSync(BASH, [posix(SCRIPT), 'auto', posix(t.repo), 'task/x', posix(t.prompt), 'run-1'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${t.bin}${path.delimiter}${process.env.PATH}`,
      AGENT_RUNS_DIR: posix(t.runs),
      HERMES_BIN: posix(path.join(t.bin, 'hermes-stub')),
      STUB_LOCAL: stubLocal,
      CLAUDE_MARK: posix(mark),
      AI_CALLS_FILE: posix(ledger),
    },
  });
  const lines = fs.readFileSync(path.join(t.runs, 'runs.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const worktree = path.join(t.dir, 'repo--task-x');
  const calls = fs.existsSync(ledger) ? fs.readFileSync(ledger, 'utf8').trim().split('\n').map(JSON.parse) : [];
  return { res, end: lines.at(-1), claudeRan: fs.existsSync(mark), worktree, calls, log: fs.readFileSync(path.join(t.runs, 'run-1.log'), 'utf8') };
}

test('auto: local fix passes the tests - claude never runs', () => {
  const r = dispatch(setup({ withTests: true }), 'fix');
  assert.equal(r.res.status, 0, r.log);
  assert.equal(r.end.status, 'done');
  assert.equal(r.end.escalated, false);
  assert.equal(r.claudeRan, false);
  assert.equal(r.calls.length, 0, 'no paid call when local passes');
  assert.equal(fs.readFileSync(path.join(r.worktree, 'fixed'), 'utf8').trim(), 'local');
});

test('auto: local attempt fails the tests - reset, then claude', () => {
  const r = dispatch(setup({ withTests: true }), 'junk');
  assert.equal(r.res.status, 0, r.log);
  assert.equal(r.end.escalated, true);
  assert.equal(r.claudeRan, true);
  assert.equal(fs.existsSync(path.join(r.worktree, 'junk.txt')), false, 'local attempt was not thrown away');
  assert.match(r.log, /tests failed .* escalating to claude/);
  // the paid run is in the ledger with its real cost; the log stays readable
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].provider, 'anthropic');
  assert.equal(r.calls[0].cost_usd, 0.05);
  assert.equal(r.calls[0].input_tokens, 110);
  assert.equal(r.calls[0].run_id, 'run-1');
  assert.match(r.log, /^done$/m);
  // claude's steps stream into the log as they happen, inputs summarised
  assert.match(r.log, /== claude started \(model claude-sonnet-test\)/);
  assert.match(r.log, /🔧 Edit fixed/);
  assert.match(r.log, /== claude finished: success · 2 turns · \$0\.0500/);
  assert.ok(!r.log.includes('SECRET-CONTENT'), 'a tool input body leaked into the log');
});

test('claude: the run exits with claude\'s code, not the log formatter\'s', () => {
  const t = setup({ withTests: false });
  fs.writeFileSync(path.join(t.bin, 'claude'), '#!/usr/bin/env bash\necho \'{"type":"result","subtype":"error_max_turns","is_error":true}\'\nexit 7\n', { mode: 0o755 });
  const r = dispatch(t, 'fix');
  assert.equal(r.res.status, 7, r.log);
  assert.equal(r.end.status, 'failed');
  assert.equal(r.end.exit_code, 7);
});

test('auto: local agent errors - claude takes over', () => {
  const r = dispatch(setup({ withTests: true }), 'fail');
  assert.equal(r.end.escalated, true);
  assert.equal(r.claudeRan, true);
  assert.match(r.log, /failed \(exit 3\) - escalating/);
});

test('auto: no tests in the repo - straight to claude, local never tried', () => {
  const r = dispatch(setup({ withTests: false }), 'fix');
  assert.equal(r.end.escalated, true);
  assert.equal(r.claudeRan, true);
  assert.equal(fs.readFileSync(path.join(r.worktree, 'fixed'), 'utf8').trim(), 'claude');
  assert.match(r.log, /no tests to check/);
});

test('the run log records the task title and specialist, not the appended guidance', () => {
  const t = setup({ withTests: false });
  fs.writeFileSync(t.prompt, 'Short task\n---\nSpecialist role: work this task as Code Reviewer\nlots of guidance');
  const res = spawnSync(BASH, [posix(SCRIPT), 'noop', posix(t.repo), 'task/x', posix(t.prompt), 'run-1'], {
    encoding: 'utf8',
    env: { ...process.env, AGENT_RUNS_DIR: posix(t.runs), AGENT_TASK_TITLE: 'Short task', AGENT_SPECIALIST: 'engineering-code-reviewer' },
  });
  assert.equal(res.status, 0, res.stderr);
  const start = JSON.parse(fs.readFileSync(path.join(t.runs, 'runs.jsonl'), 'utf8').trim().split('\n')[0]);
  assert.equal(start.task, 'Short task');
  assert.equal(start.specialist, 'engineering-code-reviewer');
});

test('without a specialist the run log has no specialist field', () => {
  const t = setup({ withTests: false });
  const env = { ...process.env, AGENT_RUNS_DIR: posix(t.runs) };
  delete env.AGENT_SPECIALIST;
  delete env.AGENT_TASK_TITLE;
  const res = spawnSync(BASH, [posix(SCRIPT), 'noop', posix(t.repo), 'task/x', posix(t.prompt), 'run-1'], { encoding: 'utf8', env });
  assert.equal(res.status, 0, res.stderr);
  const start = JSON.parse(fs.readFileSync(path.join(t.runs, 'runs.jsonl'), 'utf8').trim().split('\n')[0]);
  assert.equal('specialist' in start, false);
  assert.equal(start.task, 'make the tests pass');
});
