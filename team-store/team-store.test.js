// node --test team-store/team-store.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSession } = require('./supabase-session');
const { createRest } = require('./supabase-rest');
const { toRow, pendingRows, syncRuns } = require('./run-sync');

const URL = 'https://proj.supabase.co';
const KEY = 'sb_publishable_test';
const TEAM = '10000000-0000-0000-0000-00000000000a';

// A fetch stub that records calls and answers from a queue of responses.
function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined });
    const r = responses.shift();
    if (!r) throw new Error('unexpected fetch ' + url);
    if (r.throw) throw r.throw;
    return { ok: r.status < 300, status: r.status, json: async () => r.json, text: async () => JSON.stringify(r.json ?? '') };
  };
  fn.calls = calls;
  return fn;
}

const tokenReply = (token, expiresIn = 3600) => ({
  status: 200,
  json: { access_token: token, refresh_token: 'r-' + token, expires_in: expiresIn, user: { id: 'user-1' } },
});

// --- session -----------------------------------------------------------------

test('signs in with the password grant once and reuses the token', async () => {
  const fetch = fakeFetch([tokenReply('t1')]);
  const s = createSession({ url: URL, key: KEY, email: 'a@x.in', password: 'pw', fetch, now: () => 0 });
  assert.equal((await s.getToken()).token, 't1');
  assert.equal((await s.getToken()).token, 't1');
  assert.equal(fetch.calls.length, 1);
  assert.match(fetch.calls[0].url, /\/auth\/v1\/token\?grant_type=password$/);
  assert.equal(fetch.calls[0].init.headers.apikey, KEY);
  assert.deepEqual(fetch.calls[0].body, { email: 'a@x.in', password: 'pw' });
});

test('refreshes with the refresh token shortly before expiry', async () => {
  let clock = 0;
  const fetch = fakeFetch([tokenReply('t1', 100), tokenReply('t2')]);
  const s = createSession({ url: URL, key: KEY, email: 'a@x.in', password: 'pw', fetch, now: () => clock });
  await s.getToken();
  clock = 50 * 1000; // 50 s left, inside the 60 s margin
  assert.equal((await s.getToken()).token, 't2');
  assert.match(fetch.calls[1].url, /grant_type=refresh_token$/);
  assert.deepEqual(fetch.calls[1].body, { refresh_token: 'r-t1' });
});

test('falls back to a fresh sign-in when the refresh is refused', async () => {
  let clock = 0;
  const fetch = fakeFetch([tokenReply('t1', 100), { status: 400, json: { error: 'invalid_grant' } }, tokenReply('t3')]);
  const s = createSession({ url: URL, key: KEY, email: 'a@x.in', password: 'pw', fetch, now: () => clock });
  await s.getToken();
  clock = 50 * 1000;
  assert.equal((await s.getToken()).token, 't3');
  assert.match(fetch.calls[2].url, /grant_type=password$/);
});

test('a refused sign-in throws without echoing the password', async () => {
  const fetch = fakeFetch([{ status: 400, json: { error_description: 'Invalid login credentials' } }]);
  const s = createSession({ url: URL, key: KEY, email: 'a@x.in', password: 'secret-pw', fetch, now: () => 0 });
  await assert.rejects(s.getToken(), (err) => {
    assert.match(err.message, /sign-in failed \(400\)/);
    assert.doesNotMatch(err.message, /secret-pw/);
    return true;
  });
});

// --- rest --------------------------------------------------------------------

const session = { getToken: async () => ({ token: 'tok', userId: 'user-1' }) };

test('upsert posts rows with merge-duplicates and the user token', async () => {
  const fetch = fakeFetch([{ status: 201, json: null }]);
  const rest = createRest({ url: URL, key: KEY, session, fetch });
  await rest.upsert('arunachala_agent_runs', [{ id: 'r1' }], 'id');
  const c = fetch.calls[0];
  assert.equal(c.url, `${URL}/rest/v1/arunachala_agent_runs?on_conflict=id`);
  assert.equal(c.init.method, 'POST');
  assert.equal(c.init.headers.Authorization, 'Bearer tok');
  assert.equal(c.init.headers.apikey, KEY);
  assert.match(c.init.headers.Prefer, /resolution=merge-duplicates/);
  assert.deepEqual(c.body, [{ id: 'r1' }]);
});

