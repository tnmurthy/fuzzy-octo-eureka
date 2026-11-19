// node --test orchestration/approval-mcp.test.js
// Runs the helper against a real approvals store behind a local HTTP server.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { createApprovals } = require('../approvals');
const { createApprovalsApi } = require('../approvals-api');

const HELPER = path.join(__dirname, 'approval-mcp.js');

async function harness({ timeoutMs = 60_000 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-mcp-'));
  const store = createApprovals({ file: path.join(dir, 'always.json'), timeoutMs });
  const api = createApprovalsApi({ store, isLocal: () => true, isAdmin: () => true });
  const sendJson = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const readJsonBody = (req) => new Promise((resolve, reject) => {
    let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (e) { reject(e); } });
  });
  const server = http.createServer((req, res) => { if (!api.handle(req, res, { sendJson, readJsonBody })) { res.writeHead(404); res.end(); } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const token = store.registerRun({ runId: 'run-1', repo: 'app', level: 'auto' });
  return { store, base, token, close: () => server.close() };
}

function helper(env) {
  const child = spawn(process.execPath, [HELPER], { env: { ...process.env, APPROVAL_POLL_MS: '20', ...env }, stdio: ['pipe', 'pipe', 'inherit'] });
  const waiting = new Map();
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      const w = waiting.get(msg.id); if (w) { waiting.delete(msg.id); w(msg); }
    }
  });
  let next = 1;
  const call = (method, params) => new Promise((resolve) => {
    const id = next++; waiting.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  return { call, stop: () => child.kill() };
}

const answer = (msg) => JSON.parse(msg.result.content[0].text);

test('lists one approve tool after initialize', async () => {
  const h = helper({});
  const init = await h.call('initialize', { protocolVersion: '2025-06-18' });
  assert.equal(init.result.serverInfo.name, 'arunachala-approvals');
  const list = await h.call('tools/list', {});
  assert.deepEqual(list.result.tools.map((t) => t.name), ['approve']);
  h.stop();
});

test('waits for a person, then allows with the input unchanged', async () => {
  const s = await harness();
  const h = helper({ APPROVAL_URL: s.base, APPROVAL_RUN_ID: 'run-1', APPROVAL_TOKEN: s.token });
  const pending = h.call('tools/call', { name: 'approve', arguments: { tool_name: 'Bash', input: { command: 'npm run build' } } });
  let req;
  for (let i = 0; i < 100 && !req; i++) { await new Promise((r) => setTimeout(r, 10)); req = s.store.pending()[0]; }
  assert.equal(req.summary, 'npm run build');
  s.store.decide({ id: req.id, decision: 'allow', actor: 'test' });
  assert.deepEqual(answer(await pending), { behavior: 'allow', updatedInput: { command: 'npm run build' } });
  h.stop(); s.close();
});

test('a person says no: deny with the reason', async () => {
  const s = await harness();
  const h = helper({ APPROVAL_URL: s.base, APPROVAL_RUN_ID: 'run-1', APPROVAL_TOKEN: s.token });
  const pending = h.call('tools/call', { name: 'approve', arguments: { tool_name: 'Bash', input: { command: 'rm -rf build' } } });
  let req;
  for (let i = 0; i < 100 && !req; i++) { await new Promise((r) => setTimeout(r, 10)); req = s.store.pending()[0]; }
  s.store.decide({ id: req.id, decision: 'deny' });
  const a = answer(await pending);
  assert.equal(a.behavior, 'deny');
  h.stop(); s.close();
});

test('fails closed: wrong token, or no dashboard at all', async () => {
  const s = await harness();
  const bad = helper({ APPROVAL_URL: s.base, APPROVAL_RUN_ID: 'run-1', APPROVAL_TOKEN: 'nope' });
  assert.equal(answer(await bad.call('tools/call', { name: 'approve', arguments: { tool_name: 'Bash', input: {} } })).behavior, 'deny');
  bad.stop(); s.close();
  const none = helper({ APPROVAL_URL: 'http://127.0.0.1:9', APPROVAL_RUN_ID: 'run-1', APPROVAL_TOKEN: 'x' });
  assert.equal(answer(await none.call('tools/call', { name: 'approve', arguments: { tool_name: 'Bash', input: {} } })).behavior, 'deny');
  none.stop();
});

test('nobody answers: deny at the deadline', async () => {
  const s = await harness({ timeoutMs: 50 });
  const h = helper({ APPROVAL_URL: s.base, APPROVAL_RUN_ID: 'run-1', APPROVAL_TOKEN: s.token, APPROVAL_TIMEOUT_MS: '50' });
  const a = answer(await h.call('tools/call', { name: 'approve', arguments: { tool_name: 'Bash', input: { command: 'deploy' } } }));
  assert.equal(a.behavior, 'deny');
  assert.match(a.message, /nobody answered|said no/);
  h.stop(); s.close();
});
