// context-view.js - shapes data for the Context page (/context): the team's
// members with their activity, and memory three ways - mine (this machine),
// shared (the team's Supabase table) and combined (both, de-duplicated).
// Pure functions; the server route only fetches and passes data in.

const MAX_CONTENT = 1500;

const clip = (s, n) => {
  const t = String(s || '');
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/**
 * One row per team member: role, joined, memories shared, agent runs, AI
 * calls and tokens in the last 7 days, last run.
 */
function buildMembers({ members = [], memories = [], runs = [], calls = [], me = null }) {
  const count = (rows, id) => rows.reduce((n, r) => n + (r.owner === id ? 1 : 0), 0);
  return members
    .map((m) => {
      const mine = runs.filter((r) => r.owner === m.user_id);
      const myCalls = calls.filter((c) => c.owner === m.user_id);
      return {
        name: m.display_name,
        role: m.role,
        you: m.user_id === me,
        joined: m.created_at,
        memories: count(memories, m.user_id),
        runs: mine.length,
        lastRun: mine.reduce((latest, r) => (!latest || r.started_at > latest ? r.started_at : latest), null),
        aiCalls7d: myCalls.length,
        tokens7d: myCalls.reduce((n, c) => n + (c.input_tokens || 0) + (c.output_tokens || 0), 0),
      };
    })
    .sort((a, b) => (b.you - a.you) || (a.role === 'owner' ? -1 : b.role === 'owner' ? 1 : 0) || a.name.localeCompare(b.name));
}

/**
 * Merge this machine's memory with the team's. Each entry says where it
 * lives:
 *   mine:      true when this person wrote it (here or on another machine)
 *   local:     present on this machine
 *   shared:    present in the team table
 * A local entry and its synced team row (client_id = local id) become one.
 */
function combineMemory({ local = [], team = [], members = [], me = null }) {
  const names = Object.fromEntries(members.map((m) => [m.user_id, m.display_name]));
  const myName = names[me] || 'You';
  const byId = new Map();

  for (const e of local) {
    if (!e || !e.id || !e.content) continue;
    byId.set(e.id, {
      id: e.id,
      title: clip(e.title || 'Untitled', 200),
      content: clip(e.content, MAX_CONTENT),
      project: e.projectId || 'global',
      category: e.category || 'context',
      tags: Array.isArray(e.tags) ? e.tags.slice(0, 8).map(String) : [],
      createdAt: e.createdAt || null,
      author: myName,
      mine: true,
      local: true,
      shared: false,
    });
  }
  for (const r of team) {
    const key = r.client_id || r.id;
    const existing = byId.get(key);
    if (existing) { existing.shared = true; continue; }
    byId.set(key, {
      id: key,
      title: clip(r.title || 'Untitled', 200),
      content: clip(r.content, MAX_CONTENT),
      project: r.project_id || 'global',
      category: r.category || 'context',
      tags: Array.isArray(r.tags) ? r.tags.slice(0, 8).map(String) : [],
      createdAt: r.created_at || null,
      author: names[r.owner] || 'Former member',
      mine: r.owner === me,
      local: false,
      shared: true,
    });
  }
  return [...byId.values()].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

/** Headline numbers for the page. */
function summarize(entries, members) {
  return {
    members: members.length,
    mine: entries.filter((e) => e.mine).length,
    localOnly: entries.filter((e) => e.local && !e.shared).length,
    shared: entries.filter((e) => e.shared).length,
    fromTeammates: entries.filter((e) => !e.mine).length,
    combined: entries.length,
  };
}

/**
 * @param {{ local: object[], team?: object|null, error?: string|null }} input
 *   team: teamStore.teamContext() result, or null when the team store is off
 */
function buildContextView({ local, team = null, error = null }) {
  const members = team ? buildMembers(team) : [];
  const entries = combineMemory({ local, team: team ? team.memories : [], members: team ? team.members : [], me: team ? team.me : null });
  return {
    ok: true,
    teamStore: team ? 'on' : (error ? 'error' : 'off'),
    note: error ? `Team data unavailable (${error}); showing this machine only.` : (team ? null : 'Team sharing is off (no Supabase settings), so only this machine\'s memory is shown.'),
    teamName: team ? team.teamName : null,
    members,
    memory: entries,
    totals: summarize(entries, members),
  };
}

module.exports = { buildContextView, buildMembers, combineMemory, summarize };
