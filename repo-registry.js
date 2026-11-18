// repo-registry.js - the repositories agents may work on, beyond the ones the
// dashboard finds by itself. Kept in logs/repos.json:
//   { name, path, remote, source: 'local' | 'git', addedBy, addedAt }
//
// Add a local folder (must be a git repo inside the home folder, not in a
// hidden or system folder) or clone a git URL (https or ssh, no credentials
// in the URL) into AGENT_REPOS_DIR. Removing only unregisters: files on disk
// are never deleted. Agents run a repo's code (tests, scripts) on this
// machine, so the dashboard lets only admins add repos.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const NAME_RE = /^[A-Za-z0-9._-]{1,80}$/;
const HTTPS_RE = /^https:\/\/([A-Za-z0-9.-]+)(:\d+)?\/([\w.-]+\/)+[\w.-]+?(\.git)?\/?$/;
const SSH_RE = /^git@([A-Za-z0-9.-]+):([\w.-]+\/)+[\w.-]+?(\.git)?$/;
const CLONE_TIMEOUT_MS = 5 * 60 * 1000;
const DISCOVER_LIMIT = 40;
const DEV_FOLDERS = ['', 'projects', 'Projects', 'code', 'Code', 'dev', 'src', 'repos', 'git', 'GitHub', 'Sites', 'Documents/GitHub', 'agent-repos'];

/** Strip credentials from a remote URL before storing or showing it. */
function safeRemote(url) {
  const u = String(url || '').trim();
  return u.replace(/^(https?:\/\/)[^/@\s]+@/, '$1');
}

function validateGitUrl(url) {
  const u = String(url || '').trim();
  if (/^https?:\/\/[^/]*@/.test(u)) return { ok: false, error: 'remove the username/token from the URL; private repos clone over ssh (git@host:owner/repo.git)' };
  if (HTTPS_RE.test(u) || SSH_RE.test(u)) return { ok: true, value: u };
  return { ok: false, error: 'use an https URL (https://github.com/owner/repo) or ssh (git@github.com:owner/repo.git)' };
}

function repoNameFromUrl(url) {
  const last = String(url).replace(/\/+$/, '').split(/[/:]/).pop().replace(/\.git$/, '');
  return last.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 80) || 'repo';
}

/** A folder an admin may register: an existing git repo inside home, not hidden or system. */
function validateLocalPath(input, home) {
  const raw = String(input || '').trim().replace(/^~(?=$|\/)/, home);
  if (/^[a-zA-Z]:[\\/]/.test(raw) || /\\/.test(raw)) {
    return {
      ok: false,
      error: 'That is a path on your local Windows PC (e.g. C:\\...). The AI models run on the host server and cannot read files directly from your personal laptop. Please click the "From Git URL" tab and enter the repository URL (e.g. https://github.com/owner/repo) to clone and register it.'
    };
  }
  if (!raw || !path.isAbsolute(raw)) return { ok: false, error: 'give the full path to the folder, e.g. ~/projects/my-app' };
  let real;
  // .native: the case-correct path (macOS folders are case-insensitive).
  try { real = fs.realpathSync.native(raw); } catch (_) { return { ok: false, error: 'that folder does not exist' }; }
  const rel = path.relative(home, real);
  if (rel.startsWith('..') || path.isAbsolute(rel) || rel === '') return { ok: false, error: 'the folder must be inside your home folder' };
  const parts = rel.split(path.sep);
  if (parts.some((p) => p.startsWith('.')) || parts[0] === 'Library') return { ok: false, error: 'hidden and system folders cannot be added' };
  if (!fs.statSync(real).isDirectory()) return { ok: false, error: 'that is a file, not a folder' };
  if (!fs.existsSync(path.join(real, '.git'))) return { ok: false, error: 'that folder is not a git repository (no .git); run git init there first' };
  if (path.basename(real).includes('--')) return { ok: false, error: 'that looks like an agent worktree; add the main repository instead' };
  return { ok: true, value: real };
}

