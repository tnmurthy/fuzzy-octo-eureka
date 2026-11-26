'use strict';
// retrieval-eval.js - recall@k and MRR of memory search on a labelled set
// (corpus.json + queries.json). Compares the keyword fallback, embeddings
// alone and hybrid (embeddings + BM25, the default).
//
//   node evals/retrieval/retrieval-eval.js [--k 3] [--json]
//
// Needs Ollama with nomic-embed-text for the embeddings and hybrid rows; the
// keyword row always runs. Embeddings are cached in a temp file per run, so
// nothing touches the dashboard's cache.

const os = require('os');
const path = require('path');
const DrisyonMemoryEngine = require('../../memory-engine');
const { createEmbedder } = require('../../embeddings');
const { semanticSearch } = require('../../memory-search');

const CORPUS = require('./corpus.json').map((e) => ({ ...e, tenantId: 'global', projectId: 'global', category: 'lesson' }));
const QUERIES = require('./queries.json');

/** recall@k and MRR for ranked id lists. Pure. */
function score(rankings, queries, k) {
  const rows = queries.map((q, i) => {
    const ids = rankings[i] || [];
    const first = ids.findIndex((id) => q.relevant.includes(id));
    return { kind: q.kind, hit: first >= 0 && first < k, rr: first >= 0 ? 1 / (first + 1) : 0 };
  });
  const agg = (list) => ({
    n: list.length,
    recall: list.length ? Number((list.filter((r) => r.hit).length / list.length).toFixed(3)) : 0,
    mrr: list.length ? Number((list.reduce((s, r) => s + r.rr, 0) / list.length).toFixed(3)) : 0,
  });
  const kinds = [...new Set(queries.map((q) => q.kind))];
  return { all: agg(rows), ...Object.fromEntries(kinds.map((kd) => [kd, agg(rows.filter((r) => r.kind === kd))])) };
}

async function run({ k = 3, embedder } = {}) {
  const engine = new DrisyonMemoryEngine({ storagePath: path.join(os.tmpdir(), `retrieval-eval-${process.pid}.json`) });
  const opts = { topK: k, tenantId: '*' };
  const out = { k, keywords: score(QUERIES.map((q) => engine.searchEntries(CORPUS, q.q, { ...opts, threshold: 0 }).map((r) => r.id)), QUERIES, k) };
  if (embedder) {
    for (const ranker of ['embeddings', 'hybrid']) {
      const lists = [];
      let used = ranker;
      for (const q of QUERIES) {
        const r = await semanticSearch({ engine, embedder, entries: CORPUS, query: q.q, options: { ...opts, ranker } });
        used = r.ranker;
        lists.push(r.results.map((x) => x.id));
      }
      out[ranker] = used === ranker ? score(lists, QUERIES, k) : { error: `fell back to ${used}` };
    }
  }
  return out;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const k = Number(args[args.indexOf('--k') + 1]) || 3;
  const embedder = createEmbedder({ cacheFile: path.join(os.tmpdir(), 'retrieval-eval-embeddings.json') });
  run({ k, embedder }).then((out) => {
    if (args.includes('--json')) return console.log(JSON.stringify(out, null, 2));
    console.log(`recall@${k} / MRR   (all | paraphrase | exact)`);
    for (const r of ['keywords', 'embeddings', 'hybrid']) {
      const s = out[r];
      if (!s) continue;
      if (s.error) { console.log(`${r.padEnd(11)} ${s.error}`); continue; }
      const f = (x) => (x ? `${x.recall.toFixed(2)} / ${x.mrr.toFixed(2)}` : '-');
      console.log(`${r.padEnd(11)} ${f(s.all)} | ${f(s.paraphrase)} | ${f(s.exact)}`);
    }
  }, (err) => { console.error(err.message); process.exit(2); });
}

module.exports = { score, run, CORPUS, QUERIES };
