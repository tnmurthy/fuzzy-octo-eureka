// agents-api.js - the Agents page's API: what is running, the GitHub issue
// queue, a run's live log, and "give an agent a task" (opens a GitHub issue
// labelled agent:ready, which the issue poller picks up).
//
//   GET  /api/agents/overview   cap, running + recent runs, issue queue
//   GET  /api/agents/mine       the signed-in person's threads (Ask page)
//   GET  /api/agents/request-kind?q=  answer | document | change guess
//   POST /api/agents/plan/approve {runId}  carry out a finished plan
//   GET  /api/agents/log?id=R   tail of run R's log (only files in the runs dir)
//   POST /api/agents/task       { repo, title, body, agent } -> new issue
//   POST /api/agents/settings   { dailyPaidRuns } (admin only) -> new cap
//   GET  /api/agents/specialists catalog of agency-agents personas (no bodies)
//   GET  /api/agents/specialists/suggest?q=  top 3 for a task description
//   GET  /api/agents/specialists/recommended  all, ranked by your usage + memory
//   GET  /api/agents/repos      registered repos + ones found on this machine
//   POST /api/agents/repos      { type: 'local', path } | { type: 'git', url } (admin)
//   POST /api/agents/repos/remove { name } (admin; unregisters, files stay)
//   POST /api/agents/run        { repo, agent, specialist?, title, body? } -> run now
//   POST /api/agents/followup   { runId, message } -> resume that claude run's session
//   POST /api/agents/stop       { runId } -> stop a running agent (run-control.js)
//   POST /api/agents/redirect   { runId, message } -> stop it, then resume with the message
//   GET  /api/agents/thread?id=R  the task R belongs to: every run (answer, question) + queue
//   POST /api/agents/queue      { runId, text } -> send now if the agent is idle, else queue it
//   POST /api/agents/queue/update { threadId, itemId, text? | move: up|down | remove }
//   POST /api/agents/queue/steer  { threadId, itemId } -> stop the agent, deliver that message now
//
// The GitHub queue is cached for QUEUE_TTL_MS so a page refreshing every few
// seconds does not burn the token's rate limit. Errors never carry the token.

const fs = require('fs');
const path = require('path');
const { resultOf } = require('./followup');
const { createAgentQueue } = require('./agent-queue');
const { myThreads, mayOpen } = require('./agents-mine');
const { REQUEST_KINDS, keywordKind } = require('./request-kinds');

const AGENTS = ['claude', 'hermes', 'codex', 'noop', 'auto'];
const QUEUE_LABELS = { ready: 'agent:ready', running: 'agent:running', review: 'agent:review', failed: 'agent:failed' };
const QUEUE_TTL_MS = 30000;
const LOG_TAIL_BYTES = 64 * 1024;
const MAX_TITLE = 200;
const MAX_BODY = 8000;
const RUN_ID_RE = /^[A-Za-z0-9._-]{1,80}$/;

const MAX_QUESTION = 600;

/**
 * The question an agent ended its answer with ("QUESTION: ..." on its own
 * line, the convention agent-dispatch.sh gives runs started from this page).
 */
function questionOf(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 5); i -= 1) {
    const m = lines[i].match(/^\**QUESTION:\**\s*(.+)$/i);
    if (m) return m[1].replace(/\*+$/, '').trim().slice(0, MAX_QUESTION) || null;
  }
  return null;
}

