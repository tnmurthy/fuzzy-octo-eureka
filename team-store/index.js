// team-store/index.js - shared team context in Supabase, if configured.
//
// Off unless all of SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, SUPABASE_EMAIL,
// SUPABASE_PASSWORD and TEAM_ID are set: a solo install keeps working on local
// files alone. When on, this machine's runs sync up every SYNC_INTERVAL_MS and
// /api/runs?scope=team reads the whole team's runs back.

const fs = require('fs');
const { createSession } = require('./supabase-session');
const { createRest } = require('./supabase-rest');
const { syncRuns } = require('./run-sync');

const SYNC_INTERVAL_MS = 30 * 1000;
const RUNS_SYNC_LIMIT = 1000;
const TEAM_RUNS_LIMIT = 50;
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
 * @param {{ readRuns: Function, runsFile: string, stateFile: string, log?: Function, fetch?: Function }} deps
 */
function createTeamStore(env, { readRuns, runsFile, stateFile, log = console.error, fetch }) {
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

  let state = readState(stateFile);
  let busy = false;
  let lastError = null;

  async function syncOnce() {
    if (busy) return;
    busy = true;
    try {
      const { runs } = readRuns(runsFile, RUNS_SYNC_LIMIT);
      const next = await syncRuns({ runs, state, rest, teamId });
      if (next !== state) { state = next; writeState(stateFile, state); }
      if (lastError) log('team-store: run sync recovered');
      lastError = null;
    } catch (err) {
      // Offline or refused: state is unchanged, so the same rows go next time.
      if (err.message !== lastError) log(`team-store: run sync failed: ${err.message}`);
      lastError = err.message;
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
  };
}

module.exports = { createTeamStore, REQUIRED };
