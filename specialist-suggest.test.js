// node --test specialist-suggest.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSuggester, keywordRank, cleanPicks } = require('./specialist-suggest');
const { cosine } = require('./embeddings');

const items = [
  { slug: 'engineering-frontend-developer', name: 'Frontend Developer', description: 'React, CSS and accessible UI components', divisionLabel: 'Engineering' },
  { slug: 'engineering-code-reviewer', name: 'Code Reviewer', description: 'Constructive code review for correctness and security', divisionLabel: 'Engineering' },
  { slug: 'sales-deal-strategist', name: 'Deal Strategist', description: 'Qualify deals and write proposals', divisionLabel: 'Sales' },
];
const specialists = { list: () => ({ specialists: items }) };

// Toy embedder: one dimension per topic word.
const TOPICS = ['react', 'review', 'deal'];
const vec = (t) => TOPICS.map((w) => (t.toLowerCase().includes(w) ? 1 : 0.01));
const embedder = {
  calls: 0,
  async embedDocuments(texts) { this.calls += 1; return texts.map(vec); },
  async embedQuery(t) { return vec(t); },
};

test('ranks by meaning with embeddings and embeds the catalog only once', async () => {
  const s = createSuggester({ specialists, embedder, cosine });
  const a = await s.suggest('Please review my pull request', 2);
  assert.equal(a.ranker, 'embeddings');
  assert.equal(a.suggestions[0].slug, 'engineering-code-reviewer');
  await s.suggest('Build a React settings panel');
  assert.equal(embedder.calls, 1);
});

test('falls back to keywords when Ollama is down', async () => {
  const down = { embedDocuments: async () => { throw new Error('ECONNREFUSED'); }, embedQuery: async () => { throw new Error('x'); } };
  const s = createSuggester({ specialists, embedder: down, cosine });
  const r = await s.suggest('write proposals for a deal');
  assert.equal(r.ranker, 'keywords');
  assert.equal(r.suggestions[0].slug, 'sales-deal-strategist');
});

test('short or empty queries suggest nothing', async () => {
  const s = createSuggester({ specialists, embedder: null, cosine });
  assert.deepEqual(await s.suggest('ab'), { ranker: 'none', suggestions: [] });
  assert.deepEqual(keywordRank('the and of', items, 3), [], 'stop words alone match nothing');
});

test('stemmed keywords match word forms (inject -> injection)', () => {
  const extra = [...items, { slug: 'security-appsec', name: 'AppSec Engineer', description: 'Finds injection flaws in web apps', divisionLabel: 'Security' }];
  assert.equal(keywordRank('fix the SQL injecting bug', extra, 1)[0].s.slug, 'security-appsec');
});

test('a local model re-ranks the shortlist; bad answers fall back to the shortlist order', async () => {
  const many = Array.from({ length: 6 }, (_, i) => ({ slug: `s${i}`, name: `Spec ${i} react`, description: 'react work', divisionLabel: 'X' }));
  const sp = { list: () => ({ specialists: many }) };
  const good = createSuggester({ specialists: sp, embedder, cosine, rerank: async () => [6, 6, 2, 99] });
  const r = await good.suggest('react things', 3);
  assert.equal(r.ranker, 'embeddings+model');
  assert.equal(r.suggestions[0].slug, 's5', 'model pick first');
  assert.equal(r.suggestions[1].slug, 's1', 'duplicates and out-of-range picks dropped');
  assert.equal(r.suggestions.length, 3, 'topped up from the shortlist');

  const broken = createSuggester({ specialists: sp, embedder, cosine, rerank: async () => { throw new Error('timeout'); } });
  assert.equal((await broken.suggest('react things', 3)).ranker, 'embeddings');
  const nonsense = createSuggester({ specialists: sp, embedder, cosine, rerank: async () => 'banana' });
  assert.equal((await nonsense.suggest('react things', 3)).ranker, 'embeddings');
});

test('cleanPicks keeps valid, unique, in-range positions', () => {
  assert.deepEqual(cleanPicks([3, '1', 3, 0, 7, 2.5, 2], 5, 3), [2, 0, 1]);
  assert.deepEqual(cleanPicks(null, 5, 3), []);
});
