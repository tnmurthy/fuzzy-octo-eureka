'use strict';

function createLimiter({ limit, windowMs, now = Date.now } = {}) {
  const hits = new Map();
  return {
    allow(key) {
      const t = now();
      const recent = (hits.get(key) || []).filter((x) => t - x < windowMs);
      if (recent.length >= limit) { hits.set(key, recent); return false; }
      recent.push(t);
      hits.set(key, recent);
      return true;
    },
    size(key) { return (hits.get(key) || []).length; },
  };
}

module.exports = { createLimiter };
