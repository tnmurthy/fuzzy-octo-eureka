'use strict';
// portal-scope.js - P0.6 (2026-11-23): each portal sees only its own agent runs.
//
// Both dashboards (team on 8787, drisyon on 8788) share one run log
// (AGENT_RUNS_FILE). Runs record `portal` on their start line since #49; a run
// without one is older than that and belongs to the team portal. Everything
// that reads runs through server.js's readRuns (lists, threads, logs, stop,
// follow-ups, the paid cap, costs) gets only this portal's runs, so a Drisyon
// teammate never sees, continues or uses up the team's work, and vice versa.
//
// Per-portal state files: the team portal keeps the original names; another
// portal gets `<name>.<portal>.<ext>` (logs/dispatch-settings.drisyon.json).

const path = require('path');

const DEFAULT_PORTAL = 'team';

const runPortal = (run) => (run && typeof run.portal === 'string' && run.portal) || DEFAULT_PORTAL;

/**
 * Wraps a run-log reader so it returns only `portal`'s runs.
 * The limit applies after filtering, so a quiet portal still gets its `limit`.
 * @param {(file: string, limit: number) => {runs: object[]}} readRuns
 * @param {string} portal
 */
function scopedReader(readRuns, portal) {
  return (file, limit = 50) => {
    const out = readRuns(file, Number.MAX_SAFE_INTEGER);
    const runs = (out.runs || []).filter((r) => runPortal(r) === portal).slice(0, limit);
    return { ...out, runs };
  };
}

/** logs/x.json -> logs/x.drisyon.json for a portal other than the team one. */
function portalFile(file, portal) {
  if (!portal || portal === DEFAULT_PORTAL) return file;
  const ext = path.extname(file);
  return `${file.slice(0, file.length - ext.length)}.${portal}${ext}`;
}

module.exports = { DEFAULT_PORTAL, runPortal, scopedReader, portalFile };
