// node --test agents-api.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createAgentsApi, validateTask, linkOf, isSameSiteJson } = require('./agents-api');

const REPOS = ['me/app'];

function setup({ runs = [], active = {}, github = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-api-'));
  const runsFile = path.join(dir, 'runs.jsonl');
  const stateFile = path.join(dir, 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ active }));
  const api = createAgentsApi({
    runsFile,
    stateFile,
    readRuns: () => ({ runs }),
    capNow: () => ({ used: 2, cap: 20 }),
    repos: REPOS,
    github,
  });
  return { api, dir };
}

test('validateTask accepts a good task and defaults the agent to hermes (local)', () => {
  const v = validateTask({ repo: 'me/app', title: '  Fix it  ' }, REPOS);
  assert.deepEqual(v, { ok: true, value: { repo: 'me/app', title: 'Fix it', body: '', agent: 'hermes', specialist: null } });
});

test('validateTask rejects unknown repos, empty or long titles, long bodies and unknown agents', () => {
  assert.match(validateTask({ repo: 'evil/x', title: 't' }, REPOS).error, /repo must be one of/);
  assert.match(validateTask({ repo: 'me/app', title: ' ' }, REPOS).error, /title is required/);
  assert.match(validateTask({ repo: 'me/app', title: 'x'.repeat(201) }, REPOS).error, /longer than 200/);
  assert.match(validateTask({ repo: 'me/app', title: 't', body: 'x'.repeat(8001) }, REPOS).error, /longer than 8000/);
  assert.match(validateTask({ repo: 'me/app', title: 't', agent: 'rm -rf' }, REPOS).error, /agent must be one of/);
  assert.equal(validateTask(null, REPOS).ok, false);
});

test('linkOf prefers poller state, then reads the task text', () => {
  assert.deepEqual(linkOf({ id: 'a' }, { a: { kind: 'review', pr: 9, repo: 'me/app' } }), { kind: 'review', pr: 9, repo: 'me/app' });
  assert.deepEqual(linkOf({ id: 'b', task: 'GitHub issue me/app#12: Fix typo' }, {}), { kind: 'issue', issue: 12, repo: 'me/app' });
  assert.deepEqual(linkOf({ id: 'c', task: 'Review pull request #31 in me/app: the changes' }, {}), { kind: 'review', pr: 31, repo: 'me/app' });
  assert.equal(linkOf({ id: 'd', task: 'hello' }, {}), null);
});

test('isSameSiteJson blocks cross-site and non-JSON posts', () => {
  const json = { 'content-type': 'application/json', host: '127.0.0.1:8787' };
  assert.equal(isSameSiteJson({ headers: json }), true);
  assert.equal(isSameSiteJson({ headers: { ...json, origin: 'http://127.0.0.1:8787' } }), true);
  assert.equal(isSameSiteJson({ headers: { ...json, origin: 'https://evil.example' } }), false);
  assert.equal(isSameSiteJson({ headers: { ...json, 'sec-fetch-site': 'cross-site' } }), false);
  assert.equal(isSameSiteJson({ headers: { 'content-type': 'text/plain', host: '127.0.0.1:8787' } }), false);
});

test('overview splits running from recent and hides the queue without a token', async () => {
  const runs = [
    { id: 'r2', agent: 'claude', status: 'running', started_at: '2026-11-17T10:00:00Z', task: 'GitHub issue me/app#5: A', log: '/x/r2.log' },
    { id: 'r1', agent: 'noop', status: 'done', duration_s: 3, task: 'B' },
  ];
  const { api } = setup({ runs });
  const o = await api.overview();
  assert.deepEqual(o.cap, { used: 2, cap: 20 });
  assert.equal(o.running.length, 1);
  assert.deepEqual(o.running[0].link, { kind: 'issue', issue: 5, repo: 'me/app' });
  assert.equal(o.running[0].hasLog, true);
  assert.equal('log' in o.running[0], false, 'local paths stay on the server');
  assert.equal(o.recent.length, 1);
  assert.equal(o.queue.available, false);
});

