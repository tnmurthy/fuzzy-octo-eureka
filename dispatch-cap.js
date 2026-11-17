// dispatch-cap.js - a hard daily cap on paid agent runs, checked in
// server.js's spawnAgentDispatch before any run starts (API, dashboard chat,
// Mantis sweep), so nothing spends past it.
//
// Paid = an agent that calls a cloud model: claude, codex, agy, mantis (runs
// on agy when its local runner is missing) and auto (it can escalate to
// claude). hermes and noop are local and free. Each claude PR costs two runs
// (the work and its review), and both count.
//
// Counted from the run log (runs.jsonl start lines since local midnight) plus
// runs this server started that have not written their start line yet, so
// two dispatches a second apart cannot both slip under the cap.
//
// DISPATCH_DAILY_PAID_RUNS sets the cap (default 20); 0 turns paid runs off.

const PAID_AGENTS = new Set(['claude', 'codex', 'auto', 'agy', 'mantis']);
const DEFAULT_CAP = 20;

function localMidnight(now) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function parseCap(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_CAP;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_CAP;
}

/**
 * @param {object} opts
 * @param {string} opts.agent
 * @param {Array<{id: string, agent?: string, started_at?: string}>} opts.runs  folded run log
 * @param {Array<{id: string, agent: string, at: number}>} [opts.pending]     started here, maybe not logged yet
 * @param {number} opts.cap
 * @param {number} [opts.now]
 * @returns {{ ok: boolean, paid: boolean, used: number, cap: number, error?: string }}
 */
function checkDispatchCap({ agent, runs, pending = [], cap, now = Date.now() }) {
  if (!PAID_AGENTS.has(agent)) return { ok: true, paid: false, used: 0, cap };
  const since = localMidnight(now);
  const ids = new Set();
  for (const r of runs || []) {
    if (PAID_AGENTS.has(r.agent) && Date.parse(r.started_at) >= since) ids.add(r.id);
  }
  for (const p of pending) {
    if (PAID_AGENTS.has(p.agent) && p.at >= since) ids.add(p.id);
  }
  const used = ids.size;
  if (used >= cap) {
    return {
      ok: false, paid: true, used, cap,
      error: cap === 0
        ? 'Paid agent runs are off (DISPATCH_DAILY_PAID_RUNS=0). Use agent hermes, or raise the cap.'
        : `Daily cap reached: ${used} of ${cap} paid agent runs today (DISPATCH_DAILY_PAID_RUNS). Resets at midnight; use agent hermes meanwhile.`,
    };
  }
  return { ok: true, paid: true, used, cap };
}

module.exports = { checkDispatchCap, parseCap, PAID_AGENTS, DEFAULT_CAP };
