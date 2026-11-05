// ai-sync.js - copies this machine's AI call ledger into arunachala_ai_calls.
// The ledger is append-only, so the sync state is just how many lines have
// been sent. Rows carry the ledger line's id as client_id, so a resend after
// a crash is ignored, not duplicated.

const TABLE = 'arunachala_ai_calls';
const BATCH = 500;
const isCapError = (err) => /ai_cap_(member|team)/.test(err.message);

function toCallRow(c, teamId) {
  const n = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.round(Number(v)) : 0);
  return {
    client_id: c.id,
    team_id: teamId,
    provider: String(c.provider || 'unknown'),
    model: String(c.model || 'unknown'),
    purpose: String(c.purpose || 'unknown'),
    ok: c.ok !== false,
    input_tokens: n(c.input_tokens),
    output_tokens: n(c.output_tokens),
    ms: c.ms == null ? null : n(c.ms),
    cost_usd: Number.isFinite(Number(c.cost_usd)) && Number(c.cost_usd) >= 0 ? Number(c.cost_usd) : 0,
    created_at: c.at,
  };
}

async function syncCalls({ calls, state, rest, teamId, log = console.error }) {
  const from = state.sent || 0;
  const batch = calls.slice(from, from + BATCH);
  if (!batch.length) return state;
  const rows = batch.map((c) => toCallRow(c, teamId));
  try {
    await rest.insertIgnoringDuplicates(TABLE, rows, 'client_id');
  } catch (err) {
    if (!isCapError(err)) throw err; // offline etc.: same rows next time
    // A cloud call past the database cap rejects the whole batch. Record
    // every row that fits; log the refused ones rather than jam the outbox.
    for (const row of rows) {
      try {
        await rest.insertIgnoringDuplicates(TABLE, [row], 'client_id');
      } catch (rowErr) {
        if (!isCapError(rowErr)) throw rowErr;
        log(`ai-sync: call ${row.client_id} not recorded in Supabase: ${rowErr.message}`);
      }
    }
  }
  return { ...state, sent: from + batch.length };
}

module.exports = { toCallRow, syncCalls };
