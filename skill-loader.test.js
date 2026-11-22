// skill-loader.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { createSkillLoader, parseSkillMd } = require('./skill-loader');

test('parseSkillMd extracts YAML frontmatter and body properly', () => {
  const content = `---
name: sample-skill
description: Tests skill parser
triggers: [test, sample, parse]
file_patterns: ["*.test.js", "*.spec.js"]
---

# Instructions
Do not skip tests.`;

  const { meta, body } = parseSkillMd(content);
  assert.equal(meta.name, 'sample-skill');
  assert.equal(meta.description, 'Tests skill parser');
  assert.deepEqual(meta.triggers, ['test', 'sample', 'parse']);
  assert.deepEqual(meta.file_patterns, ['*.test.js', '*.spec.js']);
  assert.match(body, /# Instructions/);
  assert.match(body, /Do not skip tests\./);
});

test('skill loader scans directory and discovers seeded skills', () => {
  const loader = createSkillLoader();
  const all = loader.loadAllSkills();
  assert.ok(all.length >= 4, `Expected at least 4 skills, found ${all.length}`);

  const names = all.map((s) => s.name);
  assert.ok(names.includes('sqlite-wal'));
  assert.ok(names.includes('api-contract'));
  assert.ok(names.includes('security-audit'));
  assert.ok(names.includes('canary-deploy'));
});

test('skill loader matches skills based on keywords and files', () => {
  const loader = createSkillLoader();

  // 1. Database task matches sqlite-wal
  const dbMatches = loader.matchSkills('Configure SQLite WAL mode for transaction safety', ['ledger-db.js']);
  assert.ok(dbMatches.length > 0);
  assert.equal(dbMatches[0].skill.name, 'sqlite-wal');
  assert.ok(dbMatches[0].score >= 20);

  // 2. Security audit task matches security-audit
  const secMatches = loader.matchSkills('Audit diff for OWASP vulnerabilities and token leaks', ['auth.js']);
  assert.ok(secMatches.length > 0);
  assert.equal(secMatches[0].skill.name, 'security-audit');

  // 3. Unrelated task returns empty
  const emptyMatches = loader.matchSkills('Write a poem about sunshine', ['poem.txt']);
  assert.equal(emptyMatches.length, 0);
});

test('skill loader bounds prompt injection with character budgets', () => {
  const loader = createSkillLoader();
  const matches = loader.matchSkills('Migrate database with SQLite WAL pragma', ['ledger.db']);
  const prompt = loader.formatSkillPrompt(matches, { maxChars: 500, perSkillChars: 250 });

  assert.match(prompt, /Just-In-Time Operational Skills/);
  assert.match(prompt, /Skill: sqlite-wal/);
  assert.ok(prompt.length <= 600, `Expected prompt length <= 600, got ${prompt.length}`);
});