test('overview groups the GitHub queue by label and caches it', async () => {
  let calls = 0;
  const github = {
    listIssuesWithLabel: async (repo, label) => {
      calls += 1;
      return label === 'agent:ready' ? [{ number: 7, title: 'Do X', html_url: 'u7', labels: [{ name: 'agent:ready' }, { name: 'agent:hermes' }] }] : [];
    },
  };
  const { api } = setup({ github });
  const o = await api.overview();
  assert.deepEqual(o.queue.columns.ready, [{ repo: 'me/app', number: 7, title: 'Do X', url: 'u7', updated_at: undefined, agent: 'hermes' }]);
  assert.deepEqual(o.queue.columns.review, []);
  await api.overview();
  assert.equal(calls, 4, 'second call within the TTL is served from cache');
});

test('a GitHub outage does not break the overview', async () => {
  const github = { listIssuesWithLabel: async () => { throw Object.assign(new Error('x'), { status: 502 }); } };
  const { api } = setup({ github });
  const o = await api.overview();
  assert.equal(o.queue.available, false);
  assert.match(o.queue.note, /502/);
});

test('log serves only files inside the runs folder, by run id', () => {
  const { dir } = setup();
  const inside = path.join(dir, 'r1.log');
  fs.writeFileSync(inside, 'line 1\nline 2\n');
  const runs = [
    { id: 'r1', status: 'running', log: inside },
    { id: 'r2', status: 'done', log: '/etc/passwd' },
  ];
  const api = createAgentsApi({ runsFile: path.join(dir, 'runs.jsonl'), stateFile: path.join(dir, 'state.json'), readRuns: () => ({ runs }), capNow: () => ({}), repos: REPOS, github: null });
  assert.deepEqual(api.log('r1'), { status: 200, body: { ok: true, id: 'r1', status: 'running', truncated: false, text: 'line 1\nline 2\n' } });
  assert.equal(api.log('r2').status, 403);
  assert.equal(api.log('../etc').status, 400);
  assert.equal(api.log('nope').status, 404);
});

test('createTask opens an issue labelled agent:ready plus the agent', async () => {
  let sent;
  const github = {
    listIssuesWithLabel: async () => [],
    createIssue: async (repo, issue) => { sent = { repo, ...issue }; return { number: 44, html_url: 'https://github.com/me/app/issues/44' }; },
  };
  const { api } = setup({ github });
  const r = await api.createTask({ repo: 'me/app', title: 'Add docs', body: '', agent: 'hermes' });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body, { ok: true, number: 44, url: 'https://github.com/me/app/issues/44' });
  assert.deepEqual(sent, { repo: 'me/app', title: 'Add docs', body: 'Add docs', labels: ['agent:ready', 'agent:hermes'] });
});

test('createTask refuses without a token or with bad input', async () => {
  assert.equal((await setup().api.createTask({ repo: 'me/app', title: 't' })).status, 503);
  const { api } = setup({ github: { createIssue: async () => { throw new Error('should not be called'); } } });
  assert.equal((await api.createTask({ repo: 'other/x', title: 't' })).status, 400);
});

// ---- admin: change the daily limit ----------------------------------------
const { Readable } = require('stream');
const { createTeammateModeSetting } = require('./teammate-mode');
const { createDispatchSettings } = require('./dispatch-settings');

function call(api, { method = 'POST', url, body, headers = {} }) {
  return new Promise((resolve) => {
    const req = Readable.from(body == null ? [] : [JSON.stringify(body)]);
    Object.assign(req, { method, url, headers: { 'content-type': 'application/json', host: '127.0.0.1:8787', ...headers } });
    const sendJson = (_res, status, payload) => resolve({ status, payload });
    const readJsonBody = (r) => new Promise((ok, bad) => {
      let s = '';
      r.on('data', (c) => { s += c; });
      r.on('end', () => { try { ok(JSON.parse(s || '{}')); } catch (e) { bad(e); } });
    });
    api.handle(req, {}, { sendJson, readJsonBody });
  });
}

