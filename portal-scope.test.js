'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { runPortal, scopedReader, portalFile } = require('./portal-scope');

const RUNS = [
  { id: 'a', portal: 'drisyon' },
  { id: 'b', portal: 'team' },
  { id: 'c' },
  { id: 'd', portal: 'drisyon' },
  { id: 'e', portal: '' },
];
const raw = (file, limit) => ({ ok: true, file, runs: RUNS.slice(0, limit) });

test('a run without a portal is older than #49 and belongs to the team portal', () => {
  assert.equal(runPortal({ portal: 'drisyon' }), 'drisyon');
  assert.equal(runPortal({}), 'team');
  assert.equal(runPortal({ portal: '' }), 'team');
  assert.equal(runPortal(null), 'team');
});

test('each portal reads only its own runs, limit applied after filtering', () => {
  const team = scopedReader(raw, 'team');
  const dris = scopedReader(raw, 'drisyon');
  assert.deepEqual(team('f', 50).runs.map((r) => r.id), ['b', 'c', 'e']);
  assert.deepEqual(dris('f', 50).runs.map((r) => r.id), ['a', 'd']);
  assert.deepEqual(dris('f', 1).runs.map((r) => r.id), ['a']);
  assert.deepEqual(scopedReader(raw, 'drisyon')('f', 1).runs.length, 1);
  assert.equal(team('f').ok, true, 'keeps the reader\'s other fields');
  assert.equal(team('f').file, 'f');
});

test('state files: the team portal keeps its names, others get a suffix', () => {
  assert.equal(portalFile('/x/logs/dispatch-settings.json', 'team'), '/x/logs/dispatch-settings.json');
  assert.equal(portalFile('/x/logs/dispatch-settings.json', 'drisyon'), '/x/logs/dispatch-settings.drisyon.json');
  assert.equal(portalFile('/x/logs/repos.json', undefined), '/x/logs/repos.json');
});
