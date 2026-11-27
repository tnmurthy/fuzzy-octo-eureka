'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBm25, fuseRanks, terms } = require('./bm25');
const DrisyonMemoryEngine = require('./memory-engine');
const os = require('os');
const path = require('path');
const { semanticSearch } = require('./memory-search');
const { score } = require('./evals/retrieval/retrieval-eval');

test('terms: lower-case, stop words out, 5-letter stems, unicode letters kept', () => {
  assert.deepEqual(terms('The Migrations are RUNNING on café-42'), ['migra', 'runni', 'café', '42']);
});

test('bm25: exact rare terms win; unrelated docs score 0', () => {
  const bm = createBm25(['Postgres error 42P01 relation does not exist', 'Restart cloudflared safely', 'error handling in general error error']);
  const s = bm.score('42P01');
  assert.ok(s[0] > 0);
  assert.equal(s[1], 0);
  assert.equal(s[2], 0);
  const e = bm.score('error');
  assert.ok(e[2] > e[0], 'more occurrences score higher');
});

test('fuseRanks: items high in both lists win; ties break by index', () => {
  assert.deepEqual(fuseRanks([[2, 0, 1], [0, 2]]).map((r) => r.index).slice(0, 2), [0, 2]);
  assert.deepEqual(fuseRanks([[1], [0]]).map((r) => r.index), [0, 1]);
});

// Fake embedder: every doc is equally (and weakly) similar except doc "B".
function fakeEmbedder(simOf) {
  return {
    embedQuery: async () => [1, 0],
    embedDocuments: async (texts) => texts.map((t) => { const s = simOf(t); return [s, Math.sqrt(1 - s * s)]; }),
  };
}
const engine = new DrisyonMemoryEngine({ storagePath: path.join(os.tmpdir(), `bm25-test-${process.pid}.json`) });
const entries = [
  { id: 'A', title: 'Postgres error 42P01', content: 'relation does not exist', tenantId: 'global', projectId: 'global' },
  { id: 'B', title: 'database migrations', content: 'run migrations before deploy', tenantId: 'global', projectId: 'global' },
  { id: 'C', title: 'cloudflared', content: 'restart the tunnel', tenantId: 'global', projectId: 'global' },
];

test('memory search: embeddings by default; hybrid lifts an exact keyword hit', async () => {
  const embedder = fakeEmbedder((t) => (t.includes('migrations') ? 0.8 : 0.3));
  const def = await semanticSearch({ engine, embedder, entries, query: '42P01', options: { topK: 2, tenantId: '*' } });
  assert.equal(def.ranker, 'embeddings');
  assert.deepEqual(def.results.map((r) => r.id), ['B']);
  const hyb = await semanticSearch({ engine, embedder, entries, query: '42P01', options: { topK: 2, tenantId: '*', ranker: 'hybrid' } });
  assert.equal(hyb.ranker, 'hybrid');
  assert.deepEqual(hyb.results.map((r) => r.id).sort(), ['A', 'B']);
  assert.equal(hyb.results.find((r) => r.id === 'A').score, 0.3, 'shown score stays the cosine');
});

test('memory search: embeddings down -> keywords fallback', async () => {
  const broken = { embedQuery: async () => { throw new Error('ollama down'); }, embedDocuments: async () => [] };
  const r = await semanticSearch({ engine, embedder: broken, entries, query: 'tunnel', options: { tenantId: '*' } });
  assert.equal(r.ranker, 'keywords');
});

test('retrieval eval: recall@k and MRR by kind', () => {
  const q = [{ relevant: ['a'], kind: 'x' }, { relevant: ['b'], kind: 'y' }];
  const s = score([['z', 'a'], ['c', 'd', 'e', 'b']], q, 3);
  assert.deepEqual(s.all, { n: 2, recall: 0.5, mrr: 0.375 });
  assert.deepEqual(s.x, { n: 1, recall: 1, mrr: 0.5 });
  assert.deepEqual(s.y, { n: 1, recall: 0, mrr: 0.25 });
});
