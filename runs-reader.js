// Reads orchestration/agent-dispatch.sh's run log for the Agent Runs tab.
//
// The log is append-only: a start line and an end line per run, sharing an id.
// Folding them here keeps the writer a plain append that two agents can do at
// once without a lock.
const fs = require('fs');

// A run still "running" after this long lost its end line (killed, machine
// slept). Showing it as running forever would hide that.
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

function foldRuns(text, now = Date.now()) {
  const byId = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // a torn line from a crash must not hide every other run
    }
    if (!entry || typeof entry.id !== 'string') continue;
    byId.set(entry.id, { ...(byId.get(entry.id) || {}), ...entry });
  }

  return [...byId.values()]
    .map((run) => {
      const started = Date.parse(run.started_at);
      const stale = run.status === 'running' && Number.isFinite(started) && now - started > STALE_AFTER_MS;
      return stale ? { ...run, status: 'stale' } : run;
    })
    .sort((a, b) => String(b.started_at || '').localeCompare(String(a.started_at || '')));
}

function readRuns(file, limit = 50) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: true, runs: [], note: 'No runs recorded yet.' };
    return { ok: false, runs: [], error: `cannot read run log: ${err.code || err.message}` };
  }
  return { ok: true, runs: foldRuns(text).slice(0, limit) };
}

module.exports = { foldRuns, readRuns, STALE_AFTER_MS };
