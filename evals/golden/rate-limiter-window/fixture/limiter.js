'use strict';

// TODO: sliding-window rate limiter.
function createLimiter({ limit, windowMs, now = Date.now } = {}) {
  return { allow: () => true };
}

module.exports = { createLimiter };
