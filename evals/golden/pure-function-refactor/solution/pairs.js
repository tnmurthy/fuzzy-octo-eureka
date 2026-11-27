'use strict';

// True when two different positions in nums add up to target. O(N), pure.
function hasPairWithSum(nums, target) {
  const seen = new Set();
  for (const n of nums) {
    if (seen.has(target - n)) return true;
    seen.add(n);
  }
  return false;
}

module.exports = { hasPairWithSum };
