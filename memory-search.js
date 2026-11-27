// memory-search.js - memory search by meaning (local embeddings), with the
// engine's keyword scoring as the fallback when Ollama is unavailable.
// Same tenant/project/category rules either way (engine.filterEntries).
//
// MEMORY_RANKER=hybrid (opt-in) adds BM25 keywords to the embeddings, merged
// by reciprocal-rank fusion (bm25.js); the score shown stays the cosine
// similarity, the order is fused. Not the default: on the labelled set in
// evals/retrieval/ (2026-11-26) hybrid scored recall@3 0.86 vs 0.95 for
// embeddings alone - nomic-embed-text already finds exact ids and error codes
// there, and BM25 added keyword noise to paraphrased questions. Re-run
// `node evals/retrieval/retrieval-eval.js` before changing the default.

const { cosine } = require('./embeddings');
const { createBm25, fuseRanks } = require('./bm25');

// nomic-embed-text: related text scores ~0.6-0.7, unrelated ~0.35-0.4.
const MIN_SIMILARITY = 0.5;
// How many keyword hits may join the fusion: a few per result wanted.
const KEYWORD_POOL_FACTOR = 4;

const docText = (e) => `${e.title || ''}\n${e.content || ''}\n${(e.tags || []).join(' ')}`;

/** Indexes whose score passes keep, best first, at most n. */
function rankedIndexes(scores, keep, n) {
  return scores
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => keep(s))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, n)
    .map(({ i }) => i);
}

async function semanticSearch({ engine, embedder, entries, query, options = {} }) {
  const topK = options.topK || 5;
  const hybrid = (options.ranker || process.env.MEMORY_RANKER || 'embeddings') === 'hybrid';
  const ranker = hybrid ? 'hybrid' : 'embeddings';
  try {
    const pool = engine.filterEntries(entries, options);
    if (!pool.length || !query.trim()) return { ranker, results: [] };
    const texts = pool.map(docText);
    const [q, docs] = await Promise.all([embedder.embedQuery(query), embedder.embedDocuments(texts)]);
    const sims = docs.map((d) => cosine(q, d));
    const byMeaning = rankedIndexes(sims, (s) => s >= MIN_SIMILARITY, pool.length);
    const order = hybrid
      ? fuseRanks([byMeaning, rankedIndexes(createBm25(texts).score(query), (s) => s > 0, topK * KEYWORD_POOL_FACTOR)]).map((r) => r.index)
      : byMeaning;
    const results = order.slice(0, topK).map((i) => engine.toResult(pool[i], sims[i]));
    return { ranker, results };
  } catch (err) {
    return { ranker: 'keywords', note: `embeddings unavailable: ${err.message}`, results: engine.searchEntries(entries, query, options) };
  }
}

module.exports = { semanticSearch, docText, MIN_SIMILARITY };
