'use strict';

// page is 1-based.
function paginate(items, page, size) {
  const totalPages = Math.max(1, Math.ceil(items.length / size));
  const start = (page - 1) * size;
  return { items: items.slice(start, start + size), page, totalPages };
}

module.exports = { paginate };
