// node --test approval-levels.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { LEVELS, toolsFor, parseLevel, effectiveLevel } = require('./approval-levels');

test('a review reads by exact tool name only: no shell, no edits, never asks', () => {
  const t = toolsFor('review');
  assert.equal(t.allowed, 'Read Glob Grep');
  for (const denied of ['Edit', 'Write', 'NotebookEdit', 'Bash', 'WebFetch', 'WebSearch']) {
    assert.ok(t.denied.split(' ').includes(denied), denied);
  }
  assert.equal(t.asks, false);
  assert.ok(!/Bash\(/.test(t.allowed), 'no shell pattern is pre-allowed');
});

test('push and gh are denied at every level', () => {
  for (const level of LEVELS) {
    const t = toolsFor(level);
    assert.ok(t.denied.includes('Bash(git push:*)'), level);
    assert.ok(t.denied.includes('Bash(gh:*)'), level);
  }
});

test('levels grow in what they pre-allow', () => {
  assert.equal(toolsFor('ask').permissionMode, 'default');
  assert.ok(!toolsFor('ask').allowed.includes('Edit'));
  assert.ok(toolsFor('edits').allowed.includes('Edit'));
  assert.ok(!toolsFor('edits').allowed.includes('Bash'));
  assert.ok(toolsFor('auto', { scriptsDir: '/x' }).allowed.includes('Bash(/x/db-lock.sh:*)'));
});

test('there is no full-access level', () => {
  assert.equal(parseLevel('full'), null);
  assert.throws(() => toolsFor('full'));
});

test('a review is always review, whatever was asked', () => {
  assert.equal(effectiveLevel({ requested: 'auto', readOnly: true }), 'review');
});

test('a level only flows down: a follow-up never gets more than its parent', () => {
  assert.equal(effectiveLevel({ requested: 'auto', parentLevel: 'edits' }), 'edits');
  assert.equal(effectiveLevel({ requested: 'ask', parentLevel: 'auto' }), 'ask');
  assert.equal(effectiveLevel({ requested: 'auto', parentLevel: 'review' }), 'ask');
});

test('unknown or missing levels fall back to auto (today\'s behaviour)', () => {
  assert.equal(effectiveLevel({ requested: 'everything' }), 'auto');
  assert.equal(effectiveLevel({}), 'auto');
  assert.equal(effectiveLevel({ requested: undefined, fallback: 'ask' }), 'ask');
});

// ---- auto names subcommands, never a whole CLI (2026-11-22) -----------------
const { AUTO_COMMANDS } = require('./approval-levels');

// Does Claude Code's prefix rule `Bash(<prefix>:*)` / exact `Bash(<cmd>)` allow cmd?
function preAllowed(cmd, allowed) {
  return (allowed.match(/Bash\([^)]*\)/g) || []).some((rule) => {
    const body = rule.slice(5, -1);
    if (body.endsWith(':*')) { const pre = body.slice(0, -2); return cmd === pre || cmd.startsWith(`${pre} `); }
    return cmd === body;
  });
}

test('auto pre-allows the everyday dev commands', () => {
  const { allowed } = toolsFor('auto', { scriptsDir: '/x' });
  for (const cmd of ['git status', 'git add -A', 'git commit -m "x"', 'git diff HEAD~1', 'npm test', 'npm run lint', 'npm ci', 'npm install',
    'node --test a.test.js', 'npx eslint .', 'npx tsc --noEmit', 'npx playwright test', 'supabase db reset', 'ls -la', 'cat README.md', '/x/db-lock.sh npm test']) {
    assert.ok(preAllowed(cmd, allowed), cmd);
  }
});

test('auto no longer pre-allows ways to run anything or reach outside', () => {
  const { allowed } = toolsFor('auto', { scriptsDir: '/x' });
  for (const cmd of ['node -e "require(\'child_process\')"', 'node evil.js', 'npx some-package', 'npx -y cowsay', 'git -C . push origin main',
    'git -c core.sshCommand=sh push', 'git config core.hooksPath /tmp/h', 'git remote add x url', 'git push', 'npm publish', 'npm exec foo',
    'npm install left-pad', 'supabase link --project-ref abc', 'supabase db push', 'supabase functions deploy x', 'curl http://x']) {
    assert.ok(!preAllowed(cmd, allowed), cmd);
  }
  assert.ok(!/Bash\((git|npm|npx|node|supabase):\*\)/.test(allowed), 'no whole-CLI wildcard');
  assert.ok(AUTO_COMMANDS.length > 20);
});

test('npm publish is denied at every level', () => {
  for (const l of ['ask', 'edits', 'auto']) assert.ok(toolsFor(l).denied.includes('Bash(npm publish:*)'), l);
});

test('disallowedTools and specialistRole enforce least-privilege tool masking', () => {
  // Explicit disallowed tools
  const masked = toolsFor('auto', { disallowedTools: ['Bash', 'Edit'] });
  assert.ok(!masked.allowed.includes('Edit'));
  assert.ok(!masked.allowed.includes('Bash('));
  assert.ok(masked.denied.includes('Bash'));
  assert.ok(masked.denied.includes('Edit'));

  // Role-based profile: researcher is strictly read-only (no Bash, no Edit, no Write)
  const researcher = toolsFor('auto', { specialistRole: 'researcher' });
  assert.ok(!researcher.allowed.includes('Edit'));
  assert.ok(!researcher.allowed.includes('Write'));
  assert.ok(!researcher.allowed.includes('Bash('));
  assert.ok(researcher.denied.includes('Bash'));
  assert.ok(researcher.denied.includes('Edit'));
  assert.ok(researcher.allowed.includes('Read'));
  assert.ok(researcher.allowed.includes('Glob'));

  // Engineering role: defaults remain intact
  const standard = toolsFor('auto');
  assert.ok(standard.allowed.includes('Edit'));
  assert.ok(standard.allowed.includes('Write'));
});
