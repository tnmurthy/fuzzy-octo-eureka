const fs = require('fs');
const path = require('path');
const { probeLocalModel, hermesModel } = require('../evals/model-preflight');

/**
 * Runs the Ollama probe, logs the result, and exits.
 * @param {Object} params
 * @param {Function} params.probe - The probe function
 * @param {string} params.model - The model name
 * @param {string} params.logFile - The file path to write the log
 * @param {Date} params.now - The current date/time
 */
async function runProbe({ probe, model, logFile, now }) {
  const result = await probe(model);
  const entry = {
    at: now.toISOString(),
    ok: result.ok,
    ms: result.ms,
    model: model,
    error: result.error
  };
  
  const logDir = path.dirname(logFile);
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
  fs.appendFileSync(logFile, JSON.stringify(entry) + '\n');

  if (result.ok) {
    console.log(`ollama ok in ${result.ms} ms`);
    process.exit(0);
  } else {
    console.error(`ollama STUCK: ${result.error}`);
    process.exit(1);
  }
}

if (require.main === module) {
  const model = hermesModel();
  const logFile = path.join(process.cwd(), 'logs', 'ollama-probe.jsonl');
  const now = new Date();

  runProbe({
    probe: probeLocalModel({
      model: model,
      host: process.env.OLLAMA_HOST || "127.0.0.1",
      port: Number(process.env.OLLAMA_PORT) || 11434,
      timeoutMs: Number(process.env.OLLAMA_PROBE_MS) || 30000
    }),
    model,
    logFile,
    now
  }).catch(err => {
    console.error(`ollama STUCK: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { runProbe };
