// costs.js - what the AI is costing, from the AI call ledger (local
// logs/ai-calls.jsonl or the team's arunachala_ai_calls), plus plain advice
// on cutting it. Pure functions: server.js does the reading.

const DAY_MS = 24 * 60 * 60 * 1000;
// Advice thresholds.
const PAID_SHARE_HIGH = 0.3;
const MIN_AUTO_RUNS = 5;
const LOCAL_SHARE_LOW = 0.3;
const CAP_WARN_SHARE = 0.8;
const DISPATCH_COST_HIGH_USD = 0.5;

const round4 = (n) => Math.round(n * 10000) / 10000;
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const isPaid = (c) => c.provider !== 'ollama';

function fromTeamRow(r) {
  return {
    at: r.created_at, provider: r.provider, model: r.model, purpose: r.purpose, ok: r.ok,
    input_tokens: r.input_tokens, output_tokens: r.output_tokens, cost_usd: num(r.cost_usd), owner: r.owner,
  };
}

function group(calls, key) {
  const map = new Map();
  for (const c of calls) {
    const k = c[key] || 'unknown';
    const g = map.get(k) || { [key]: k, calls: 0, tokens: 0, costUsd: 0 };
    g.calls += 1;
    g.tokens += num(c.input_tokens) + num(c.output_tokens);
    g.costUsd += num(c.cost_usd);
    map.set(k, g);
  }
  return [...map.values()]
    .map((g) => ({ ...g, costUsd: round4(g.costUsd) }))
    .sort((a, b) => b.costUsd - a.costUsd || b.tokens - a.tokens);
}

function summarizeCalls(calls, { now = Date.now(), days = 7 } = {}) {
  const from = now - days * DAY_MS;
  const inWindow = calls.filter((c) => {
    const t = Date.parse(c.at);
    return Number.isFinite(t) && t >= from && t <= now;
  });
  const byDay = new Map();
  for (const c of inWindow) {
    const day = new Date(Date.parse(c.at)).toISOString().slice(0, 10);
    const d = byDay.get(day) || { day, calls: 0, costUsd: 0 };
    d.calls += 1;
    d.costUsd += num(c.cost_usd);
    byDay.set(day, d);
  }
  const paid = inWindow.filter(isPaid);
  return {
    from: new Date(from).toISOString(),
    to: new Date(now).toISOString(),
    totals: {
      calls: inWindow.length,
      paidCalls: paid.length,
      localCalls: inWindow.length - paid.length,
      inputTokens: inWindow.reduce((s, c) => s + num(c.input_tokens), 0),
      outputTokens: inWindow.reduce((s, c) => s + num(c.output_tokens), 0),
      costUsd: round4(inWindow.reduce((s, c) => s + num(c.cost_usd), 0)),
    },
    byProvider: group(inWindow, 'provider'),
    byPurpose: group(inWindow, 'purpose'),
    byModel: group(inWindow, 'model'),
    byDay: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)).map((d) => ({ ...d, costUsd: round4(d.costUsd) })),
  };
}

// Paid calls since UTC midnight, for the cap warning.
function paidCallsSince(calls, sinceMs) {
  return calls.filter((c) => isPaid(c) && Date.parse(c.at) >= sinceMs).length;
}

function autoStats(runs) {
  const auto = runs.filter((r) => r.agent === 'auto');
  const stayedLocal = auto.filter((r) => r.escalated === false).length;
  return {
    autoRuns: auto.length,
    stayedLocal,
    escalated: auto.filter((r) => r.escalated === true).length,
    localShare: auto.length ? Math.round((stayedLocal / auto.length) * 100) / 100 : null,
  };
}

function advice({ summary, auto, limits, paidCallsToday, localFirstEnabled }) {
  const out = [];
  const { calls, paidCalls } = summary.totals;
  if (calls && paidCalls / calls > PAID_SHARE_HIGH && !localFirstEnabled) {
    out.push(`${Math.round((paidCalls / calls) * 100)}% of calls are paid - set DISPATCH_LOCAL_FIRST=true so the local model tries tasks first.`);
  }
  if (auto.autoRuns >= MIN_AUTO_RUNS && auto.localShare !== null && auto.localShare < LOCAL_SHARE_LOW) {
    out.push('Local model rarely passes the tests - add .arunachala-test to repos with fast, green test suites, or keep claude for these tasks.');
  }
  if (limits && limits.member_daily_calls && paidCallsToday >= CAP_WARN_SHARE * limits.member_daily_calls) {
    out.push(`Daily cap is close: ${paidCallsToday} of ${limits.member_daily_calls} paid calls used today.`);
  }
  const dispatch = summary.byPurpose.find((g) => g.purpose === 'dispatch');
  if (dispatch && dispatch.calls && dispatch.costUsd / dispatch.calls > DISPATCH_COST_HIGH_USD) {
    out.push(`Dispatches average $${(dispatch.costUsd / dispatch.calls).toFixed(2)} each - name the files in the task and try a smaller CLAUDE_MODEL.`);
  }
  return out.length ? out : ['No action needed.'];
}

module.exports = { summarizeCalls, paidCallsSince, autoStats, advice, fromTeamRow };
