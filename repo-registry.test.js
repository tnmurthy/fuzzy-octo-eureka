// node --test repo-registry.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRepoRegistry, validateGitUrl, validateLocalPath, safeRemote, repoNameFromUrl, readOrigin } = require('./repo-registry');

function sandbox() {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'reg-home-')));
  const mkRepo = (rel) => { const p = path.join(home, rel); fs.mkdirSync(path.join(p, '.git'), { recursive: true }); return p; };
  return { home, mkRepo, file: path.join(home, 'state', 'repos.json'), cloneDir: path.join(home, 'agent-repos') };
}

test('git URLs: https and ssh accepted; credentials, other schemes and junk refused', () => {
  assert.equal(validateGitUrl('https://github.com/msitarzewski/agency-agents.git').ok, true);
  assert.equal(validateGitUrl('https://gitlab.com/group/sub/project').ok, true);
  assert.equal(validateGitUrl('git@github.com:me/app.git').ok, true);
  assert.match(validateGitUrl('https://user:ghp_x@github.com/me/app').error, /remove the username/);
  for (const bad of ['file:///etc', 'ext::sh -c id', 'http://github.com/me/app', '--upload-pack=x', 'https://github.com/me', '']) {
    assert.equal(validateGitUrl(bad).ok, false, bad);
  }
  assert.equal(safeRemote('https://tok@github.com/me/app.git'), 'https://github.com/me/app.git');
  assert.equal(repoNameFromUrl('git@github.com:me/My App.git'), 'My-App');
});

test('local folders: must be a git repo inside home, not hidden, system or a worktree', () => {
  const { home, mkRepo } = sandbox();
  const ok = mkRepo('projects/app');
  assert.deepEqual(validateLocalPath('~/projects/app', home), { ok: true, value: ok });
  fs.mkdirSync(path.join(home, 'plain'));
  assert.match(validateLocalPath(path.join(home, 'plain'), home).error, /not a git repository/);
  mkRepo('.secret/repo');
  assert.match(validateLocalPath(path.join(home, '.secret/repo'), home).error, /hidden/);
  mkRepo('Library/x');
  assert.match(validateLocalPath(path.join(home, 'Library/x'), home).error, /system/);
  mkRepo('app--agent-issue-1');
  assert.match(validateLocalPath(path.join(home, 'app--agent-issue-1'), home).error, /worktree/);
  assert.match(validateLocalPath('/etc', home).error, /inside your home/);
  assert.match(validateLocalPath('relative/path', home).error, /full path/);
  assert.match(validateLocalPath('C:\\projects\\app', home).error, /Windows PC/);
  assert.match(validateLocalPath(path.join(home, 'nope'), home).error, /does not exist/);
});

test('adding a local repo registers it once, with a unique name and its remote', async () => {
  const s = sandbox();
  const p = s.mkRepo('code/app');
  const reg = createRepoRegistry({ ...s, builtins: () => [{ name: 'app', path: '/elsewhere/app' }], git: async () => 'https://tok@github.com/me/app.git\n' });
  const r = await reg.addLocal(p, 'sriad');
  assert.equal(r.ok, true);
  assert.equal(r.value.name, 'app-2', 'name taken by a built-in');
  assert.equal(r.value.remote, 'https://github.com/me/app.git', 'credentials stripped');
  assert.equal((await reg.addLocal(p, 'sriad')).already, true);
  assert.equal(reg.resolve('app-2'), p);
  assert.equal(reg.resolve('nope'), null);
});

test('cloning a git URL lands in the clone folder; failures leave nothing behind', async () => {
  const s = sandbox();
  const calls = [];
  const reg = createRepoRegistry({ ...s, git: async (args) => {
    calls.push(args);
    if (args[0] === 'clone') fs.mkdirSync(path.join(args.at(-1), '.git'), { recursive: true });
    return '';
  } });
  const r = await reg.addGit('https://github.com/me/app.git', 'sriad');
  assert.equal(r.ok, true);
  assert.equal(r.value.path, path.join(s.cloneDir, 'app'));
  assert.deepEqual(calls[0].slice(0, 5), ['clone', '--depth', '50', '--no-recurse-submodules', '--']);
  assert.equal((await reg.addGit('https://github.com/me/app', 'sriad')).already, true, 'same remote is not cloned twice');

  const failing = createRepoRegistry({ ...sandbox(), git: async (args) => {
    fs.mkdirSync(args.at(-1), { recursive: true });
    throw Object.assign(new Error('x'), { stderr: 'ERROR: Repository not found.' });
  } });
  const f = await failing.addGit('https://github.com/me/missing', 'sriad');
  assert.deepEqual(f, { ok: false, error: 'repository not found' });
});

test('remove only unregisters; discover lists unregistered repos in dev folders', async () => {
  const s = sandbox();
  const a = s.mkRepo('projects/alpha');
  s.mkRepo('projects/beta');
  s.mkRepo('projects/beta--agent-issue-2');
  s.mkRepo('.hidden-repo');
  const reg = createRepoRegistry({ ...s, git: async () => '' });
  await reg.addLocal(a, 'x');
  assert.deepEqual(reg.discover().map((r) => r.display), ['~/projects/beta']);
  assert.deepEqual(reg.remove('alpha'), { ok: true });
  assert.ok(fs.existsSync(a), 'files are never deleted');
  assert.equal(reg.remove('alpha').ok, false);
});

test('built-in repos report their origin from .git/config, without credentials', () => {
  const s = sandbox();
  const p = s.mkRepo('code/svc');
  fs.writeFileSync(path.join(p, '.git', 'config'), '[core]\n\tbare = false\n[remote "origin"]\n\turl = https://tok@github.com/me/svc.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n');
  assert.equal(readOrigin(p), 'https://github.com/me/svc.git');
  const reg = createRepoRegistry({ ...s, builtins: () => [{ name: 'svc', path: p }] });
  assert.equal(reg.list()[0].remote, 'https://github.com/me/svc.git');
  assert.equal(readOrigin(path.join(s.home, 'nope')), null);
});
