// router-fallback.js - tries several router clients in order, first one
// that answers in time wins.
//
// Why not just one bigger timeout: a multi-question routing prompt on
// gemma3:4b is usually done in 10-30s but occasionally runs long (cold
// model, loaded host). Rather than block the operator for a long single
// timeout, give the primary model a shorter budget and fall back to a
// smaller/faster model (qwen2.5-coder:3b) that answers the same questions
// adequately for routing, even if its judgment is a bit cruder. If every
// local model fails, systemOne still throws - handler.js's own catch then
// falls back to the PO persona chat as the final safety net.

function createFallbackRouterClient(stages) {
  if (!stages.length) throw new Error('createFallbackRouterClient needs at least one stage');

  async function systemOne(request) {
    const errors = [];
    for (const stage of stages) {
      try {
        const res = await stage.client.systemOne(request);
        if (errors.length) res.fallbackFrom = errors.map(e => e.label);
        return res;
      } catch (err) {
        errors.push({ label: stage.label, message: err.message });
      }
    }
    throw new Error(`all routers failed: ${errors.map(e => `${e.label}: ${e.message}`).join(' | ')}`);
  }

  return { systemOne };
}

module.exports = { createFallbackRouterClient };
