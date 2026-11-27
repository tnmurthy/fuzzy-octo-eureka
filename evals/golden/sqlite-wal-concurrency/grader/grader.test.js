'use strict';
// Hidden grader: copied in after the agent finishes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDb, withRetry } = require('./db');

const busy = () => Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR' });

test('openDb turns on WAL', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wal-'));
  const db = openDb(path.join(dir, 't.db'));
  const row = db.prepare('PRAGMA journal_mode').get();
  assert.equal(String(Object.values(row)[0]).toLowerCase(), 'wal');
  db.close();
});

test('retries busy errors with exponential backoff, then succeeds', async () => {
  const waits = [];
  let calls = 0;
  const out = await withRetry(
    () => {
      calls++;
      if (calls < 4) throw calls === 2 ? Object.assign(new Error('busy'), { code: 'SQLITE_BUSY' }) : busy();
      return 'ok';
    },
    { retries: 5, baseMs: 10, sleep: async (ms) => waits.push(ms) }
  );
  assert.equal(out, 'ok');
  assert.equal(calls, 4);
  assert.deepEqual(waits, [10, 20, 40]);
});

test('gives up after the retries and rethrows the busy error', async () => {
  const waits = [];
  let calls = 0;
  await assert.rejects(
    withRetry(() => { calls++; throw busy(); }, { retries: 2, baseMs: 5, sleep: async (ms) => waits.push(ms) }),
    /database is locked/
  );
  assert.equal(calls, 3);
  assert.deepEqual(waits, [5, 10]);
});

test('other errors are rethrown at once, without waiting', async () => {
  const waits = [];
  let calls = 0;
  await assert.rejects(
    withRetry(() => { calls++; throw new TypeError('boom'); }, { sleep: async (ms) => waits.push(ms) }),
    TypeError
  );
  assert.equal(calls, 1);
  assert.deepEqual(waits, []);
});

test('works with async functions', async () => {
  assert.equal(await withRetry(async () => 7, { sleep: async () => {} }), 7);
});
