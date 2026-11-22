// node --test agent-queue.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createAgentQueue, rootOf, threadRuns } = require('./agent-queue');

const RUNS = [
  { id: 'a', status: 'done', started_at: '2026-11-22T10:00:00Z' },
  { id: 'b', status: 'done', parent: 'a', started_at: '2026-11-22T10:05:00Z' },
  { id: 'c', status: 'running', parent: 'b', started_at: '2026-11-22T10:10:00Z' },
  { id: 'x', status: 'done', started_at: '2026-11-22T09:00:00Z' },
];

function make({ runs = RUNS, continueRun, t = 1_000_000 } = {}) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aq-')), 'q.json');
  let clock = t;
  const sent = [];
  const q = createAgentQueue({
    file,
    loadRuns: () => runs,
    continueRun: continueRun || (async (run, text) => { sent.push([run.id, text]); return { ok: true, runId: `r${sent.length}` }; }),
    now: () => clock,
  });
  return { q, file, sent, setRuns: (r) => { runs = r; }, advance: (ms) => { clock += ms; } };
}

test('threads follow parent links to the first run', () => {
  assert.equal(rootOf(RUNS, 'c'), 'a');
  assert.equal(rootOf(RUNS, 'x'), 'x');
  assert.equal(rootOf(RUNS, 'nope'), null);
  assert.deepEqual(threadRuns(RUNS, 'a').map((r) => r.id), ['a', 'b', 'c']);
  const loop = [{ id: 'p', parent: 'q' }, { id: 'q', parent: 'p' }];
  assert.ok(['p', 'q'].includes(rootOf(loop, 'p')), 'a parent loop ends');
});

test('messages queue while the agent works and go out, in order, when it finishes', async () => {
  const m = make();
  assert.equal(m.q.add({ runId: 'c', text: 'also add tests' }).threadId, 'a');
  m.q.add({ runId: 'b', text: 'then update the README' });
  assert.deepEqual(await m.q.tick(), [], 'latest run still working');
  m.setRuns(RUNS.map((r) => (r.id === 'c' ? { ...r, status: 'done' } : r)));
  const d = await m.q.tick();
  assert.deepEqual(m.sent, [['c', 'also add tests']]);
  assert.equal(d[0].runId, 'r1');
  assert.deepEqual(await m.q.tick(), [], 'waits for the just-started run to show up');
  m.setRuns([...RUNS.map((r) => (r.id === 'c' ? { ...r, status: 'done' } : r)), { id: 'r1', parent: 'c', status: 'done', started_at: '2026-11-22T10:20:00Z' }]);
  await m.q.tick();
  assert.deepEqual(m.sent.map((s) => s[0]), ['c', 'r1'], 'the next message continues the newest run');
  assert.equal(m.q.view('a').items.length, 0);
});

test('an inflight run that never logs is given up after a while', async () => {
  const done = RUNS.map((r) => ({ ...r, status: 'done' }));
  const m = make({ runs: done });
  m.q.add({ runId: 'a', text: 'one' });
  m.q.add({ runId: 'a', text: 'two' });
  await m.q.tick();
  await m.q.tick();
  assert.equal(m.sent.length, 1);
  m.advance(3 * 60 * 1000);
  await m.q.tick();
  assert.equal(m.sent.length, 2);
});

test('a failed delivery keeps the message, shows the error and pauses (no paid retry loop)', async () => {
  let calls = 0;
  const m = make({ runs: RUNS.map((r) => ({ ...r, status: 'done' })), continueRun: async () => { calls += 1; return { ok: false, error: 'daily paid run limit reached' }; } });
  const { item } = m.q.add({ runId: 'a', text: 'go on' });
  await m.q.tick();
  await m.q.tick();
  assert.equal(calls, 1);
  assert.equal(m.q.view('a').items[0].error, 'daily paid run limit reached');
  m.q.update({ threadId: 'a', itemId: item.id, text: 'go on, please' });
  assert.equal(m.q.view('a').items[0].error, null, 'editing retries');
  await m.q.tick();
  assert.equal(calls, 2);
});

test('edit, reorder, remove and take; validation; state survives a restart', () => {
  const m = make();
  const one = m.q.add({ runId: 'c', text: 'one' }).item;
  const two = m.q.add({ runId: 'c', text: 'two' }).item;
  m.q.update({ threadId: 'a', itemId: two.id, move: 'up' });
  assert.deepEqual(m.q.view('c').items.map((i) => i.text), ['two', 'one']);
  m.q.update({ threadId: 'a', itemId: one.id, text: 'uno' });
  assert.equal(m.q.take({ threadId: 'a', itemId: two.id }).text, 'two');
  const again = createAgentQueue({ file: m.file, loadRuns: () => RUNS, continueRun: async () => ({ ok: true }) });
  assert.deepEqual(again.view('a').items.map((i) => i.text), ['uno']);
  assert.equal(m.q.update({ threadId: 'a', itemId: one.id, remove: true }).ok, true);
  assert.equal(m.q.add({ runId: 'c', text: '   ' }).status, 400);
  assert.equal(m.q.add({ runId: 'zzz', text: 'hi' }).status, 404);
  assert.equal(m.q.update({ threadId: 'a', itemId: 'nope', text: 'x' }).status, 404);
});
