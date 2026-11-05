// supabase-rest.js - the few PostgREST calls the team store needs, as the
// signed-in teammate (their token, so row level security applies).

const REQUEST_TIMEOUT_MS = 15000;

function withQuery(table, query) {
  const qs = Object.entries(query).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  return qs ? `${table}?${qs}` : table;
}

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
      const res = await request(table, withQuery(table, query), { method: 'GET' });
      return res.json();
    },
    async insert(table, rows) {
      const res = await request(table, table, {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(rows),
      });
      return res.json();
    },
    // filter: PostgREST operators, e.g. { id: 'eq.<uuid>' }. Returns the rows
    // changed - empty when RLS hid the row or nothing matched.
    async update(table, filter, patch) {
      const res = await request(table, withQuery(table, filter), {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(patch),
      });
      return res.json();
    },
  };
}

module.exports = { createRest };