function settingsApi(admin) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-set-'));
  const settings = createDispatchSettings({ file: path.join(dir, 's.json'), envCap: 20 });
  const teammateModeSetting = createTeammateModeSetting({ file: path.join(dir, 'tm.json'), envMode: 'sandbox' });
  const api = createAgentsApi({
    runsFile: path.join(dir, 'runs.jsonl'), stateFile: path.join(dir, 'st.json'),
    readRuns: () => ({ runs: [] }), capNow: () => ({ used: 0, cap: settings.cap() }),
    repos: REPOS, github: null, settings, teammateModeSetting, isAdmin: () => admin, actorOf: () => 'sriad',
  });
  return { api, settings, teammateModeSetting };
}

test('an admin can change the daily limit; it applies at once and is reported', async () => {
  const { api, settings } = settingsApi(true);
  const r = await call(api, { url: '/api/agents/settings', body: { dailyPaidRuns: 50 } });
  assert.equal(r.status, 200);
  assert.equal(settings.cap(), 50);
  assert.equal(r.payload.capSettings.updatedBy, 'sriad');
  const o = await api.overview({ headers: {} });
  assert.equal(o.admin, true);
  assert.equal(o.capSettings.dailyPaidRuns, 50);
});

test('non-admins, cross-site posts and bad values cannot change the limit', async () => {
  const user = settingsApi(false);
  assert.equal((await call(user.api, { url: '/api/agents/settings', body: { dailyPaidRuns: 999 } })).status, 403);
  assert.equal(user.settings.cap(), 20);
  assert.equal((await user.api.overview({ headers: {} })).admin, false);

  const admin = settingsApi(true);
  assert.equal((await call(admin.api, { url: '/api/agents/settings', body: { dailyPaidRuns: 50 }, headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await call(admin.api, { url: '/api/agents/settings', body: { dailyPaidRuns: -1 } })).status, 400);
  assert.equal(admin.settings.cap(), 20);
});

test('createTask adds a specialist label after making sure it exists, and rejects unknown ones', async () => {
  const made = [];
  let sent;
  const github = {
    listIssuesWithLabel: async () => [],
    ensureLabel: async (repo, l) => { made.push(l.name); },
    createIssue: async (repo, issue) => { sent = issue; return { number: 5, html_url: 'u' }; },
  };
  const specialists = { get: (s) => (s === 'engineering-code-reviewer' ? { slug: s } : null), list: () => ({ specialists: [{ slug: 'engineering-code-reviewer' }] }) };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-sp-'));
  const api = createAgentsApi({ runsFile: path.join(dir, 'r.jsonl'), stateFile: path.join(dir, 's.json'), readRuns: () => ({ runs: [] }), capNow: () => ({}), repos: REPOS, github, specialists });
  const ok = await api.createTask({ repo: 'me/app', title: 'Review it', specialist: 'engineering-code-reviewer' });
  assert.equal(ok.status, 201);
  assert.deepEqual(made, ['specialist:engineering-code-reviewer']);
  assert.deepEqual(sent.labels, ['agent:ready', 'agent:hermes', 'specialist:engineering-code-reviewer']);
  const bad = await api.createTask({ repo: 'me/app', title: 'x', specialist: 'made-up' });
  assert.equal(bad.status, 400);
  const list = await call(api, { method: 'GET', url: '/api/agents/specialists' });
  assert.equal(list.payload.specialists.length, 1);
});

// ---- repos + run now --------------------------------------------------------
function workspaceApi({ admin = true, dispatchRun } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-ws-'));
  const added = [];
  const repoRegistry = {
    list: () => [
      { name: 'app', path: path.join(os.homedir(), 'code', 'app'), source: 'local', remote: 'git@github.com:me/app.git', exists: true },
      { name: 'tool', path: '/opt/tool', source: 'git', remote: 'https://github.com/other/tool', exists: true },
    ],
    discover: () => [{ name: 'beta', display: '~/projects/beta' }],
    addLocal: async (p, actor) => { added.push(['local', p, actor]); return { ok: true, value: { name: 'x', path: p } }; },
    addGit: async (u) => (u.startsWith('https://') ? { ok: true, value: { name: 'y', path: '/c/y', remote: u } } : { ok: false, error: 'use an https URL' }),
    remove: () => ({ ok: true }),
  };
  const api = createAgentsApi({
    runsFile: path.join(dir, 'r.jsonl'), stateFile: path.join(dir, 's.json'), readRuns: () => ({ runs: [] }), capNow: () => ({}),
    repos: ['me/app'], github: null, repoRegistry, dispatchRun, isAdmin: () => admin, actorOf: () => 'sriad', now: () => 1_700_000_000_000,
  });
  return { api, added };
}

test('repos list shows home paths with ~, GitHub links, and which the poller watches', async () => {
  const { api } = workspaceApi();
  const r = await call(api, { method: 'GET', url: '/api/agents/repos' });
  assert.equal(r.payload.repos[0].path, '~/code/app');
  assert.deepEqual([r.payload.repos[0].github, r.payload.repos[0].watched], ['me/app', true]);
  assert.deepEqual([r.payload.repos[1].github, r.payload.repos[1].watched], ['other/tool', false]);
  assert.deepEqual(r.payload.suggestions, [{ name: 'beta', path: '~/projects/beta' }]);
  assert.equal(r.payload.canAdd, true);
});

test('only admins add repos, same-site only; errors come back as 400', async () => {
  const user = workspaceApi({ admin: false });
  assert.equal((await call(user.api, { url: '/api/agents/repos', body: { type: 'local', path: '~/x' } })).status, 403);
  const admin = workspaceApi();
  assert.equal((await call(admin.api, { url: '/api/agents/repos', body: { type: 'local', path: '~/x' }, headers: { origin: 'https://evil.example' } })).status, 403);
  const ok = await call(admin.api, { url: '/api/agents/repos', body: { type: 'local', path: '~/x' } });
  assert.equal(ok.status, 201);
  assert.deepEqual(admin.added[0], ['local', '~/x', 'sriad']);
  assert.equal((await call(admin.api, { url: '/api/agents/repos', body: { type: 'git', url: 'ftp://x' } })).status, 400);
  assert.equal((await call(admin.api, { url: '/api/agents/repos', body: { type: 'zip' } })).status, 400);
});

test('run now builds the task, picks a fresh branch and goes through dispatch', async () => {
  const sent = [];
  const { api } = workspaceApi({ dispatchRun: async (p) => { sent.push(p); return { status: 202, body: { ok: true, runId: 'r1', branch: p.branch } }; } });
  const r = await call(api, { url: '/api/agents/run', body: { repo: 'app', agent: 'claude', title: 'Add tests', body: 'for utils', specialist: 'testing-api-tester' } });
  assert.equal(r.status, 202);
  assert.deepEqual(sent[0], { agent: 'claude', repo: 'app', task: 'Add tests\n\nfor utils', specialist: 'testing-api-tester', branch: `agent/run-${(1_700_000_000_000).toString(36)}`, canAsk: true });
  assert.equal((await call(api, { url: '/api/agents/run', body: { repo: 'app', title: '', by: 'spoof' } })).status, 400);
  assert.equal((await call(api, { url: '/api/agents/run', body: { repo: 'app', title: 'x', agent: 'rm' } })).status, 400);
  assert.equal((await call(api, { url: '/api/agents/run', body: { repo: 'app', title: 'x' }, headers: { 'content-type': 'text/plain' } })).status, 403);
});

// ---- questions, stop and redirect (2026-11-22) -------------------------------
const { questionOf } = require('./agents-api');

test('questionOf reads a trailing QUESTION: line only', () => {
  assert.equal(questionOf('Did the refactor.\n\nQUESTION: Keep the old API for a release?'), 'Keep the old API for a release?');
  assert.equal(questionOf('**QUESTION:** Which DB?**'), 'Which DB?');
  assert.equal(questionOf('QUESTION: early\nline\nline\nline\nline\nline\nend'), null);
  assert.equal(questionOf('All done.'), null);
  assert.equal(questionOf(null), null);
});

test('overview shows an open question until a follow-up answers it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-q-'));
  const log = (id) => path.join(dir, `${id}.log`);
  fs.writeFileSync(path.join(dir, 'q1.claude.json'), JSON.stringify({ result: 'Made a plan.\nQUESTION: Postgres or SQLite?' }));
  fs.writeFileSync(path.join(dir, 'q2.claude.json'), JSON.stringify({ result: 'QUESTION: answered already?' }));
  let runs = [
    { id: 'q1', status: 'done', log: log('q1') },
    { id: 'q2', status: 'done', log: log('q2') },
    { id: 'f1', status: 'done', parent: 'q2', log: log('f1') },
  ];
  const api = createAgentsApi({ runsFile: path.join(dir, 'runs.jsonl'), stateFile: path.join(dir, 's.json'), readRuns: () => ({ runs }), capNow: () => ({}), repos: REPOS, github: null });
  const byId = (o) => Object.fromEntries(o.recent.map((r) => [r.id, r.question]));
  assert.deepEqual(byId(await api.overview({ headers: {} })), { q1: 'Postgres or SQLite?', q2: null, f1: null });
  runs = [...runs, { id: 'f2', status: 'running', parent: 'q1' }];
  assert.equal(byId(await api.overview({ headers: {} })).q1, null);
});

