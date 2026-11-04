const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPendingStore } = require('./pending-store');

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pending-')), 'pending.json');
const event = { id: 'e1', pubkey: 'p1', tags: [['h', 'chan']], content: 'do it' };

test('take returns a stored event once, then nothing', () => {
  const store = createPendingStore({ file: tmpFile() });
  store.set('run-1', event);
  assert.deepStrictEqual(store.take('run-1'), event);
  assert.strictEqual(store.take('run-1'), undefined);
});

test('a pending dispatch survives a restart', () => {
  const file = tmpFile();
  createPendingStore({ file }).set('run-1', event);
  assert.deepStrictEqual(createPendingStore({ file }).take('run-1'), event);
});

test('take removes the entry from disk too', () => {
  const file = tmpFile();
  const store = createPendingStore({ file });
  store.set('run-1', event);
  store.take('run-1');
  assert.strictEqual(createPendingStore({ file }).take('run-1'), undefined);
});

test('entries older than the ttl are dropped on load', () => {
  const file = tmpFile();
  let clock = 1000;
  createPendingStore({ file, ttlMs: 500, now: () => clock }).set('old', event);
  clock = 2000;
  assert.strictEqual(createPendingStore({ file, ttlMs: 500, now: () => clock }).take('old'), undefined);
});

test('a missing or corrupt file starts empty instead of throwing', () => {
  const file = tmpFile();
  assert.strictEqual(createPendingStore({ file }).take('x'), undefined);
  fs.writeFileSync(file, '{not json');
  const store = createPendingStore({ file });
  assert.strictEqual(store.take('x'), undefined);
  store.set('run-2', event);
  assert.deepStrictEqual(createPendingStore({ file }).take('run-2'), event);
});

test('ignores a missing run id or event', () => {
  const store = createPendingStore({ file: tmpFile() });
  store.set('', event);
  store.set('run-3', null);
  assert.strictEqual(store.take(''), undefined);
  assert.strictEqual(store.take('run-3'), undefined);
  assert.strictEqual(store.take(undefined), undefined);
});
