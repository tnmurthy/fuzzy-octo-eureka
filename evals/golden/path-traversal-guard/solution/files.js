'use strict';
const path = require('path');

function fail(code, msg) {
  return Object.assign(new Error(msg), { code });
}

function resolveSafe(root, userPath) {
  if (typeof userPath !== 'string' || userPath.includes('\0')) throw fail('EBADPATH', 'bad path');
  const base = path.resolve(root);
  const full = path.resolve(base, userPath);
  if (full !== base && !full.startsWith(base + path.sep)) throw fail('EOUTSIDE', 'outside root');
  return full;
}

module.exports = { resolveSafe };