function controlApi({ stop, waitForEnd, dispatchRun }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-ctl-'));
  return createAgentsApi({
    runsFile: path.join(dir, 'r.jsonl'), stateFile: path.join(dir, 's.json'), readRuns: () => ({ runs: [] }), capNow: () => ({}),
    repos: REPOS, github: null, runControl: { stop, waitForEnd }, dispatchRun,
  });
}

test('stop signals the run and reports how it ended', async () => {
  const calls = [];
  const api = controlApi({ stop: (id) => { calls.push(id); return { ok: true }; }, waitForEnd: async () => ({ status: 'stopped' }) });
  const r = await call(api, { url: '/api/agents/stop', body: { runId: 'r1' } });
  assert.deepEqual([r.status, r.payload], [200, { ok: true, runId: 'r1', status: 'stopped' }]);
  assert.deepEqual(calls, ['r1']);
  assert.equal((await call(api, { url: '/api/agents/stop', body: { runId: 'r1' }, headers: { origin: 'https://evil.example' } })).status, 403);
  const refused = controlApi({ stop: () => ({ ok: false, status: 409, error: 'the run has already finished' }), waitForEnd: async () => null });
  assert.equal((await call(refused, { url: '/api/agents/stop', body: { runId: 'r1' } })).status, 409);
  const slow = controlApi({ stop: () => ({ ok: true }), waitForEnd: async () => null });
  assert.equal((await call(slow, { url: '/api/agents/stop', body: { runId: 'r1' } })).status, 504);
});

