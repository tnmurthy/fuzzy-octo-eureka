// node --test team-store/ai-ledger.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { recordAiCall, readCalls, ollamaUsage } = require('./ai-ledger');
const { toCallRow, syncCalls } = require('./ai-sync');

const TEAM = '10000000-0000-0000-0000-00000000000a';
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ai-')), 'logs', 'ai-calls.jsonl');

// --- ledger ------------------------------------------------------------------

test('records one line per call with a unique id', () => {
  const file = tmpFile();
  recordAiCall(file, { provider: 'ollama', model: 'gemma3:4b', purpose: 'persona', ok: true, ms: 1200 });
  recordAiCall(file, { provider: 'typesafe', model: 'jev-latest', purpose: 'route', ok: false });
  const calls = readCalls(file);
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0].id, calls[1].id);
  assert.equal(calls[0].provider, 'ollama');
  assert.match(calls[0].at, /^\d{4}-\d{2}-\d{2}T/);
});

test('a ledger write failure never breaks the caller', () => {
  const logs = [];
  // A directory where the file should be: appendFileSync throws.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-'));
  assert.doesNotThrow(() => recordAiCall(dir, { provider: 'ollama', model: 'm', purpose: 'p' }, (m) => logs.push(m)));
  assert.match(logs[0], /ai ledger write failed/);
});

test('reads past a torn line', () => {
  const file = tmpFile();
  recordAiCall(file, { provider: 'ollama', model: 'm', purpose: 'p' });
  fs.appendFileSync(file, '{"torn":');
  assert.equal(readCalls(file).length, 1);
});

test('ollamaUsage pulls token counts and duration from an Ollama reply', () => {
  assert.deepEqual(ollamaUsage({ prompt_eval_count: 120, eval_count: 80, total_duration: 2.5e9 }), { input_tokens: 120, output_tokens: 80, ms: 2500 });
  assert.deepEqual(ollamaUsage({}), { input_tokens: 0, output_tokens: 0, ms: null });
});

// --- sync ----------------------------------------------------------------------

const call = (over = {}) => ({ id: 'c1', at: '2026-11-05T10:00:00.000Z', provider: 'ollama', model: 'gemma3:4b', purpose: 'persona', ok: true, input_tokens: 10, output_tokens: 5, ms: 900, ...over });

test('maps a ledger line to a row keyed by client_id; owner left to the database', () => {
  const row = toCallRow(call(), TEAM);
  assert.equal(row.client_id, 'c1');
  assert.equal(row.team_id, TEAM);
  assert.equal(row.created_at, '2026-11-05T10:00:00.000Z');
  assert.equal('owner' in row, false);
  assert.equal('id' in row, false);
  assert.equal(toCallRow(call({ input_tokens: undefined }), TEAM).input_tokens, 0);
});

test('syncCalls sends only lines after the saved position', async () => {
  const sent = [];
  const rest = { insertIgnoringDuplicates: async (table, rows, key) => { sent.push({ table, rows, key }); } };
  const calls = [call({ id: 'a' }), call({ id: 'b' }), call({ id: 'c' })];
  const state = await syncCalls({ calls, state: { sent: 1 }, rest, teamId: TEAM });
  assert.equal(sent[0].table, 'arunachala_ai_calls');
  assert.equal(sent[0].key, 'client_id');
  assert.deepEqual(sent[0].rows.map((r) => r.client_id), ['b', 'c']);
  assert.equal(state.sent, 3);
});

test('syncCalls sends nothing when up to date', async () => {
  let n = 0;
  const rest = { insertIgnoringDuplicates: async () => { n += 1; } };
  const state = { sent: 2 };
  assert.equal(await syncCalls({ calls: [call({ id: 'a' }), call({ id: 'b' })], state, rest, teamId: TEAM }), state);
  assert.equal(n, 0);
});

test('syncCalls keeps the position when offline', async () => {
  const rest = { insertIgnoringDuplicates: async () => { throw new Error('fetch failed'); } };
  await assert.rejects(syncCalls({ calls: [call()], state: { sent: 0 }, rest, teamId: TEAM }), /fetch failed/);
});

test('a cap refusal falls back to row by row and skips only the refused rows', async () => {
  const logs = [];
  const rest = {
    insertIgnoringDuplicates: async (table, rows) => {
      if (rows.length > 1) throw new Error('Supabase arunachala_ai_calls 400: ai_cap_member: daily limit of 200 calls reached');
      if (rows[0].client_id === 'b') throw new Error('Supabase arunachala_ai_calls 400: ai_cap_member: daily limit of 200 calls reached');
    },
  };
  const state = await syncCalls({ calls: [call({ id: 'a' }), call({ id: 'b' })], state: { sent: 0 }, rest, teamId: TEAM, log: (m) => logs.push(m) });
  assert.equal(state.sent, 2);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /b.*ai_cap_member/);
});

test('sends at most one batch per sync', async () => {
  const sent = [];
  const rest = { insertIgnoringDuplicates: async (t, rows) => { sent.push(rows.length); } };
  const calls = Array.from({ length: 1200 }, (_, i) => call({ id: `c${i}` }));
  const state = await syncCalls({ calls, state: { sent: 0 }, rest, teamId: TEAM });
  assert.deepEqual(sent, [500]);
  assert.equal(state.sent, 500);
});
