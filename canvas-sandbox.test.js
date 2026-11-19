const test = require('node:test');
const assert = require('node:assert');
const { parseSandboxPath, rewriteSandboxUrls, createSandboxPortCheck } = require('./canvas-sandbox');

test('parseSandboxPath', () => {
  assert.deepStrictEqual(parseSandboxPath('/sandbox/41234/sockets/events/a?k=1'), { port: 41234, path: '/sockets/events/a?k=1' });
  assert.deepStrictEqual(parseSandboxPath('/sandbox/41234'), { port: 41234, path: '/' });
  assert.strictEqual(parseSandboxPath('/sandbox/99999/x'), null);
  assert.strictEqual(parseSandboxPath('/sandbox/abc/x'), null);
  assert.strictEqual(parseSandboxPath('/api/x'), null);
});

test('rewriteSandboxUrls covers http, ws and 127.0.0.1, leaves other hosts alone', () => {
  const out = rewriteSandboxUrls('a http://localhost:5000/x b ws://127.0.0.1:6000 c https://example.com:7000', 'h.test');
  assert.strictEqual(out, 'a https://h.test/sandbox/5000/x b https://h.test/sandbox/6000 c https://example.com:7000');
});

test('port check caches, refreshes unknown ports, and fails closed on Docker errors', async () => {
  let calls = 0;
  let t = 0;
  const check = createSandboxPortCheck(async () => { calls++; return new Set([5000]); }, () => t);
  assert.strictEqual(await check(5000), true);
  assert.strictEqual(await check(5000), true);
  assert.strictEqual(calls, 1);
  assert.strictEqual(await check(8787), false);
  assert.strictEqual(calls, 2);
  const failing = createSandboxPortCheck(async () => { throw new Error('no docker'); });
  assert.strictEqual(await failing(5000), false);
});