test('redirect stops, waits, then resumes the session with the new instruction', async () => {
  const order = [];
  const api = controlApi({
    stop: () => { order.push('stop'); return { ok: true }; },
    waitForEnd: async () => { order.push('wait'); return { status: 'stopped' }; },
    dispatchRun: async (p) => { order.push(p); return { status: 202, body: { ok: true, runId: 'r2' } }; },
  });
  assert.equal((await call(api, { url: '/api/agents/redirect', body: { runId: 'r1', message: '' } })).status, 400);
  assert.equal(order.length, 0);
  const r = await call(api, { url: '/api/agents/redirect', body: { runId: 'r1', message: 'Use SQLite instead' } });
  assert.equal(r.status, 202);
  assert.deepEqual(r.payload, { ok: true, runId: 'r2', stopped: 'r1' });
  assert.deepEqual(order.slice(0, 2), ['stop', 'wait']);
  assert.equal(order[2].followUpOf, 'r1');
  assert.equal(order[2].canAsk, true);
  assert.match(order[2].task, /New instruction: Use SQLite instead$/);
});

test('redirect of a local run stopped before it saved a session starts afresh on the same branch', async () => {
  const sent = [];
  const api = controlApi({
    stop: () => ({ ok: true }),
    waitForEnd: async () => ({ status: 'stopped', agent: 'hermes', branch: 'agent/run-x', repo: '/Users/me/code/app/' }),
    dispatchRun: async (p) => {
      sent.push(p);
      return p.followUpOf ? { status: 400, body: { ok: false, error: 'this run saved no session to resume' } } : { status: 202, body: { ok: true, runId: 'r3' } };
    },
  });
  const r = await call(api, { url: '/api/agents/redirect', body: { runId: 'r1', message: 'Use SQLite' } });
  assert.equal(r.status, 202);
  assert.equal(r.payload.fresh, true);
  assert.deepEqual([sent[1].agent, sent[1].repo, sent[1].branch], ['hermes', 'app', 'agent/run-x']);
  assert.match(sent[1].task, /New instruction: Use SQLite/);
});

