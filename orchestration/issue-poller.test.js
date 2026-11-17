// node --test orchestration/issue-poller.test.js
//
// GitHub, the dashboard, git and the run log are all stubs: these tests pin
// what the poller asks of them for each issue and run state.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPoller, pickAgent, buildTask, LABELS, LOST_AFTER_MS } = require('./issue-poller');
const { createGitHubClient } = require('./github-client');

const REPO = 'tnmurthy/demo';

function fakeGitHub(issues = []) {
  const calls = [];
  const rec = (name) => async (...args) => { calls.push([name, ...args]); };
  return {
    calls,
    getRepo: async () => ({ default_branch: 'main' }),
    listIssuesWithLabel: async (repo, label) => { calls.push(['list', repo, label]); return issues; },
    addLabels: rec('add'),
    removeLabel: rec('remove'),
    comment: rec('comment'),
    ensureLabel: rec('ensure'),
    createPull: async (repo, pr) => { calls.push(['pull', repo, pr]); return { number: 99 }; },
  };
}

function setup({ issues = [], runs = [], state = { active: {} }, dispatchImpl, gitImpl, now = () => 1_000_000, maxConcurrent = 2, authors, reviewAgent = 'off', reviewSpecialist = null, readLog } = {}) {
  const github = fakeGitHub(issues);
  const gitCalls = [];
  const dispatched = [];
  let saved = state;
  const poller = createPoller({
    github,
    dispatch: dispatchImpl || (async (p) => { dispatched.push(p); return { runId: `run-${dispatched.length}` }; }),
    git: (args, cwd) => { gitCalls.push(args); return gitImpl ? gitImpl(args, cwd) : ''; },
    readRuns: () => runs,
    loadState: () => JSON.parse(JSON.stringify(state)),
    saveState: (s) => { saved = JSON.parse(JSON.stringify(s)); },
    repos: [{ repo: REPO, path: '/work/demo', name: 'demo' }],
    authors, maxConcurrent, now, log: () => {}, reviewAgent, reviewSpecialist, readLog,
  });
  return { poller, github, gitCalls, dispatched, saved: () => saved };
}

const issue = (number, extra = {}) => ({ number, title: `Issue ${number}`, body: 'Do the thing', user: { login: 'tnmurthy' }, labels: [{ name: LABELS.ready }], ...extra });
const commentsOf = (github) => github.calls.filter((c) => c[0] === 'comment').map((c) => c[3]);

test('agent comes from an agent:<name> label, else the default; agent:confirmed is passed on', () => {
  assert.deepEqual(pickAgent([{ name: 'agent:hermes' }], 'claude'), { agent: 'hermes', confirmed: false, specialist: null });
  assert.deepEqual(pickAgent(['bug', 'agent:confirmed'], 'claude'), { agent: 'claude', confirmed: true, specialist: null });
  assert.deepEqual(pickAgent(['agent:rm'], 'claude'), { agent: 'claude', confirmed: false, specialist: null });
  assert.deepEqual(pickAgent(['specialist:engineering-frontend-developer'], 'claude').specialist, 'engineering-frontend-developer');
  assert.equal(pickAgent(['specialist:../x'], 'claude').specialist, null, 'malformed slugs are ignored');
});

test('the task names the issue, carries its body, and tells the agent not to push', () => {
  const task = buildTask(REPO, issue(7));
  assert.match(task, /tnmurthy\/demo#7: Issue 7/);
  assert.match(task, /Do the thing/);
  assert.match(task, /do not push/);
});

test('a ready issue from the owner is claimed, branched from origin/main and dispatched', async () => {
  const { poller, github, gitCalls, dispatched, saved } = setup({ issues: [issue(7, { labels: [{ name: LABELS.ready }, { name: 'agent:hermes' }] })] });
  await poller.tick();
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].agent, 'hermes');
  assert.equal(dispatched[0].repo, 'demo');
  assert.match(dispatched[0].branch, /^agent\/issue-7-/);
  assert.deepEqual(gitCalls[0], ['fetch', 'origin', 'main']);
  assert.deepEqual(gitCalls[1], ['branch', dispatched[0].branch, 'origin/main']);
  assert.ok(github.calls.some((c) => c[0] === 'remove' && c[3] === LABELS.ready));
  assert.ok(github.calls.some((c) => c[0] === 'add' && c[3][0] === LABELS.running));
  assert.equal(saved().active['run-1'].number, 7);
});

