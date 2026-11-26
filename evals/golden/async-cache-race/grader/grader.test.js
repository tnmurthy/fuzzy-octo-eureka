'use strict';
// Hidden grader: copied in after the agent finishes.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createConfig } = require('./config');

test('concurrent calls share one load; later calls are cached', async () => {
  let calls = 0;
  const c = createConfig(async () => { calls++; await new Promise((r) => setTimeout(r, 20)); return { v: 1 }; });
  const [a, b, d] = await Promise.all([c.get(), c.get(), c.get()]);
  assert.equal(calls, 1);
  assert.deepEqual([a, b, d], [{ v: 1 }, { v: 1 }, { v: 1 }]);
  assert.deepEqual(await c.get(), { v: 1 });
  assert.equal(calls, 1);
});
test('a failed load rejects every waiter and is retried next time', async () => {
  let calls = 0;
  const c = createConfig(async () => { calls++; await new Promise((r) => setTimeout(r, 10)); if (calls === 1) throw new Error('down'); return 'ok'; });
  const results = await Promise.allSettled([c.get(), c.get()]);
  assert.deepEqual(results.map((r) => r.status), ['rejected', 'rejected']);
  assert.equal(calls, 1);
  assert.equal(await c.get(), 'ok');
  assert.equal(calls, 2);
});
