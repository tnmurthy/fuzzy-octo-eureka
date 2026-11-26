'use strict';
// model-preflight.js - is the local model actually answering?
// Ollama can wedge with /api/tags still answering (2026-11-26: gemma4:12b
// stuck "Stopping...", a 5-token request hung 60 s+), so a hermes eval would
// record environment stalls as agent failures. One tiny generation decides.

const fs = require('fs');
const path = require('path');

const CONFIG = path.join(__dirname, '..', 'orchestration', 'hermes-agent-config.yaml');

/** The model dispatched hermes runs use: HERMES_MODEL, else the config's default. */
function hermesModel(env = process.env, configFile = CONFIG) {
  if (env.HERMES_MODEL) return env.HERMES_MODEL;
  try {
    const m = fs.readFileSync(configFile, 'utf8').match(/^\s+default:\s*(\S+)/m);
    return m ? m[1] : null;
  } catch (_) {
    return null;
  }
}

/**
 * @returns {Promise<{ ok: boolean, ms: number, error?: string }>}
 */
async function probeLocalModel({ model, host = '127.0.0.1', port = 11434, timeoutMs = 30000, fetch = globalThis.fetch } = {}) {
  const t0 = Date.now();
  if (!model) return { ok: false, ms: 0, error: 'no local model configured' };
  try {
    const res = await fetch(`http://${host}:${port}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt: 'Reply with: ok', stream: false, options: { num_predict: 5 } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, ms: Date.now() - t0, error: `Ollama answered ${res.status}` };
    await res.json();
    return { ok: true, ms: Date.now() - t0 };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      ok: false,
      ms: Date.now() - t0,
      error: timedOut
        ? `${model} did not answer a 5-token request in ${Math.round(timeoutMs / 1000)} s (Ollama is up but the model is stuck: restart Ollama)`
        : `cannot reach Ollama: ${err.message}`,
    };
  }
}

module.exports = { probeLocalModel, hermesModel };
