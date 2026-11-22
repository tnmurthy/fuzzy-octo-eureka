// task-feed.js - plain-language task status and "what changed" events for
// the /agents page. Pure functions, no DOM: loaded in the browser as
// window.TaskFeed and in node by task-feed.test.js.
//
// Feedback this answers (2026-11-22): people could not tell what state their
// task was in, and nothing told them when a task (or a follow-up) finished or
// when an agent was waiting for their Allow/Deny.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TaskFeed = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // One stage per task, in the words a non-developer would use.
  const STAGES = {
    'needs-you': { label: 'Needs you', tone: 'amber', order: 0 },
    working: { label: 'Working', tone: 'blue', order: 1 },
    queued: { label: 'Queued', tone: 'muted', order: 2 },
    review: { label: 'Ready for review', tone: 'green', order: 3 },
    done: { label: 'Done', tone: 'green', order: 4 },
    failed: { label: 'Failed', tone: 'red', order: 5 },
    stopped: { label: 'Stopped', tone: 'muted', order: 6 },
  };

  const clip = (s, n) => {
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    return t.length > n ? `${t.slice(0, n - 1)}…` : t;
  };

  /**
   * @param {object} run         slim run from /api/agents/overview
   * @param {object[]} approvals pending approvals ({runId, tool})
   * @returns {{key: string, label: string, tone: string, next: string}}
   */
  function stageOf(run, approvals = []) {
    const asks = approvals.filter((a) => a.runId === run.id);
    if (run.status === 'running' && asks.length) {
      return { key: 'needs-you', ...STAGES['needs-you'], next: `Agent is waiting for your Allow/Deny on ${asks[0].tool}. Unanswered requests are denied.` };
    }
    if (run.question) return { key: 'needs-you', ...STAGES['needs-you'], question: run.question, next: `Agent asks: ${clip(run.question, 200)}` };
    if (run.status === 'running') return { key: 'working', ...STAGES.working, next: 'Agent is working. You will get an alert when it finishes.' };
    if (run.status === 'stopped') return { key: 'stopped', ...STAGES.stopped, next: run.canFollowUp ? 'You stopped this task. Follow up to continue it.' : 'You stopped this task.' };
    if (run.status === 'failed' || run.status === 'timed_out' || run.status === 'stale') return { key: 'failed', ...STAGES.failed, next: 'Open the log to see why, then follow up or retry.' };
    if (run.commits_ahead > 0) return { key: 'review', ...STAGES.review, next: `${run.commits_ahead} change(s) on a draft branch. Review the deliverable, then push & open a PR or follow up.` };
    return { key: 'done', ...STAGES.done, next: run.canFollowUp ? 'Finished with no code changes. Read the answer, or follow up to continue.' : 'Finished with no code changes. Read the answer.' };
  }

  /**
   * Running + recent runs as one list, newest first, "needs you" on top.
   * Only runs started within `windowMs` (default 24 h) and at most `limit`.
   */
  function myTasks({ running = [], recent = [], approvals = [], queued = [], now = Date.now(), windowMs = 24 * 3600e3, limit = 8 } = {}) {
    const seen = new Set();
    const all = [];
    // GitHub issues waiting for the poller: not runs yet, shown so a task sent
    // as an issue does not vanish until the poller picks it up.
    for (const i of queued) {
      all.push({ issue: i, run: { id: `issue:${i.repo}#${i.number}`, task: i.title }, stage: { key: 'queued', ...STAGES.queued, next: 'Waiting for a free agent; starts within about a minute.' }, started: Infinity });
    }
    for (const r of [...running, ...recent]) {
      if (!r || !r.id || seen.has(r.id)) continue;
      seen.add(r.id);
      const started = Date.parse(r.started_at);
      if (r.status !== 'running' && Number.isFinite(started) && now - started > windowMs) continue;
      all.push({ run: r, stage: stageOf(r, approvals), started: Number.isFinite(started) ? started : 0 });
    }
    const urgent = (t) => (t.stage.key === 'needs-you' ? 0 : 1);
    all.sort((a, b) => urgent(a) - urgent(b) || b.started - a.started);
    return all.slice(0, limit);
  }

  /** What the browser remembers between polls (and page loads). */
  function snapshotOf({ running = [], approvals = [] } = {}) {
    return { running: running.map((r) => r.id), approvals: approvals.map((a) => a.id) };
  }

  /**
   * Events between two polls. `prev` null = first look this session: nothing
   * is announced, except runs that a stored snapshot says were running and
   * have finished since (reported once as "while you were away").
   */
  function diffEvents(prev, { running = [], recent = [], approvals = [] } = {}) {
    if (!prev) return [];
    const events = [];
    const runningNow = new Set(running.map((r) => r.id));
    for (const id of prev.running || []) {
      if (runningNow.has(id)) continue;
      const r = recent.find((x) => x.id === id);
      if (!r) continue; // not in the recent list yet: wait for the next poll
      if (r.status === 'stopped') continue; // the person did this; no news
      const failed = r.status !== 'done';
      const kind = r.question ? 'question' : failed ? 'failed' : r.parent ? 'followup-done' : 'done';
      const title = r.question ? 'Agent has a question' : failed ? 'Task failed' : r.parent ? 'Follow-up finished' : 'Task finished';
      const body = r.question ? clip(r.question, 140) : `${clip(r.task, 120)}${!failed && r.commits_ahead ? ` (${r.commits_ahead} change(s) ready to review)` : ''}`;
      events.push({ kind, runId: id, title, body });
    }
    const askedBefore = new Set(prev.approvals || []);
    for (const a of approvals) {
      if (askedBefore.has(a.id)) continue;
      events.push({ kind: 'approval', runId: a.runId, approvalId: a.id, title: 'Agent needs your approval', body: clip(`${a.tool} in ${a.repo}: ${a.summary || ''}`, 140) });
    }
    return events;
  }

  /** Runs in `prev` still unresolved: kept so that a poll that misses a run does not drop it. */
  function carryRunning(prev, { running = [], recent = [] } = {}) {
    const now = new Set(running.map((r) => r.id));
    const resolved = new Set(recent.map((r) => r.id));
    const keep = (prev && prev.running ? prev.running : []).filter((id) => !now.has(id) && !resolved.has(id));
    return [...now, ...keep];
  }

  return { STAGES, stageOf, myTasks, snapshotOf, diffEvents, carryRunning, clip };
});
