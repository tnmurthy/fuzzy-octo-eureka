// pending-store.js - the Buzz events waiting on a dispatched run's /notify,
// keyed by run id and kept in a JSON file so a bridge restart mid-run still
// replies in the original thread. Entries past ttlMs are dropped on load:
// a run that never notified must not pile up forever.

const fs = require('fs');
const path = require('path');

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000; // agent-dispatch.sh's 1h timeout, with room

function readEntries(file, cutoff) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
  if (!raw || typeof raw !== 'object') return {};
  return Object.fromEntries(
    Object.entries(raw).filter(([, v]) => v && v.event && Number(v.at) >= cutoff)
  );
}

function writeEntries(file, entries) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(entries));
  fs.renameSync(tmp, file);
}

function createPendingStore({ file, ttlMs = DEFAULT_TTL_MS, now = Date.now }) {
  let entries = readEntries(file, now() - ttlMs);

  const save = (next) => {
    entries = next;
    try { writeEntries(file, entries); } catch (e) {
      console.error(`pending-store: could not save ${file}: ${e.message}`);
    }
  };

  return {
    set(runId, event) {
      if (!runId || !event) return;
      save({ ...entries, [runId]: { event, at: now() } });
    },
    take(runId) {
      const hit = runId && entries[runId];
      if (!hit) return undefined;
      const { [runId]: _removed, ...rest } = entries;
      save(rest);
      return hit.event;
    },
  };
}

module.exports = { createPendingStore };
