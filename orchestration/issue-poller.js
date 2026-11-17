// issue-poller.js - GitHub issues are the agents' work queue.
//
//   you label an issue agent:ready
//     -> poller claims it (agent:running), branches from the default branch,
//        and dispatches it through POST /api/dispatch/run
//     -> agent-dispatch.sh runs the agent in its own worktree (no push)
//     -> on finish: commits -> poller pushes the branch and opens a PR that
//        closes the issue (agent:review); no commits -> agent:no-changes;
//        failure -> agent:failed with the run id and log path
//
// Only issues opened by POLLER_AUTHORS (default: the repo owner) are run, so
// anyone else who can label an issue still cannot spend agent time. Agent per
// issue: an agent:<name> label (claude, hermes, codex, noop, auto), else
// POLLER_DEFAULT_AGENT (claude). Text the dashboard's safety filter refuses
// (rm -rf, force push, ...) runs only with an agent:confirmed label.
//
// The core (createPoller) takes every side effect as a dependency and is
// tested with stubs; the bottom of this file wires the real ones.

const LABELS = {
  ready: 'agent:ready',
  running: 'agent:running',
  review: 'agent:review',
  failed: 'agent:failed',
  noChanges: 'agent:no-changes',
  confirmed: 'agent:confirmed',
};

const LABEL_DEFS = [
  { name: LABELS.ready, color: '0e8a16', description: 'Queue this issue for an agent' },
  { name: LABELS.running, color: 'fbca04', description: 'An agent is working on this issue' },
  { name: LABELS.review, color: '1d76db', description: 'Agent opened a PR; needs human review' },
  { name: LABELS.failed, color: 'b60205', description: 'Agent run failed; see comment' },
  { name: LABELS.noChanges, color: 'cccccc', description: 'Agent finished without committing anything' },
  { name: LABELS.confirmed, color: 'd93f0b', description: 'Owner confirms a task the safety filter flags' },
];

const AGENTS = ['claude', 'hermes', 'codex', 'noop', 'auto'];
const LOST_AFTER_MS = 10 * 60 * 1000; // dispatched but never recorded a run
const MAX_FINISH_ATTEMPTS = 3;
const MAX_BODY_CHARS = 8000;

function pickAgent(labels, fallback) {
  const names = labels.map((l) => (typeof l === 'string' ? l : l.name));
  const chosen = AGENTS.find((a) => names.includes(`agent:${a}`));
  return { agent: chosen || fallback, confirmed: names.includes(LABELS.confirmed) };
}

const MAX_REVIEW_CHARS = 60000;

function buildReviewTask({ repo, number, pr, base, title, issueBody }) {
  return [
    `Review pull request #${pr} in ${repo}: the changes on this branch, which close issue #${number} ("${title}").`,
    '',
    `Read the change with \`git diff origin/${base}...HEAD\` and open whatever files you need for context.`,
    'You are a reviewer: do not edit files and do not commit.',
    '',
    'Reply in markdown, under 400 words:',
    '- First line: **Verdict:** approve | request changes',
    '- Then findings, most severe first. Each: `file:line`, what is wrong, and a concrete input or state that breaks it.',
    '- Check: does it do what the issue asks, correctness, tests for the new behaviour, security (secrets, injection, auth).',
    '- If nothing blocks a merge, say "No blocking issues" and list at most 3 optional improvements.',
    '',
    'Issue text, for intent:',
    String(issueBody || '(no description)').slice(0, 3000),
  ].join('\n');
}

function buildTask(repo, issue) {
  const body = String(issue.body || '(no description)').slice(0, MAX_BODY_CHARS);
  return [
    `GitHub issue ${repo}#${issue.number}: ${issue.title}`,
    '',
    body,
    '',
    '---',
    'Done means: the change is committed on this branch and the repo\'s tests pass.',
    `A pull request that closes #${issue.number} is opened for you after the run - do not push.`,
  ].join('\n');
}

/**
 * @param {object} deps
 * @param {object} deps.github      github-client.js instance
 * @param {Function} deps.dispatch  ({agent, repo, branch, task, confirmed}) => Promise<{runId}>
 * @param {Function} deps.git       (args: string[], cwd: string) => string
 * @param {Function} deps.readRuns  () => run[]
 * @param {Function} deps.loadState () => {active}
 * @param {Function} deps.saveState (state) => void
 * @param {Array<{repo: string, path: string, name: string}>} deps.repos
 * @param {string[]} [deps.authors]
 * @param {number} [deps.maxConcurrent]
 * @param {string} [deps.defaultAgent]
 * @param {Function} [deps.now]
 * @param {Function} [deps.log]
 */
