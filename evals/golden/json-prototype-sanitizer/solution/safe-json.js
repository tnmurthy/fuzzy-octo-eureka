'use strict';

const BLOCKED = new Set(['__proto__', 'constructor', 'prototype']);

function safeParse(text) {
  return JSON.parse(text, (key, value) => (BLOCKED.has(key) ? undefined : value));
}

// Deep merge of plain objects; source wins; never writes a blocked key.
function merge(target, source) {
  for (const key of Object.keys(source)) {
    if (BLOCKED.has(key)) continue;
    const v = source[key];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if (!Object.hasOwn(target, key) || !target[key] || typeof target[key] !== 'object') target[key] = {};
      merge(target[key], v);
    } else {
      target[key] = v;
    }
  }
  return target;
}

module.exports = { safeParse, merge };
