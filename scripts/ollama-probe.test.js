'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runProbe } = require('./ollama-probe');

const now = () => new Date('2026-11-27T10:00:00Z');
const lastLine = (f) => JSON.parse(fs.readFileSync(f, 'utf8').trim().split('\n').pop());

test('ok: exit 0, one JSON line logged', async () => {
  const logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'probe-')), 'logs', 'p.jsonl');
  const said = [];
  const code = await runProbe({ probe: async () => ({ ok: true, ms: 42 }), model: 'm1', logFile, now, log: (s) => said.push(s) });
  assert.equal(code, 0);
  assert.deepEqual(lastLine(logFile), { at: '2026-11-27T10:00:00.000Z', ok: true, ms: 42, model: 'm1', error: null });
  assert.deepEqual(said, ['ollama ok in 42 ms']);
});

test('stuck: exit 1, error logged', async () => {
  const logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'probe-')), 'p.jsonl');
  const said = [];
  const code = await runProbe({ probe: async () => ({ ok: false, ms: 30000, error: 'stuck' }), model: 'm1', logFile, now, log: (s) => said.push(s) });
  assert.equal(code, 1);
  assert.equal(lastLine(logFile).error, 'stuck');
  assert.deepEqual(said, ['ollama STUCK: stuck']);
});
