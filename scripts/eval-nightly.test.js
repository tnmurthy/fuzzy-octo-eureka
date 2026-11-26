'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { inWindow, regressions, pruneKept, latestReport } = require('./eval-nightly');

test('inWindow: plain and wrapping windows, bad spec is never', () => {
  assert.equal(inWindow('1-5', 2), true);
  assert.equal(inWindow('1-5', 5), false);
  assert.equal(inWindow('1-5', 14), false);
  assert.equal(inWindow('22-4', 23), true);
  assert.equal(inWindow('22-4', 3), true);
  assert.equal(inWindow('22-4', 12), false);
  assert.equal(inWindow('nonsense', 2), false);
});

test('regressions: passed before, failing now', () => {
  const prev = { results: [{ challengeId: 'a', passed: true }, { challengeId: 'b', passed: false }, { challengeId: 'c', passed: true }] };
  const cur = { results: [{ challengeId: 'a', passed: false }, { challengeId: 'b', passed: false }, { challengeId: 'c', passed: true }, { challengeId: 'd', passed: false }] };
  assert.deepEqual(regressions(prev, cur), ['a']);
  assert.deepEqual(regressions(null, cur), []);
});

test('pruneKept removes only old folders; latestReport skips today', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightly-'));
  fs.mkdirSync(path.join(dir, 'old'));
  fs.mkdirSync(path.join(dir, 'new'));
  const past = new Date(Date.now() - 5 * 86400000);
  fs.utimesSync(path.join(dir, 'old'), past, past);
  assert.equal(pruneKept(dir, 3), 1);
  assert.deepEqual(fs.readdirSync(dir), ['new']);
  assert.equal(pruneKept(path.join(dir, 'missing'), 3), 0);

  fs.writeFileSync(path.join(dir, '2026-11-25.json'), '{"passed":3}');
  fs.writeFileSync(path.join(dir, '2026-11-26.json'), '{"passed":4}');
  assert.deepEqual(latestReport(dir, path.join(dir, '2026-11-26.json')), { passed: 3 });
  assert.equal(latestReport(path.join(dir, 'none'), ''), null);
});

test('outside the window it exits at once', () => {
  const { spawnSync } = require('child_process');
  const r = spawnSync(process.execPath, [path.join(__dirname, 'eval-nightly.js')], { encoding: 'utf8', env: { ...process.env, EVAL_NIGHTLY_WINDOW: 'never' } });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /outside the never h window/);
});
