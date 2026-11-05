// digest.js - the weekly AI digest the bridge posts to Buzz: runs, how often
// local-first was enough, spend, and what to change. Built from /api/costs and
// /api/runs data; pure functions so the wording and the schedule are tested.

const IST_OFFSET_MIN = 330;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

function countBy(items, key) {
  const m = new Map();
  for (const it of items) m.set(it[key] || 'unknown', (m.get(it[key] || 'unknown') || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

function buildDigest({ costs, runs }) {
  const scope = costs.source === 'team' ? 'whole team' : 'this machine';
  const lines = [`Weekly AI digest - ${scope}, last ${costs.days} days`];

  if (runs.length) {
    const byStatus = countBy(runs, 'status').map(([s, n]) => `${n} ${s}`).join(', ');
    const byAgent = countBy(runs, 'agent').map(([a, n]) => `${a} ${n}`).join(', ');
    lines.push(`- ${runs.length} agent runs: ${byStatus} (${byAgent})`);
  } else {
    lines.push('- No agent runs.');
  }

  const a = costs.auto;
  lines.push(a.autoRuns
    ? `- Local-first: ${a.stayedLocal} of ${a.autoRuns} auto runs stayed local (${Math.round((a.localShare || 0) * 100)}%)`
    : '- Local-first: no auto runs.');

  const t = costs.summary.totals;
  lines.push(`- AI calls: ${t.paidCalls} paid calls, ${t.localCalls} local (free); $${t.costUsd.toFixed(2)} spent`);
  const top = costs.summary.byPurpose.filter((g) => g.costUsd > 0).slice(0, 3);
  if (top.length) lines.push(`- Top cost: ${top.map((g) => `${g.purpose} $${g.costUsd.toFixed(2)}`).join(', ')}`);

  lines.push('What to change:');
  for (const tip of costs.advice) lines.push(`- ${tip}`);
  return lines.join('\n');
}

// Due once a week from `weekday` (0 = Sunday, 1 = Monday) `hour`:00 local
// time (IST by default). A missed slot (machine off) posts at the next check.
function isDigestDue(nowMs, lastPostedIso, { weekday = 1, hour = 9, offsetMin = IST_OFFSET_MIN } = {}) {
  const local = new Date(nowMs + offsetMin * 60000);
  const daysSince = (local.getUTCDay() - weekday + 7) % 7;
  const slotLocal = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - daysSince, hour);
  let slot = slotLocal - offsetMin * 60000;
  if (slot > nowMs) slot -= WEEK_MS; // today is the weekday but before the hour
  const last = lastPostedIso ? Date.parse(lastPostedIso) : NaN;
  // Never posted (fresh install): wait for the slot itself rather than
  // posting at a random hour; after that, a missed slot catches up.
  if (!Number.isFinite(last)) return nowMs - slot < DAY_MS;
  return last < slot;
}

module.exports = { buildDigest, isDigestDue };
