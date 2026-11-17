// specialist-suggest.js - rank specialists (agency-agents personas) for a task
// description, so the Agents page can suggest one as you type.
//
// 1. Shortlist: meaning (local nomic-embed-text embeddings of name +
//    description, cached on disk) plus a stemmed keyword boost. Keywords
//    alone if Ollama is down.
// 2. Optional re-rank: a small local model picks the best 3 from the top
//    SHORTLIST (e.g. it knows "SQL injection" is security work, which neither
//    embeddings nor keywords get). Its answer is validated against the
//    shortlist; a slow, failed or odd answer falls back to the shortlist order.
// Everything runs locally; persona bodies are never embedded or sent.

const SHORTLIST = 30;
const KEYWORD_WEIGHT = 0.2;
const STOP = new Set('a an and the to of in on for with from by at is are be this that it as or into our your my we you i add make fix update new use using page set up please can'.split(' '));
const stems = (s) => (String(s || '').toLowerCase().match(/[a-z0-9][a-z0-9+#.-]{1,}/g) || [])
  .filter((w) => !STOP.has(w)).map((w) => w.slice(0, 5));

/** Share of the query's stems found in a specialist's name/description. */
function keywordScore(queryStems, docStems) {
  if (!queryStems.length) return 0;
  return queryStems.filter((t) => docStems.has(t)).length / queryStems.length;
}

function keywordRank(query, items, k) {
  const q = [...new Set(stems(query))];
  return items
    .map((s) => ({ s, score: keywordScore(q, new Set(stems(`${s.name} ${s.description}`))) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.s.name.localeCompare(b.s.name))
    .slice(0, k);
}

/** Validate a re-ranker's answer: 1-based indices into the shortlist. */
function cleanPicks(picks, n, k) {
  const out = [];
  for (const p of Array.isArray(picks) ? picks : []) {
    const i = Number(p);
    if (Number.isInteger(i) && i >= 1 && i <= n && !out.includes(i - 1)) out.push(i - 1);
    if (out.length === k) break;
  }
  return out;
}

/**
 * @param {object} o
 * @param {{ list: () => {specialists: object[]} }} o.specialists
 * @param {{ embedDocuments: Function, embedQuery: Function } | null} o.embedder
 * @param {(a: number[], b: number[]) => number} o.cosine
 * @param {((query: string, shortlist: object[]) => Promise<number[]>) | null} [o.rerank]
 *   resolves to 1-based shortlist positions, best first
 */
function createSuggester({ specialists, embedder, cosine, rerank = null }) {
  const items = specialists.list().specialists;
  const docStems = items.map((s) => new Set(stems(`${s.name} ${s.description}`)));
  let docVectors = null;
  let warming = null;

  function warm() {
    if (!embedder || docVectors) return Promise.resolve();
    if (!warming) {
      warming = embedder.embedDocuments(items.map((s) => `${s.name}. ${s.description}`))
        .then((v) => { docVectors = v; })
        .catch(() => { warming = null; }); // retry on a later request
    }
    return warming;
  }

  const pick = (s, score, ranker) => ({ slug: s.slug, name: s.name, emoji: s.emoji, divisionLabel: s.divisionLabel, score: Math.round(score * 1000) / 1000, ranker });

  async function shortlist(q) {
    const qs = [...new Set(stems(q))];
    if (embedder) {
      try {
        await warm();
        if (docVectors) {
          const qv = await embedder.embedQuery(q);
          return {
            ranker: 'embeddings',
            ranked: items.map((s, i) => ({ s, score: cosine(qv, docVectors[i]) + KEYWORD_WEIGHT * keywordScore(qs, docStems[i]) }))
              .sort((a, b) => b.score - a.score).slice(0, SHORTLIST),
          };
        }
      } catch (_) { /* Ollama down: keywords below */ }
    }
    return { ranker: 'keywords', ranked: keywordRank(q, items, SHORTLIST) };
  }

  /** Top k specialists for a task description. */
  async function suggest(query, k = 3) {
    const q = String(query || '').trim().slice(0, 500);
    if (q.length < 3 || !items.length) return { ranker: 'none', suggestions: [] };
    const { ranker, ranked } = await shortlist(q);
    if (rerank && ranked.length > k) {
      try {
        const order = cleanPicks(await rerank(q, ranked.map((r) => r.s)), ranked.length, k);
        if (order.length) {
          const chosen = order.map((i) => ranked[i]);
          for (const r of ranked) { if (chosen.length >= k) break; if (!chosen.includes(r)) chosen.push(r); }
          return { ranker: `${ranker}+model`, suggestions: chosen.map((r) => pick(r.s, r.score, `${ranker}+model`)) };
        }
      } catch (_) { /* slow or failed model: shortlist order */ }
    }
    return { ranker, suggestions: ranked.slice(0, k).map((r) => pick(r.s, r.score, ranker)) };
  }

  return { suggest, warm };
}

/**
 * A re-ranker backed by a local Ollama model. `record` gets one ledger entry
 * per call (provider ollama: exempt from the paid caps).
 */
function ollamaReranker({ host = '127.0.0.1', port = 11434, model = 'gemma3:4b', timeoutMs = 4000, record = () => {} }) {
  return async (query, shortlistItems) => {
    const list = shortlistItems.map((s, i) => `${i + 1}. ${s.name}: ${String(s.description).slice(0, 110)}`).join('\n');
    const started = Date.now();
    let ok = false;
    try {
      const res = await fetch(`http://${host}:${port}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model, stream: false, format: 'json', options: { temperature: 0 },
          prompt: `Task: ${JSON.stringify(query)}\n\nWhich 3 specialists below are best suited to do this task? Answer as JSON {"picks":[numbers]}, best first.\n\n${list}`,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = await res.json();
      ok = res.ok;
      return (JSON.parse(body.response || '{}').picks) || [];
    } finally {
      try { record({ provider: 'ollama', model, purpose: 'suggest', ok, latency_ms: Date.now() - started }); } catch (_) { /* ledger is best effort */ }
    }
  };
}

module.exports = { createSuggester, ollamaReranker, keywordRank, cleanPicks };
