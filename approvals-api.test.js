// node --test approvals-api.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { createApprovals } = require('./approvals');
const { createApprovalsApi } = require('./approvals-api');

function setup({ local = true, admin = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approvals-api-'));
  const store = createApprovals({ file: path.join(dir, 'a.json') });
  const token = store.registerRun({ runId: 'run-1', repo: 'app', level: 'auto' });
  const api = createApprovalsApi({ store, isLocal: () => local, isAdmin: () => admin, actorOf: () => 'sriad' });
  return { store, token, api };
}

function call(api, { method = 'GET', url, body, headers = {} }) {
  const req = Readable.from(body ? [JSON.stringify(body)] : []);
  Object.assign(req, { method, url, headers: { host: 'x', 'content-type': 'application/json', ...headers } });
  return new Promise((resolve) => {
    const res = {};
    const sendJson = (_r, status, payload) => resolve({ status, payload });
    const readJsonBody = (r) => new Promise((ok, bad) => {
      let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => { try { ok(JSON.parse(b || '{}')); } catch (e) { bad(e); } });
    });
    const handled = api.handle(req, res, { sendJson, readJsonBody });
    if (!handled) resolve({ status: 'unhandled' });
  });
}

test('ignores paths that are not approvals', async () => {
  const { api } = setup();
  assert.equal((await call(api, { url: '/api/agents/overview' })).status, 'unhandled');
});

test('the helper\'s endpoints answer local requests only', async () => {
  const { api, token } = setup({ local: false });
  const r = await call(api, { method: 'POST', url: '/api/agents/approvals/request', body: { runId: 'run-1', token, tool: 'Bash', input: { command: 'ls' } } });
  assert.equal(r.status, 403);
});

test('a run files a request and reads it back with its token', async () => {
  const { api, token } = setup();
  const r = await call(api, { method: 'POST', url: '/api/agents/approvals/request', body: { runId: 'run-1', token, tool: 'Bash', input: { command: 'ls' } } });
  assert.equal(r.status, 200);
  const s = await call(api, { url: `/api/agents/approvals/status?id=${r.payload.request.id}&runId=run-1`, headers: { 'x-run-token': token } });
  assert.equal(s.payload.request.status, 'pending');
  const bad = await call(api, { url: `/api/agents/approvals/status?id=${r.payload.request.id}&runId=run-1`, headers: { 'x-run-token': 'no' } });
  assert.equal(bad.status, 403);
});

test('only admins see and answer approvals', async () => {
  const { api } = setup({ admin: false });
  assert.equal((await call(api, { url: '/api/agents/approvals' })).status, 403);
  assert.equal((await call(api, { method: 'POST', url: '/api/agents/approvals/decide', body: { id: 'x', decision: 'allow' } })).status, 403);
});

test('a decision must be same-site JSON', async () => {
  const { api, store, token } = setup();
  const req = store.request({ runId: 'run-1', token, tool: 'Bash', input: { command: 'make' } }).request;
  const cross = await call(api, { method: 'POST', url: '/api/agents/approvals/decide', body: { id: req.id, decision: 'allow' }, headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(cross.status, 403);
  const ok = await call(api, { method: 'POST', url: '/api/agents/approvals/decide', body: { id: req.id, decision: 'allow', remember: true } });
  assert.equal(ok.payload.request.decidedBy, 'sriad');
  const list = await call(api, { url: '/api/agents/approvals' });
  assert.deepEqual(list.payload.alwaysAllow, { app: ['Bash:make'] });
});
