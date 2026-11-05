// embeddings.js - local text embeddings (Ollama nomic-embed-text) with a
// disk cache, for memory search by meaning rather than shared keywords.
//
// Measured on this CPU-only i7: ~56 ms per text in a batch of 50, so a cold
// cache of 500 memories costs ~30 s once; afterwards only new text is sent.
// nomic-embed-text expects task prefixes: search_query / search_document.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_MODEL = 'nomic-embed-text';
const DEFAULT_BATCH = 64;
const DEFAULT_TIMEOUT_MS = 120000;
const MAX_CACHE_ENTRIES = 5000;

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

function createEmbedder({
  host = '127.0.0.1', port = 11434, model = DEFAULT_MODEL, cacheFile, batch = DEFAULT_BATCH,
  timeoutMs = DEFAULT_TIMEOUT_MS, fetch = globalThis.fetch, onCall,
} = {}) {
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) || {}; } catch { /* cold cache */ }
  const keyOf = (text) => crypto.createHash('sha1').update(`${model}\n${text}`).digest('hex');

  function save() {
    const keys = Object.keys(cache);
    // Oldest-inserted first: trim the front when over the cap.
    if (keys.length > MAX_CACHE_ENTRIES) {
      cache = Object.fromEntries(keys.slice(keys.length - MAX_CACHE_ENTRIES).map((k) => [k, cache[k]]));
    }
    try {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      fs.writeFileSync(`${cacheFile}.tmp`, JSON.stringify(cache));
      fs.renameSync(`${cacheFile}.tmp`, cacheFile);
    } catch { /* a cache that cannot be saved is only slower next time */ }
  }

  async function call(inputs) {
    const res = await fetch(`http://${host}:${port}/api/embed`, {
      method: 'POST',
      body: JSON.stringify({ model, input: inputs }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.json().catch(() => ({}));
    if (onCall) {
      try {
        onCall({
          provider: 'ollama', model, purpose: 'embed', ok: res.ok,
          input_tokens: Number(body.prompt_eval_count) || 0, output_tokens: 0,
          ms: body.total_duration ? Math.round(body.total_duration / 1e6) : null,
        });
      } catch { /* ledger must not break search */ }
    }
    if (!res.ok || !Array.isArray(body.embeddings)) throw new Error(`embedding failed (HTTP ${res.status})`);
    return body.embeddings;
  }

  async function embed(texts) {
    const keys = texts.map(keyOf);
    const missing = [...new Set(texts.filter((t, i) => !cache[keys[i]]))];
    for (let i = 0; i < missing.length; i += batch) {
      const chunk = missing.slice(i, i + batch);
      const vectors = await call(chunk);
      chunk.forEach((t, j) => { cache[keyOf(t)] = vectors[j]; });
    }
    if (missing.length) save();
    return keys.map((k) => cache[k]);
  }

  return {
    embedDocuments: (texts) => embed(texts.map((t) => `search_document: ${t}`)),
    embedQuery: async (text) => (await embed([`search_query: ${text}`]))[0],
  };
}

module.exports = { createEmbedder, cosine };