/** origin's URL from .git/config without running git (cheap, sync), credentials stripped. */
function readOrigin(dir) {
  try {
    const cfg = fs.readFileSync(path.join(dir, '.git', 'config'), 'utf8');
    const m = cfg.match(/\[remote "origin"\][^[]*?\n\s*url\s*=\s*(\S+)/);
    return m ? safeRemote(m[1]) : null;
  } catch (_) { return null; }
}

/** Formats a GitHub/GitLab compare or pull request URL from a remote URL and branch name. */
function prUrlOf(remote, branch) {
  if (!remote || !branch) return null;
  const clean = String(remote).trim().replace(/\.git\/?$/, '');
  const gh = clean.match(/github\.com[:/]([^/]+)\/([^/]+)$/);
  if (gh) {
    return `https://github.com/${gh[1]}/${gh[2]}/compare/${encodeURIComponent(branch)}?expand=1`;
  }
  const gl = clean.match(/gitlab\.com[:/](.+)$/);
  if (gl) {
    const glPath = gl[1].replace(/^\/+|\/+$/g, '');
    return `https://gitlab.com/${glPath}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${encodeURIComponent(branch)}`;
  }
  return null;
}

const run = (file, args, opts) => new Promise((resolve, reject) => {
  execFile(file, args, { encoding: 'utf8', ...opts }, (err, stdout, stderr) => {
    if (err) { err.stderr = stderr; reject(err); } else resolve(stdout);
  });
});

/**
 * @param {object} o
 * @param {string} o.file          registry JSON
 * @param {string} o.cloneDir      where git URLs are cloned
 * @param {() => {name: string, path: string}[]} [o.builtins]  repos the dashboard finds itself
 * @param {string} [o.home]
 * @param {Function} [o.git]       (args, cwd) => Promise<stdout>  (tests inject)
 */
// The case-correct home folder: os.homedir() can differ in case from the real
// folder on macOS, which would make every realpath look "outside home".
const realHome = () => { try { return fs.realpathSync.native(os.homedir()); } catch (_) { return os.homedir(); } };

function createRepoRegistry({ file, cloneDir, builtins = () => [], home = realHome(), git = null, now = () => new Date() }) {
  const gitRun = git || ((args, cwd) => run('git', args, {
    cwd, timeout: CLONE_TIMEOUT_MS, maxBuffer: 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes', GIT_LFS_SKIP_SMUDGE: '1' },
  }));

  const load = () => {
    try {
      const list = JSON.parse(fs.readFileSync(file, 'utf8'));
      return Array.isArray(list) ? list.filter((r) => r && NAME_RE.test(r.name) && typeof r.path === 'string') : [];
    } catch (_) { return []; }
  };
  const save = (list) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
    fs.renameSync(tmp, file);
  };

  async function remoteOf(dir) {
    try { return safeRemote((await gitRun(['remote', 'get-url', 'origin'], dir)).trim()) || null; } catch (_) { return null; }
  }

  /** Registered + built-in repos, each with whether it still exists. */
  function list() {
    const seen = new Set();
    const out = [];
    for (const r of builtins()) {
      if (seen.has(r.path)) continue;
      seen.add(r.path);
      out.push({ name: r.name, path: r.path, source: 'builtin', remote: r.remote || readOrigin(r.path), exists: fs.existsSync(path.join(r.path, '.git')) });
    }
    for (const r of load()) {
      if (seen.has(r.path)) continue;
      seen.add(r.path);
      out.push({ ...r, exists: fs.existsSync(path.join(r.path, '.git')) });
    }
    return out;
  }

  function resolve(name) {
    const r = list().find((x) => x.name === name);
    return r && r.exists ? r.path : null;
  }

  function uniqueName(base, taken) {
    let name = base.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 76) || 'repo';
    for (let i = 2; taken.has(name); i += 1) name = `${base.slice(0, 74)}-${i}`;
    return name;
  }

  async function addLocal(input, actor) {
    const v = validateLocalPath(input, home);
    if (!v.ok) return v;
    const current = list();
    const existing = current.find((r) => r.path === v.value);
    if (existing) return { ok: true, value: existing, already: true };
    const entry = {
      name: uniqueName(path.basename(v.value), new Set(current.map((r) => r.name))),
      path: v.value, remote: await remoteOf(v.value), source: 'local',
      addedBy: String(actor || 'unknown').slice(0, 80), addedAt: now().toISOString(),
    };
    save([...load(), entry]);
    return { ok: true, value: { ...entry, exists: true } };
  }

  async function addGit(url, actor) {
    const v = validateGitUrl(url);
    if (!v.ok) return v;
    const current = list();
    const already = current.find((r) => r.remote && safeRemote(r.remote).replace(/\.git$/, '') === safeRemote(v.value).replace(/\.git$/, ''));
    if (already) return { ok: true, value: already, already: true };
    const name = uniqueName(repoNameFromUrl(v.value), new Set(current.map((r) => r.name)));
    const dest = path.join(cloneDir, name);
    if (fs.existsSync(dest)) return { ok: false, error: `${dest} already exists; add it as a local folder instead` };
    fs.mkdirSync(cloneDir, { recursive: true });
    try {
      await gitRun(['clone', '--depth', '50', '--no-recurse-submodules', '--', v.value, dest], cloneDir);
    } catch (err) {
      fs.rmSync(dest, { recursive: true, force: true });
      const why = /Authentication|Permission denied|could not read Username|publickey/i.test(err.stderr || '') ? 'access denied (private repo? add an ssh key for this Mac)'
        : /not found|does not exist/i.test(err.stderr || '') ? 'repository not found'
        : err.killed ? 'clone took longer than 5 minutes' : 'clone failed';
      return { ok: false, error: why };
    }
    const entry = { name, path: dest, remote: safeRemote(v.value), source: 'git', addedBy: String(actor || 'unknown').slice(0, 80), addedAt: now().toISOString() };
    save([...load(), entry]);
    return { ok: true, value: { ...entry, exists: true } };
  }

  /** Unregister (files stay on disk). Built-in repos cannot be removed. */
  function remove(name) {
    const all = load();
    const next = all.filter((r) => r.name !== name);
    if (next.length === all.length) return { ok: false, error: 'not a registered repo' };
    save(next);
    return { ok: true };
  }

  /** Git repos found in common dev folders that are not registered yet. */
  function discover() {
    const real = (p) => { try { return fs.realpathSync.native(p); } catch (_) { return p; } };
    const known = new Set(list().map((r) => real(r.path)));
    const scanned = new Set();
    const found = [];
    for (const sub of DEV_FOLDERS) {
      const dir = real(path.join(home, sub));
      if (scanned.has(dir)) continue; // projects/ and Projects/ are one folder on macOS
      scanned.add(dir);
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
      for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith('.') || e.name.includes('--') || e.name === 'Library') continue;
        const p = path.join(dir, e.name);
        if (known.has(p) || !fs.existsSync(path.join(p, '.git'))) continue;
        known.add(p);
        let mtime = 0;
        try { mtime = fs.statSync(path.join(p, '.git')).mtimeMs; } catch (_) { /* ignore */ }
        found.push({ name: e.name, path: p, display: `~/${path.relative(home, p)}`, mtime });
        if (found.length >= DISCOVER_LIMIT * 2) break;
      }
    }
    return found.sort((a, b) => b.mtime - a.mtime).slice(0, DISCOVER_LIMIT).map(({ mtime, ...r }) => r);
  }

  return { list, resolve, addLocal, addGit, remove, discover };
}

module.exports = { createRepoRegistry, realHome, readOrigin, validateGitUrl, validateLocalPath, safeRemote, repoNameFromUrl, prUrlOf };