// ---- thread view + message queue (2026-11-22) -------------------------------
function threadApi({ runs, dispatchRun, runControl } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-thread-'));
  fs.writeFileSync(path.join(dir, 'a.claude.json'), JSON.stringify({ session_id: 'x', result: 'Planned it.\nQUESTION: SQLite or Postgres?' }));
  let current = runs || [
    { id: 'a', agent: 'claude', status: 'done', task: 'Add a cache', started_at: '2026-11-22T10:00:00Z', log: path.join(dir, 'a.log'), branch: 'agent/x', repo: '/r/app' },
    { id: 'b', agent: 'claude', status: 'running', parent: 'a', task: 'Follow-up: SQLite', started_at: '2026-11-22T10:05:00Z', log: path.join(dir, 'b.log'), branch: 'agent/x', repo: '/r/app' },
  ];
  const sent = [];
  const api = createAgentsApi({
    runsFile: path.join(dir, 'runs.jsonl'), stateFile: path.join(dir, 's.json'), readRuns: () => ({ runs: current }), capNow: () => ({}),
    repos: REPOS, github: null, queueFile: path.join(dir, 'q.json'),
    dispatchRun: dispatchRun || (async (p) => { sent.push(p); return { status: 202, body: { ok: true, runId: `n${sent.length}` } }; }),
    runControl,
  });
  return { api, sent, setRuns: (r) => { current = r; }, runs: () => current };
}

test('thread: a task and its follow-ups, with answers, open questions and the queue', async () => {
  const t = threadApi();
  const r = await call(t.api, { method: 'GET', url: '/api/agents/thread?id=b' });
  assert.equal(r.status, 200);
  assert.equal(r.payload.threadId, 'a');
  assert.deepEqual(r.payload.runs.map((x) => [x.id, x.status]), [['a', 'done'], ['b', 'running']]);
  assert.equal(r.payload.runs[0].answer, 'Planned it.\nQUESTION: SQLite or Postgres?');
  assert.equal(r.payload.runs[0].question, null, 'answered by follow-up b');
  assert.equal((await call(t.api, { method: 'GET', url: '/api/agents/thread?id=../x' })).status, 400);
  assert.equal((await call(t.api, { method: 'GET', url: '/api/agents/thread?id=zzz' })).status, 404);
});

test('queue: a message to a working agent waits, then goes out as a follow-up when it finishes', async () => {
  const t = threadApi();
  const q = await call(t.api, { url: '/api/agents/queue', body: { runId: 'a', text: 'also add tests' } });
  assert.equal(q.status, 201);
  assert.equal(q.payload.queued, true);
  assert.equal(t.sent.length, 0);
  await t.api.tickQueue();
  assert.equal(t.sent.length, 0, 'agent still working');
  t.setRuns(t.runs().map((r) => (r.id === 'b' ? { ...r, status: 'done' } : r)));
  await t.api.tickQueue();
  assert.deepEqual([t.sent[0].followUpOf, t.sent[0].task], ['b', 'Follow-up: also add tests']);
  const view = await call(t.api, { method: 'GET', url: '/api/agents/thread?id=a' });
  assert.equal(view.payload.queue.length, 0);
  assert.equal((await call(t.api, { url: '/api/agents/queue', body: { runId: 'a', text: 'x' }, headers: { origin: 'https://evil.example' } })).status, 403);
});

