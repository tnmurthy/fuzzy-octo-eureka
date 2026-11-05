// memory-search.js - memory search by meaning (local embeddings), with the
// engine's keyword scoring as the fallback when Ollama is unavailable.
// Same tenant/project/category rules either way (engine.filterEntries).

const { cosine } = require('./embeddings');

// nomic-embed-text: related text scores ~0.6-0.7, unrelated ~0.35-0.4.
const MIN_SIMILARITY = 0.5;

const docText = (e) => `${e.title || ''}\n${e.content || ''}\n${(e.tags || []).join(' ')}`;

async function semanticSearch({ engine, embedder, entries, query, options = {} }) {
  const topK = options.topK || 5;
  try {
    const pool = engine.filterEntries(entries, options);
    if (!pool.length || !query.trim()) return { ranker: 'embeddings', results: [] };
    const [q, docs] = await Promise.all([embedder.embedQuery(query), embedder.embedDocuments(pool.map(docText))]);
    const results = pool
      .map((e, i) => ({ e, score: cosine(q, docs[i]) }))
      .filter((r) => r.score >= MIN_SIMILARITY)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map(({ e, score }) => engine.toResult(e, score));
    return { ranker: 'embeddings', results };
  } catch (err) {
    return { ranker: 'keywords', note: `embeddings unavailable: ${err.message}`, results: engine.searchEntries(entries, query, options) };
  }
}

module.exports = { semanticSearch, docText, MIN_SIMILARITY };
