'use strict';
const { DatabaseSync } = require('node:sqlite');

function openDb(file) {
  return new DatabaseSync(file);
}

// TODO: retry when the database is busy.
async function withRetry(fn) {
  return fn();
}

module.exports = { openDb, withRetry };
