// run-sync.js - copies this machine's agent runs into the team's agent_runs
// table. runs.jsonl stays the source of truth and works as an outbox: a run
// is uploaded when it is new or its status changed since the last upload, and
// an offline attempt leaves the state untouched so the next one retries.

const path = require('path');

const AGENTS = new Set(['claude', 'codex', 'agy', 'hermes', 'noop']);
// Dispatcher wording -> the table's allowed statuses. 'stale' is the reader's
// own label for a run that lost its end line; the row stays 'running'.
const STATUS = { running: 'running', stale: 'running', done: 'done', failed: 'failed', timed_out: 'timeout' };

// Repo name only: the local folder layout and log paths stay on this machine.
function toRow(run, teamId) {
  if (!AGENTS.has(run.agent) || !run.id) return null;
  return {
    id: run.id,
    team_id: teamId,
    agent: run.agent,
    repo: path.basename(String(run.repo || '').replace(/[\\/]+$/, '')) || 'unknown',
    branch: run.branch || null,
    task: run.task || null,
    status: STATUS[run.status] || 'running',
    exit_code: Number.isInteger(run.exit_code) ? run.exit_code : null,
    duration_s: Number.isInteger(run.duration_s) ? run.duration_s : null,
    commits_ahead: Number.isInteger(run.commits_ahead) ? run.commits_ahead : null,
    head: run.head || null,
    started_at: run.started_at || null,
    finished_at: run.finished_at || null,
  };
}

const fingerprint = (row) => `${row.status}|${row.finished_at || ''}`;

function pendingRows(runs, state, teamId) {
  const rows = [];
  const next = { ...state };
  for (const run of runs) {
    const row = toRow(run, teamId);
    if (!row) continue;
    const fp = fingerprint(row);
    if (state[row.id] === fp) continue;
    rows.push(row);
    next[row.id] = fp;
  }
  return { rows, next };
}

async function syncRuns({ runs, state, rest, teamId }) {
  const { rows, next } = pendingRows(runs, state, teamId);
  if (!rows.length) return state;
  await rest.upsert('agent_runs', rows, 'id');
  return next;
}

module.exports = { toRow, pendingRows, syncRuns };