test('queue: a message to an idle agent is sent at once', async () => {
  const t = threadApi();
  t.setRuns(t.runs().map((r) => ({ ...r, status: 'done' })));
  const r = await call(t.api, { url: '/api/agents/queue', body: { runId: 'a', text: 'ship it' } });
  assert.equal(r.status, 202);
  assert.equal(r.payload.sent, true);
  assert.equal(t.sent[0].followUpOf, 'b', 'continues the newest run of the task');
});

test('queue: edit and remove; steer stops the agent and delivers that message now', async () => {
  const calls = [];
  const runControl = {
    stop: (id) => { calls.push(['stop', id]); return { ok: true }; },
    waitForEnd: async (id) => ({ id, status: 'stopped', agent: 'claude', branch: 'agent/x', repo: '/r/app' }),
  };
  const t = threadApi({ runControl });
  const { payload: { item, threadId } } = await call(t.api, { url: '/api/agents/queue', body: { runId: 'b', text: 'one' } });
  assert.equal((await call(t.api, { url: '/api/agents/queue/update', body: { threadId, itemId: item.id, text: 'one, edited' } })).status, 200);
  const s = await call(t.api, { url: '/api/agents/queue/steer', body: { threadId, itemId: item.id } });
  assert.equal(s.status, 202);
  assert.deepEqual(calls, [['stop', 'b']]);
  assert.match(t.sent[0].task, /New instruction: one, edited$/);
  const second = (await call(t.api, { url: '/api/agents/queue', body: { runId: 'b', text: 'two' } })).payload.item;
  assert.equal((await call(t.api, { url: '/api/agents/queue/update', body: { threadId, itemId: second.id, remove: true } })).status, 200);
  assert.equal((await call(t.api, { method: 'GET', url: '/api/agents/thread?id=a' })).payload.queue.length, 0);
});

test('run now records the signed-in person from the server, not from the body', async () => {
  const ctxs = [];
  const { api } = workspaceApi({ dispatchRun: async (p, ctx) => { ctxs.push({ p, ctx }); return { status: 202, body: { ok: true, runId: 'r1', branch: p.branch } }; } });
  await call(api, { url: '/api/agents/run', body: { repo: 'app', agent: 'hermes', title: 'Explain', by: 'someone-else' } });
  assert.deepEqual(ctxs[0].ctx, { by: 'sriad' });
  assert.equal('by' in ctxs[0].p, false);
});

test('only an admin switches the teammate mode; everyone sees it; issues follow it', async () => {
  const admin = settingsApi(true);
  const r = await call(admin.api, { url: '/api/agents/settings', body: { teammateMode: 'readonly' } });
  assert.equal(r.status, 200);
  assert.equal(r.payload.teammateMode.mode, 'readonly');
  assert.equal(admin.teammateModeSetting.get(), 'readonly');
  assert.equal((await call(admin.api, { url: '/api/agents/settings', body: { teammateMode: 'everything' } })).status, 400);

  const user = settingsApi(false);
  assert.equal((await call(user.api, { url: '/api/agents/settings', body: { teammateMode: 'sandbox' } })).status, 403);
  assert.equal((await user.api.overview({ headers: {} })).teammateMode.mode, 'sandbox');

  // a teammate cannot route around the mode through a GitHub issue
  user.teammateModeSetting.set('readonly', 'owner');
  const issue = await call(user.api, { url: '/api/agents/task', body: { repo: REPOS[0], title: 'x' } });
  assert.equal(issue.status, 403);
  assert.match(issue.payload.error, /use Run now/);
});

