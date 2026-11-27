'use strict';
// bm25.js - Okapi BM25 keyword ranking for memory search. Pure, no deps.
// Catches what embeddings miss: exact names, ids, error strings, file paths.
// Words are lower-cased, split on anything but letters/digits, stop words
// dropped, and cut to 5 letters (a cheap stem: "migrations" ~ "migrate").

const STOP = new Set(
  'a an and are as at be but by for from has have how i if in into is it its of on or our so that the their them then there this to was we were what when where which who why will with you your'.split(' ')
);
const K1 = 1.2;
const B = 0.75;

function terms(text) {
  return (String(text || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [])
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map((w) => w.slice(0, 5));
}

/**
 * @param {string[]} docs
 * @returns {{ score(query: string): number[] }}
 */
function createBm25(docs) {
  const tfs = docs.map((d) => {
    const tf = new Map();
    for (const t of terms(d)) tf.set(t, (tf.get(t) || 0) + 1);
    return tf;
  });
  const lens = tfs.map((tf) => [...tf.values()].reduce((a, b) => a + b, 0));
  const avg = lens.reduce((a, b) => a + b, 0) / (lens.length || 1) || 1;
  const df = new Map();
  for (const tf of tfs) for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
  const n = docs.length;
  const idf = (t) => Math.log(1 + (n - (df.get(t) || 0) + 0.5) / ((df.get(t) || 0) + 0.5));

  return {
    score(query) {
      const q = [...new Set(terms(query))];
      return tfs.map((tf, i) => {
        let s = 0;
        for (const t of q) {
          const f = tf.get(t);
          if (!f) continue;
          s += idf(t) * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * lens[i]) / avg)));
        }
        return s;
      });
    },
  };
}

/**
 * Reciprocal-rank fusion: each list is item indexes, best first.
 * @param {number[][]} lists
 * @param {number} [k] 60 is the usual constant
 * @returns {Array<{ index: number, score: number }>} best first
 */
function fuseRanks(lists, k = 60) {
  const scores = new Map();
  for (const list of lists) {
    list.forEach((idx, rank) => scores.set(idx, (scores.get(idx) || 0) + 1 / (k + rank + 1)));
  }
  return [...scores.entries()].map(([index, score]) => ({ index, score })).sort((a, b) => b.score - a.score || a.index - b.index);
}

module.exports = { createBm25, fuseRanks, terms };
