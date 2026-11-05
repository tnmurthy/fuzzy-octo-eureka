// node --test digest.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDigest, isDigestDue } = require('./digest');

const costs = {
  days: 7,
  source: 'team',
  summary: {
    totals: { calls: 120, paidCalls: 20, localCalls: 100, inputTokens: 900000, outputTokens: 40000, costUsd: 6.4321 },
    byPurpose: [{ purpose: 'dispatch', calls: 18, tokens: 800000, costUsd: 6.2 }, { purpose: 'persona', calls: 60, tokens: 50000, costUsd: 0 }],
  },
  auto: { autoRuns: 10, stayedLocal: 4, escalated: 6, localShare: 0.4 },
  advice: ['Dispatches average $0.34 each - name the files in the task.'],
};
const runs = [
  { agent: 'claude', status: 'done' }, { agent: 'claude', status: 'failed' },
  { agent: 'auto', status: 'done' }, { agent: 'noop', status: 'done' },
];

test('the digest covers runs, local-first, spend and advice in plain words', () => {
  const text = buildDigest({ costs, runs });
  assert.match(text, /Weekly AI digest - whole team, last 7 days/);
  assert.match(text, /4 agent runs: 3 done, 1 failed/);
  assert.match(text, /claude 2, auto 1, noop 1/);
  assert.match(text, /Local-first: 4 of 10 auto runs stayed local \(40%\)/);
  assert.match(text, /20 paid calls, 100 local \(free\); \$6\.43 spent/);
  assert.match(text, /Top cost: dispatch \$6\.20/);
  assert.match(text, /- Dispatches average/);
});

test('an empty week still reads sensibly', () => {
  const quiet = { ...costs, summary: { totals: { calls: 0, paidCalls: 0, localCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }, byPurpose: [] }, auto: { autoRuns: 0, stayedLocal: 0, escalated: 0, localShare: null }, advice: ['No action needed.'] };
  const text = buildDigest({ costs: quiet, runs: [] });
  assert.match(text, /No agent runs/);
  assert.match(text, /no auto runs/);
  assert.doesNotMatch(text, /Top cost/);
});

// Monday 09:00 IST = Monday 03:30 UTC.
const at = (iso) => Date.parse(iso);

test('due on Monday from 09:00 IST, once per week', () => {
  assert.equal(isDigestDue(at('2026-11-09T03:29:00Z'), null), false); // Mon 08:59 IST
  assert.equal(isDigestDue(at('2026-11-09T03:30:00Z'), null), true); // Mon 09:00 IST
  assert.equal(isDigestDue(at('2026-11-09T10:00:00Z'), '2026-11-09T03:31:00Z'), false); // already posted
  assert.equal(isDigestDue(at('2026-11-10T04:00:00Z'), '2026-11-02T03:31:00Z'), true); // missed Monday: Tuesday catches up
  assert.equal(isDigestDue(at('2026-11-08T12:00:00Z'), '2026-11-02T03:31:00Z'), false); // Sunday, last week's done
});

test('a custom weekday and hour', () => {
  // Friday 17:00 IST = 11:30 UTC
  assert.equal(isDigestDue(at('2026-11-13T11:30:00Z'), '2026-11-06T11:31:00Z', { weekday: 5, hour: 17 }), true);
  assert.equal(isDigestDue(at('2026-11-13T11:29:00Z'), '2026-11-06T11:31:00Z', { weekday: 5, hour: 17 }), false);
});
