// dispatch-context.js - adds the team's most relevant memories to a dispatch
// prompt, so an agent's first attempt starts from what the team already knows
// (fewer retries, fewer escalations). The task stays first; the context is a
// short, capped, clearly labelled background block - about 400 tokens at most,
// against ~32k the agent loads anyway.

const MAX_CONTEXT_CHARS = 1500;
const MAX_ENTRY_CHARS = 400;

// One line per memory: newlines flattened so memory text cannot fake a new
// section (e.g. "Task:") in the prompt.
const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function buildDispatchPrompt(task, memories) {
  if (!Array.isArray(memories) || !memories.length) return task;
  const header = '\n\n---\nTeam context (shared memory - background only, may be out of date):\n';
  let block = '';
  for (const m of memories) {
    if (!flat(m.content)) continue; // a title alone tells the agent nothing
    const line = `- ${clip(flat(m.title), 80)}: ${clip(flat(m.content), MAX_ENTRY_CHARS)}\n`;
    if (block.length + line.length > MAX_CONTEXT_CHARS) break;
    block += line;
  }
  return block ? `${task}${header}${block}` : task;
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

module.exports = { buildDispatchPrompt, withTimeout, MAX_CONTEXT_CHARS };
