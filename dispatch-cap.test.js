// node --test dispatch-cap.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { checkDispatchCap, parseCap, DEFAULT_CAP } = require('./dispatch-cap');

const NOW = new Date(2026, 10, 17, 15, 0, 0).getTime();
const today = (h) => new Date(2026, 10, 17, h, 0, 0).toISOString();
const yesterday = new Date(2026, 10, 16, 23, 0, 0).toISOString();

test('local agents are never capped', () => {
  for (const agent of ['hermes', 'noop']) {
    const r = checkDispatchCap({ agent, runs: [], cap: 0, now: NOW });
    assert.equal(r.ok, true);
    assert.equal(r.paid, false);
  }
});

test('paid runs since local midnight count; yesterday and local runs do not', () => {
  const runs = [
    { id: 'a', agent: 'claude', started_at: today(9) },
    { id: 'b', agent: 'auto', started_at: today(10) },
    { id: 'c', agent: 'hermes', started_at: today(11) },
    { id: 'd', agent: 'claude', started_at: yesterday },
  ];
  const r = checkDispatchCap({ agent: 'claude', runs, cap: 3, now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.used, 2);
});

test('at the cap, a paid dispatch is refused with a reason that names the setting', () => {
  const runs = [{ id: 'a', agent: 'claude', started_at: today(9) }, { id: 'b', agent: 'codex', started_at: today(9) }];
  const r = checkDispatchCap({ agent: 'claude', runs, cap: 2, now: NOW });
  assert.equal(r.ok, false);
  assert.match(r.error, /Daily cap reached: 2 of 2 paid agent runs today \(DISPATCH_DAILY_PAID_RUNS\)/);
});

test('runs started here but not yet in the log count, once', () => {
  const runs = [{ id: 'a', agent: 'claude', started_at: today(9) }];
  const pending = [{ id: 'a', agent: 'claude', at: NOW - 1000 }, { id: 'b', agent: 'claude', at: NOW - 500 }];
  const r = checkDispatchCap({ agent: 'claude', runs, pending, cap: 2, now: NOW });
  assert.equal(r.used, 2);
  assert.equal(r.ok, false);
});

test('a cap of 0 turns paid runs off', () => {
  const r = checkDispatchCap({ agent: 'auto', runs: [], cap: 0, now: NOW });
  assert.equal(r.ok, false);
  assert.match(r.error, /Paid agent runs are off/);
});

test('the cap setting falls back to the default when missing or invalid', () => {
  assert.equal(parseCap(undefined), DEFAULT_CAP);
  assert.equal(parseCap(''), DEFAULT_CAP);
  assert.equal(parseCap('abc'), DEFAULT_CAP);
  assert.equal(parseCap('-1'), DEFAULT_CAP);
  assert.equal(parseCap('0'), 0);
  assert.equal(parseCap('35'), 35);
});
