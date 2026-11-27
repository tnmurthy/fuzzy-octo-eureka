'use strict';

function safeParse(text) {
  return JSON.parse(text);
}

// Deep merge of plain objects; source wins.
function merge(target, source) {
  for (const key of Object.keys(source)) {
    const v = source[key];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if (!target[key] || typeof target[key] !== 'object') target[key] = {};
      merge(target[key], v);
    } else {
      target[key] = v;
    }
  }
  return target;
}

module.exports = { safeParse, merge };
