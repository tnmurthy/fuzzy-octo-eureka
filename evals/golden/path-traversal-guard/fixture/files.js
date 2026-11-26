'use strict';
const path = require('path');

function resolveSafe(root, userPath) {
  return path.join(root, userPath);
}

module.exports = { resolveSafe };