test('select builds a query string and returns rows', async () => {
  const fetch = fakeFetch([{ status: 200, json: [{ id: 'r1' }] }]);
  const rest = createRest({ url: URL, key: KEY, session, fetch });
  const rows = await rest.select('arunachala_agent_runs', { team_id: `eq.${TEAM}`, order: 'started_at.desc', limit: '50' });
  assert.deepEqual(rows, [{ id: 'r1' }]);
  assert.equal(fetch.calls[0].url, `${URL}/rest/v1/arunachala_agent_runs?team_id=eq.${TEAM}&order=started_at.desc&limit=50`);
});

test('a failed request throws with the status, not the token', async () => {
  const fetch = fakeFetch([{ status: 403, json: { message: 'new row violates row-level security' } }]);
  const rest = createRest({ url: URL, key: KEY, session, fetch });
  await assert.rejects(rest.upsert('arunachala_agent_runs', [{ id: 'r1' }], 'id'), (err) => {
    assert.match(err.message, /agent_runs 403/);
    assert.doesNotMatch(err.message, /tok/);
    return true;
  });
});

// --- run sync ----------------------------------------------------------------

const run = (over = {}) => ({
  id: '20261104-noop-abc', agent: 'noop', repo: 'C:/tt-ai-stack/01_projects/active/arunachala-dashboard',
  branch: 'buzz/1', task: 'hello', status: 'done', exit_code: 0, duration_s: 1, commits_ahead: 0,
  head: '03a734d', started_at: '2026-11-04T19:24:58+05:30', finished_at: '2026-11-04T19:24:59+05:30',
  worktree: 'C:/x', log: 'C:/y.log', ...over,
});

test('maps a folded run to a row: repo name only, no local paths', () => {
  const row = toRow(run(), TEAM);
  assert.equal(row.repo, 'arunachala-dashboard');
  assert.equal(row.team_id, TEAM);
  assert.equal(row.status, 'done');
  assert.equal('worktree' in row, false);
  assert.equal('log' in row, false);
  assert.equal('owner' in row, false); // the database stamps auth.uid()
});

test('maps dispatcher statuses onto the table\'s allowed values', () => {
  assert.equal(toRow(run({ status: 'timed_out' }), TEAM).status, 'timeout');
  assert.equal(toRow(run({ status: 'stale' }), TEAM).status, 'running');
  assert.equal(toRow(run({ status: 'failed' }), TEAM).status, 'failed');
});

test('skips runs whose agent the table does not know', () => {
  assert.equal(toRow(run({ agent: 'mystery' }), TEAM), null);
});

test('only rows that changed since the last sync are pending', () => {
  const runs = [run({ id: 'a' }), run({ id: 'b', status: 'running', finished_at: undefined })];
  const first = pendingRows(runs, {}, TEAM);
  assert.deepEqual(first.rows.map((r) => r.id), ['a', 'b']);
  assert.deepEqual(pendingRows(runs, first.next, TEAM).rows, []);
  const later = [run({ id: 'a' }), run({ id: 'b', status: 'done' })];
  assert.deepEqual(pendingRows(later, first.next, TEAM).rows.map((r) => r.id), ['b']);
});

test('syncRuns uploads pending rows and returns the new state', async () => {
  const sent = [];
  const rest = { upsert: async (table, rows, key) => { sent.push({ table, rows, key }); } };
  const state = await syncRuns({ runs: [run({ id: 'a' })], state: {}, rest, teamId: TEAM });
  assert.equal(sent[0].table, 'arunachala_agent_runs');
  assert.equal(sent[0].key, 'id');
  assert.ok(state.a);
});

