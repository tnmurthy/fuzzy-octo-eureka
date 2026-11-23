'use strict';
// agents-mine.js - "My requests" for the Ask page (/agents): the signed-in
// person's agent runs grouped into threads (a request and its follow-ups),
// each with one plain-language stage from task-feed.js. Pure, no I/O.
//
// Owner of a run = its `by` (set by the server since 2026-11-23); runs from
// before that, and runs started at this Mac, belong to "local operator".

const { stageOf } = require('./task-feed');
const { isReadOnlyKind } = require('./request-kinds');

const LOCAL = 'local operator';

// The task text without the wording the dashboard adds to follow-ups.
function plainTitle(task) {
  return String(task || '')
    .replace(/^Follow-up: the person stopped you mid-task and changed direction\.[^:]*: /, '')
    .replace(/^Follow-up: /, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}
const ownerOf = (run) => String(run.by || LOCAL);

/** Root run id for every run, following `parent` links (cycle-safe). */
function rootsOf(runs) {
  const byId = new Map(runs.map((r) => [r.id, r]));
  const roots = new Map();
  for (const r of runs) {
    let cur = r;
    const seen = new Set();
    while (cur.parent && byId.has(cur.parent) && !seen.has(cur.id)) {
      if (roots.has(cur.id)) { cur = byId.get(roots.get(cur.id)); break; }
      seen.add(cur.id);
      cur = byId.get(cur.parent);
    }
    roots.set(r.id, cur.id);
  }
  return roots;
}

/**
 * @param {object} o
 * @param {object[]} o.runs        merged runs, any order
 * @param {string} o.actor         actorOf(req): an email, or "local operator"
 * @param {(run: object) => object} [o.decorate]  adds question / canFollowUp
 * @param {number} [o.now]
 * @param {number} [o.windowMs]    finished threads older than this are left out
 * @param {number} [o.limit]
 */
function myThreads({ runs, actor, decorate = (r) => r, now = Date.now(), windowMs = 7 * 24 * 3600e3, limit = 40 }) {
  const who = String(actor || LOCAL).toLowerCase();
  const roots = rootsOf(runs);
  const byId = new Map(runs.map((r) => [r.id, r]));
  const threads = new Map();
  for (const r of runs) {
    const rootId = roots.get(r.id);
    const root = byId.get(rootId);
    // A thread is yours when you started it.
    if (!root || ownerOf(root).toLowerCase() !== who) continue;
    const t = threads.get(rootId) || { root, runs: [] };
    t.runs.push(r);
    threads.set(rootId, t);
  }
  const out = [];
  for (const [threadId, t] of threads) {
    t.runs.sort((a, b) => String(a.started_at || '').localeCompare(String(b.started_at || '')));
    const latest = t.runs[t.runs.length - 1];
    const updated = Date.parse(latest.finished_at || latest.started_at || '') || 0;
    if (latest.status !== 'running' && now - updated > windowMs) continue;
    // Read-only kinds never change files: commits ahead are only the branch
    // base's, so they must not read as "Ready for review".
    const stage = stageOf(decorate(isReadOnlyKind(latest.kind) ? { ...latest, commits_ahead: 0 } : latest));
    out.push({
      threadId,
      runId: latest.id,
      title: plainTitle(t.root.task),
      repo: String(latest.repo || '').split(/[\\/]/).filter(Boolean).pop() || null,
      agent: latest.agent,
      kind: latest.kind || t.root.kind || null,
      turns: t.runs.length,
      updatedAt: new Date(updated).toISOString(),
      stage: { key: stage.key, label: stage.label, tone: stage.tone, next: stage.next },
    });
  }
  const urgent = (x) => (x.stage.key === 'needs-you' ? 0 : x.stage.key === 'working' ? 1 : 2);
  out.sort((a, b) => urgent(a) - urgent(b) || b.updatedAt.localeCompare(a.updatedAt));
  return out.slice(0, limit);
}

/** Who started the thread `runId` belongs to; null for an unknown run. */
function threadOwner(runs, runId) {
  const byId = new Map(runs.map((r) => [r.id, r]));
  if (!byId.has(runId)) return null;
  return ownerOf(byId.get(rootsOf(runs).get(runId)));
}

/**
 * May this person open or act on run `runId`? Admins: any run. Others: runs
 * in threads they started. An unknown run passes (the route answers 404).
 */
function mayOpen({ runs, runId, actor, admin = false }) {
  if (admin) return true;
  const owner = threadOwner(runs, runId);
  return owner === null || owner.toLowerCase() === String(actor || LOCAL).toLowerCase();
}

module.exports = { myThreads, rootsOf, ownerOf, plainTitle, threadOwner, mayOpen };
