// node --test agents-features.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { prUrlOf, readOrigin } = require('./repo-registry');

test('prUrlOf constructs compare and PR URLs accurately for GitHub and GitLab', () => {
  // GitHub HTTPS
  assert.equal(
    prUrlOf('https://github.com/my-org/my-project.git', 'agent/run-123'),
    'https://github.com/my-org/my-project/compare/agent%2Frun-123?expand=1'
  );

  // GitHub SSH
  assert.equal(
    prUrlOf('git@github.com:my-org/my-project.git', 'agent/feat-ui'),
    'https://github.com/my-org/my-project/compare/agent%2Ffeat-ui?expand=1'
  );

  // GitHub HTTPS without .git
  assert.equal(
    prUrlOf('https://github.com/my-org/my-project', 'agent/run-abc'),
    'https://github.com/my-org/my-project/compare/agent%2Frun-abc?expand=1'
  );

  // GitLab
  assert.equal(
    prUrlOf('https://gitlab.com/subgroup/repo.git', 'agent/run-xyz'),
    'https://gitlab.com/subgroup/repo/-/merge_requests/new?merge_request%5Bsource_branch%5D=agent%2Frun-xyz'
  );

  // Empty or invalid
  assert.equal(prUrlOf(null, 'agent/run-1'), null);
  assert.equal(prUrlOf('', 'agent/run-1'), null);
  assert.equal(prUrlOf('https://mygit.internal/repo.git', 'agent/run-1'), null);
});