test('an issue opened by someone else is un-queued, not run', async () => {
  const { poller, github, dispatched } = setup({ issues: [issue(8, { user: { login: 'stranger' } })] });
  await poller.tick();
  assert.equal(dispatched.length, 0);
  assert.match(commentsOf(github)[0], /only issues opened by tnmurthy/);
});

test('POLLER_AUTHORS replaces the owner-only default', async () => {
  const { poller, dispatched } = setup({ issues: [issue(8, { user: { login: 'Teammate' } })], authors: ['teammate'] });
  await poller.tick();
  assert.equal(dispatched.length, 1);
});

test('no more than maxConcurrent runs are in flight', async () => {
  const state = { active: { old: { repo: REPO, number: 1, dispatchedAt: 1_000_000 } } };
  const { poller, dispatched } = setup({ issues: [issue(2), issue(3), issue(4)], state, runs: [{ id: 'old', status: 'running' }], maxConcurrent: 2 });
  await poller.tick();
  assert.equal(dispatched.length, 1);
});

test('a refused dispatch marks the issue failed, drops the branch, and hints at agent:confirmed', async () => {
  const { poller, github, gitCalls, saved } = setup({
    issues: [issue(9)],
    dispatchImpl: async () => { throw new Error('Safety filter: destructive command requires confirmation'); },
  });
  await poller.tick();
  assert.ok(github.calls.some((c) => c[0] === 'add' && c[3][0] === LABELS.failed));
  assert.match(commentsOf(github).pop(), /agent:confirmed/);
  assert.equal(gitCalls.at(-1)[0], 'branch');
  assert.equal(gitCalls.at(-1)[1], '-D');
  assert.deepEqual(saved().active, {});
});

const job = { repo: REPO, number: 7, branch: 'agent/issue-7-x', base: 'main', agent: 'claude', path: '/work/demo', title: 'Issue 7', dispatchedAt: 1_000_000 };

