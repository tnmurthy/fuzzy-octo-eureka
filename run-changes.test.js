'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createRunChanges, worktreeOf, parseNumstat, isSecretPath, capDiff, shrinksOf, MAX_DIFF_LINES } = require('./run-changes');

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'run-changes-')));
  const repo = path.join(root, 'site');
  const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...a], { encoding: 'utf8' });
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'page.tsx'), 'title: Tourism\nbody\n');
  fs.writeFileSync(path.join(repo, 'old.txt'), 'bye\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '--no-verify', '-m', 'base');
  const branch = 'agent/run-x1';
  const wt = path.join(root, 'site--agent-run-x1');
  git(repo, 'worktree', 'add', '-q', '-b', branch, wt);
  // committed: edit + new file + delete
  fs.writeFileSync(path.join(wt, 'page.tsx'), 'title: Vizag Tourism\ncanonical: /tourism\nbody\n');
  fs.writeFileSync(path.join(wt, 'sitemap.ts'), 'export default []\n');
  fs.rmSync(path.join(wt, 'old.txt'));
  git(wt, 'add', '-A');
  git(wt, 'commit', '-q', '--no-verify', '-m', 'Add canonical tags');
  // not saved yet: an edit, a new file, a secrets file
  fs.writeFileSync(path.join(wt, 'sitemap.ts'), 'export default ["/tourism"]\n');
  fs.writeFileSync(path.join(wt, 'robots.txt'), 'User-agent: *\nAllow: /\n');
  fs.writeFileSync(path.join(wt, '.env.local'), 'API_KEY=do-not-show\n');
  return { run: { id: 'r1', repo, branch, worktree: wt }, root };
}

test('worktreeOf accepts only the folder agent-dispatch.sh derives', () => {
  const run = { repo: '/h/agent-repos/vizag-live', branch: 'agent/run-ab', worktree: '/h/agent-repos/vizag-live--agent-run-ab' };
  assert.equal(worktreeOf(run), '/h/agent-repos/vizag-live--agent-run-ab');
  assert.equal(worktreeOf({ ...run, worktree: '/h' }), null);
  assert.equal(worktreeOf({ ...run, worktree: '/h/agent-repos/vizag-live--agent-run-ab/../../..' }), null);
  assert.equal(worktreeOf({ ...run, worktree: undefined }), null);
});

test('summary lists committed and unsaved changes, new and deleted files, and commits', async () => {
  const { run, root } = fixture();
  try {
    const s = await createRunChanges().summary(run);
    assert.equal(s.ok, true);
    const by = Object.fromEntries(s.files.map((f) => [f.path, f]));
    assert.deepEqual(Object.keys(by).sort(), ['.env.local', 'old.txt', 'page.tsx', 'robots.txt', 'sitemap.ts']);
    assert.deepEqual([by['page.tsx'].status, by['page.tsx'].added, by['page.tsx'].removed, by['page.tsx'].saved], ['modified', 2, 1, true]);
    assert.deepEqual([by['sitemap.ts'].status, by['sitemap.ts'].saved], ['new', false], 'committed new file, then edited');
    assert.equal(by['old.txt'].status, 'deleted');
    assert.deepEqual([by['robots.txt'].status, by['robots.txt'].saved], ['new', false]);
    assert.equal(by['.env.local'].secret, true);
    assert.deepEqual(s.commits.map((c) => c.subject), ['Add canonical tags']);
    assert.ok(s.totals.added >= 4);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('fileDiff shows only listed files, never a secrets file', async () => {
  const { run, root } = fixture();
  try {
    const rc = createRunChanges();
    const d = await rc.fileDiff(run, 'page.tsx');
    assert.equal(d.ok, true);
    assert.match(d.diff, /^-title: Tourism$/m);
    assert.match(d.diff, /^\+canonical: \/tourism$/m);
    assert.doesNotMatch(d.diff, /^diff --git/m, 'git headers are dropped');
    assert.match((await rc.fileDiff(run, 'robots.txt')).diff, /^\+User-agent: \*$/m);
    const sec = await rc.fileDiff(run, '.env.local');
    assert.equal(sec.status, 403);
    assert.equal(JSON.stringify(sec).includes('do-not-show'), false);
    assert.equal((await rc.fileDiff(run, '../../etc/passwd')).status, 404);
    assert.equal((await rc.fileDiff(run, 'body')).status, 404);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a run whose draft copy is gone answers 404', async () => {
  const r = await createRunChanges().summary({ repo: '/nope/x', branch: 'agent/run-z', worktree: '/nope/x--agent-run-z' });
  assert.equal(r.status, 404);
});

test('helpers: numstat with renames and binaries, secret paths, diff cap', () => {
  assert.deepEqual(parseNumstat('3\t1\ta.ts\0-\t-\tlogo.png\0' + '2\t0\t\0old.ts\0new.ts\0'), [
    { path: 'a.ts', from: null, added: 3, removed: 1, binary: false },
    { path: 'logo.png', from: null, added: null, removed: null, binary: true },
    { path: 'new.ts', from: 'old.ts', added: 2, removed: 0, binary: false },
  ]);
  for (const p of ['.env', 'app/.env.production', 'certs/site.pem', 'id_rsa', 'config/credentials.json', 'secrets/x.txt']) assert.equal(isSecretPath(p), true, p);
  for (const p of ['envelope.ts', 'app/page.tsx', 'docs/keyboard.md']) assert.equal(isSecretPath(p), false, p);
  const long = Array.from({ length: MAX_DIFF_LINES + 5 }, (_, i) => `+${i}`).join('\n');
  assert.equal(capDiff(long).truncated, true);
  assert.equal(capDiff(long).diff.split('\n').length, MAX_DIFF_LINES);
});

test('shrinksOf flags files that lose much more than they gain, and deleted files', () => {
  assert.deepEqual(shrinksOf([
    { path: 'pageMeta.ts', added: 13, removed: 27, status: 'modified' },
    { path: 'big-refactor.ts', added: 30, removed: 40, status: 'modified' },
    { path: 'tiny.ts', added: 0, removed: 4, status: 'modified' },
    { path: 'old.txt', added: 0, removed: 1, status: 'deleted' },
    { path: 'logo.png', added: null, removed: null, binary: true, status: 'deleted' },
  ]), [
    { path: 'pageMeta.ts', added: 13, removed: 27, deleted: false },
    { path: 'old.txt', added: 0, removed: 1, deleted: true },
  ]);
});
