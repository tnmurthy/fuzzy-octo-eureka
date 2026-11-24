'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createDraftActions } = require('./draft-actions');

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'draft-actions-')));
  const repo = path.join(root, 'site');
  const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...a], { encoding: 'utf8' });
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'pageMeta.ts'), 'news\ntourism\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'base');
  const branch = 'agent/run-x1';
  const wt = path.join(root, 'site--agent-run-x1');
  git(repo, 'worktree', 'add', '-q', '-b', branch, wt);
  fs.writeFileSync(path.join(wt, 'pageMeta.ts'), 'gajuwaka\n');
  git(wt, 'commit', '-q', '-am', 'Replace page entries');
  return { root, repo, wt, git, run: { id: 'r1', repo, branch, worktree: wt } };
}

test('undo reverts the last saved step with a new commit', async () => {
  const f = fixture();
  try {
    const r = await createDraftActions().undo(f.run);
    assert.deepEqual(r, { ok: true, undone: 'Replace page entries' });
    assert.equal(fs.readFileSync(path.join(f.wt, 'pageMeta.ts'), 'utf8'), 'news\ntourism\n');
    assert.match(f.git(f.wt, 'log', '-1', '--format=%an %s'), /^Ask page Revert "Replace page entries"/);
    assert.equal(f.git(f.wt, 'status', '--porcelain'), '');
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('undo refuses with unsaved edits, or with nothing saved yet', async () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.wt, 'pageMeta.ts'), 'half done\n');
    assert.equal((await createDraftActions().undo(f.run)).status, 409);
    f.git(f.wt, 'checkout', '--', '.');
    f.git(f.wt, 'reset', '-q', '--hard', 'main');
    const r = await createDraftActions().undo(f.run);
    assert.deepEqual([r.status, /nothing has been saved/.test(r.error)], [409, true]);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('discard removes the draft folder and keeps the branch as discarded/...', async () => {
  const f = fixture();
  try {
    const r = await createDraftActions({ today: () => new Date(2026, 10, 24) }).discard(f.run);
    assert.deepEqual(r, { ok: true, kept: 'discarded/agent-run-x1-20261124' });
    assert.equal(fs.existsSync(f.wt), false);
    assert.match(f.git(f.repo, 'branch', '--list', 'discarded/*'), /discarded\/agent-run-x1-20261124/);
    assert.equal((await createDraftActions().undo(f.run)).status, 404, 'gone afterwards');
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('only the derived draft folder is touched', async () => {
  const f = fixture();
  try {
    const r = await createDraftActions().discard({ ...f.run, worktree: f.repo });
    assert.equal(r.status, 404);
    assert.ok(fs.existsSync(f.wt));
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
