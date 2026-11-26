'use strict';

function parseCsvLine(line) {
  return line.split(',');
}

module.exports = { parseCsvLine };
