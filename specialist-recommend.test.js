// node --test specialist-recommend.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRecommender, usageScores, contextSignals, isRealWork, taskTitle, HALF_LIFE_MS } = require('./specialist-recommend');

const NOW = Date.parse('2026-11-17T12:00:00Z');
const items = [{ slug: 'sec' }, { slug: 'ops' }, { slug: 'doc' }, { slug: 'pm' }];
const specialists = { list: () => ({ specialists: items }) };
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
// Fake suggester: keyword -> picks.
const suggester = {
  calls: 0,
  async suggest(text) {
    this.calls += 1;
    if (/security/i.test(text)) return { ranker: 'embeddings+model', suggestions: [{ slug: 'sec' }, { slug: 'ops' }] };
    if (/invoice|pdf/i.test(text)) return { ranker: 'embeddings+model', suggestions: [{ slug: 'doc' }] };
    return { ranker: 'embeddings+model', suggestions: [] };
  },
};

test('test, review and automated runs are not your work', () => {
  assert.equal(isRealWork({ agent: 'claude', branch: 'agent/issue-3-x', task: 'GitHub issue a/b#3: Fix it' }), true);
  assert.equal(isRealWork({ agent: 'noop', branch: 'agent/issue-3-x' }), false);
  assert.equal(isRealWork({ agent: 'claude', branch: 'diag/stream' }), false);
  assert.equal(isRealWork({ agent: 'mantis', branch: 'patrol/mantis-1' }), false);
  assert.equal(isRealWork({ agent: 'claude', branch: 'agent/x', task: 'Review pull request #31 in a/b' }), false);
});

test('task titles drop the issue prefix and anything after a --- block', () => {
  assert.equal(taskTitle('GitHub issue a/b#34: add page number --- Done means: tests pass'), 'add page number');
  assert.equal(taskTitle('Write docs\n---\nTeam context: x'), 'Write docs');
});

test('usage decays with age and ignores test runs', () => {
  const u = usageScores([
    { specialist: 'ops', agent: 'claude', branch: 'agent/1', started_at: iso(0) },
    { specialist: 'sec', agent: 'claude', branch: 'agent/2', started_at: iso(2 * HALF_LIFE_MS) },
    { specialist: 'doc', agent: 'noop', branch: 'diag/x', started_at: iso(0) },
  ], NOW);
  assert.equal(u.ops.score, 1);
  assert.ok(Math.abs(u.sec.score - 0.25) < 1e-9);
  assert.equal(u.doc, undefined);
});

test('context signals: memory categories by size, then real task titles once', () => {
  const s = contextSignals({
    memories: [
      { category: 'security_audit', title: 'Sweep', content: 'security scan' },
      { category: 'security_audit', title: 'Sweep 2', content: 'security scan' },
      { category: 'client_spec', title: 'Spec', content: 'invoice pdf' },
    ],
    runs: [
      { agent: 'hermes', branch: 'agent/issue-34-x', task: 'GitHub issue a/b#34: add invoice page numbers --- Done means' },
      { agent: 'hermes', branch: 'agent/issue-35-x', task: 'GitHub issue a/b#35: add invoice page numbers' },
      { agent: 'noop', branch: 'diag/x', task: 'Specialist smoke test: say hello' },
    ],
  });
  assert.deepEqual(s.map((x) => [x.kind, x.label]), [['memory', 'security audit'], ['memory', 'client spec'], ['task', 'add invoice page numbers']]);
  assert.ok(s[0].weight > s[1].weight);
});

test('recommendations blend usage and context, say why, never echo memory text', async () => {
  const r = createRecommender({
    specialists, suggester, now: () => NOW,
    readRuns: () => [{ specialist: 'ops', agent: 'claude', branch: 'agent/issue-9-x', started_at: iso(0), task: 'GitHub issue a/b#9: Make the invoice PDF prettier' }],
    readMemories: () => [{ category: 'security_audit', title: 'Audit', content: 'security review of the auth module' }],
  });
  const out = await r.recommend();
  assert.match(out.ranker, /^usage\+context/);
  const by = Object.fromEntries(out.ranked.map((x) => [x.slug, x]));
  assert.deepEqual(by.ops.reasons, ['you used it 1×', 'fits your memory: security audit']);
  assert.deepEqual(by.sec.reasons, ['fits your memory: security audit']);
  assert.deepEqual(by.doc.reasons, ['like your task: Make the invoice PDF prettier']);
  assert.equal(out.ranked[0].slug, 'ops', 'used + relevant comes first');
  assert.equal(out.ranked.at(-1).slug, 'pm');
  assert.equal(JSON.stringify(out).includes('review of the auth module'), false);
});

test('results are cached and concurrent calls share one computation', async () => {
  let reads = 0;
  const r = createRecommender({ specialists, suggester, now: () => NOW, readRuns: () => { reads += 1; return []; }, readMemories: () => [] });
  await Promise.all([r.recommend(), r.recommend()]);
  await r.recommend();
  assert.equal(reads, 1);
  r.invalidate();
  await r.recommend();
  assert.equal(reads, 2);
});
