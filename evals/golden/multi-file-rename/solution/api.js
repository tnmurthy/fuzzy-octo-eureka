'use strict';
const { getUser } = require('./users');

function handle(id) {
  const u = getUser(id);
  return u ? { status: 200, body: u } : { status: 404, body: null };
}

module.exports = { handle };
