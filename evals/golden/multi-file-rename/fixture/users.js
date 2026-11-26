'use strict';

const USERS = { 1: { id: 1, name: 'Asha' }, 2: { id: 2, name: 'Ravi' } };

function getUsr(id) {
  return USERS[id] || null;
}

module.exports = { getUsr };
