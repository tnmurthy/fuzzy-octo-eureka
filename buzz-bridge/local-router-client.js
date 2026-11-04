// local-router-client.js - routes operator messages with a local Ollama
// model instead of the paid TypeSafe API.
//
// Same systemOne(request) contract as typesafe-client.js (returns
// { answers: { <questionKey>: { choice, confidence } | { noul } } }), so
// handler.js and router.js work unchanged regardless of which client
// bridge.js wires up. No ledger, no daily cap, no API key: everything stays
// on 127.0.0.1 and costs nothing.
//
// A small local model (e.g. gemma3:4b) reliably picks the right answer for
// each question but does not reliably follow a nested-object output format
// across six questions at once - it tends to just emit the plain string or
// boolean. normalizeAnswers() accepts either shape and fills in a sane
// default confidence/noul for the plain form, rather than treating that as
// a parse failure.

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 11434;
const DEFAULT_MODEL = 'gemma3:4b';
const DEFAULT_TIMEOUT_MS = 60000;

// A model that commits to one option without hedging is usually right; this
// clears every router.js threshold (0.3-0.6) without claiming false
// certainty. Likewise a bare true/false for a "noul" question becomes a
// confident-but-not-absolute 0.85/0.15, not 1/0.
const DEFAULT_CHOICE_CONFIDENCE = 0.75;
const DEFAULT_TRUE_NOUL = 0.85;
const DEFAULT_FALSE_NOUL = 0.15;

function buildPrompt(request) {
  const { state, questions } = request;
  const qLines = Object.entries(questions)
    .map(([key, q]) => {
      const criteria = Object.entries(q.criteria)
        .map(([choice, desc]) => `    - "${choice}": ${desc}`)
        .join('\n');
      return `"${key}" (${q.type}): ${q.instructions}\n${criteria}`;
    })
    .join('\n\n');

  return `You are a routing classifier for an operator's message to an AI team. Answer every question below about the message, using only the given state as context.

State:
${JSON.stringify(state, null, 2)}

Questions:
${qLines}

Respond with ONLY a single JSON object, no prose, no markdown fences. The object's top-level keys must be exactly: ${Object.keys(questions).join(', ')}. For a "choice" question, the value is one of its listed option keys, written as a plain string (e.g. "status"). For a "noul" question, the value is the plain boolean true or false.`;
}

function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) throw new Error('no JSON object in model output');
  return JSON.parse(text.slice(start, end + 1));
}

function clamp01(n) {
  return Math.max(0, Math.min(1, n));
}

// Accepts either the requested {choice, confidence} object or a bare string
// (what a small model tends to emit instead).
function coerceChoice(value) {
  if (value && typeof value === 'object' && 'choice' in value) {
    const confidence = Number(value.confidence);
    return {
      choice: String(value.choice),
      confidence: Number.isFinite(confidence) ? clamp01(confidence) : DEFAULT_CHOICE_CONFIDENCE,
    };
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return { choice: String(value), confidence: DEFAULT_CHOICE_CONFIDENCE };
  }
  return null;
}

// Accepts {noul: 0-1}, a bare boolean, a "true"/"false" string, or a bare
// number - whatever shape the model actually produced.
function coerceNoul(value) {
  if (value && typeof value === 'object' && 'noul' in value) {
    const n = Number(value.noul);
    return Number.isFinite(n) ? clamp01(n) : null;
  }
  if (typeof value === 'boolean') return value ? DEFAULT_TRUE_NOUL : DEFAULT_FALSE_NOUL;
  if (typeof value === 'number') return clamp01(value);
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === 'true') return DEFAULT_TRUE_NOUL;
    if (v === 'false') return DEFAULT_FALSE_NOUL;
    const n = Number(v);
    if (Number.isFinite(n)) return clamp01(n);
  }
  return null;
}

function normalizeAnswers(raw, questions) {
  const answers = {};
  for (const [key, q] of Object.entries(questions)) {
    const a = raw[key];
    if (a === undefined || a === null) throw new Error(`model did not answer "${key}"`);
    if (q.type === 'noul') {
      const noul = coerceNoul(a);
      if (noul === null) throw new Error(`"${key}" missing a usable noul value`);
      answers[key] = { noul };
    } else {
      const coerced = coerceChoice(a);
      if (!coerced) throw new Error(`"${key}" missing a usable choice value`);
      if (!(coerced.choice in q.criteria)) throw new Error(`"${key}" chose an unlisted option: ${coerced.choice}`);
      answers[key] = coerced;
    }
  }
  return answers;
}

/**
 * @param {{ host?: string, port?: number, model?: string, timeoutMs?: number,
 *           fetch?: typeof fetch }} opts
 */
function createLocalRouterClient(opts = {}) {
  const host = opts.host || DEFAULT_HOST;
  const port = opts.port || DEFAULT_PORT;
  const model = opts.model || DEFAULT_MODEL;
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const fetchFn = opts.fetch || fetch;

  async function systemOne(request) {
    const prompt = buildPrompt(request);
    let res;
    try {
      res = await fetchFn(`http://${host}:${port}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: 'You output only valid JSON. No explanations, no markdown fences.' },
            { role: 'user', content: prompt },
          ],
          stream: false,
          options: { temperature: 0.1 },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new Error(`local router request failed: ${err.message}`);
    }
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300);
      throw new Error(`local router HTTP ${res.status}: ${detail}`);
    }
    const body = await res.json();
    const content = body.message && body.message.content;
    if (!content) throw new Error('local router returned no content');
    const raw = extractJson(content);
    const answers = normalizeAnswers(raw, request.questions);
    return { answers, model };
  }

  return { systemOne };
}

module.exports = { createLocalRouterClient, buildPrompt, extractJson, normalizeAnswers };
