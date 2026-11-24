'use strict';
// draft-actions.js - what a person can do with a request's draft copy from
// the Ask page, without a terminal:
//   undo     reverts the last saved step (git revert HEAD: a new commit, so
//            nothing is lost and it can be undone again)
//   discard  removes the draft folder and renames the branch to
//            discarded/<branch>-<yyyymmdd>, so the work is still there for
//            an admin to recover until someone deletes that branch.
// Only the worktree agent-dispatch.sh derives for the run is touched
// (run-changes.js worktreeOf). Commits are made with hooks off and a fixed
// "Ask page" author; nothing is pushed.

const fs = require('fs');
const path = require('path');
const { worktreeOf, defaultGit } = require('./run-changes');

const AUTHOR = ['-c', 'user.name=Ask page', '-c', 'user.email=ask-page@arunachala.invalid', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false'];

function createDraftActions({ git = defaultGit, exists = fs.existsSync, today = () => new Date() } = {}) {
  async function open(run) {
    const wt = worktreeOf(run);
    if (!wt || !exists(path.join(wt, '.git'))) return { ok: false, status: 404, error: 'the draft copy for this request is gone' };
    return { ok: true, wt };
  }

  async function mergeBase(wt) {
    let base = 'main';
    try { base = (await git(wt, ['rev-parse', '--abbrev-ref', 'origin/HEAD'])).trim() || 'main'; } catch (_) { /* no origin/HEAD */ }
    try { return (await git(wt, ['merge-base', base, 'HEAD'])).trim(); } catch (_) { return null; }
  }

  /** Revert the last commit on the draft branch. */
  async function undo(run) {
    const o = await open(run);
    if (!o.ok) return o;
    const { wt } = o;
    if ((await git(wt, ['status', '--porcelain'])).trim()) {
      return { ok: false, status: 409, error: 'the draft has edits that are not saved yet; wait for the helper to finish, or discard the draft' };
    }
    const mb = await mergeBase(wt);
    const ahead = mb ? Number((await git(wt, ['rev-list', '--count', `${mb}..HEAD`])).trim()) : 0;
    if (!ahead) return { ok: false, status: 409, error: 'nothing has been saved on this draft yet, so there is nothing to undo' };
    const subject = (await git(wt, ['log', '-1', '--format=%s'])).trim();
    try {
      await git(wt, [...AUTHOR, 'revert', '--no-edit', 'HEAD']);
    } catch (_) {
      try { await git(wt, ['revert', '--abort']); } catch (__) { /* nothing to abort */ }
      return { ok: false, status: 409, error: 'that step could not be undone cleanly; ask the helper to undo it instead' };
    }
    return { ok: true, undone: subject };
  }

  /** Remove the draft folder; keep the branch under discarded/. */
  async function discard(run) {
    const o = await open(run);
    if (!o.ok) return o;
    const repo = String(run.repo).replace(/[\\/]+$/, '');
    if (!exists(path.join(repo, '.git'))) return { ok: false, status: 404, error: 'the project folder is gone' };
    const d = today();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    const kept = `discarded/${String(run.branch).replace(/\//g, '-')}-${stamp}`;
    await git(repo, ['worktree', 'remove', '--force', o.wt]);
    try {
      await git(repo, ['branch', '-m', String(run.branch), kept]);
    } catch (_) {
      return { ok: true, kept: run.branch, note: 'the draft folder was removed; the branch kept its name' };
    }
    return { ok: true, kept };
  }

  return { undo, discard };
}

module.exports = { createDraftActions };
