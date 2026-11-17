// followup.js - continue a finished agent run: resume its Claude session in
// the same repo and branch (the dispatch script reuses the worktree), so the
// agent remembers what it did and builds on its own commits.
//
// Used by a person ("Follow up" on the Agents page) and by agents (the issue
// poller hands a reviewer's findings back to the worker). Only claude runs
// keep a session: its id is in <run>.claude.json, written by stream-log.js.

const fs = require('fs');
const path = require('path');

const SESSION_RE = /^[0-9a-fA-F-]{36}$/;
const RUN_ID_RE = /^[A-Za-z0-9._-]{1,80}$/;

/** The session id saved next to a run's log, or null. */
function sessionOf(run, readFile = fs.readFileSync) {
  if (!run || !run.log) return null;
  try {
    const j = JSON.parse(readFile(String(run.log).replace(/\.log$/, '.claude.json'), 'utf8'));
    return SESSION_RE.test(j.session_id || '') ? j.session_id : null;
  } catch (_) { return null; }
}

/** Whether a run can be followed up, and why not. */
function followUpStatus(run, { readFile } = {}) {
  if (!run) return { ok: false, error: 'run not found' };
  if (run.status === 'running') return { ok: false, error: 'the run is still going; wait for it to finish' };
  if (run.agent !== 'claude' && run.agent !== 'auto') return { ok: false, error: 'only Claude runs keep a session to resume' };
  if (!run.branch || !run.repo) return { ok: false, error: 'the run has no branch to continue on' };
  const session = sessionOf(run, readFile);
  if (!session) return { ok: false, error: 'this run saved no Claude session (it may have run on Hermes only)' };
  return { ok: true, session };
}

/**
 * Resolve a follow-up target.
 * @param {object} o
 * @param {object[]} o.runs                 folded run log
 * @param {string} o.runId
 * @param {(name: string) => string|null} o.resolveRepo  repo name -> path, only known repos
 * @returns {{ok: true, repo: string, repoPath: string, branch: string, session: string, parent: string} | {ok: false, error: string}}
 */
function resolveFollowUp({ runs, runId, resolveRepo, readFile }) {
  if (!RUN_ID_RE.test(String(runId || ''))) return { ok: false, error: 'bad run id' };
  const run = (runs || []).find((r) => r.id === runId);
  const st = followUpStatus(run, { readFile });
  if (!st.ok) return st;
  // The run log has the absolute repo path; only continue in a repo the
  // dashboard still knows under that name and path.
  const name = path.basename(String(run.repo).replace(/[\\/]+$/, ''));
  const known = resolveRepo(name);
  if (!known || path.resolve(known).toLowerCase() !== path.resolve(run.repo).toLowerCase()) {
    return { ok: false, error: `the repo ${name} is no longer registered on this dashboard` };
  }
  return { ok: true, repo: name, repoPath: known, branch: run.branch, session: st.session, parent: run.id };
}

module.exports = { resolveFollowUp, followUpStatus, sessionOf };
