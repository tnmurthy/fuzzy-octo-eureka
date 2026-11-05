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
  const res = spawnSync(BASH, [posix(SCRIPT), 'auto', posix(t.repo), 'task/x', posix(t.prompt), 'run-1'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${t.bin}${path.delimiter}${process.env.PATH}`,
      AGENT_RUNS_DIR: posix(t.runs),
      HERMES_BIN: posix(path.join(t.bin, 'hermes-stub')),
      STUB_LOCAL: stubLocal,
      CLAUDE_MARK: posix(mark),
    },
  });
  const lines = fs.readFileSync(path.join(t.runs, 'runs.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const worktree = path.join(t.dir, 'repo--task-x');
  return { res, end: lines.at(-1), claudeRan: fs.existsSync(mark), worktree, log: fs.readFileSync(path.join(t.runs, 'run-1.log'), 'utf8') };
}

test('auto: local fix passes the tests - claude never runs', () => {
  const r = dispatch(setup({ withTests: true }), 'fix');
  assert.equal(r.res.status, 0, r.log);
  assert.equal(r.end.status, 'done');
  assert.equal(r.end.escalated, false);
  assert.equal(r.claudeRan, false);
  assert.equal(fs.readFileSync(path.join(r.worktree, 'fixed'), 'utf8').trim(), 'local');
});

test('auto: local attempt fails the tests - reset, then claude', () => {
  const r = dispatch(setup({ withTests: true }), 'junk');
  assert.equal(r.res.status, 0, r.log);
  assert.equal(r.end.escalated, true);
  assert.equal(r.claudeRan, true);
  assert.equal(fs.existsSync(path.join(r.worktree, 'junk.txt')), false, 'local attempt was not thrown away');
  assert.match(r.log, /tests failed .* escalating to claude/);
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
