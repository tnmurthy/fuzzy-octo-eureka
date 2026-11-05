// ai-ledger.js - one JSONL line per AI model call, local or cloud, on this
// machine. It is the record of what the team's AI actually costs (tokens,
// time, which purpose) and the outbox ai-sync.js copies to Supabase. Writing
// it must never break the call it records.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * @param {string} file
 * @param {{ provider: string, model: string, purpose: string, ok?: boolean,
 *           input_tokens?: number, output_tokens?: number, ms?: number|null }} entry
 */
function recordAiCall(file, entry, log = console.error) {
  try {
    const line = { id: crypto.randomUUID(), at: new Date().toISOString(), ok: true, ...entry };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(line) + '\n');
  } catch (err) {
    log(`ai ledger write failed: ${err.message}`);
  }
}

function readCalls(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const calls = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const c = JSON.parse(line);
      if (c && typeof c.id === 'string') calls.push(c);
    } catch { /* torn line from a crash */ }
  }
  return calls;
}

// Token counts and wall time from an Ollama /api/chat or /api/generate reply.
function ollamaUsage(body) {
  const b = body || {};
  return {
    input_tokens: Number(b.prompt_eval_count) || 0,
    output_tokens: Number(b.eval_count) || 0,
    ms: b.total_duration ? Math.round(b.total_duration / 1e6) : null,
  };
}

module.exports = { recordAiCall, readCalls, ollamaUsage };
