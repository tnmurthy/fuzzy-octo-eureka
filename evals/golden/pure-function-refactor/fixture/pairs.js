'use strict';

// True when two different positions in nums add up to target.
function hasPairWithSum(nums, target) {
  nums.sort((a, b) => a - b);
  for (let i = 0; i < nums.length; i++) {
    for (let j = i + 1; j < nums.length; j++) {
      if (nums[i] + nums[j] === target) return true;
    }
  }
  return false;
}

module.exports = { hasPairWithSum };
