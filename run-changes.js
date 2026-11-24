'use strict';
// run-changes.js - "Files changed" for a run on the Ask page: what the helper
// changed on its draft copy compared with where the branch started.
//
// Compares the worktree (committed and not-yet-committed edits, plus new
// files) with the merge-base of the repo's default branch and HEAD. Only reads
// the worktree agent-dispatch.sh derives for the run:
// <repo parent>/<repo name>--<branch with / as ->, so a run-log line cannot
// point it at another folder. A file's diff is served only for a path in the
// changed list; secret-looking files are listed by name, never shown.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const MAX_FILES = 200;
const MAX_DIFF_LINES = 400;
const MAX_DIFF_BYTES = 256 * 1024;
const SECRET_RE = /(^|\/)(\.env[^/]*|.*\.(pem|key|p12|pfx)|id_(rsa|ed25519|ecdsa)[^/]*|credentials[^/]*\.json|secrets?(\/|\.[a-z]+$))/i;

const isSecretPath = (p) => SECRET_RE.test(String(p));
const SHRINK_MIN = 10;

/** Files that lose much more than they gain (or are deleted): worth a look. */
const shrinksOf = (files) => files
  .filter((f) => !f.binary && (f.status === 'deleted' ? (f.removed || 0) > 0 : (f.removed || 0) >= SHRINK_MIN && (f.removed || 0) > 2 * (f.added || 0)))
  .map((f) => ({ path: f.path, added: f.added || 0, removed: f.removed || 0, deleted: f.status === 'deleted' }));

/** The worktree agent-dispatch.sh made for this run, or null. */
function worktreeOf(run) {
  if (!run || !run.repo || !run.branch || !run.worktree) return null;
  const repo = String(run.repo).replace(/[\\/]+$/, '');
  const want = path.join(path.dirname(repo), `${path.basename(repo)}--${String(run.branch).replace(/\//g, '-')}`);
  return path.resolve(String(run.worktree)) === path.resolve(want) ? want : null;
}

const defaultGit = (cwd, args) => new Promise((resolve, reject) => {
  execFile('git', ['-C', cwd, '-c', 'core.quotepath=off', ...args],
    { encoding: 'utf8', timeout: 8000, maxBuffer: 4 * 1024 * 1024 },
    (err, stdout) => (err ? reject(err) : resolve(stdout)));
});

/** Parses `git diff --numstat -z` output. */
function parseNumstat(out) {
  const files = [];
  const parts = String(out || '').split('\0');
  for (let i = 0; i < parts.length; i += 1) {
    const rec = parts[i];
    if (!rec) continue;
    const m = rec.match(/^(-|\d+)\t(-|\d+)\t(.*)$/);
    if (!m) continue;
    let file = m[3];
    let from = null;
    if (file === '') { from = parts[i + 1]; file = parts[i + 2]; i += 2; } // rename: old\0new\0
    files.push({ path: file, from, added: m[1] === '-' ? null : Number(m[1]), removed: m[2] === '-' ? null : Number(m[2]), binary: m[1] === '-' });
  }
  return files;
}

/** Caps a diff at MAX_DIFF_LINES lines. */
function capDiff(text) {
  const lines = String(text || '').split('\n');
  if (lines.length <= MAX_DIFF_LINES) return { diff: lines.join('\n'), truncated: false };
  return { diff: lines.slice(0, MAX_DIFF_LINES).join('\n'), truncated: true };
}

