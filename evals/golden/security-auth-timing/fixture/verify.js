'use strict';
const crypto = require('crypto');

// True when signature is the hex HMAC-SHA256 of payload under secret.
function verifySignature(payload, signature, secret) {
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return expected === signature;
}

module.exports = { verifySignature };
