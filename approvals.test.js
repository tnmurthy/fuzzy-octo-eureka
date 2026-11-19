// node --test approvals.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApprovals, actionKey, MAX_ALWAYS_ALLOW } = require('./approvals');

function setup({ timeoutMs = 1000 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approvals-'));
  const file = path.join(dir, 'always-allow.json');
  let t = 1_000_000;
  const store = createApprovals({ file, now: () => t, timeoutMs });
  const token = store.registerRun({ runId: 'run-1', repo: 'app', level: 'auto' });
  return { store, token, file, tick: (ms) => { t += ms; } };
}

const bash = (command) => ({ tool: 'Bash', input: { command } });

test('the key is the exact action, never a prefix', () => {
  assert.equal(actionKey('Bash', { command: ' npm test ' }), 'Bash:npm test');
  assert.equal(actionKey('Edit', { file_path: '/r/a.js' }), 'Edit:/r/a.js');
  assert.equal(actionKey('WebFetch', { url: 'https://x.dev/a' }), 'WebFetch:https://x.dev/a');
  assert.equal(actionKey('mcp__x__get', {}), 'mcp__x__get');
});

test('a request needs its run\'s token', () => {
  const { store } = setup();
  assert.equal(store.request({ runId: 'run-1', token: 'wrong', ...bash('ls') }).status, 403);
  assert.equal(store.request({ runId: 'run-9', token: 'x', ...bash('ls') }).status, 403);
});

test('a person allows once; the next identical request asks again', () => {
  const { store, token } = setup();
  const r = store.request({ runId: 'run-1', token, ...bash('npm run build') }).request;
  assert.equal(r.status, 'pending');
  assert.equal(store.decide({ id: r.id, decision: 'allow', actor: 'sriad' }).request.status, 'allowed');
  assert.equal(store.request({ runId: 'run-1', token, ...bash('npm run build') }).request.status, 'pending');
});

test('always allow remembers the exact command for the repo, persisted', () => {
  const { store, token, file } = setup();
  const r = store.request({ runId: 'run-1', token, ...bash('npm run build') }).request;
  store.decide({ id: r.id, decision: 'allow', remember: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { app: ['Bash:npm run build'] });
  assert.equal(store.request({ runId: 'run-1', token, ...bash('npm run build') }).request.status, 'allowed');
  assert.equal(store.request({ runId: 'run-1', token, ...bash('npm run build; rm -rf ~') }).request.status, 'pending');
});

test('a removed grant stops applying at once', () => {
  const { store, token } = setup();
  const r = store.request({ runId: 'run-1', token, ...bash('make') }).request;
  store.decide({ id: r.id, decision: 'allow', remember: true });
  assert.equal(store.removeAlways({ repo: 'app', key: 'Bash:make' }).ok, true);
  assert.equal(store.request({ runId: 'run-1', token, ...bash('make') }).request.status, 'pending');
});

test('past the cap a grant is refused, not dropped: the card stays pending', () => {
  const { file } = setup();
  fs.writeFileSync(file, JSON.stringify({ app: Array.from({ length: MAX_ALWAYS_ALLOW }, (_, i) => `Bash:cmd${i}`) }));
  const fresh = createApprovals({ file, now: () => 1, timeoutMs: 1000 });
  const tok = fresh.registerRun({ runId: 'r', repo: 'app', level: 'auto' });
  const r = fresh.request({ runId: 'r', token: tok, ...bash('one-more') }).request;
  const out = fresh.decide({ id: r.id, decision: 'allow', remember: true });
  assert.equal(out.ok, false);
  assert.equal(out.status, 409);
  assert.equal(fresh.pending().length, 1);
});

test('nobody answers: denied at the deadline', () => {
  const { store, token, tick } = setup({ timeoutMs: 1000 });
  const r = store.request({ runId: 'run-1', token, ...bash('npm publish') }).request;
  tick(1001);
  const s = store.status({ id: r.id, runId: 'run-1', token }).request;
  assert.equal(s.status, 'denied');
  assert.equal(s.decidedBy, 'timeout');
  assert.equal(store.decide({ id: r.id, decision: 'allow' }).status, 409);
});

test('a run cannot read another run\'s request', () => {
  const { store, token } = setup();
  const other = store.registerRun({ runId: 'run-2', repo: 'app', level: 'auto' });
  const r = store.request({ runId: 'run-1', token, ...bash('ls') }).request;
  assert.equal(store.status({ id: r.id, runId: 'run-2', token: other }).status, 404);
});
