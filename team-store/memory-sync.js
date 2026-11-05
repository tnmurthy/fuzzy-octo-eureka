// memory-sync.js - copies this machine's Drisyon memory entries into
// arunachala_memory, and maps team rows back into the engine's entry shape
// for team-wide search. The engine keeps entries newest first and only ever
// adds; state is the newest createdAt already sent.

const TABLE = 'arunachala_memory';
const BATCH = 200;

// The local term-frequency vector stays local: search recomputes it.
function toMemoryRow(e, teamId) {
  return {
    client_id: e.id,
    team_id: teamId,
    tenant_id: e.tenantId || 'tenant:drisyon_core',
    project_id: e.projectId || 'global',
    category: e.category || 'context',
    title: String(e.title || 'Untitled Knowledge').slice(0, 200),
    content: String(e.content || '').slice(0, 20000),
    tags: Array.isArray(e.tags) ? e.tags.map(String) : [],
    metadata: e.metadata && typeof e.metadata === 'object' ? e.metadata : {},
    created_at: e.createdAt,
  };
}

function fromMemoryRow(r) {
  return {
    id: r.client_id || r.id,
    tenantId: r.tenant_id,
    projectId: r.project_id,
    category: r.category,
    title: r.title,
    content: r.content,
    tags: r.tags || [],
    metadata: r.metadata || {},
    createdAt: r.created_at,
  };
}

async function syncMemory({ entries, state, rest, teamId }) {
  const since = state.since || '';
  const pending = entries
    .filter((e) => e && e.id && e.createdAt && e.content && e.createdAt > since)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(0, BATCH);
  if (!pending.length) return state;
  await rest.insertIgnoringDuplicates(TABLE, pending.map((e) => toMemoryRow(e, teamId)), 'client_id');
  return { ...state, since: pending[pending.length - 1].createdAt };
}

module.exports = { toMemoryRow, fromMemoryRow, syncMemory };
