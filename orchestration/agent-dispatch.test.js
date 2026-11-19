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
[ -n "$CLAUDE_ARGS" ] && printf '%s\\n' "$@" > "$CLAUDE_ARGS"
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

test('a follow-up resumes the earlier claude session and records its parent run', () => {
  const t = setup({ withTests: false });
  const argsFile = path.join(t.dir, 'claude-args');
  const res = spawnSync(BASH, [posix(SCRIPT), 'claude', posix(t.repo), 'task/x', posix(t.prompt), 'run-2'], {
    encoding: 'utf8',
    env: {
      ...process.env, PATH: `${t.bin}${path.delimiter}${process.env.PATH}`, AGENT_RUNS_DIR: posix(t.runs),
      CLAUDE_ARGS: posix(argsFile), CLAUDE_MARK: posix(path.join(t.dir, 'm')), AI_CALLS_FILE: posix(path.join(t.dir, 'ai.jsonl')),
      AGENT_RESUME_SESSION: '0f4c2a1e-8b7d-4c3a-9e2f-1a2b3c4d5e6f', AGENT_PARENT_RUN: 'run-1',
    },
  });
  assert.equal(res.status, 0, res.stderr);
  const args = fs.readFileSync(argsFile, 'utf8').split('\n');
  const i = args.indexOf('--resume');
  assert.ok(i > 0, 'claude got --resume');
  assert.equal(args[i + 1], '0f4c2a1e-8b7d-4c3a-9e2f-1a2b3c4d5e6f');
  const start = JSON.parse(fs.readFileSync(path.join(t.runs, 'runs.jsonl'), 'utf8').trim().split('\n')[0]);
  assert.equal(start.parent, 'run-1');
});

test('a malformed session id is never passed to claude', () => {
  const t = setup({ withTests: false });
  const argsFile = path.join(t.dir, 'claude-args');
  const res = spawnSync(BASH, [posix(SCRIPT), 'claude', posix(t.repo), 'task/x', posix(t.prompt), 'run-3'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${t.bin}${path.delimiter}${process.env.PATH}`, AGENT_RUNS_DIR: posix(t.runs), CLAUDE_ARGS: posix(argsFile),
      CLAUDE_MARK: posix(path.join(t.dir, 'm')), AI_CALLS_FILE: posix(path.join(t.dir, 'ai.jsonl')), AGENT_RESUME_SESSION: 'x; rm -rf /' },
  });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(fs.readFileSync(argsFile, 'utf8').includes('--resume'), false);
});

// --- approval levels and cards (approval-levels.js, approval-mcp.js) ---------

function runClaude(t, extraEnv, runId = 'run-a') {
  const argsFile = path.join(t.dir, `claude-args-${runId}`);
  const res = spawnSync(BASH, [posix(SCRIPT), 'claude', posix(t.repo), `task/${runId}`, posix(t.prompt), runId], {
    encoding: 'utf8',
    env: {
      ...process.env, PATH: `${t.bin}${path.delimiter}${process.env.PATH}`, AGENT_RUNS_DIR: posix(t.runs),
      CLAUDE_ARGS: posix(argsFile), CLAUDE_MARK: posix(path.join(t.dir, 'm')), AI_CALLS_FILE: posix(path.join(t.dir, 'ai.jsonl')),
      ...extraEnv,
    },
  });
  assert.equal(res.status, 0, res.stderr);
  return fs.readFileSync(argsFile, 'utf8').split('\n');
}

test('with a run token, claude asks through the approval helper; the config is removed after', () => {
  const t = setup({ withTests: false });
  const args = runClaude(t, { APPROVAL_TOKEN: 'tok-123', CLAUDE_PERMISSION_MODE: 'default', AGENT_LEVEL: 'ask' });
  const i = args.indexOf('--permission-prompt-tool');
  assert.equal(args[i + 1], 'mcp__arunachala_approvals__approve');
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'default');
  const cfg = args[args.indexOf('--mcp-config') + 1];
  assert.ok(cfg.endsWith('run-a.mcp.json'));
  assert.ok(!fs.existsSync(cfg), 'the config with the token is removed when the run ends');
  assert.ok(!args.join(' ').includes('tok-123'), 'the token is never on the command line');
  const start = JSON.parse(fs.readFileSync(path.join(t.runs, 'runs.jsonl'), 'utf8').trim().split('\n')[0]);
  assert.equal(start.level, 'ask');
});

test('without a token nothing is asked, as before', () => {
  const t = setup({ withTests: false });
  const args = runClaude(t, {});
  assert.equal(args.indexOf('--permission-prompt-tool'), -1);
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'acceptEdits');
});

test('a review gets the diff as a file that git ignores', () => {
  const t = setup({ withTests: false });
  spawnSync('git', ['-C', t.repo, 'remote', 'add', 'origin', t.repo]);
  spawnSync('git', ['-C', t.repo, 'fetch', '-q', 'origin']);
  runClaude(t, { AGENT_REVIEW_BASE: 'main' }, 'run-r');
  const start = JSON.parse(fs.readFileSync(path.join(t.runs, 'runs.jsonl'), 'utf8').trim().split('\n')[0]);
  assert.ok(fs.existsSync(path.join(start.worktree, '.arunachala-review.diff')), 'diff written');
  const status = spawnSync('git', ['-C', start.worktree, 'status', '--porcelain'], { encoding: 'utf8' }).stdout;
  assert.ok(!status.includes('.arunachala-review.diff'), 'and ignored by git');
});
