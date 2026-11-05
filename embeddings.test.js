// node --test embeddings.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createEmbedder, cosine } = require('./embeddings');
const { semanticSearch } = require('./memory-search');
const DrisyonMemoryEngine = require('./memory-engine');

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'emb-')), 'cache.json');

// Embeds each text as a 3-d vector by keyword, so tests can reason about scores.
function fakeOllama() {
  const calls = [];
  const vec = (t) => [/supabase|share|team/i.test(t) ? 1 : 0, /pizza|lunch/i.test(t) ? 1 : 0, 0.1];
  const fn = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    return { ok: true, status: 200, json: async () => ({ embeddings: body.input.map(vec), prompt_eval_count: body.input.length * 10, total_duration: 5e6 }) };
  };
  fn.calls = calls;
  return fn;
}

test('embeds with the nomic task prefixes and caches by text', async () => {
  const fetch = fakeOllama();
  const e = createEmbedder({ fetch, cacheFile: tmp() });
  await e.embedDocuments(['a supabase note', 'pizza']);
  await e.embedDocuments(['a supabase note']);
  assert.equal(fetch.calls.length, 1);
  assert.deepEqual(fetch.calls[0].body.input, ['search_document: a supabase note', 'search_document: pizza']);
  assert.equal(fetch.calls[0].body.model, 'nomic-embed-text');
  await e.embedQuery('team?');
  assert.deepEqual(fetch.calls[1].body.input, ['search_query: team?']);
});

test('the cache survives a restart', async () => {
  const cacheFile = tmp();
  await createEmbedder({ fetch: fakeOllama(), cacheFile }).embedDocuments(['x']);
  const fetch = fakeOllama();
  await createEmbedder({ fetch, cacheFile }).embedDocuments(['x']);
  assert.equal(fetch.calls.length, 0);
});

test('sends uncached texts in batches and reports each call', async () => {
  const fetch = fakeOllama();
  const seen = [];
  const e = createEmbedder({ fetch, cacheFile: tmp(), batch: 2, onCall: (c) => seen.push(c) });
  await e.embedDocuments(['a', 'b', 'c']);
  assert.deepEqual(fetch.calls.map((c) => c.body.input.length), [2, 1]);
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[0], { provider: 'ollama', model: 'nomic-embed-text', purpose: 'embed', ok: true, input_tokens: 20, output_tokens: 0, ms: 5 });
});

test('cosine of equal and orthogonal vectors', () => {
  assert.equal(cosine([1, 0], [1, 0]), 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.equal(cosine([0, 0], [1, 0]), 0);
});

const engine = new DrisyonMemoryEngine({ storagePath: tmp() });
const entries = [
  { id: 'a', tenantId: 'tenant:drisyon_core', projectId: 'global', category: 'context', title: 'Team sync', content: 'memory shared through supabase', tags: [] },
  { id: 'b', tenantId: 'tenant:drisyon_core', projectId: 'global', category: 'context', title: 'Lunch', content: 'pizza on friday', tags: [] },
  { id: 'c', tenantId: 'tenant:other', projectId: 'global', category: 'context', title: 'Other tenant', content: 'team supabase plans', tags: [] },
];

test('ranks by meaning and keeps the tenant rules', async () => {
  const embedder = createEmbedder({ fetch: fakeOllama(), cacheFile: tmp() });
  const out = await semanticSearch({ engine, embedder, entries, query: 'how does the team share context', options: { tenantId: 'tenant:other' } });
  assert.equal(out.ranker, 'embeddings');
  assert.deepEqual(out.results.map((r) => r.id), ['c']); // non-core tenant sees only its own
  const core = await semanticSearch({ engine, embedder, entries, query: 'how does the team share context', options: {} });
  assert.deepEqual(core.results.map((r) => r.id).sort(), ['a', 'c']);
  assert.ok(core.results[0].score > 0.5);
});

test('falls back to keyword scoring when Ollama is down', async () => {
  const embedder = { embedQuery: async () => { throw new Error('ECONNREFUSED'); }, embedDocuments: async () => [] };
  const out = await semanticSearch({ engine, embedder, entries, query: 'pizza friday', options: {} });
  assert.equal(out.ranker, 'keywords');
  assert.equal(out.results[0].id, 'b');
  assert.match(out.note, /ECONNREFUSED/);
});
