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

test('validateTask accepts a good task and defaults the agent to claude', () => {
  const v = validateTask({ repo: 'me/app', title: '  Fix it  ' }, REPOS);
  assert.deepEqual(v, { ok: true, value: { repo: 'me/app', title: 'Fix it', body: '', agent: 'claude', specialist: null } });
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
  const api = createAgentsApi({
    runsFile: path.join(dir, 'runs.jsonl'), stateFile: path.join(dir, 'st.json'),
    readRuns: () => ({ runs: [] }), capNow: () => ({ used: 0, cap: settings.cap() }),
    repos: REPOS, github: null, settings, isAdmin: () => admin, actorOf: () => 'sriad',
  });
  return { api, settings };
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
  assert.deepEqual(sent.labels, ['agent:ready', 'agent:claude', 'specialist:engineering-code-reviewer']);
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
  assert.deepEqual(sent[0], { agent: 'claude', repo: 'app', task: 'Add tests\n\nfor utils', specialist: 'testing-api-tester', branch: `agent/run-${(1_700_000_000_000).toString(36)}` });
  assert.equal((await call(api, { url: '/api/agents/run', body: { repo: 'app', title: '' } })).status, 400);
  assert.equal((await call(api, { url: '/api/agents/run', body: { repo: 'app', title: 'x', agent: 'rm' } })).status, 400);
  assert.equal((await call(api, { url: '/api/agents/run', body: { repo: 'app', title: 'x' }, headers: { 'content-type': 'text/plain' } })).status, 403);
});
