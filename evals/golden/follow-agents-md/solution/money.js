'use strict';

function assertPaise(n) {
  if (!Number.isInteger(n) || n < 0) throw new TypeError('amount must be non-negative integer paise');
}

function formatINR(paise) {
  assertPaise(paise);
  return '₹' + (paise / 100).toFixed(2);
}

function addGst(amount, ratePercent) {
  assertPaise(amount);
  if (typeof ratePercent !== 'number' || !Number.isFinite(ratePercent) || ratePercent < 0) {
    throw new TypeError('rate must be a finite number >= 0');
  }
  return amount + Math.round((amount * ratePercent) / 100);
}

module.exports = { assertPaise, formatINR, addGst };