test('a run that committed is pushed and opened as a PR that closes the issue', async () => {
  const { poller, github, gitCalls, saved } = setup({
    state: { active: { r1: job } },
    runs: [{ id: 'r1', status: 'done', commits_ahead: 2, duration_s: 30, worktree: '/work/demo--agent-issue-7-x' }],
  });
  await poller.tick();
  assert.deepEqual(gitCalls[0], ['push', '-u', 'origin', 'agent/issue-7-x:agent/issue-7-x']);
  const pull = github.calls.find((c) => c[0] === 'pull')[2];
  assert.equal(pull.head, 'agent/issue-7-x');
  assert.equal(pull.base, 'main');
  assert.match(pull.body, /Closes #7/);
  assert.ok(github.calls.some((c) => c[0] === 'add' && c[3][0] === LABELS.review));
  assert.deepEqual(gitCalls[1], ['worktree', 'remove', '/work/demo--agent-issue-7-x']);
  assert.deepEqual(saved().active, {});
});

test('a run with no commits is labelled no-changes and its branch dropped', async () => {
  const { poller, github, gitCalls } = setup({ state: { active: { r1: job } }, runs: [{ id: 'r1', status: 'done', commits_ahead: 0 }] });
  await poller.tick();
  assert.ok(github.calls.some((c) => c[0] === 'add' && c[3][0] === LABELS.noChanges));
  assert.ok(!github.calls.some((c) => c[0] === 'pull'));
  assert.deepEqual(gitCalls.at(-1), ['branch', '-D', 'agent/issue-7-x']);
});

test('a failed run is labelled failed with its log path, and its worktree is kept', async () => {
  const { poller, github, gitCalls } = setup({ state: { active: { r1: job } }, runs: [{ id: 'r1', status: 'failed', exit_code: 1, log: '/runs/r1.log' }] });
  await poller.tick();
  assert.ok(github.calls.some((c) => c[0] === 'add' && c[3][0] === LABELS.failed));
  assert.match(commentsOf(github)[0], /failed\*\*, exit 1\. Log on the agent host: `\/runs\/r1.log`/);
  assert.equal(gitCalls.length, 0);
});

test('a running run is left alone; a run never recorded is failed only after the grace period', async () => {
  const running = setup({ state: { active: { r1: job } }, runs: [{ id: 'r1', status: 'running' }] });
  await running.poller.tick();
  assert.ok(running.saved().active.r1);

  const early = setup({ state: { active: { r1: job } }, now: () => job.dispatchedAt + 1000 });
  await early.poller.tick();
  assert.ok(early.saved().active.r1);

  const late = setup({ state: { active: { r1: job } }, now: () => job.dispatchedAt + LOST_AFTER_MS + 1 });
  await late.poller.tick();
  assert.deepEqual(late.saved().active, {});
  assert.match(commentsOf(late.github)[0], /lost.*dispatch\.log/);
});

test('a push that keeps failing is retried, then given up on with a comment', async () => {
  const s = setup({
    state: { active: { r1: job } },
    runs: [{ id: 'r1', status: 'done', commits_ahead: 1 }],
    gitImpl: (args) => { if (args[0] === 'push') throw new Error('Permission denied (publickey)'); return ''; },
  });
  await s.poller.tick();
  assert.equal(s.saved().active.r1.attempts, 1);
  await s.poller.tick();
  await s.poller.tick();
  assert.deepEqual(s.saved().active, {});
  assert.match(commentsOf(s.github).pop(), /could not be handed back: Permission denied/);
});

const prRun = { id: 'r1', status: 'done', commits_ahead: 2, duration_s: 30, worktree: '/work/demo--agent-issue-7-x' };
const jobWithMeta = { ...job, name: 'demo', issueBody: 'Make it faster' };

test('a new PR gets a read-only review run on the same branch, and keeps its worktree for it', async () => {
  const { poller, github, gitCalls, dispatched, saved } = setup({ state: { active: { r1: jobWithMeta } }, runs: [prRun], reviewAgent: 'claude' });
  await poller.tick();
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].readOnly, true);
  assert.equal(dispatched[0].agent, 'claude');
  assert.equal(dispatched[0].branch, 'agent/issue-7-x');
  assert.equal(dispatched[0].repo, 'demo');
  assert.match(dispatched[0].task, /pull request #99/);
  assert.match(dispatched[0].task, /do not edit files and do not commit/);
  assert.match(dispatched[0].task, /Make it faster/);
  assert.ok(!gitCalls.some((c) => c[0] === 'worktree'));
  const review = saved().active['run-1'];
  assert.equal(review.kind, 'review');
  assert.equal(review.pr, 99);
  assert.equal(review.commitsBefore, 2);
  assert.match(commentsOf(github)[0], /agent review \(`claude`\) will be posted/);
});

test('a finished review is posted on the PR, then the worktree is removed', async () => {
  const reviewJob = { ...jobWithMeta, kind: 'review', pr: 99, commitsBefore: 2, worktree: '/work/demo--agent-issue-7-x' };
  const { poller, github, gitCalls, saved } = setup({
    state: { active: { rv: reviewJob } },
    runs: [{ id: 'rv', status: 'done', commits_ahead: 2, log: '/runs/rv.log' }],
    readLog: (f) => (f === '/runs/rv.log' ? '**Verdict:** approve\nNo blocking issues' : ''),
  });
  await poller.tick();
  const posted = github.calls.find((c) => c[0] === 'comment');
  assert.equal(posted[2], 99);
  assert.match(posted[3], /Agent review \(`claude`, run `rv`\)/);
  assert.match(posted[3], /Verdict:\*\* approve/);
  assert.ok(!/Warning/.test(posted[3]));
  assert.deepEqual(gitCalls, [['worktree', 'remove', '/work/demo--agent-issue-7-x']]);
  assert.ok(!github.calls.some((c) => c[0] === 'add' || c[0] === 'remove'));
  assert.deepEqual(saved().active, {});
});

