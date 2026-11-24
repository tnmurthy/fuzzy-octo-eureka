'use strict';
// request-kinds.js - what a request on the Ask page is (P3-P5, 2026-11-23).
//
//   answer    a question; the helper reads and replies. Read-only, free.
//   document  a plan, report, backlog... written as Markdown in the reply.
//             Read-only, free.
//   change    something should change. It first runs as a `plan`: a free,
//             read-only proposal. Only "Go ahead" (approvePlan) starts the
//             `change` run, which may edit files on its draft branch.
//
// Read-only kinds (answer, document, plan) run Hermes in read-only mode
// (AGENT_HERMES_MODE=readonly) and Claude at the `review` level, whatever the
// person or the teammate mode picked. Follow-ups keep their thread's kind.

const REQUEST_KINDS = ['answer', 'document', 'change'];
const RUN_KINDS = ['answer', 'document', 'plan', 'change'];
const READ_ONLY_KINDS = new Set(['answer', 'document', 'plan']);

const isReadOnlyKind = (kind) => READ_ONLY_KINDS.has(kind);

const DOC_WORDS = /\b(document|report|proposal|backlog|checklist|guide|brief|write-?up|plan|roadmap|summary|memo|outline|strategy|faq|minutes)\b/;
const CHANGE_WORDS = /\b(fix|add|change|update|remove|delete|rename|refactor|implement|replace|migrate|upgrade|install|build|create|make|split|move|speed up|improve|translate|resize|style)\b/;
// "Write a short document / report / plan ..." is a document whatever else it
// mentions ("...to increase traffic" read as a change once).
const ASKS_FOR_DOC = /^(please |can you |could you )?(write|draft|prepare|produce|give me|put together|create|make)\b.{0,60}?\b(document|doc|report|proposal|backlog|checklist|guide|brief|write-?up|plan|roadmap|summary|memo|outline|strategy|faq)\b/;
const QUESTION_START = /^(what|why|how|where|which|who|when|can|could|does|do|is|are|should|explain|tell me|describe|summari[sz]e|review|read|check|find|list|compare|show)\b/;

/** A quick guess from the words alone (no model). */
function keywordKind(text) {
  const t = String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!t) return 'answer';
  if (ASKS_FOR_DOC.test(t)) return 'document';
  if (DOC_WORDS.test(t)) return 'document';
  const firstWords = t.split(' ').slice(0, 3).join(' ');
  if (CHANGE_WORDS.test(firstWords)) return 'change';
  if (QUESTION_START.test(t) || t.endsWith('?')) return 'answer';
  if (CHANGE_WORDS.test(t)) return 'change';
  return 'answer';
}

/**
 * The kind a run gets.
 * @param {{ requested?: string, parentKind?: string|null, approvePlan?: boolean, followUp?: boolean }} o
 * @returns {string|null} null = no kind (older callers: behave as before)
 */
function resolveKind({ requested, parentKind = null, approvePlan = false, followUp = false }) {
  if (approvePlan) return 'change';
  if (followUp) return RUN_KINDS.includes(parentKind) ? parentKind : null;
  if (!REQUEST_KINDS.includes(requested)) return null;
  return requested === 'change' ? 'plan' : requested;
}

/** Guidance appended after the task (never before: the first 160 chars name the run). */
function kindBlock(kind) {
  switch (kind) {
    case 'answer':
      return '\n\n---\nHow to respond: answer in your reply, in plain language a non-technical reader understands. Read whatever you need, but do not change any files.';
    case 'document':
      return '\n\n---\nHow to respond: write the requested document in your reply as complete, well-structured Markdown (a title, headings, short paragraphs, lists or tables where they help). Plain language for a non-technical reader. Do not change any files: the reply is the document.';
    case 'plan':
      return '\n\n---\nHow to respond: do not change any files yet. Look at what is needed, then reply with a short plan in plain language:\n1. What you will do, as numbered steps.\n2. What it affects (pages, files, people).\n3. Anything you need to know first.\nThe person approves the plan before any change is made.';
    case 'change':
      return '\n\n---\nThe person approved the plan above. Carry it out now on this branch. Keep the change as small as the plan says, and commit your work. Do not push, open a pull request or deploy: the person sends the draft for review from the page. Do not give them terminal commands to run. Finish with a plain-language summary of what changed and how to check it once it is live.';
    default:
      return '';
  }
}

/**
 * Picks a kind with a local model, falling back to keywordKind.
 * @param {{ ask?: ((text: string) => Promise<string|null>) | null }} o
 */
function createKindClassifier({ ask = null } = {}) {
  const cache = new Map();
  return async function classify(text) {
    const q = String(text || '').trim().slice(0, 600);
    const guess = keywordKind(q);
    if (!q || !ask) return { kind: guess, source: 'keywords' };
    if (ASKS_FOR_DOC.test(q.toLowerCase().replace(/\s+/g, ' '))) return { kind: 'document', source: 'keywords' };
    if (cache.has(q)) return cache.get(q);
    let out = { kind: guess, source: 'keywords' };
    try {
      const k = await ask(q);
      if (REQUEST_KINDS.includes(k)) out = { kind: k, source: 'model' };
    } catch (_) { /* model down or slow: keywords */ }
    if (cache.size > 200) cache.delete(cache.keys().next().value);
    cache.set(q, out);
    return out;
  };
}

/** Ollama asker; calls are logged (provider ollama: exempt from paid caps). */
function ollamaKindAsker({ host = '127.0.0.1', port = 11434, model = 'gemma3:4b', timeoutMs = 3000, record = () => {} }) {
  return async (text) => {
    const started = Date.now();
    let ok = false;
    try {
      const res = await fetch(`http://${host}:${port}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model, stream: false, format: 'json', options: { temperature: 0 },
          prompt: 'Classify this request to an assistant that works on a software project.\n'
            + '"answer": a question to explain, check or find something.\n'
            + '"document": write a plan, report, backlog, guide or other document.\n'
            + '"change": change the project itself (code, text, layout, settings).\n'
            + `Request: ${JSON.stringify(text)}\nAnswer as JSON {"kind": "answer" | "document" | "change"}.`,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = await res.json();
      ok = res.ok;
      return String((JSON.parse(body.response || '{}').kind) || '').toLowerCase() || null;
    } finally {
      try { record({ provider: 'ollama', model, purpose: 'classify', ok, latency_ms: Date.now() - started }); } catch (_) { /* best effort */ }
    }
  };
}

module.exports = {
  REQUEST_KINDS, RUN_KINDS, isReadOnlyKind, keywordKind, resolveKind, kindBlock,
  createKindClassifier, ollamaKindAsker,
};
