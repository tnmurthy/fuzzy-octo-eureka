'use strict';

function createConfig(load) {
  let pending = null;
  return {
    get() {
      if (!pending) {
        pending = Promise.resolve().then(load);
        pending.catch(() => { pending = null; });
      }
      return pending;
    },
  };
}

module.exports = { createConfig };
