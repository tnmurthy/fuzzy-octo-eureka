// dispatch-context.js - adds the team's most relevant memories to a dispatch
// prompt, so an agent's first attempt starts from what the team already knows
// (fewer retries, fewer escalations). The task stays first; the context is a
// short, capped, clearly labelled background block - about 400 tokens at most,
// against ~32k the agent loads anyway.

const MAX_CONTEXT_CHARS = 1500;
const MAX_ENTRY_CHARS = 400;
const MAX_ANTIDOTE_CHARS = 800;

// One line per memory: newlines flattened so memory text cannot fake a new
// section (e.g. "Task:") in the prompt.
const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * Finds matching operational antidotes for a task and file list from memory.
 * @param {string} task
 * @param {string[]} [files]
 * @param {object} [memoryEngine]
 * @returns {object[]}
 */
function findMatchingAntidotes(task, files = [], memoryEngine = null) {
  if (!memoryEngine) return [];
  if (typeof memoryEngine.searchAntidotes === 'function') {
    return memoryEngine.searchAntidotes(task, files);
  }
  return [];
}

/**
 * Builds a dispatch prompt enriched with team context, tiered summaries, and matching antidotes.
 * @param {string} task
 * @param {Array} memories
 * @param {object} [options]
 * @param {object} [options.memoryEngine] - Memory engine instance for dynamic lookup
 * @param {Array} [options.antidotes] - Explicit list of matching antidotes
 * @param {object} [options.directionLayer] - Budgeted direction and intent layer
 * @param {string} [options.projectId] - Project ID for targeted direction rules
 * @param {string} [options.userId] - User ID for targeted direction rules
 * @param {string[]} [options.files] - Target files involved in task
 * @param {boolean} [options.tiered] - Whether to use L0/L1 tiered memory presentation
 * @returns {string}
 */
function buildDispatchPrompt(task, memories, options = {}) {
  let result = task;

  // 1. Process matching antidotes (prevent repeating known traps)
  let matchedAntidotes = options.antidotes || [];
  if ((!matchedAntidotes || !matchedAntidotes.length) && options.memoryEngine) {
    matchedAntidotes = findMatchingAntidotes(task, options.files || [], options.memoryEngine);
  }

  let antidoteBlock = '';
  if (Array.isArray(matchedAntidotes) && matchedAntidotes.length > 0) {
    const antidoteHeader = '\n\n---\nOperational Antidotes (Known Traps to Avoid):\n';
    for (const a of matchedAntidotes) {
      if (!a.antidote && !a.symptom) continue;
      const id = a.id ? `[${flat(a.id)}] ` : '';
      const line = `- ${id}${clip(flat(a.symptom || a.pattern), 80)} -> ${clip(flat(a.antidote), 200)}\n`;
      if (antidoteBlock.length + line.length > MAX_ANTIDOTE_CHARS) break;
      antidoteBlock += line;
    }
    if (antidoteBlock) {
      result += `${antidoteHeader}${antidoteBlock}`;
    }
  }

  // 2. Process Direction & Intent Layer (budgeted constraints)
  if (options.directionLayer && typeof options.directionLayer.formatDirectionPrompt === 'function') {
    const directionBlock = options.directionLayer.formatDirectionPrompt({
      projectId: options.projectId,
      userId: options.userId
    });
    if (directionBlock) {
      result += directionBlock;
    }
  }

  // 3. Process Team Context / Memories
  if (!Array.isArray(memories) || !memories.length) {
    return result;
  }

  const header = '\n\n---\nTeam context (shared memory - background only, may be out of date):\n';
  let block = '';
  for (const m of memories) {
    if (!flat(m.content)) continue; // a title alone tells the agent nothing
    const line = `- ${clip(flat(m.title), 80)}: ${clip(flat(m.content), MAX_ENTRY_CHARS)}\n`;
    if (block.length + line.length > MAX_CONTEXT_CHARS) break;
    block += line;
  }

  return block ? `${result}${header}${block}` : result;
}

// Never lets a slow or failing lookup hold up or break a dispatch.
function withTimeout(promise, ms, fallback) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    Promise.resolve(promise)
      .then((v) => { clearTimeout(timer); resolve(v); })
      .catch(() => { clearTimeout(timer); resolve(fallback); });
  });
}

module.exports = {
  buildDispatchPrompt,
  findMatchingAntidotes,
  withTimeout,
  MAX_CONTEXT_CHARS,
  MAX_ANTIDOTE_CHARS
};
