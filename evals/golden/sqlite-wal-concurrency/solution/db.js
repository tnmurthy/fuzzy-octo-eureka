'use strict';
const { DatabaseSync } = require('node:sqlite');

function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  return db;
}

function isBusy(err) {
  if (!err) return false;
  if (err.code === 'SQLITE_BUSY') return true;
  return err.code === 'ERR_SQLITE_ERROR' && /database is locked/i.test(String(err.message));
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(fn, { retries = 5, baseMs = 20, sleep = defaultSleep } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isBusy(err) || attempt >= retries) throw err;
      await sleep(baseMs * 2 ** attempt);
    }
  }
}

module.exports = { openDb, withRetry };
