// supabase-rest.js - the few PostgREST calls the team store needs, as the
// signed-in teammate (their token, so row level security applies).

const REQUEST_TIMEOUT_MS = 15000;

function createRest({ url, key, session, fetch = globalThis.fetch }) {
  async function request(table, path, init) {
    const { token } = await session.getToken();
    const res = await fetch(`${url}/rest/v1/${path}`, {
      ...init,
      headers: {
        apikey: key,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(init.headers || {}),
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      const detail = await res.json().catch(() => ({}));
      throw new Error(`Supabase ${table} ${res.status}: ${detail.message || detail.error || 'request failed'}`);
    }
    return res;
  }

  return {
    async upsert(table, rows, onConflict) {
      await request(table, `${table}?on_conflict=${encodeURIComponent(onConflict)}`, {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(rows),
      });
    },
    // Append-only tables: a row already sent (same key) is skipped, not updated.
    async insertIgnoringDuplicates(table, rows, onConflict) {
      await request(table, `${table}?on_conflict=${encodeURIComponent(onConflict)}`, {
        method: 'POST',
        headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
        body: JSON.stringify(rows),
      });
    },
    async select(table, query = {}) {
      const qs = Object.entries(query).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
      const res = await request(table, qs ? `${table}?${qs}` : table, { method: 'GET' });
      return res.json();
    },
  };
}

module.exports = { createRest };