test('syncRuns keeps the old state when offline, so the rows go next time', async () => {
  const rest = { upsert: async () => { throw new Error('fetch failed'); } };
  const before = {};
  await assert.rejects(syncRuns({ runs: [run({ id: 'a' })], state: before, rest, teamId: TEAM }), /fetch failed/);
  assert.deepEqual(before, {});
});

test('syncRuns makes no request when nothing changed', async () => {
  let calls = 0;
  const rest = { upsert: async () => { calls += 1; } };
  const state = await syncRuns({ runs: [run({ id: 'a' })], state: {}, rest, teamId: TEAM });
  await syncRuns({ runs: [run({ id: 'a' })], state, rest, teamId: TEAM });
  assert.equal(calls, 1);
});

// --- wiring ------------------------------------------------------------------

const { createTeamStore, REQUIRED } = require('./index');
const fsx = require('fs');
const osx = require('os');
const pathx = require('path');

const fullEnv = {
  SUPABASE_URL: URL + '/', SUPABASE_PUBLISHABLE_KEY: KEY, SUPABASE_EMAIL: 'a@x.in', SUPABASE_PASSWORD: 'pw', TEAM_ID: TEAM,
};
const tmpState = () => pathx.join(fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'ts-')), 'state.json');

test('stays off with no Supabase settings (solo install)', () => {
  const logs = [];
  assert.equal(createTeamStore({}, { readRuns: () => ({ runs: [] }), runsFile: 'x', stateFile: tmpState(), log: (m) => logs.push(m) }), null);
  assert.deepEqual(logs, []);
});

test('stays off and names what is missing when half set up', () => {
  const logs = [];
  const env = { ...fullEnv, SUPABASE_PASSWORD: '' };
  assert.equal(createTeamStore(env, { readRuns: () => ({ runs: [] }), runsFile: 'x', stateFile: tmpState(), log: (m) => logs.push(m) }), null);
  assert.match(logs[0], /missing SUPABASE_PASSWORD/);
  assert.equal(REQUIRED.length, 5);
});

test('syncOnce signs in, uploads, and saves state so a restart does not resend', async () => {
  const stateFile = tmpState();
  const fetch = fakeFetch([tokenReply('t1'), { status: 201, json: null }]);
  const deps = { readRuns: () => ({ runs: [run({ id: 'a' })] }), runsFile: 'x', stateFile, log: () => {}, fetch };
  await createTeamStore(fullEnv, deps).syncOnce();
  assert.equal(fetch.calls[1].url, `${URL}/rest/v1/arunachala_agent_runs?on_conflict=id`);
  assert.ok(JSON.parse(fsx.readFileSync(stateFile, 'utf8')).a);
  const again = fakeFetch([]); // a fresh process with the saved state sends nothing
  await createTeamStore(fullEnv, { ...deps, fetch: again }).syncOnce();
  assert.equal(again.calls.length, 0);
});

test('syncOnce logs an outage once, not every interval', async () => {
  const logs = [];
  const down = { throw: new Error('fetch failed') };
  const fetch = fakeFetch([down, down]);
  const store = createTeamStore(fullEnv, { readRuns: () => ({ runs: [run({ id: 'a' })] }), runsFile: 'x', stateFile: tmpState(), log: (m) => logs.push(m), fetch });
  await store.syncOnce();
  await store.syncOnce();
  assert.equal(logs.length, 1);
  assert.match(logs[0], /run sync failed: fetch failed/);
});

test('insertIgnoringDuplicates posts with ignore-duplicates on the given key', async () => {
  const fetch = fakeFetch([{ status: 201, json: null }]);
  const rest = createRest({ url: URL, key: KEY, session, fetch });
  await rest.insertIgnoringDuplicates('arunachala_ai_calls', [{ client_id: 'c1' }], 'client_id');
  const c = fetch.calls[0];
  assert.equal(c.url, `${URL}/rest/v1/arunachala_ai_calls?on_conflict=client_id`);
  assert.match(c.init.headers.Prefer, /resolution=ignore-duplicates/);
});
