'use strict';

// page is 1-based.
function paginate(items, page, size) {
  const totalPages = Math.floor(items.length / size);
  const start = page * size;
  return { items: items.slice(start, start + size), page, totalPages };
}

module.exports = { paginate };