function createPoller(deps) {
  const {
    github, dispatch, git, readRuns, loadState, saveState, repos,
    maxConcurrent = 2, defaultAgent = 'claude', reviewAgent = 'claude',
    readLog = () => '',
    now = Date.now, log = console.log,
  } = deps;
  const authors = (deps.authors || []).map((a) => a.toLowerCase());
  const defaultBranches = new Map();
  let state = loadState() || { active: {} };
  if (!state.active) state.active = {};

  const persist = () => saveState(state);
  const activeCount = () => Object.keys(state.active).length;

  async function defaultBranch(repo) {
    if (!defaultBranches.has(repo)) defaultBranches.set(repo, (await github.getRepo(repo)).default_branch);
    return defaultBranches.get(repo);
  }

  function allowedAuthors(repo) {
    return authors.length ? authors : [repo.split('/')[0].toLowerCase()];
  }

  async function setLabel(repo, number, from, to) {
    await github.removeLabel(repo, number, from);
    await github.addLabels(repo, number, [to]);
  }

  function quietGit(args, cwd) {
    try { git(args, cwd); } catch (_) { /* cleanup is best-effort */ }
  }

  // A second, read-only run on the PR's branch; its answer becomes a PR
  // comment. It reuses the worktree, which is removed once the review is in.
  async function startReview(job, pr, run) {
    const { runId } = await dispatch({
      agent: reviewAgent,
      repo: job.name,
      branch: job.branch,
      task: buildReviewTask({ repo: job.repo, number: job.number, pr, base: job.base, title: job.title, issueBody: job.issueBody }),
      readOnly: true,
    });
    state.active[runId] = {
      ...job, kind: 'review', pr, agent: reviewAgent, dispatchedAt: now(),
      commitsBefore: Number(run.commits_ahead) || 0, worktree: run.worktree,
    };
    log(`[poller] ${job.repo}#${pr} review -> ${reviewAgent} run ${runId}`);
  }

  async function finishReview(runId, job, run) {
    const { repo, pr, path } = job;
    let body;
    if (run.status === 'done') {
      const text = String(readLog(run.log) || '').trim().slice(0, MAX_REVIEW_CHARS);
      body = `### Agent review (\`${job.agent}\`, run \`${runId}\`)\n\n${text || '_The reviewer returned no text._'}`;
      if ((Number(run.commits_ahead) || 0) !== job.commitsBefore) {
        body += `\n\n> **Warning:** the branch changed during the review (${job.commitsBefore} -> ${run.commits_ahead} commits). Check the branch before merging.`;
      }
    } else {
      body = `Agent review run \`${runId}\` ended **${run.status}**.${run.log ? ` Log on the agent host: \`${run.log}\`.` : ''} Review this PR by hand.`;
    }
    await github.comment(repo, pr, body);
    if (job.worktree) quietGit(['worktree', 'remove', job.worktree], path);
  }

  async function finish(runId, job, run) {
    if (job.kind === 'review') return finishReview(runId, job, run);
    const { repo, number, branch, path } = job;
    const commits = Number(run.commits_ahead) || 0;

    if (run.status === 'done' && commits > 0) {
      git(['push', '-u', 'origin', `${branch}:${branch}`], path);
      const pr = await github.createPull(repo, {
        head: branch,
        base: job.base,
        title: job.title,
        body: `Closes #${number}\n\nAgent \`${job.agent}\`, run \`${runId}\`, ${run.duration_s ?? '?'}s, ${commits} commit(s).`,
      });
      await setLabel(repo, number, LABELS.running, LABELS.review);
      const reviewing = reviewAgent !== 'off';
      await github.comment(repo, number, `Opened #${pr.number} for review.${reviewing ? ` An agent review (\`${reviewAgent}\`) will be posted on it.` : ''}`);
      if (reviewing) {
        try {
          await startReview(job, pr.number, run);
          return;
        } catch (err) {
          await github.comment(repo, pr.number, `Could not start the agent review: ${err.message}. Review this PR by hand.`);
        }
      }
      if (run.worktree) quietGit(['worktree', 'remove', run.worktree], path);
      return;
    }

    if (run.status === 'done') {
      await setLabel(repo, number, LABELS.running, LABELS.noChanges);
      await github.comment(repo, number, `Run \`${runId}\` (\`${job.agent}\`) finished without committing anything. Add more detail and re-label \`${LABELS.ready}\` to retry.`);
      if (run.worktree) quietGit(['worktree', 'remove', run.worktree], path);
      quietGit(['branch', '-D', branch], path);
      return;
    }

    // failed, timed_out, stale, lost: keep the worktree for inspection.
    await setLabel(repo, number, LABELS.running, LABELS.failed);
    const where = run.log ? ` Log on the agent host: \`${run.log}\`.` : ' It never recorded a run - see `logs/dispatch.log` on the agent host.';
    const exit = run.exit_code !== undefined ? `, exit ${run.exit_code}` : '';
    await github.comment(repo, number, `Run \`${runId}\` (\`${job.agent}\`) ended **${run.status}**${exit}.${where} Re-label \`${LABELS.ready}\` to retry.`);
  }

  async function reconcile() {
    const ids = Object.keys(state.active);
    if (!ids.length) return;
    const byId = new Map(readRuns().map((r) => [r.id, r]));
    for (const runId of ids) {
      const job = state.active[runId];
      let run = byId.get(runId);
      if (!run) {
        if (now() - job.dispatchedAt < LOST_AFTER_MS) continue;
        run = { status: 'lost' };
      }
      if (run.status === 'running') continue;
      try {
        await finish(runId, job, run);
        delete state.active[runId];
      } catch (err) {
        job.attempts = (job.attempts || 0) + 1;
        log(`[poller] finishing ${job.repo}#${job.number} (attempt ${job.attempts}) failed: ${err.message}`);
        if (job.attempts >= MAX_FINISH_ATTEMPTS) {
          delete state.active[runId];
          try {
            if (job.kind === 'review') {
              await github.comment(job.repo, job.pr, `Agent review run \`${runId}\` could not be posted: ${err.message}. Review this PR by hand.`);
            } else {
              await setLabel(job.repo, job.number, LABELS.running, LABELS.failed);
              await github.comment(job.repo, job.number, `Run \`${runId}\` finished but could not be handed back: ${err.message}. Branch \`${job.branch}\` is on the agent host.`);
            }
          } catch (_) { /* GitHub itself is failing; the log line above stands */ }
        }
      }
      persist();
    }
  }

  async function claimOne(target, issue) {
    const { repo, number } = { repo: target.repo, number: issue.number };
    const login = String(issue.user && issue.user.login || '').toLowerCase();
    if (!allowedAuthors(repo).includes(login)) {
      await github.removeLabel(repo, number, LABELS.ready);
      await github.comment(repo, number, `Not queued: only issues opened by ${allowedAuthors(repo).join(', ')} are run by agents.`);
      return;
    }

    await setLabel(repo, number, LABELS.ready, LABELS.running);
    const { agent, confirmed } = pickAgent(issue.labels || [], defaultAgent);
    const base = await defaultBranch(repo);
    const branch = `agent/issue-${number}-${now().toString(36)}`;

    try {
      git(['fetch', 'origin', base], target.path);
      git(['branch', branch, `origin/${base}`], target.path);
      const { runId } = await dispatch({ agent, repo: target.name, branch, task: buildTask(repo, issue), confirmed });
      state.active[runId] = {
        repo, number, branch, base, agent, path: target.path, name: target.name,
        title: issue.title, issueBody: String(issue.body || '').slice(0, 3000), dispatchedAt: now(),
      };
      persist();
      await github.comment(repo, number, `Started run \`${runId}\` with \`${agent}\` on branch \`${branch}\`.`);
      log(`[poller] ${repo}#${number} -> ${agent} run ${runId}`);
    } catch (err) {
      quietGit(['branch', '-D', branch], target.path);
      await setLabel(repo, number, LABELS.running, LABELS.failed);
      const hint = /safety|risky|destructive/i.test(err.message) ? ` If this is intended, add \`${LABELS.confirmed}\` and re-label \`${LABELS.ready}\`.` : '';
      await github.comment(repo, number, `Could not start an agent: ${err.message}.${hint}`);
      log(`[poller] ${repo}#${number} dispatch failed: ${err.message}`);
    }
  }

  async function claim() {
    for (const target of repos) {
      if (activeCount() >= maxConcurrent) return;
      let issues;
      try {
        issues = await github.listIssuesWithLabel(target.repo, LABELS.ready);
      } catch (err) {
        log(`[poller] listing ${target.repo} failed: ${err.message}`);
        continue;
      }
      for (const issue of issues) {
        if (activeCount() >= maxConcurrent) return;
        await claimOne(target, issue);
      }
    }
  }

  async function ensureLabels() {
    for (const target of repos) {
      for (const def of LABEL_DEFS) await github.ensureLabel(target.repo, def);
    }
  }

  return {
    async tick() {
      await reconcile();
      await claim();
    },
    ensureLabels,
    state: () => state,
  };
}

