// agents-api.js - the Agents page's API: what is running, the GitHub issue
// queue, a run's live log, and "give an agent a task" (opens a GitHub issue
// labelled agent:ready, which the issue poller picks up).
//
//   GET  /api/agents/overview   cap, running + recent runs, issue queue
//   GET  /api/agents/log?id=R   tail of run R's log (only files in the runs dir)
//   POST /api/agents/task       { repo, title, body, agent } -> new issue
//   POST /api/agents/settings   { dailyPaidRuns } (admin only) -> new cap
//   GET  /api/agents/specialists catalog of agency-agents personas (no bodies)
//   GET  /api/agents/specialists/suggest?q=  top 3 for a task description
//
// The GitHub queue is cached for QUEUE_TTL_MS so a page refreshing every few
// seconds does not burn the token's rate limit. Errors never carry the token.

const fs = require('fs');
const path = require('path');

const AGENTS = ['claude', 'hermes', 'codex', 'noop', 'auto'];
const QUEUE_LABELS = { ready: 'agent:ready', running: 'agent:running', review: 'agent:review', failed: 'agent:failed' };
const QUEUE_TTL_MS = 30000;
const LOG_TAIL_BYTES = 64 * 1024;
const MAX_TITLE = 200;
const MAX_BODY = 8000;
const RUN_ID_RE = /^[A-Za-z0-9._-]{1,80}$/;

/** Validate a "give an agent a task" request. Returns { ok, value } or { ok: false, error }. */
function validateTask(input, repos, specialists = null) {
  const o = input && typeof input === 'object' ? input : {};
  const repo = String(o.repo || '').trim();
  const title = String(o.title || '').trim();
  const body = String(o.body || '').trim();
  const agent = String(o.agent || 'claude').trim();
  if (!repos.includes(repo)) return { ok: false, error: `repo must be one of: ${repos.join(', ')}` };
  if (!title) return { ok: false, error: 'title is required' };
  if (title.length > MAX_TITLE) return { ok: false, error: `title is longer than ${MAX_TITLE} characters` };
  if (body.length > MAX_BODY) return { ok: false, error: `description is longer than ${MAX_BODY} characters` };
  if (!AGENTS.includes(agent)) return { ok: false, error: `agent must be one of: ${AGENTS.join(', ')}` };
  const specialist = String(o.specialist || '').trim();
  if (specialist && !(specialists && specialists.get(specialist))) return { ok: false, error: 'unknown specialist' };
  return { ok: true, value: { repo, title, body, agent, specialist: specialist || null } };
}

/** True for a JSON request that is not from another site. */
function isSameSiteJson(req) {
  const h = req.headers || {};
  if (!/^application\/json\b/i.test(String(h['content-type'] || ''))) return false;
  if (String(h['sec-fetch-site'] || '') === 'cross-site') return false;
  if (h.origin) {
    try { return new URL(h.origin).host === String(h.host || ''); } catch (_) { return false; }
  }
  return true;
}

