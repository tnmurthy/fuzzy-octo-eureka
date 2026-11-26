'use strict';

function createConfig(load) {
  let value;
  let loaded = false;
  return {
    async get() {
      if (loaded) return value;
      value = await load().catch((e) => e);
      loaded = true;
      return value;
    },
  };
}

module.exports = { createConfig };