test('a review that changed the branch is flagged; a failed review asks for a human', async () => {
  const reviewJob = { ...jobWithMeta, kind: 'review', pr: 99, commitsBefore: 2 };
  const changed = setup({ state: { active: { rv: reviewJob } }, runs: [{ id: 'rv', status: 'done', commits_ahead: 3 }], readLog: () => 'ok' });
  await changed.poller.tick();
  assert.match(commentsOf(changed.github)[0], /Warning:\*\* the branch changed during the review \(2 -> 3/);

  const failed = setup({ state: { active: { rv: reviewJob } }, runs: [{ id: 'rv', status: 'timed_out', log: '/runs/rv.log' }] });
  await failed.poller.tick();
  assert.match(commentsOf(failed.github)[0], /ended \*\*timed_out\*\*.*Review this PR by hand/);
});

test('a review that cannot start leaves a note on the PR and cleans up', async () => {
  const { poller, github, gitCalls, saved } = setup({
    state: { active: { r1: jobWithMeta } }, runs: [prRun], reviewAgent: 'claude',
    dispatchImpl: async () => { throw new Error('dashboard HTTP 500'); },
  });
  await poller.tick();
  const onPr = github.calls.filter((c) => c[0] === 'comment' && c[2] === 99);
  assert.match(onPr[0][3], /Could not start the agent review: dashboard HTTP 500/);
  assert.deepEqual(gitCalls.at(-1), ['worktree', 'remove', prRun.worktree]);
  assert.deepEqual(saved().active, {});
});

test('the GitHub client sends the token as a header and never puts it in an error', async () => {
  const seen = [];
  const fetchImpl = async (url, opts) => {
    seen.push({ url, opts });
    return { ok: false, status: 404, text: async () => JSON.stringify({ message: 'Not Found' }) };
  };
  const gh = createGitHubClient({ token: 'ghp_secret', fetchImpl });
  await assert.rejects(gh.getRepo('a/b'), (err) => {
    assert.match(err.message, /GitHub GET \/repos\/a\/b: 404 Not Found/);
    assert.ok(!err.message.includes('ghp_secret'));
    return true;
  });
  assert.equal(seen[0].opts.headers.Authorization, 'Bearer ghp_secret');
  await gh.removeLabel('a/b', 1, 'agent:ready'); // 404 on remove is fine
  assert.throws(() => createGitHubClient({ token: '' }), /GITHUB_TOKEN is not set/);
});

test('listing issues drops pull requests', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => JSON.stringify([{ number: 1 }, { number: 2, pull_request: {} }]) });
  const gh = createGitHubClient({ token: 't', fetchImpl });
  assert.deepEqual((await gh.listIssuesWithLabel('a/b', 'agent:ready')).map((i) => i.number), [1]);
});

test('a specialist label travels with the dispatch and is kept on the job', async () => {
  const { poller, dispatched, saved } = setup({ issues: [issue(8, { labels: [{ name: LABELS.ready }, { name: 'specialist:engineering-frontend-developer' }] })] });
  await poller.tick();
  assert.equal(dispatched[0].specialist, 'engineering-frontend-developer');
  assert.equal(saved().active['run-1'].specialist, 'engineering-frontend-developer');
});

test('without a specialist label the dispatch payload has no specialist key', async () => {
  const { poller, dispatched } = setup({ issues: [issue(9, { labels: [{ name: LABELS.ready }] })] });
  await poller.tick();
  assert.equal('specialist' in dispatched[0], false);
});

test('reviews use the configured review specialist', async () => {
  const { poller, dispatched } = setup({ state: { active: { r1: jobWithMeta } }, runs: [prRun], reviewAgent: 'claude', reviewSpecialist: 'engineering-code-reviewer' });
  await poller.tick();
  assert.equal(dispatched[0].readOnly, true);
  assert.equal(dispatched[0].specialist, 'engineering-code-reviewer');
});
