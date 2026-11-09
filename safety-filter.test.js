const test = require('node:test');
const assert = require('node:assert/strict');
const { checkPromptSafety, validateDispatchSafety } = require('./safety-filter');

test('safety-filter: allows benign code instructions', () => {
  const benign = [
    'Refactor the auth middleware to handle sliding expiration',
    'Add unit tests for telemetry daemon',
    'Run npm test and report summary',
    'git status && git log -5'
  ];

  for (const prompt of benign) {
    const check = checkPromptSafety(prompt);
    assert.equal(check.safe, true, `Prompt should be safe: ${prompt}`);
    const verdict = validateDispatchSafety(prompt);
    assert.equal(verdict.ok, true);
  }
});

test('safety-filter: flags destructive commands without confirmation (FR-CHAT-07)', () => {
  const dangerous = [
    { prompt: 'clean the worktree using git reset --hard HEAD~1', name: 'git reset --hard' },
    { prompt: 'push all changes upstream: git push origin main --force', name: 'git push --force' },
    { prompt: 'rm -rf node_modules and reinstall', name: 'rm -rf' },
    { prompt: 'rm -f -r dist/ && rm -rf build/', name: 'rm -rf' },
    { prompt: 'execute SQL: DROP TABLE users CASCADE;', name: 'DROP/TRUNCATE table' },
    { prompt: 'wipe partition: dd if=/dev/zero of=/dev/sda', name: 'destructive disk/block write' }
  ];

  for (const { prompt, name } of dangerous) {
    const check = checkPromptSafety(prompt);
    assert.equal(check.safe, false, `Prompt should be flagged: ${prompt}`);
    assert.equal(check.matchedPattern, name);

    const verdict = validateDispatchSafety(prompt);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.risky, true);
    assert.equal(verdict.requiresConfirmation, true);
    assert.equal(verdict.matchedPattern, name);
  }
});

test('safety-filter: permits risky commands when confirmed: true', () => {
  const prompt = 'git reset --hard HEAD';
  const verdict = validateDispatchSafety(prompt, { confirmed: true });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.confirmed, true);
  assert.match(verdict.warning, /git reset --hard/);
});
