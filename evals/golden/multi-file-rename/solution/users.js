'use strict';

const USERS = { 1: { id: 1, name: 'Asha' }, 2: { id: 2, name: 'Ravi' } };

function getUser(id) {
  return USERS[id] || null;
}

/** @deprecated use getUser */
const getUsr = getUser;

module.exports = { getUser, getUsr };
