// node --test runs-reader.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { foldRuns, readRuns, STALE_AFTER_MS } = require('./runs-reader');

const start = (id, at, extra = {}) =>
  JSON.stringify({ id, agent: 'codex', status: 'running', started_at: at, ...extra });

test('merges a run\'s start and end lines into one row', () => {
  const text = [
    start('r1', '2026-10-01T10:00:00+05:30'),
    JSON.stringify({ id: 'r1', status: 'done', exit_code: 0 }),
  ].join('\n');

  assert.deepEqual(foldRuns(text), [
    { id: 'r1', agent: 'codex', status: 'done', started_at: '2026-10-01T10:00:00+05:30', exit_code: 0 },
  ]);
});

test('lists newest first', () => {
  const text = [start('old', '2026-10-01T09:00:00Z'), start('new', '2026-10-01T11:00:00Z')].join('\n');
  const now = Date.parse('2026-10-01T11:01:00Z');

  assert.deepEqual(foldRuns(text, now).map((r) => r.id), ['new', 'old']);
});

test('skips a torn line instead of losing every other run', () => {
  const text = [start('ok', '2026-10-01T10:00:00Z'), '{"id":"torn","sta', ''].join('\n');

  assert.deepEqual(foldRuns(text, Date.parse('2026-10-01T10:01:00Z')).map((r) => r.id), ['ok']);
});

test('marks a run that never finished as stale, not running', () => {
  const at = '2026-10-01T00:00:00Z';
  const later = Date.parse(at) + STALE_AFTER_MS + 1000;

  assert.equal(foldRuns(start('lost', at), later)[0].status, 'stale');
  assert.equal(foldRuns(start('live', at), Date.parse(at) + 1000)[0].status, 'running');
});

test('reports no log as no runs, not an error', () => {
  const missing = path.join(os.tmpdir(), `no-such-runs-${process.pid}.jsonl`);

  assert.deepEqual(readRuns(missing), { ok: true, runs: [], note: 'No runs recorded yet.' });
});

test('caps how many runs it returns', () => {
  const file = path.join(os.tmpdir(), `runs-${process.pid}.jsonl`);
  const lines = Array.from({ length: 5 }, (_, i) => start(`r${i}`, `2026-10-01T10:0${i}:00Z`));
  fs.writeFileSync(file, lines.join('\n'));
  try {
    assert.equal(readRuns(file, 3).runs.length, 3);
  } finally {
    fs.unlinkSync(file);
  }
});
