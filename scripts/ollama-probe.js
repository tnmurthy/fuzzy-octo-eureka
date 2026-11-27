'use strict';
// scripts/ollama-probe.js - does the local model really answer?
// Ollama can hang with /api/tags still answering (the watchdog's check), so
// this sends one 5-token generation (evals/model-preflight.js), appends the
// result to logs/ollama-probe.jsonl and exits 0 (ok) or 1 (stuck / down).
// It never restarts, kills or starts anything.
//
//   node scripts/ollama-probe.js        OLLAMA_PROBE_MS (30000), OLLAMA_HOST/PORT

const fs = require('fs');
const path = require('path');
const { probeLocalModel, hermesModel } = require('../evals/model-preflight');

/**
 * @param {{ probe: (model: string) => Promise<{ok: boolean, ms: number, error?: string}>,
 *           model: string, logFile: string, now?: () => Date, log?: (s: string) => void }} o
 * @returns {Promise<number>} exit code
 */
async function runProbe({ probe, model, logFile, now = () => new Date(), log = console.log }) {
  const r = await probe(model);
  const entry = { at: now().toISOString(), ok: r.ok, ms: r.ms, model, error: r.error || null };
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.appendFileSync(logFile, JSON.stringify(entry) + '\n');
  log(r.ok ? `ollama ok in ${r.ms} ms` : `ollama STUCK: ${r.error}`);
  return r.ok ? 0 : 1;
}

if (require.main === module) {
  runProbe({
    probe: (model) =>
      probeLocalModel({
        model,
        host: process.env.OLLAMA_HOST || '127.0.0.1',
        port: Number(process.env.OLLAMA_PORT) || 11434,
        timeoutMs: Number(process.env.OLLAMA_PROBE_MS) || 30000,
      }),
    model: hermesModel(),
    logFile: path.join(__dirname, '..', 'logs', 'ollama-probe.jsonl'),
  }).then(
    (code) => process.exit(code),
    (err) => {
      console.error(`ollama STUCK: ${err.message}`);
      process.exit(1);
    }
  );
}

module.exports = { runProbe };
