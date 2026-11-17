// node --test context-view.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildContextView, buildMembers, combineMemory } = require('./context-view');

const ME = 'u-me';
const MATE = 'u-mate';
const members = [
  { user_id: MATE, display_name: 'Priya', role: 'member', created_at: '2026-11-06T00:00:00Z' },
  { user_id: ME, display_name: 'Sriad', role: 'owner', created_at: '2026-11-05T00:00:00Z' },
];
const local = [
  { id: 'L1', title: 'Synced note', content: 'a', projectId: 'app', category: 'decision', createdAt: '2026-11-10T00:00:00Z' },
  { id: 'L2', title: 'Local only', content: 'b', createdAt: '2026-11-12T00:00:00Z' },
  { id: 'L3', content: '' }, // empty: skipped
];
const team = [
  { id: 'r1', client_id: 'L1', owner: ME, title: 'Synced note', content: 'a', project_id: 'app', created_at: '2026-11-10T00:00:00Z' },
  { id: 'r2', client_id: 'P1', owner: MATE, title: 'Teammate note', content: 'c', project_id: 'web', created_at: '2026-11-11T00:00:00Z' },
  { id: 'r3', client_id: 'M2', owner: ME, title: 'From my laptop', content: 'd', created_at: '2026-11-09T00:00:00Z' },
  { id: 'r4', client_id: null, owner: 'u-gone', title: 'Old', content: 'e', created_at: '2026-11-01T00:00:00Z' },
];

test('combineMemory merges a local entry with its synced row and labels every source', () => {
  const out = combineMemory({ local, team, members, me: ME });
  const by = Object.fromEntries(out.map((e) => [e.id, e]));
  assert.equal(out.length, 5, 'L1 counted once; empty L3 skipped');
  assert.deepEqual([by.L1.mine, by.L1.local, by.L1.shared], [true, true, true]);
  assert.deepEqual([by.L2.mine, by.L2.local, by.L2.shared], [true, true, false]);
  assert.deepEqual([by.P1.mine, by.P1.local, by.P1.shared, by.P1.author], [false, false, true, 'Priya']);
  assert.deepEqual([by.M2.mine, by.M2.local, by.M2.author], [true, false, 'Sriad']);
  assert.equal(by.r4.author, 'Former member');
  assert.deepEqual(out.map((e) => e.id), ['L2', 'P1', 'L1', 'M2', 'r4'], 'newest first');
});

test('combineMemory clips long content', () => {
  const [e] = combineMemory({ local: [{ id: 'x', content: 'y'.repeat(5000), createdAt: '2026-11-01' }] });
  assert.equal(e.content.length, 1500);
});

test('buildMembers counts each person\'s activity and lists you first', () => {
  const rows = buildMembers({
    members,
    memories: team,
    runs: [{ owner: ME, started_at: '2026-11-17T10:00:00Z' }, { owner: ME, started_at: '2026-11-16T10:00:00Z' }, { owner: MATE, started_at: '2026-11-15T00:00:00Z' }],
    calls: [{ owner: ME, input_tokens: 100, output_tokens: 20 }, { owner: MATE, input_tokens: 5, output_tokens: 5 }],
    me: ME,
  });
  assert.deepEqual(rows.map((r) => r.name), ['Sriad', 'Priya']);
  assert.deepEqual(rows[0], { name: 'Sriad', role: 'owner', you: true, joined: '2026-11-05T00:00:00Z', memories: 2, runs: 2, lastRun: '2026-11-17T10:00:00Z', aiCalls7d: 1, tokens7d: 120 });
  assert.equal(rows[1].memories, 1);
});

test('buildContextView works with the team store off, on, or failing', () => {
  const off = buildContextView({ local });
  assert.equal(off.teamStore, 'off');
  assert.equal(off.totals.combined, 2);
  assert.match(off.note, /only this machine/);

  const on = buildContextView({ local, team: { me: ME, teamName: 'Talia', members, memories: team, runs: [], calls: [] } });
  assert.equal(on.teamStore, 'on');
  assert.equal(on.teamName, 'Talia');
  assert.deepEqual(on.totals, { members: 2, mine: 3, localOnly: 1, shared: 4, fromTeammates: 2, combined: 5 });

  const failed = buildContextView({ local, error: 'Supabase sign-in failed (400)' });
  assert.equal(failed.teamStore, 'error');
  assert.match(failed.note, /sign-in failed/);
});
