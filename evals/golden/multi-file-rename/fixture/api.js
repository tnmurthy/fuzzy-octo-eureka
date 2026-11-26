'use strict';
const { getUsr } = require('./users');

function handle(id) {
  const u = getUsr(id);
  return u ? { status: 200, body: u } : { status: 404, body: null };
}

module.exports = { handle };
