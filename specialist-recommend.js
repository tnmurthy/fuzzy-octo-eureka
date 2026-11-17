// specialist-recommend.js - "Recommended for you": rank the agency-agents
// specialists for the person at this dashboard from two signals:
//
//   usage    - real runs on this machine that used a specialist, weighted by
//              recency (half-life 14 days), so habits fade.
//   context  - their memory (one signal per category) and recent real task
//              titles. Each signal goes through the same suggester the task
//              form uses (local embeddings shortlist + local model pick), and
//              its top 3 picks earn relevance and a reason.
//
// Test and automated runs (noop, diag/ branches, PR reviews, patrol/ sweeps)
// are ignored. Everything runs locally; memory text never leaves the machine
// and is never returned - reasons name only a memory category or a task title.

const HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_TASKS = 8;
const MAX_CATEGORIES = 6;
const PER_CATEGORY = 6;
const USAGE_WEIGHT = 0.55;
const PICK_WEIGHTS = [1, 0.7, 0.5];

const clip = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** A run the person asked for, not a test, review or scheduled sweep. */
function isRealWork(r) {
  if (!r || r.agent === 'noop') return false;
  const branch = String(r.branch || '');
  if (/^(diag|patrol|sim|test)\//.test(branch)) return false;
  return !/^Review pull request/.test(String(r.task || ''));
}

/** The task's own words: no "GitHub issue x#n:" prefix, nothing after a --- block. */
function taskTitle(task) {
  return clip(String(task || '').split(/\s---\s|\n---/)[0].replace(/^GitHub issue \S+#\d+:\s*/, ''), 120);
}

/** Recency-weighted use count per specialist slug. */
function usageScores(runs, now) {
  const out = {};
  for (const r of runs || []) {
    if (!r || !r.specialist || !isRealWork(r)) continue;
    const at = Date.parse(r.started_at);
    const age = Number.isFinite(at) ? Math.max(0, now - at) : HALF_LIFE_MS * 4;
    const u = out[r.specialist] || (out[r.specialist] = { score: 0, count: 0 });
    u.score += 0.5 ** (age / HALF_LIFE_MS);
    u.count += 1;
  }
  return out;
}

/** The person's context as labelled texts: memory categories, then recent task titles. */
function contextSignals({ memories = [], runs = [] }) {
  const signals = [];
  const byCat = {};
  for (const m of memories) {
    if (!m || !m.content) continue;
    const c = String(m.category || 'context');
    (byCat[c] = byCat[c] || []).push(m);
  }
  const cats = Object.entries(byCat).sort((a, b) => b[1].length - a[1].length).slice(0, MAX_CATEGORIES);
  const total = cats.reduce((n, [, list]) => n + list.length, 0) || 1;
  for (const [cat, list] of cats) {
    const text = list.slice(0, PER_CATEGORY).map((m) => `${clip(m.title, 80)}: ${clip(m.content, 120)}`).join('\n');
    signals.push({ kind: 'memory', label: cat.replace(/_/g, ' '), weight: 0.5 + list.length / total, text });
  }
  const seen = new Set();
  for (const r of runs) {
    if (!isRealWork(r)) continue;
    const title = taskTitle(r.task);
    if (title.length < 12 || seen.has(title.toLowerCase())) continue;
    seen.add(title.toLowerCase());
    signals.push({ kind: 'task', label: title, weight: 0.8, text: title });
    if (seen.size >= MAX_TASKS) break;
  }
  return signals;
}

/**
 * Pure ranking.
 * @param {object[]} items  catalog entries
 * @param {{signal: object, picks: string[]}[]} picked  per signal, slugs best first
 * @param {Record<string, {score: number, count: number}>} usage
 */
function rank({ items, picked, usage }) {
  const rel = {};
  const reason = {};
  for (const { signal, picks } of picked) {
    picks.slice(0, PICK_WEIGHTS.length).forEach((slug, i) => {
      const v = signal.weight * PICK_WEIGHTS[i];
      rel[slug] = (rel[slug] || 0) + v;
      if (!reason[slug] || v > reason[slug].v) reason[slug] = { v, signal };
    });
  }
  const maxRel = Math.max(0, ...Object.values(rel));
  const maxUse = Math.max(0, ...Object.values(usage).map((u) => u.score));
  return items
    .map((s) => {
      const u = usage[s.slug];
      const useNorm = u && maxUse > 0 ? u.score / maxUse : 0;
      const relNorm = maxRel > 0 ? (rel[s.slug] || 0) / maxRel : 0;
      const reasons = [];
      if (u) reasons.push(`you used it ${u.count}×`);
      const r = reason[s.slug];
      if (r) reasons.push(r.signal.kind === 'memory' ? `fits your memory: ${r.signal.label}` : `like your task: ${clip(r.signal.label, 60)}`);
      return { slug: s.slug, score: Math.round((USAGE_WEIGHT * useNorm + (1 - USAGE_WEIGHT) * relNorm) * 1000) / 1000, reasons, used: u ? u.count : 0 };
    })
    .sort((a, b) => b.score - a.score || b.used - a.used || a.slug.localeCompare(b.slug));
}

/**
 * @param {object} o
 * @param {{ list: () => {specialists: object[]} }} o.specialists
 * @param {{ suggest: (text: string, k: number) => Promise<{suggestions: {slug: string}[]}> }} o.suggester
 * @param {() => object[]} o.readRuns      this machine's runs, newest first
 * @param {() => object[]} o.readMemories  this machine's memory entries
 * @param {number} [o.ttlMs]               cache the ranking this long
 */
function createRecommender({ specialists, suggester, readRuns, readMemories, ttlMs = 5 * 60 * 1000, now = Date.now }) {
  const items = specialists.list().specialists;
  let cache = { at: 0, value: null };
  let inflight = null;

  async function compute() {
    const runs = readRuns() || [];
    const usage = usageScores(runs, now());
    const signals = contextSignals({ memories: readMemories() || [], runs });
    const picked = [];
    let ranker = 'usage';
    for (const signal of signals) { // sequential: one local model call at a time
      try {
        const r = await suggester.suggest(signal.text, 3);
        const picks = (r.suggestions || []).map((x) => x.slug);
        if (picks.length) { picked.push({ signal, picks }); ranker = `usage+context (${r.ranker})`; }
      } catch (_) { /* skip this signal */ }
    }
    return {
      ranker,
      signals: signals.map((s) => ({ kind: s.kind, label: s.kind === 'memory' ? s.label : clip(s.label, 60) })),
      ranked: rank({ items, picked, usage }),
    };
  }

  async function recommend() {
    if (cache.value && now() - cache.at < ttlMs) return cache.value;
    if (!inflight) {
      inflight = compute()
        .then((value) => { cache = { at: now(), value }; return value; })
        .finally(() => { inflight = null; });
    }
    return inflight;
  }

  return { recommend, invalidate: () => { cache = { at: 0, value: null }; } };
}

module.exports = { createRecommender, rank, usageScores, contextSignals, isRealWork, taskTitle, HALF_LIFE_MS };
