// node --test buzz-bridge/router-fallback.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFallbackRouterClient } = require('./router-fallback');

function okClient(answers) {
  return { systemOne: async () => ({ answers }) };
}
function failClient(message) {
  return { systemOne: async () => { throw new Error(message); } };
}

test('returns the first stage that succeeds, with no fallback marker', async () => {
  const c = createFallbackRouterClient([{ label: 'primary', client: okClient({ a: 1 }) }]);
  const res = await c.systemOne({});
  assert.deepEqual(res.answers, { a: 1 });
  assert.equal(res.fallbackFrom, undefined);
});

test('falls through a failed primary to the next stage, and records which failed', async () => {
  const c = createFallbackRouterClient([
    { label: 'gemma3:4b', client: failClient('timeout') },
    { label: 'qwen2.5-coder:3b', client: okClient({ a: 2 }) },
  ]);
  const res = await c.systemOne({});
  assert.deepEqual(res.answers, { a: 2 });
  assert.deepEqual(res.fallbackFrom, ['gemma3:4b']);
});

test('throws a combined error only once every stage has failed', async () => {
  const c = createFallbackRouterClient([
    { label: 'gemma3:4b', client: failClient('timeout') },
    { label: 'qwen2.5-coder:3b', client: failClient('ECONNREFUSED') },
  ]);
  await assert.rejects(c.systemOne({}), /gemma3:4b: timeout.*qwen2\.5-coder:3b: ECONNREFUSED/s);
});

test('rejects being built with no stages', () => {
  assert.throws(() => createFallbackRouterClient([]), /at least one stage/);
});