module.exports = { createPoller, pickAgent, buildTask, buildReviewTask, LABELS, LABEL_DEFS, LOST_AFTER_MS };

// ---------------------------------------------------------------------------
// Process entry point (PM2: IssuePoller in ecosystem.config.js).
if (require.main === module) {
  const fs = require('fs');
  const path = require('path');
  const { execFileSync } = require('child_process');
  const ROOT = path.resolve(__dirname, '..');
  require('../load-env').loadEnv(ROOT);
  const { createGitHubClient } = require('./github-client');
  const { readRuns } = require('../runs-reader');

  const STATE_FILE = path.join(ROOT, 'logs', 'issue-poller-state.json');
  const RUNS_FILE = process.env.AGENT_RUNS_FILE || path.join(ROOT, '..', '..', '04_internal', 'agent-runs', 'runs.jsonl');
  const DASHBOARD = process.env.DASHBOARD_URL || 'http://127.0.0.1:8787';
  const INTERVAL_MS = Number(process.env.POLLER_INTERVAL_MS) || 60000;
  const IDLE_LOG_MS = 60 * 60 * 1000;

  const git = (args, cwd) => execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 120000,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_SSH_COMMAND: 'ssh -o BatchMode=yes', GIT_TERMINAL_PROMPT: '0' },
  });

  // POLLER_REPOS=owner/name=/abs/path,owner2/name2=/abs/path2. Default: this
  // checkout and its origin remote.
  function parseRepos() {
    const spec = process.env.POLLER_REPOS;
    if (spec) {
      return spec.split(',').map((s) => s.trim()).filter(Boolean).map((entry) => {
        const [repo, p] = entry.split('=');
        return { repo, path: p, name: path.basename(p) };
      });
    }
    const url = git(['remote', 'get-url', 'origin'], ROOT).trim();
    const m = url.match(/github\.com[:/]([^/]+\/[^/]+?)(\.git)?$/);
    if (!m) throw new Error(`cannot derive owner/name from origin ${url}; set POLLER_REPOS`);
    return [{ repo: m[1], path: ROOT, name: path.basename(ROOT) }];
  }

  async function dispatch(payload) {
    const res = await fetch(`${DASHBOARD}/api/dispatch/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.runId) throw new Error(body.error || `dashboard HTTP ${res.status}`);
    return { runId: body.runId };
  }

  function loadState() {
    try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (_) { return { active: {} }; }
  }
  function saveState(s) {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    const tmp = `${STATE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
    fs.renameSync(tmp, STATE_FILE);
  }

  let poller = null;
  let busy = false;
  let lastIdleLog = 0;

  async function loop() {
    if (busy) return;
    busy = true;
    try {
      if (!poller) {
        if (!process.env.GITHUB_TOKEN) {
          if (Date.now() - lastIdleLog > IDLE_LOG_MS) {
            console.error('[poller] idle: GITHUB_TOKEN is not set (add it to the secrets file named by SECRETS_ENV_FILE, then pm2 restart IssuePoller --update-env)');
            lastIdleLog = Date.now();
          }
          return;
        }
        const repos = parseRepos();
        poller = createPoller({
          github: createGitHubClient({ token: process.env.GITHUB_TOKEN }),
          dispatch, git,
          readRuns: () => readRuns(RUNS_FILE, 5000).runs || [],
          loadState, saveState, repos,
          authors: (process.env.POLLER_AUTHORS || '').split(',').map((s) => s.trim()).filter(Boolean),
          maxConcurrent: Number(process.env.POLLER_MAX_CONCURRENT) || 2,
          defaultAgent: process.env.POLLER_DEFAULT_AGENT || 'claude',
          // claude (default) | noop | off. Only agents the dashboard can
          // lock to read-only tools may review.
          reviewAgent: process.env.POLLER_REVIEW_AGENT || 'claude',
          readLog: (file) => {
            if (!file) return '';
            try {
              const text = fs.readFileSync(file, 'utf8');
              return text.length > 200000 ? text.slice(-200000) : text;
            } catch (_) { return ''; }
          },
        });
        await poller.ensureLabels();
        console.log(`[poller] watching ${repos.map((r) => r.repo).join(', ')} every ${INTERVAL_MS / 1000}s`);
      }
      await poller.tick();
    } catch (err) {
      console.error(`[poller] tick failed: ${err.message}`);
      if (/401|403/.test(err.message)) poller = null; // re-read the token next time
    } finally {
      busy = false;
    }
  }

  loop();
  setInterval(loop, INTERVAL_MS);
}