/** Validate a "give an agent a task" request. Returns { ok, value } or { ok: false, error }. */
function validateTask(input, repos, specialists = null) {
  const o = input && typeof input === 'object' ? input : {};
  const repo = String(o.repo || '').trim();
  const title = String(o.title || '').trim();
  const body = String(o.body || '').trim();
  const agent = String(o.agent || 'hermes').trim();
  if (!repos.includes(repo)) return { ok: false, error: `repo must be one of: ${repos.join(', ')}` };
  if (!title) return { ok: false, error: 'title is required' };
  if (title.length > MAX_TITLE) return { ok: false, error: `title is longer than ${MAX_TITLE} characters` };
  if (body.length > MAX_BODY) return { ok: false, error: `description is longer than ${MAX_BODY} characters` };
  if (!AGENTS.includes(agent)) return { ok: false, error: `agent must be one of: ${AGENTS.join(', ')}` };
  const specialist = String(o.specialist || '').trim();
  if (specialist && !(specialists && specialists.get(specialist))) return { ok: false, error: 'unknown specialist' };
  return { ok: true, value: { repo, title, body, agent, specialist: specialist || null } };
}

const HOMES = [...new Set([require('os').homedir(), (() => { try { return fs.realpathSync.native(require('os').homedir()); } catch (_) { return null; } })()].filter(Boolean))];
const tilde = (p) => {
  const h = p && HOMES.find((x) => p.toLowerCase().startsWith(`${x.toLowerCase()}${path.sep}`));
  return h ? `~${p.slice(h.length)}` : p;
};
// owner/name from a GitHub remote, to tell which repos the issue poller watches.
const ownerRepo = (remote) => {
  const m = String(remote || '').match(/github\.com[:/]([^/]+\/[^/]+?)(\.git)?\/?$/);
  return m ? m[1] : null;
};

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
  specialist: r.specialist || (active[r.id] && active[r.id].specialist) || null,
  status: r.status,
  started_at: r.started_at,
  finished_at: r.finished_at,
  duration_s: r.duration_s,
  commits_ahead: r.commits_ahead,
  task: String(r.task || '').slice(0, 300),
  link: linkOf(r, active),
  hasLog: Boolean(r.log),
  parent: r.parent || null,
  kind: r.kind || null,
  helper: r.helper || null,
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
function createAgentsApi({ runsFile, stateFile, readRuns, capNow, repos, github, settings = null, teammateModeSetting = null, classifyKind = null, specialists = null, suggester = null, recommender = null, repoRegistry = null, runChanges = null, dispatchRun = null, canFollowUp = () => false, runControl = null, queueFile = null, isAdmin = () => false, actorOf = () => 'unknown', now = Date.now }) {
  const runsDir = path.resolve(path.dirname(runsFile));
  let queueCache = { at: 0, value: null };

  /**
   * Continue a finished run with a message: resume its session (same agent,
   * branch, worktree). A run with no session to resume (a local run stopped
   * before it reported one) gets a fresh run of the same agent on its branch.
   * Returns dispatchRun's { status, body }.
   */
  async function continueWith(run, task, by = null) {
    const ctx = { by };
    let r = await dispatchRun({ followUpOf: run.id, canAsk: true, task }, ctx);
    if (r.status === 400 && /no session/.test(String(r.body && r.body.error)) && run.agent && run.branch && run.repo) {
      r = await dispatchRun({
        agent: run.agent, repo: path.basename(String(run.repo).replace(/[\\/]+$/, '')), branch: run.branch, canAsk: true,
        task: `${task}\n\n(Your earlier session on this branch could not be resumed; read the code and git log to see where it got to.)`,
      }, ctx);
      r = { ...r, body: { ...r.body, fresh: true } };
    }
    return r;
  }

  // Messages written while an agent works wait here (agent-queue.js).
  const agentQueue = queueFile && dispatchRun ? createAgentQueue({
    file: queueFile,
    loadRuns: () => loadRuns(),
    continueRun: async (run, text, item) => {
      const r = await continueWith(run, `Follow-up: ${text}`, item && item.by);
      return r.status < 300 ? { ok: true, runId: r.body.runId } : { ok: false, error: (r.body && r.body.error) || `HTTP ${r.status}` };
    },
    now,
    log: (m) => console.log(m),
  }) : null;

  /** Stop a running agent, wait for its end line, then continue it with `message`. */
  async function redirectRun(runId, message, by = null) {
    const st = runControl.stop(runId);
    if (!st.ok) return { status: st.status || 409, body: { ok: false, error: st.error } };
    const ended = await runControl.waitForEnd(runId);
    if (!ended) return { status: 504, body: { ok: false, error: 'the agent was told to stop but has not finished yet; try again in a moment' } };
    const task = `Follow-up: the person stopped you mid-task and changed direction. Check git status for uncommitted work first. New instruction: ${message}`;
    const r = await continueWith({ ...ended, id: runId }, task, by);
    return { status: r.status, body: { ...r.body, stopped: runId } };
  }

  const loadRuns = () => readRuns(runsFile, 5000).runs || [];
  // Each request is visible only to the person who started it, and admins
  // (agents-mine.js mayOpen). Someone else's run reads as not found.
  const notYours = (req, runId, runs = loadRuns()) =>
    !mayOpen({ runs, runId: String(runId || ''), actor: actorOf(req), admin: Boolean(isAdmin(req)) });
  const NOT_FOUND = { ok: false, error: 'run not found' };
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

  // The agent's open question on a finished run, unless a follow-up already
  // answered it. Reads <run>.claude.json (result text) only inside the runs dir.
  function openQuestion(run, answered) {
    if (run.status !== 'done' || answered.has(run.id) || !run.log) return null;
    if (path.dirname(path.resolve(String(run.log))) !== runsDir) return null;
    const j = resultOf(run);
    return j ? questionOf(j.result) : null;
  }

  async function overview(req) {
    const all = loadRuns();
    const runs = req && isAdmin(req) ? all : all.filter((r) => !notYours(req, r.id, all));
    const answered = new Set(runs.map((r) => r.parent).filter(Boolean));
    const active = loadActive();
    let q;
    try { q = await queue(); } catch (err) { q = { available: false, note: `GitHub queue unavailable (${err.status || 'network'})` }; }
    return {
      cap: capNow(runs),
      capSettings: settings ? settings.describe() : null,
      teammateMode: teammateModeSetting ? teammateModeSetting.describe() : null,
      admin: Boolean(req && isAdmin(req)),
      repos,
      agents: AGENTS,
      running: runs.filter((r) => r.status === 'running').map((r) => slimRun(r, active)),
      recent: runs.filter((r) => r.status !== 'running').slice(0, 25).map((r) => ({ ...slimRun(r, active), canFollowUp: Boolean(canFollowUp(r)), question: openQuestion(r, answered) })),
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
    if (url.pathname === '/api/agents/repos' && req.method === 'GET') {
      if (!repoRegistry) { sendJson(res, 200, { ok: true, repos: [], suggestions: [], canAdd: false }); return true; }
      const list = repoRegistry.list().map((r) => {
        const gh = ownerRepo(r.remote);
        return { name: r.name, path: tilde(r.path), source: r.source, remote: r.remote || null, exists: r.exists, github: gh, watched: Boolean(gh && repos.includes(gh)) };
      });
      sendJson(res, 200, { ok: true, repos: list, suggestions: repoRegistry.discover().map((d) => ({ name: d.name, path: d.display })), canAdd: Boolean(isAdmin(req)) });
      return true;
    }
    if ((url.pathname === '/api/agents/repos' || url.pathname === '/api/agents/repos/remove') && req.method === 'POST') {
      if (!isSameSiteJson(req)) { sendJson(res, 403, { ok: false, error: 'cross-site request refused' }); return true; }
      if (!repoRegistry || !isAdmin(req)) { sendJson(res, 403, { ok: false, error: 'only an admin can add or remove repositories' }); return true; }
      readJsonBody(req, 4096)
        .then(async (b) => {
          if (url.pathname.endsWith('/remove')) {
            const r = repoRegistry.remove(String(b.name || ''));
            return sendJson(res, r.ok ? 200 : 400, r);
          }
          const r = b.type === 'git' ? await repoRegistry.addGit(b.url, actorOf(req))
            : b.type === 'local' ? await repoRegistry.addLocal(b.path, actorOf(req))
              : { ok: false, error: "type must be 'local' or 'git'" };
          if (!r.ok) return sendJson(res, 400, { ok: false, error: r.error });
          if (recommender) recommender.invalidate();
          return sendJson(res, r.already ? 200 : 201, { ok: true, already: Boolean(r.already), repo: { name: r.value.name, path: tilde(r.value.path), remote: r.value.remote || null } });
        })
        .catch(() => sendJson(res, 400, { ok: false, error: 'bad request body' }));
      return true;
    }
    if (url.pathname === '/api/agents/followup' && req.method === 'POST') {
      // Send a message to a finished claude run: its session resumes on the
      // same branch. Same checks and paid cap as any dispatch.
      if (!isSameSiteJson(req)) { sendJson(res, 403, { ok: false, error: 'cross-site request refused' }); return true; }
      if (!dispatchRun) { sendJson(res, 503, { ok: false, error: 'follow-ups are not available' }); return true; }
      readJsonBody(req, 16 * 1024)
        .then(async (b) => {
          const message = String(b.message || '').trim();
          if (!message) return sendJson(res, 400, { ok: false, error: 'write a message for the agent' });
          if (message.length > MAX_BODY) return sendJson(res, 400, { ok: false, error: 'message is too long' });
          if (notYours(req, b.runId)) return sendJson(res, 404, NOT_FOUND);
          // The level is capped at the parent run's by startDispatch (approval-levels.js).
          const r = await dispatchRun({
            followUpOf: String(b.runId || ''), task: `Follow-up: ${message}`, canAsk: true, ...(b.level ? { level: String(b.level) } : {}),
          }, { by: actorOf(req) });
          return sendJson(res, r.status, r.body);
        })
        .catch(() => sendJson(res, 400, { ok: false, error: 'bad request body' }));
      return true;
    }
    if ((url.pathname === '/api/agents/stop' || url.pathname === '/api/agents/redirect') && req.method === 'POST') {
      // Stop a running agent; redirect = stop, wait for its end line, then
      // resume its session with the new instruction (a paid follow-up).
      if (!isSameSiteJson(req)) { sendJson(res, 403, { ok: false, error: 'cross-site request refused' }); return true; }
      if (!runControl) { sendJson(res, 503, { ok: false, error: 'stopping runs is not available' }); return true; }
      const redirect = url.pathname.endsWith('/redirect');
      readJsonBody(req, 16 * 1024)
        .then(async (b) => {
          const runId = String(b.runId || '');
          const message = String(b.message || '').trim();
          if (redirect && !message) return sendJson(res, 400, { ok: false, error: 'tell the agent what to do instead' });
          if (message.length > MAX_BODY) return sendJson(res, 400, { ok: false, error: 'message is too long' });
          if (redirect && !dispatchRun) return sendJson(res, 503, { ok: false, error: 'follow-ups are not available' });
          if (notYours(req, runId)) return sendJson(res, 404, NOT_FOUND);
          if (!redirect) {
            const st = runControl.stop(runId);
            if (!st.ok) return sendJson(res, st.status || 409, { ok: false, error: st.error });
            const ended = await runControl.waitForEnd(runId);
            if (!ended) return sendJson(res, 504, { ok: false, error: 'the agent was told to stop but has not finished yet; try again in a moment' });
            return sendJson(res, 200, { ok: true, runId, status: ended.status });
          }
          const r = await redirectRun(runId, message, actorOf(req));
          return sendJson(res, r.status, r.body);
        })
        .catch(() => sendJson(res, 400, { ok: false, error: 'bad request body' }));
      return true;
    }
    if (url.pathname === '/api/agents/request-kind' && req.method === 'GET') {
      // The Ask page's guess at answer / document / change (request-kinds.js).
      const q = String(url.searchParams.get('q') || '').slice(0, 600);
      Promise.resolve(classifyKind ? classifyKind(q) : { kind: keywordKind(q), source: 'keywords' })
        .then((r) => sendJson(res, 200, { ok: true, ...r }))
        .catch(() => sendJson(res, 200, { ok: true, kind: keywordKind(q), source: 'keywords' }));
      return true;
    }
    if (url.pathname === '/api/agents/plan/approve' && req.method === 'POST') {
      // "Go ahead" on a plan: a new run on the same branch that carries out the
      // plan (kind change), with the request and the plan in its task.
      if (!isSameSiteJson(req)) { sendJson(res, 403, { ok: false, error: 'cross-site request refused' }); return true; }
      if (!dispatchRun) { sendJson(res, 503, { ok: false, error: 'run now is not available' }); return true; }
      readJsonBody(req, 1024)
        .then(async (b) => {
          const runs = loadRuns();
          if (notYours(req, b.runId, runs)) return sendJson(res, 404, NOT_FOUND);
          const plan = runs.find((r) => r.id === String(b.runId || ''));
          if (!plan || plan.kind !== 'plan') return sendJson(res, 400, { ok: false, error: 'that is not a plan' });
          if (plan.status !== 'done') return sendJson(res, 409, { ok: false, error: 'the plan is not finished yet' });
          if (runs.some((r) => r.parent === plan.id)) return sendJson(res, 409, { ok: false, error: 'this plan already has a newer reply; approve the latest plan' });
          const j = path.dirname(path.resolve(String(plan.log || ''))) === runsDir ? resultOf(plan) : null;
          const planText = j && j.result ? String(j.result).slice(0, 6000) : '';
          if (!planText.trim()) return sendJson(res, 409, { ok: false, error: 'the plan has no text to approve; ask for it again' });
          const t = agentQueue ? agentQueue.threadOf(plan.id) : null;
          const root = t && t.runs.length ? t.runs[0] : plan;
          const request = String(root.task || '').slice(0, 2000);
          const task = `Go ahead with the plan.\n\nOriginal request: ${request}\n\nApproved plan:\n${planText}`;
          const r = await dispatchRun({ followUpOf: plan.id, approvePlan: true, canAsk: true, task }, { by: actorOf(req) });
          return sendJson(res, r.status, r.body);
        })
        .catch(() => sendJson(res, 400, { ok: false, error: 'bad request body' }));
      return true;
    }
    if (url.pathname === '/api/agents/mine' && req.method === 'GET') {
      // The Ask page's list: only threads this person started (agents-mine.js).
      // Light on purpose: no GitHub queue, polled every few seconds.
      const runs = loadRuns();
      const answered = new Set(runs.map((r) => r.parent).filter(Boolean));
      const threads = myThreads({
        runs,
        actor: actorOf(req),
        decorate: (r) => ({ ...r, canFollowUp: Boolean(canFollowUp(r)), question: openQuestion(r, answered) }),
        now: now(),
      });
      sendJson(res, 200, {
        ok: true,
        me: actorOf(req),
        admin: Boolean(isAdmin(req)),
        teammateMode: teammateModeSetting ? teammateModeSetting.get() : null,
        cap: capNow(runs),
        threads,
      });
      return true;
    }
    if (url.pathname === '/api/agents/thread' && req.method === 'GET') {
      const id = url.searchParams.get('id') || '';
      if (!RUN_ID_RE.test(id)) { sendJson(res, 400, { ok: false, error: 'bad run id' }); return true; }
      const runs = loadRuns();
      if (notYours(req, id, runs)) { sendJson(res, 404, NOT_FOUND); return true; }
      const t = agentQueue ? agentQueue.threadOf(id) : null;
      const chain = t ? t.runs : runs.filter((r) => r.id === id);
      if (!chain.length) { sendJson(res, 404, { ok: false, error: 'run not found' }); return true; }
      const active = loadActive();
      const answered = new Set(runs.map((r) => r.parent).filter(Boolean));
      const items = chain.map((r) => {
        const j = r.status === 'running' || path.dirname(path.resolve(String(r.log || ''))) !== runsDir ? null : resultOf(r);
        return {
          ...slimRun(r, active),
          canFollowUp: Boolean(canFollowUp(r)),
          question: openQuestion(r, answered),
          answer: j && j.result ? String(j.result).slice(0, 6000) : null,
        };
      });
      const q = agentQueue ? agentQueue.view(id) : null;
      sendJson(res, 200, { ok: true, threadId: t ? t.threadId : id, runs: items, queue: q ? q.items : [], inflight: q ? q.inflight : null, canQueue: Boolean(agentQueue) });
      return true;
    }
    if (url.pathname.startsWith('/api/agents/queue') && req.method === 'POST') {
      if (!isSameSiteJson(req)) { sendJson(res, 403, { ok: false, error: 'cross-site request refused' }); return true; }
      if (!agentQueue) { sendJson(res, 503, { ok: false, error: 'the message queue is not available' }); return true; }
      readJsonBody(req, 16 * 1024)
        .then(async (b) => {
          if (notYours(req, b.runId || b.threadId)) return sendJson(res, 404, NOT_FOUND);
          if (url.pathname === '/api/agents/queue') {
            // Idle agent: send now (a follow-up). Working agent: queue it.
            const t = agentQueue.threadOf(String(b.runId || ''));
            if (!t) return sendJson(res, 404, { ok: false, error: 'run not found' });
            const latest = t.runs[t.runs.length - 1];
            const text = String(b.text || '').trim();
            if (latest.status !== 'running' && !(agentQueue.view(t.threadId).items.length)) {
              if (!text) return sendJson(res, 400, { ok: false, error: 'write a message' });
              if (text.length > MAX_BODY) return sendJson(res, 400, { ok: false, error: 'message is too long' });
              const r = await continueWith(latest, `Follow-up: ${text}`, actorOf(req));
              return sendJson(res, r.status, { ...r.body, sent: r.status < 300 });
            }
            const r = agentQueue.add({ runId: latest.id, text, by: actorOf(req) });
            return sendJson(res, r.ok ? 201 : r.status, r.ok ? { ok: true, queued: true, threadId: r.threadId, item: r.item } : { ok: false, error: r.error });
          }
          if (url.pathname === '/api/agents/queue/update') {
            const r = agentQueue.update({ threadId: String(b.threadId || ''), itemId: String(b.itemId || ''), text: b.text, move: b.move, remove: b.remove === true });
            return sendJson(res, r.ok ? 200 : r.status, r.ok ? { ok: true } : { ok: false, error: r.error });
          }
          if (url.pathname === '/api/agents/queue/steer') {
            // Deliver one queued message now: stop the working agent and redirect it.
            if (!runControl) return sendJson(res, 503, { ok: false, error: 'stopping runs is not available' });
            const t = agentQueue.threadOf(String(b.threadId || ''));
            if (!t) return sendJson(res, 404, { ok: false, error: 'task not found' });
            const latest = t.runs[t.runs.length - 1];
            if (latest.status !== 'running') return sendJson(res, 409, { ok: false, error: 'the agent is not working; the message will be sent on the next check' });
            const item = agentQueue.take({ threadId: t.threadId, itemId: String(b.itemId || '') });
            if (!item) return sendJson(res, 404, { ok: false, error: 'queued message not found' });
            const r = await redirectRun(latest.id, item.text, item.by || actorOf(req));
            if (r.status >= 300) agentQueue.add({ runId: latest.id, text: item.text, by: item.by }); // put it back
            return sendJson(res, r.status, r.body);
          }
          return sendJson(res, 404, { ok: false, error: 'unknown queue action' });
        })
        .catch(() => sendJson(res, 400, { ok: false, error: 'bad request body' }));
      return true;
    }
    if ((url.pathname === '/api/agents/changes' || url.pathname === '/api/agents/changes/file') && req.method === 'GET') {
      // Files changed on a run's draft copy (run-changes.js): the list, or one
      // file's diff. Owner or admin only; read-only.
      const id = url.searchParams.get('id') || '';
      if (!RUN_ID_RE.test(id)) { sendJson(res, 400, { ok: false, error: 'bad run id' }); return true; }
      if (!runChanges) { sendJson(res, 503, { ok: false, error: 'change view is not available' }); return true; }
      const runs = loadRuns();
      const run = runs.find((r) => r.id === id);
      if (!run || notYours(req, id, runs)) { sendJson(res, 404, NOT_FOUND); return true; }
      const file = url.pathname.endsWith('/file') ? String(url.searchParams.get('path') || '') : null;
      (file === null ? runChanges.summary(run) : runChanges.fileDiff(run, file))
        .then((r) => sendJson(res, r.ok ? 200 : r.status || 500, r.ok ? r : { ok: false, error: r.error }))
        .catch(() => sendJson(res, 500, { ok: false, error: 'could not read the changes' }));
      return true;
    }
    if (url.pathname === '/api/agents/make-changes' && req.method === 'POST') {
      // "Make these changes" under an answer or document: a new Change request
      // (plan first, then Go ahead) on the same project, carrying that reply.
      // Follow-ups keep their thread's kind, so this is the way from read-only
      // findings to edits.
      if (!isSameSiteJson(req)) { sendJson(res, 403, { ok: false, error: 'cross-site request refused' }); return true; }
      if (!dispatchRun) { sendJson(res, 503, { ok: false, error: 'run now is not available' }); return true; }
      readJsonBody(req, 1024)
        .then(async (b) => {
          const runs = loadRuns();
          if (notYours(req, b.runId, runs)) return sendJson(res, 404, NOT_FOUND);
          const src = runs.find((r) => r.id === String(b.runId || ''));
          if (!src) return sendJson(res, 404, NOT_FOUND);
          if (!['answer', 'document'].includes(src.kind)) return sendJson(res, 400, { ok: false, error: 'only an answer or a document can be turned into changes' });
          if (src.status !== 'done') return sendJson(res, 409, { ok: false, error: 'wait for the reply to finish first' });
          const j = path.dirname(path.resolve(String(src.log || ''))) === runsDir ? resultOf(src) : null;
          const findings = j && j.result ? String(j.result).slice(0, 8000) : '';
          if (!findings.trim()) return sendJson(res, 409, { ok: false, error: 'that reply has no text to act on' });
          const agent = String(b.agent || src.agent || 'hermes');
          if (!AGENTS.includes(agent)) return sendJson(res, 400, { ok: false, error: `agent must be one of: ${AGENTS.join(', ')}` });
          const t = agentQueue ? agentQueue.threadOf(src.id) : null;
          const root = t && t.runs.length ? t.runs[0] : src;
          const request = String(root.task || '').replace(/\s+/g, ' ').trim();
          const focus = String(b.focus || '').trim().slice(0, 2000);
          const task = `Make the changes from: ${request.slice(0, 120)}\n\n`
            + (focus ? `What to do now: ${focus}\n\n` : 'What to do now: the most valuable fixes below, smallest first.\n\n')
            + `Original request: ${request.slice(0, 2000)}\n\nThe ${src.kind} to act on:\n${findings}`;
          const repo = path.basename(String(src.repo || '').replace(/[\\/]+$/, ''));
          const r = await dispatchRun({
            agent, repo, task, branch: `agent/run-${now().toString(36)}`, canAsk: true, kind: 'change',
          }, { by: actorOf(req) });
          return sendJson(res, r.status, r.body);
        })
        .catch(() => sendJson(res, 400, { ok: false, error: 'bad request body' }));
      return true;
    }
    if (url.pathname === '/api/agents/run' && req.method === 'POST') {
      // Run now on any registered repo: no GitHub issue; the work lands on a
      // new branch in its own worktree. Same checks and paid cap as dispatch.
      if (!isSameSiteJson(req)) { sendJson(res, 403, { ok: false, error: 'cross-site request refused' }); return true; }
      if (!dispatchRun) { sendJson(res, 503, { ok: false, error: 'run now is not available' }); return true; }
      readJsonBody(req, 16 * 1024)
        .then(async (b) => {
          const title = String(b.title || '').trim();
          const details = String(b.body || '').trim();
          if (!title) return sendJson(res, 400, { ok: false, error: 'title is required' });
          if (title.length > MAX_TITLE || details.length > MAX_BODY) return sendJson(res, 400, { ok: false, error: 'task is too long' });
          const agent = String(b.agent || 'hermes');
          if (!AGENTS.includes(agent)) return sendJson(res, 400, { ok: false, error: `agent must be one of: ${AGENTS.join(', ')}` });
          const task = details ? `${title}\n\n${details}` : title;
          if (b.kind != null && !REQUEST_KINDS.includes(b.kind)) return sendJson(res, 400, { ok: false, error: `kind is one of: ${REQUEST_KINDS.join(', ')}` });
          const r = await dispatchRun({
            agent, repo: String(b.repo || ''), task, specialist: b.specialist || null,
            branch: `agent/run-${now().toString(36)}`, canAsk: true, ...(b.level ? { level: String(b.level) } : {}),
            ...(b.kind ? { kind: b.kind } : {}),
          }, { by: actorOf(req) });
          if (r.status < 300 && recommender) recommender.invalidate();
          return sendJson(res, r.status, r.body);
        })
        .catch(() => sendJson(res, 400, { ok: false, error: 'bad request body' }));
      return true;
    }
    if (url.pathname === '/api/agents/specialists/recommended' && req.method === 'GET') {
      if (!recommender) { sendJson(res, 200, { ok: true, ranker: 'none', signals: [], ranked: [] }); return true; }
      recommender.recommend()
        .then((r) => sendJson(res, 200, { ok: true, ...r }))
        .catch(() => sendJson(res, 200, { ok: true, ranker: 'none', signals: [], ranked: [] }));
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
      if (notYours(req, url.searchParams.get('id'))) { sendJson(res, 404, NOT_FOUND); return true; }
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
        sendJson(res, 403, { ok: false, error: 'only an admin can change agent settings' });
        return true;
      }
      readJsonBody(req, 1024)
        .then((b) => {
          if (b.teammateMode !== undefined) {
            if (!teammateModeSetting) return sendJson(res, 404, { ok: false, error: 'teammate mode is not available here' });
            const t = teammateModeSetting.set(b.teammateMode, actorOf(req));
            if (!t.ok) return sendJson(res, 400, { ok: false, error: t.error });
            console.log(`teammate run mode set to ${t.value.mode} by ${t.value.updatedBy}`);
            return sendJson(res, 200, { ok: true, teammateMode: teammateModeSetting.describe() });
          }
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
      // An issue runs later under the poller, which cannot tell who asked, so
      // teammates may queue issues only when their runs are unrestricted
      // (sandbox mode); otherwise they use Run now, where the mode applies.
      if (!isAdmin(req) && teammateModeSetting && teammateModeSetting.get() !== 'sandbox') {
        sendJson(res, 403, { ok: false, error: 'GitHub issue tasks are for admins in the current teammate mode; use Run now.' });
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

  return { handle, overview, log, createTask, tickQueue: () => (agentQueue ? agentQueue.tick() : Promise.resolve([])) };
}

module.exports = { createAgentsApi, validateTask, linkOf, isSameSiteJson, questionOf, AGENTS };