test('GET /api/agents/mine lists only the caller\'s threads, with mode and admin flag', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-mine-'));
  const started = new Date(Date.now() - 60e3).toISOString();
  const runs = [
    { id: 'r-mine', agent: 'hermes', status: 'done', task: 'Explain auth', by: 'asha@example.com', started_at: started, finished_at: started, repo: '/x/app' },
    { id: 'r-other', agent: 'hermes', status: 'done', task: 'Other', by: 'ravi@example.com', started_at: started, finished_at: started },
  ];
  const teammateModeSetting = createTeammateModeSetting({ file: path.join(dir, 'tm.json'), envMode: 'readonly' });
  const api = createAgentsApi({
    runsFile: path.join(dir, 'r.jsonl'), stateFile: path.join(dir, 's.json'), readRuns: () => ({ runs }),
    capNow: () => ({ used: 1, cap: 20 }), repos: REPOS, github: null, teammateModeSetting,
    isAdmin: () => false, actorOf: () => 'asha@example.com',
  });
  const r = await call(api, { method: 'GET', url: '/api/agents/mine' });
  assert.equal(r.status, 200);
  assert.equal(r.payload.admin, false);
  assert.equal(r.payload.teammateMode, 'readonly');
  assert.deepEqual(r.payload.threads.map((t) => t.threadId), ['r-mine']);
  assert.equal(r.payload.threads[0].repo, 'app');
});

test('Ask page kinds: run passes the kind, bad kinds are refused, plans are approved once', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-kind-'));
  const runsFile = path.join(dir, 'runs.jsonl');
  const planLog = path.join(dir, 'p1.log');
  fs.writeFileSync(planLog, '');
  fs.writeFileSync(path.join(dir, 'p1.hermes.json'), JSON.stringify({ result: '1. Add a check\n2. Show a message' }));
  const runs = [
    { id: 'p1', agent: 'hermes', kind: 'plan', helper: 'claude', status: 'done', task: 'Signup accepts empty emails', log: planLog, started_at: '2026-11-23T10:00:00Z' },
    { id: 'a1', agent: 'hermes', kind: 'answer', status: 'done', task: 'What is this?', log: planLog, started_at: '2026-11-23T10:00:00Z' },
    { id: 'p2', agent: 'hermes', kind: 'plan', status: 'running', task: 'x', log: planLog, started_at: '2026-11-23T10:00:00Z' },
  ];
  const sent = [];
  const api = createAgentsApi({
    runsFile, stateFile: path.join(dir, 's.json'), readRuns: () => ({ runs }), capNow: () => ({}),
    repos: REPOS, github: null, isAdmin: () => false, actorOf: () => 'asha@example.com', now: () => 1_700_000_000_000,
    dispatchRun: async (p, ctx) => { sent.push({ p, ctx }); return { status: 202, body: { ok: true, runId: 'new' } }; },
    classifyKind: async () => ({ kind: 'document', source: 'model' }),
  });
  await call(api, { url: '/api/agents/run', body: { repo: 'app', agent: 'claude', title: 'Fix signup', kind: 'change' } });
  assert.equal(sent[0].p.kind, 'change');
  assert.equal((await call(api, { url: '/api/agents/run', body: { repo: 'app', title: 'x', kind: 'plan' } })).status, 400, 'plan is not a request kind');

  assert.equal((await call(api, { url: '/api/agents/plan/approve', body: { runId: 'a1' } })).status, 400);
  assert.equal((await call(api, { url: '/api/agents/plan/approve', body: { runId: 'p2' } })).status, 409);
  const ok = await call(api, { url: '/api/agents/plan/approve', body: { runId: 'p1' } });
  assert.equal(ok.status, 202);
  const last = sent.at(-1);
  assert.equal(last.p.followUpOf, 'p1');
  assert.equal(last.p.approvePlan, true);
  assert.match(last.p.task, /Original request: Signup accepts empty emails/);
  assert.match(last.p.task, /Approved plan:\n1\. Add a check/);
  assert.deepEqual(last.ctx, { by: 'asha@example.com' });

  runs.push({ id: 'p1b', parent: 'p1', agent: 'hermes', kind: 'plan', status: 'done', task: 'y', started_at: '2026-11-23T11:00:00Z' });
  assert.equal((await call(api, { url: '/api/agents/plan/approve', body: { runId: 'p1' } })).status, 409, 'an older plan cannot be approved');

  const g = await call(api, { method: 'GET', url: '/api/agents/request-kind?q=write%20a%20report' });
  assert.deepEqual(g.payload, { ok: true, kind: 'document', source: 'model' });
});