/** Which issue or PR a run serves, from the poller state or the task text it wrote. */
function linkOf(run, active) {
  const job = active[run.id];
  if (job) return job.kind === 'review' ? { kind: 'review', pr: job.pr, repo: job.repo } : { kind: 'issue', issue: job.number, repo: job.repo };
  const task = String(run.task || '');
  let m = task.match(/^Review pull request #(\d+) in (\S+?):/);
  if (m) return { kind: 'review', pr: Number(m[1]), repo: m[2] };
  m = task.match(/GitHub issue (\S+)#(\d+)/);
  if (m) return { kind: 'issue', issue: Number(m[2]), repo: m[1] };
  return null;
}

const slimRun = (r, active) => ({
  id: r.id,
  agent: r.agent,
  status: r.status,
  started_at: r.started_at,
  finished_at: r.finished_at,
  duration_s: r.duration_s,
  commits_ahead: r.commits_ahead,
  task: String(r.task || '').slice(0, 300),
  link: linkOf(r, active),
  hasLog: Boolean(r.log),
});

/**
 * @param {object} deps
 * @param {string} deps.runsFile
 * @param {string} deps.stateFile           issue poller state (run id -> job)
 * @param {(file: string, n: number) => {runs: object[]}} deps.readRuns
 * @param {(runs: object[]) => {used: number, cap: number, blocked?: boolean}} deps.capNow
 * @param {string[]} deps.repos             owner/name the poller watches
 * @param {object|null} deps.github         github-client, or null without a token
 * @param {object} [deps.settings]          dispatch-settings store (admin-editable cap)
 * @param {(req) => boolean} [deps.isAdmin]
 * @param {(req) => string} [deps.actorOf]  who to record as making a change
 * @param {() => number} [deps.now]
 */
function createAgentsApi({ runsFile, stateFile, readRuns, capNow, repos, github, settings = null, specialists = null, suggester = null, isAdmin = () => false, actorOf = () => 'unknown', now = Date.now }) {
  const runsDir = path.resolve(path.dirname(runsFile));
  let queueCache = { at: 0, value: null };

  const loadRuns = () => readRuns(runsFile, 5000).runs || [];
  const loadActive = () => {
    try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')).active || {}; } catch (_) { return {}; }
  };

  async function queue() {
    if (!github) return { available: false, note: 'GITHUB_TOKEN is not set, so the issue queue is hidden.' };
    if (queueCache.value && now() - queueCache.at < QUEUE_TTL_MS) return queueCache.value;
    const columns = {};
    for (const [col, label] of Object.entries(QUEUE_LABELS)) {
      const lists = await Promise.all(repos.map((repo) => github.listIssuesWithLabel(repo, label)
        .then((issues) => issues.map((i) => ({
          repo,
          number: i.number,
          title: i.title,
          url: i.html_url,
          updated_at: i.updated_at,
          agent: ((i.labels || []).map((l) => (typeof l === 'string' ? l : l.name))
            .find((n) => AGENTS.includes(n.replace(/^agent:/, ''))) || '').replace(/^agent:/, '') || null,
        })))));
      columns[col] = lists.flat();
    }
    queueCache = { at: now(), value: { available: true, columns } };
    return queueCache.value;
  }

  async function overview(req) {
    const runs = loadRuns();
    const active = loadActive();
    let q;
    try { q = await queue(); } catch (err) { q = { available: false, note: `GitHub queue unavailable (${err.status || 'network'})` }; }
    return {
      cap: capNow(runs),
      capSettings: settings ? settings.describe() : null,
      admin: Boolean(req && isAdmin(req)),
      repos,
      agents: AGENTS,
      running: runs.filter((r) => r.status === 'running').map((r) => slimRun(r, active)),
      recent: runs.filter((r) => r.status !== 'running').slice(0, 25).map((r) => slimRun(r, active)),
      queue: q,
    };
  }

  function log(id) {
    if (!RUN_ID_RE.test(id || '')) return { status: 400, body: { ok: false, error: 'bad run id' } };
    const run = loadRuns().find((r) => r.id === id);
    if (!run || !run.log) return { status: 404, body: { ok: false, error: 'run or log not found' } };
    const file = path.resolve(run.log);
    if (path.dirname(file) !== runsDir) return { status: 403, body: { ok: false, error: 'log is outside the runs folder' } };
    let text = '';
    let truncated = false;
    try {
      const { size } = fs.statSync(file);
      const start = Math.max(0, size - LOG_TAIL_BYTES);
      truncated = start > 0;
      const fd = fs.openSync(file, 'r');
      try {
        const buf = Buffer.alloc(size - start);
        fs.readSync(fd, buf, 0, buf.length, start);
        text = buf.toString('utf8');
      } finally { fs.closeSync(fd); }
    } catch (_) {
      return { status: 404, body: { ok: false, error: 'log file not written yet' } };
    }
    return { status: 200, body: { ok: true, id, status: run.status, truncated, text } };
  }

  async function createTask(input) {
    if (!github) return { status: 503, body: { ok: false, error: 'GITHUB_TOKEN is not set; add it to the secrets file to queue tasks.' } };
    const v = validateTask(input, repos, specialists);
    if (!v.ok) return { status: 400, body: { ok: false, error: v.error } };
    const { repo, title, body, agent, specialist } = v.value;
    const labels = [QUEUE_LABELS.ready, `agent:${agent}`];
    if (specialist) {
      // specialist:<slug> tells the poller which persona to use. Created on
      // first use; GitHub caps label names at 50 characters.
      const label = `specialist:${specialist}`.slice(0, 50);
      if (github.ensureLabel) await github.ensureLabel(repo, { name: label, color: '5319e7', description: 'agency-agents persona for this task' });
      labels.push(label);
    }
    const issue = await github.createIssue(repo, { title, body: body || title, labels });
    queueCache = { at: 0, value: null };
    return { status: 201, body: { ok: true, number: issue.number, url: issue.html_url } };
  }

  /** Returns true when it handled the request. */
  function handle(req, res, { sendJson, readJsonBody }) {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/agents/overview' && req.method === 'GET') {
      overview(req).then((b) => sendJson(res, 200, b)).catch(() => sendJson(res, 500, { ok: false, error: 'could not read agent runs' }));
      return true;
    }
    if (url.pathname === '/api/agents/specialists/suggest' && req.method === 'GET') {
      if (!suggester) { sendJson(res, 200, { ok: true, ranker: 'none', suggestions: [] }); return true; }
      suggester.suggest(url.searchParams.get('q') || '', 3)
        .then((r) => sendJson(res, 200, { ok: true, ...r }))
        .catch(() => sendJson(res, 200, { ok: true, ranker: 'none', suggestions: [] }));
      return true;
    }
    if (url.pathname === '/api/agents/specialists' && req.method === 'GET') {
      sendJson(res, 200, specialists ? { ok: true, ...specialists.list() } : { ok: true, specialists: [], divisions: {} });
      return true;
    }
    if (url.pathname === '/api/agents/log' && req.method === 'GET') {
      const r = log(url.searchParams.get('id'));
      sendJson(res, r.status, r.body);
      return true;
    }
    if (url.pathname === '/api/agents/settings' && req.method === 'POST') {
      if (!isSameSiteJson(req)) {
        sendJson(res, 403, { ok: false, error: 'cross-site request refused' });
        return true;
      }
      if (!settings || !isAdmin(req)) {
        sendJson(res, 403, { ok: false, error: 'only an admin can change the daily limit' });
        return true;
      }
      readJsonBody(req, 1024)
        .then((b) => {
          const r = settings.setCap(b.dailyPaidRuns, actorOf(req));
          if (!r.ok) return sendJson(res, 400, { ok: false, error: r.error });
          console.log(`dispatch cap set to ${r.value.dailyPaidRuns} by ${r.value.updatedBy}`);
          return sendJson(res, 200, { ok: true, capSettings: settings.describe() });
        })
        .catch(() => sendJson(res, 400, { ok: false, error: 'bad request body' }));
      return true;
    }
    if (url.pathname === '/api/agents/task' && req.method === 'POST') {
      // Opening an issue starts a paid agent, so block cross-site requests:
      // JSON content type forces a CORS preflight (which this server never
      // grants), and a browser-sent Origin must be this host.
      if (!isSameSiteJson(req)) {
        sendJson(res, 403, { ok: false, error: 'cross-site request refused' });
        return true;
      }
      readJsonBody(req, 16 * 1024)
        .then(createTask)
        .then((r) => sendJson(res, r.status, r.body))
        .catch((err) => sendJson(res, err.status ? 502 : 400, { ok: false, error: err.status ? `GitHub refused the issue (${err.status})` : 'bad request body' }));
      return true;
    }
    return false;
  }

  return { handle, overview, log, createTask };
}

module.exports = { createAgentsApi, validateTask, linkOf, isSameSiteJson, AGENTS };
