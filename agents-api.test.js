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
  assert.deepEqual(v, { ok: true, value: { repo: 'me/app', title: 'Fix it', body: '', agent: 'claude' } });
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
