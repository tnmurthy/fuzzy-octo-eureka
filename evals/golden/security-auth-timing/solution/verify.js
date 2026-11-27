'use strict';
const crypto = require('crypto');

// True when signature is the hex HMAC-SHA256 of payload under secret.
// Constant-time compare; any malformed signature is simply false.
function verifySignature(payload, signature, secret) {
  if (typeof signature !== 'string' || !/^[0-9a-f]*$/i.test(signature)) return false;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest();
  const given = Buffer.from(signature, 'hex');
  if (given.length !== expected.length) return false;
  return crypto.timingSafeEqual(given, expected);
}

module.exports = { verifySignature };
