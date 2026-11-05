// node --test team-store/costs.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { summarizeCalls, autoStats, advice, fromTeamRow } = require('./costs');

const NOW = Date.parse('2026-11-05T12:00:00Z');
const call = (over = {}) => ({ at: '2026-11-05T10:00:00Z', provider: 'ollama', model: 'gemma3:4b', purpose: 'persona', ok: true, input_tokens: 100, output_tokens: 50, ...over });

test('totals split paid from local calls and add up tokens and cost', () => {
  const s = summarizeCalls([
    call(),
    call({ provider: 'anthropic', model: 'claude-sonnet', purpose: 'dispatch', input_tokens: 40000, output_tokens: 2000, cost_usd: 0.31234 }),
    call({ provider: 'anthropic', model: 'claude-sonnet', purpose: 'dispatch', input_tokens: 39000, output_tokens: 1000, cost_usd: 0.2 }),
  ], { now: NOW, days: 7 });
  assert.equal(s.totals.calls, 3);
  assert.equal(s.totals.paidCalls, 2);
  assert.equal(s.totals.localCalls, 1);
  assert.equal(s.totals.inputTokens, 79100);
  assert.equal(s.totals.outputTokens, 3050);
  assert.equal(s.totals.costUsd, 0.5123);
});

test('only calls inside the window count', () => {
  const s = summarizeCalls([call(), call({ at: '2026-10-20T10:00:00Z' })], { now: NOW, days: 7 });
  assert.equal(s.totals.calls, 1);
  assert.equal(s.from, '2026-10-29T12:00:00.000Z');
});

test('groups are sorted by cost, then tokens', () => {
  const s = summarizeCalls([
    call({ purpose: 'embed', input_tokens: 10, output_tokens: 0 }),
    call({ purpose: 'persona', input_tokens: 500 }),
    call({ provider: 'anthropic', purpose: 'dispatch', cost_usd: 0.1 }),
  ], { now: NOW, days: 7 });
  assert.deepEqual(s.byPurpose.map((g) => g.purpose), ['dispatch', 'persona', 'embed']);
  assert.deepEqual(s.byProvider.map((g) => g.provider), ['anthropic', 'ollama']);
  assert.equal(s.byModel[0].calls, 3); // all three share one model name
});

test('calls are bucketed by UTC day', () => {
  const s = summarizeCalls([call(), call({ at: '2026-11-04T23:00:00Z', provider: 'anthropic', cost_usd: 0.5 })], { now: NOW, days: 7 });
  assert.deepEqual(s.byDay, [{ day: '2026-11-04', calls: 1, costUsd: 0.5 }, { day: '2026-11-05', calls: 1, costUsd: 0 }]);
});

test('team rows read like ledger lines', () => {
  assert.deepEqual(fromTeamRow({ created_at: 'x', provider: 'p', model: 'm', purpose: 'u', ok: true, input_tokens: 1, output_tokens: 2, cost_usd: '0.5', owner: 'o' }),
    { at: 'x', provider: 'p', model: 'm', purpose: 'u', ok: true, input_tokens: 1, output_tokens: 2, cost_usd: 0.5, owner: 'o' });
});

test('autoStats counts how often local was enough', () => {
  assert.deepEqual(autoStats([{ agent: 'auto', escalated: false }, { agent: 'auto', escalated: true }, { agent: 'auto', escalated: false }, { agent: 'claude' }]),
    { autoRuns: 3, stayedLocal: 2, escalated: 1, localShare: 0.67 });
  assert.equal(autoStats([{ agent: 'claude' }]).localShare, null);
});

const base = (over = {}) => ({
  summary: summarizeCalls([call()], { now: NOW, days: 7 }),
  auto: { autoRuns: 0, stayedLocal: 0, escalated: 0, localShare: null },
  limits: null, paidCallsToday: 0, localFirstEnabled: true, ...over,
});

test('advice a: many paid calls and local-first off', () => {
  const summary = summarizeCalls([call(), call({ provider: 'anthropic', purpose: 'dispatch', cost_usd: 0.1 })], { now: NOW, days: 7 });
  assert.match(advice(base({ summary, localFirstEnabled: false })).join(' '), /DISPATCH_LOCAL_FIRST=true/);
  assert.doesNotMatch(advice(base({ summary, localFirstEnabled: true })).join(' '), /DISPATCH_LOCAL_FIRST/);
});

test('advice b: local rarely passes the tests', () => {
  assert.match(advice(base({ auto: { autoRuns: 6, stayedLocal: 1, escalated: 5, localShare: 0.17 } })).join(' '), /\.arunachala-test/);
});

test('advice c: the daily cap is close', () => {
  const out = advice(base({ limits: { member_daily_calls: 200, team_daily_calls: 1000 }, paidCallsToday: 170 })).join(' ');
  assert.match(out, /170 of 200/);
});

test('advice d: expensive dispatches', () => {
  const summary = summarizeCalls([call({ provider: 'anthropic', purpose: 'dispatch', cost_usd: 0.9 })], { now: NOW, days: 7 });
  assert.match(advice(base({ summary })).join(' '), /name the files/i);
});

test('advice e: nothing to do', () => {
  assert.deepEqual(advice(base()), ['No action needed.']);
});
