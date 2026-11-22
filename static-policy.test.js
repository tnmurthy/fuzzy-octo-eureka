// node --test static-policy.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { isServable } = require('./static-policy');

test('serves top-level web assets and docs', () => {
  for (const p of ['/agents.html', '/dashboard.css', '/agents-page.js', '/task-feed.js', '/drisyon-logo.jpeg', '/docs/DRISYON_COHORT_01_ENROLLMENT_PLAYBOOK.md']) {
    assert.equal(isServable(p), true, p);
  }
});

test('refuses secrets, state, dotfiles and other folders', () => {
  for (const p of ['/.env', '/.env.drisyon', '/.git/config', '/logs/repos.json', '/logs/runs.jsonl', '/secrets/x.env',
    '/drisyon-memory.json', '/telemetry.json', '/package.json', '/node_modules/x/index.js', '/team-store/index.js',
    '/server.js', '/ecosystem.config.js', '/auth.test.js', '/docs/../.env', '/docs/.hidden.md', '/', '', '/a\\b.js', '/x.js\0']) {
    assert.equal(isServable(p), false, p);
  }
});
