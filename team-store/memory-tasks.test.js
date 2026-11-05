// node --test team-store/memory-tasks.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { toMemoryRow, fromMemoryRow, syncMemory } = require('./memory-sync');
const { toColumns, validateNewTask, validateStatus } = require('./tasks');
const { parseTasksMd } = require('../tasks-md');

const TEAM = '10000000-0000-0000-0000-00000000000a';

// --- memory ------------------------------------------------------------------

const mem = (id, createdAt, over = {}) => ({
  id, tenantId: 'tenant:drisyon_core', projectId: 'global', category: 'context', title: 'T', content: 'C',
  tags: ['a'], metadata: { k: 1 }, vector: { a: 1 }, createdAt, ...over,
});

test('maps a memory entry to a row keyed by client_id, without the local vector', () => {
  const row = toMemoryRow(mem('mem_1', '2026-11-05T10:00:00.000Z'), TEAM);
  assert.equal(row.client_id, 'mem_1');
  assert.equal(row.team_id, TEAM);
  assert.equal(row.tenant_id, 'tenant:drisyon_core');
  assert.equal(row.created_at, '2026-11-05T10:00:00.000Z');
  assert.equal('vector' in row, false);
  assert.equal('owner' in row, false);
});

test('a team row reads back in the engine\'s entry shape', () => {
  const back = fromMemoryRow({ client_id: 'mem_1', id: 'uuid', tenant_id: 't', project_id: 'p', category: 'c', title: 'T', content: 'C', tags: ['x'], metadata: {}, created_at: 'd' });
  assert.deepEqual(back, { id: 'mem_1', tenantId: 't', projectId: 'p', category: 'c', title: 'T', content: 'C', tags: ['x'], metadata: {}, createdAt: 'd' });
});

test('syncMemory sends entries newer than the last sent, oldest first', async () => {
  const sent = [];
  const rest = { insertIgnoringDuplicates: async (t, rows, key) => sent.push({ t, ids: rows.map((r) => r.client_id), key }) };
  // the engine keeps newest first
  const entries = [mem('m3', '2026-11-05T03:00:00Z'), mem('m2', '2026-11-05T02:00:00Z'), mem('m1', '2026-11-05T01:00:00Z')];
  const state = await syncMemory({ entries, state: { since: '2026-11-05T01:00:00Z' }, rest, teamId: TEAM });
  assert.deepEqual(sent, [{ t: 'arunachala_memory', ids: ['m2', 'm3'], key: 'client_id' }]);
  assert.equal(state.since, '2026-11-05T03:00:00Z');
});

test('syncMemory does nothing when up to date and keeps state when offline', async () => {
  let n = 0;
  const entries = [mem('m1', '2026-11-05T01:00:00Z')];
  const st = { since: '2026-11-05T01:00:00Z' };
  assert.equal(await syncMemory({ entries, state: st, rest: { insertIgnoringDuplicates: async () => { n += 1; } }, teamId: TEAM }), st);
  assert.equal(n, 0);
  await assert.rejects(syncMemory({ entries, state: {}, rest: { insertIgnoringDuplicates: async () => { throw new Error('fetch failed'); } }, teamId: TEAM }), /fetch failed/);
});

test('syncMemory skips entries without an id or date', async () => {
  const sent = [];
  const rest = { insertIgnoringDuplicates: async (t, rows) => sent.push(...rows) };
  await syncMemory({ entries: [mem(undefined, 'x'), mem('m1', undefined), mem('m2', '2026-11-05T01:00:00Z')], state: {}, rest, teamId: TEAM });
  assert.deepEqual(sent.map((r) => r.client_id), ['m2']);
});

// --- tasks -------------------------------------------------------------------

test('team task rows become the board columns the UI already reads', () => {
  const rows = [
    { id: 'u1', title: 'Wire CI', project: 'infra', status: 'in_progress', link: null },
    { id: 'u2', title: 'Write guide', project: null, status: 'backlog', link: 'https://x/1' },
    { id: 'u3', title: 'Ship', project: 'web', status: 'done', link: null },
  ];
  const cols = toColumns(rows, { u1: 'Ravi' });
  assert.deepEqual(cols.in_progress, [{ id: 'u1', task: 'Wire CI', project: 'infra', owner: 'Ravi' }]);
  assert.deepEqual(cols.backlog, [{ id: 'u2', task: 'Write guide', project: 'General', issue: 'https://x/1' }]);
  assert.equal(cols.done[0].task, 'Ship');
});

test('a new task needs a title; status and project are checked', () => {
  assert.deepEqual(validateNewTask({ title: '  Do it  ', project: 'web' }), { ok: true, task: { title: 'Do it', project: 'web', status: 'backlog', link: null } });
  assert.equal(validateNewTask({ title: '' }).ok, false);
  assert.equal(validateNewTask({ title: 'x'.repeat(301) }).ok, false);
  assert.equal(validateNewTask({ title: 'x', status: 'nope' }).ok, false);
  assert.equal(validateNewTask({ title: 'x', link: 'javascript:alert(1)' }).ok, false);
  assert.equal(validateNewTask(null).ok, false);
});

test('a status change accepts only the three columns', () => {
  assert.equal(validateStatus('done'), true);
  assert.equal(validateStatus('archived'), false);
});

// --- TASKS.md parser (moved out of server.js unchanged) -----------------------

test('parses TASKS.md sections into columns', () => {
  const md = [
    '# Tasks', '', '## In Progress', '| # | Task | Project | Owner |', '| --- | --- | --- | --- |',
    '| 1 | Rebuild image | docker-base | CI |', '', '## Backlog', '| # | Task | Project | GitHub Issue |',
    '| --- | --- | --- | --- |', '| 2 | Push secret | docker-base | #1 |', '## Done', '| # | Task |', '| 3 | Old thing |',
  ].join('\n');
  const cols = parseTasksMd(md);
  assert.deepEqual(cols.in_progress, [{ id: '1', task: 'Rebuild image', project: 'docker-base', owner: 'CI' }]);
  assert.deepEqual(cols.backlog, [{ id: '2', task: 'Push secret', project: 'docker-base', issue: '#1' }]);
  assert.equal(cols.done.length, 1);
});