function createRunChanges({ git = defaultGit, exists = fs.existsSync, readFile = fs.readFileSync } = {}) {
  async function baseOf(wt) {
    let base = 'main';
    try { base = (await git(wt, ['rev-parse', '--abbrev-ref', 'origin/HEAD'])).trim() || 'main'; } catch (_) { /* no origin/HEAD */ }
    try { return (await git(wt, ['merge-base', base, 'HEAD'])).trim(); } catch (_) { return null; }
  }

  async function open(run) {
    const wt = worktreeOf(run);
    if (!wt || !exists(path.join(wt, '.git'))) return { ok: false, status: 404, error: 'the draft copy for this run is gone' };
    const mb = await baseOf(wt);
    if (!mb) return { ok: false, status: 409, error: 'cannot tell where this branch started' };
    return { ok: true, wt, mb };
  }

  /** Changed files, totals, commits. */
  async function summary(run) {
    const o = await open(run);
    if (!o.ok) return o;
    const { wt, mb } = o;
    const [num, unsaved, untracked, log] = await Promise.all([
      git(wt, ['diff', '--numstat', '-z', '-M', mb]),
      git(wt, ['diff', '--name-only', '-z', 'HEAD']).catch(() => ''),
      git(wt, ['ls-files', '--others', '--exclude-standard', '-z']).catch(() => ''),
      git(wt, ['log', '--format=%h%x09%s', '-n', '20', `${mb}..HEAD`]).catch(() => ''),
    ]);
    const notSaved = new Set(unsaved.split('\0').filter(Boolean));
    const files = parseNumstat(num).map((f) => ({ ...f, saved: !notSaved.has(f.path), status: f.from ? 'renamed' : 'modified' }));
    const seen = new Set(files.map((f) => f.path));
    for (const p of untracked.split('\0').filter(Boolean)) {
      if (seen.has(p)) continue;
      let lines = null;
      try { lines = String(readFile(path.join(wt, p), 'utf8')).split('\n').length; } catch (_) { /* unreadable */ }
      files.push({ path: p, from: null, added: lines, removed: 0, binary: lines === null, saved: false, status: 'new' });
    }
    // A file that did not exist at the base is "new", even when committed.
    let added = '';
    try { added = await git(wt, ['diff', '--name-only', '-z', '--diff-filter=A', mb]); } catch (_) { /* fine */ }
    const isNew = new Set(added.split('\0').filter(Boolean));
    let deleted = '';
    try { deleted = await git(wt, ['diff', '--name-only', '-z', '--diff-filter=D', mb]); } catch (_) { /* fine */ }
    const isGone = new Set(deleted.split('\0').filter(Boolean));
    const out = files.slice(0, MAX_FILES).map((f) => ({
      ...f,
      status: isNew.has(f.path) ? 'new' : isGone.has(f.path) ? 'deleted' : f.status,
      secret: isSecretPath(f.path),
    }));
    return {
      ok: true,
      files: out,
      more: Math.max(0, files.length - MAX_FILES),
      totals: out.reduce((t, f) => ({ added: t.added + (f.added || 0), removed: t.removed + (f.removed || 0) }), { added: 0, removed: 0 }),
      commits: log.split('\n').filter(Boolean).map((l) => { const i = l.indexOf('\t'); return { sha: l.slice(0, i), subject: l.slice(i + 1) }; }),
      shrinks: shrinksOf(out),
      branch: run.branch,
    };
  }

  /** One file's diff; `file` must be in the changed list. */
  async function fileDiff(run, file) {
    const s = await summary(run);
    if (!s.ok) return s;
    const f = s.files.find((x) => x.path === file);
    if (!f) return { ok: false, status: 404, error: 'that file is not among the changes' };
    if (f.secret) return { ok: false, status: 403, error: 'this looks like a secrets file, so its contents are not shown' };
    if (f.binary) return { ok: true, path: file, binary: true, diff: '', truncated: false };
    const { wt, mb } = await open(run);
    let text;
    if (f.status === 'new' && !f.saved) {
      let body = '';
      try { body = String(readFile(path.join(wt, file), 'utf8')).slice(0, MAX_DIFF_BYTES); } catch (_) { body = ''; }
      text = body.split('\n').map((l) => `+${l}`).join('\n');
    } else {
      text = (await git(wt, ['diff', '-M', mb, '--', file])).slice(0, MAX_DIFF_BYTES);
      text = text.split('\n').filter((l) => !/^(diff --git|index |--- |\+\+\+ |similarity index|rename (from|to) |new file mode|deleted file mode)/.test(l)).join('\n');
    }
    return { ok: true, path: file, binary: false, ...capDiff(text) };
  }

  return { summary, fileDiff };
}

module.exports = { createRunChanges, worktreeOf, parseNumstat, isSecretPath, capDiff, shrinksOf, defaultGit, MAX_DIFF_LINES };
