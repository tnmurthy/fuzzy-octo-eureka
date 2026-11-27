'use strict';
// prompt-write-guard.js - who may write text that goes into every agent's
// prompt (blackboard facts, direction rules, precompact checkpoints).
// Such text steers runs started by everyone, admins' paid runs included, so
// writing it is admin-only, and only from a same-site JSON request (so another
// website cannot post it through a local browser).

const { isSameSiteJson } = require('./agents-api');

/**
 * @param {{ admin: boolean, headers: object }} o
 * @returns {null | { status: number, error: string }} null = allowed
 */
function promptWriteRefusal({ admin, headers }) {
  const h = headers || {};
  if (!/^application\/json\b/i.test(String(h['content-type'] || ''))) {
    return { status: 415, error: 'send JSON (Content-Type: application/json)' };
  }
  if (!isSameSiteJson({ headers: h })) return { status: 403, error: 'cross-site request refused' };
  if (!admin) return { status: 403, error: 'admin only: this text goes into every agent prompt' };
  return null;
}

module.exports = { promptWriteRefusal };
