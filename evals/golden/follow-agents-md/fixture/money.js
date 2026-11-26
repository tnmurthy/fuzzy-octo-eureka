'use strict';

function assertPaise(n) {
  if (!Number.isInteger(n) || n < 0) throw new TypeError('amount must be non-negative integer paise');
}

function formatINR(paise) {
  assertPaise(paise);
  return '₹' + (paise / 100).toFixed(2);
}

module.exports = { assertPaise, formatINR };
