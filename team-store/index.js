// team-store/index.js - shared team context in Supabase, if configured.
//
// Off unless all of SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, SUPABASE_EMAIL,
// SUPABASE_PASSWORD and TEAM_ID are set: a solo install keeps working on local
// files alone. When on, this machine's runs and AI call ledger sync up every
// SYNC_INTERVAL_MS and /api/runs?scope=team reads the whole team's runs back.

const fs = require('fs');
const { createSession } = require('./supabase-session');
const { createRest } = require('./supabase-rest');
const { syncRuns } = require('./run-sync');
const { readCalls } = require('./ai-ledger');
const { syncCalls } = require('./ai-sync');
const { syncMemory, fromMemoryRow } = require('./memory-sync');
const { toColumns } = require('./tasks');

const SYNC_INTERVAL_MS = 30 * 1000;
const RUNS_SYNC_LIMIT = 1000;
const TEAM_RUNS_LIMIT = 50;
const TEAM_MEMORY_LIMIT = 500;
const TEAM_TASKS_LIMIT = 300;
const REQUIRED = ['SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_EMAIL', 'SUPABASE_PASSWORD', 'TEAM_ID'];

function readState(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { return {}; }
}

function writeState(file, state) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, file);
}

/**
 * @param {Record<string, string|undefined>} env
 * @param {{ readRuns: Function, runsFile: string, stateFile: string,
 *           callsFile?: string, callStateFile?: string,
 *           readMemories?: () => object[], memoryStateFile?: string,
 *           log?: Function, fetch?: Function }} deps
 */
function createTeamStore(env, {
  readRuns, runsFile, stateFile, callsFile, callStateFile, readMemories, memoryStateFile,
  log = console.error, fetch,
}) {
  const missing = REQUIRED.filter((k) => !env[k]);
  if (missing.length === REQUIRED.length) return null; // not set up: solo mode
  if (missing.length) {
    log(`team-store off: missing ${missing.join(', ')} in .env`);
    return null;
  }
  const url = env.SUPABASE_URL.replace(/\/+$/, '');
  const key = env.SUPABASE_PUBLISHABLE_KEY;
  const teamId = env.TEAM_ID;
  const session = createSession({ url, key, email: env.SUPABASE_EMAIL, password: env.SUPABASE_PASSWORD, fetch });
  const rest = createRest({ url, key, session, fetch });

  // One outbox -> table copy with its own saved state. Offline or refused:
  // state is unchanged, so the same rows go next time; an outage is logged
  // once, not every interval.
  function makeJob(label, file, step) {
    let state = readState(file);
    let lastError = null;
    return async () => {
      try {
        const next = await step(state);
        if (next !== state) { state = next; writeState(file, state); }
        if (lastError) log(`team-store: ${label} sync recovered`);
        lastError = null;
      } catch (err) {
        if (err.message !== lastError) log(`team-store: ${label} sync failed: ${err.message}`);
        lastError = err.message;
      }
    };
  }

  const jobs = [
    makeJob('run', stateFile, (state) =>
      syncRuns({ runs: readRuns(runsFile, RUNS_SYNC_LIMIT).runs, state, rest, teamId })),
  ];
  if (callsFile) {
    jobs.push(makeJob('ai call', callStateFile, (state) =>
      syncCalls({ calls: readCalls(callsFile), state, rest, teamId, log })));
  }
  if (readMemories) {
    jobs.push(makeJob('memory', memoryStateFile, (state) =>
      syncMemory({ entries: readMemories(), state, rest, teamId })));
  }

  let busy = false;
  async function syncOnce() {
    if (busy) return;
    busy = true;
    try {
      for (const job of jobs) await job();
    } finally {
      busy = false;
    }
  }

  return {
    start() {
      syncOnce();
      return setInterval(syncOnce, SYNC_INTERVAL_MS);
    },
    syncOnce,
    async teamRuns() {
      const runs = await rest.select('arunachala_agent_runs', {
        team_id: `eq.${teamId}`, order: 'started_at.desc', limit: String(TEAM_RUNS_LIMIT),
      });
      return { ok: true, source: 'team', runs };
    },
    // Team memory in the engine's entry shape; the caller ranks it.
    async teamMemories() {
      const rows = await rest.select('arunachala_memory', {
        team_id: `eq.${teamId}`, order: 'created_at.desc', limit: String(TEAM_MEMORY_LIMIT),
      });
      return rows.map(fromMemoryRow);
    },
    async teamTasks() {
      const [rows, members] = await Promise.all([
        rest.select('arunachala_tasks', { team_id: `eq.${teamId}`, order: 'created_at.asc', limit: String(TEAM_TASKS_LIMIT) }),
        rest.select('arunachala_team_members', { team_id: `eq.${teamId}`, select: 'user_id,display_name' }),
      ]);
      const names = Object.fromEntries(members.map((m) => [m.user_id, m.display_name]));
      const ownerNames = Object.fromEntries(rows.map((r) => [r.id, names[r.assignee || r.owner] || 'Team']));
      return { ok: true, source: 'team', columns: toColumns(rows, ownerNames) };
    },
    // task: already validated by tasks.validateNewTask.
    async createTask(task) {
      const [row] = await rest.insert('arunachala_tasks', [{ ...task, team_id: teamId }]);
      return row;
    },
    // Resolves to the moved row, or null when no visible task has that id.
    async moveTask(id, status) {
      const rows = await rest.update('arunachala_tasks', { id: `eq.${id}`, team_id: `eq.${teamId}` }, { status });
      return rows[0] || null;
    },
  };
}

module.exports = { createTeamStore, REQUIRED };
