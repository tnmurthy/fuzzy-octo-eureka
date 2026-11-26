#!/usr/bin/env node
// scripts/eval-nightly.js - the golden evals once a night, free agent only.
// PM2 app NightlyEval (ecosystem.config.js) starts it at 02:30; it also runs
// when PM2 (re)starts the app, so outside the night window it exits at once:
// a daytime restart must not hold the local model for an hour while people
// wait for their runs (agent-dispatch.sh lets one hermes run use it at a time).
//
//   node scripts/eval-nightly.js [--now]      --now ignores the window
//
// Writes logs/eval-nightly/<date>.json (pass rate, per task, trajectory flags)
// and prints REGRESSION lines for tasks that passed last night and fail now.
// Results also reach the ledger -> GET /api/eval/leaderboard.
// Env: EVAL_NIGHTLY_AGENT (hermes), EVAL_NIGHTLY_WINDOW ("1-5", local hours),
//      EVAL_KEEP_DAYS (3) for temp folders of failed tasks.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'logs', 'eval-nightly');

/** "1-5" -> is hour h inside [1, 5)? A window may wrap midnight ("22-4"). */
function inWindow(spec, h) {
  const m = String(spec || '').match(/^(\d{1,2})-(\d{1,2})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a <= b ? h >= a && h < b : h >= a || h < b;
}

/** Tasks that passed in prev and fail in cur. */
function regressions(prev, cur) {
  const before = new Map(((prev && prev.results) || []).map((r) => [r.challengeId, r.passed]));
  return ((cur && cur.results) || []).filter((r) => before.get(r.challengeId) === true && !r.passed).map((r) => r.challengeId);
}

/** Temp folders the runner kept for failed tasks, older than days. */
function pruneKept(dir, days, now = Date.now()) {
  let removed = 0;
  let names;
  try { names = fs.readdirSync(dir); } catch (_) { return 0; }
  for (const n of names) {
    const p = path.join(dir, n);
    try {
      if (now - fs.statSync(p).mtimeMs > days * 86400000) { fs.rmSync(p, { recursive: true, force: true }); removed++; }
    } catch (_) { /* gone already */ }
  }
  return removed;
}

function latestReport(dir, exceptFile) {
  let files;
  try { files = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort(); } catch (_) { return null; }
  const prev = files.filter((f) => path.join(dir, f) !== exceptFile).pop();
  if (!prev) return null;
  try { return JSON.parse(fs.readFileSync(path.join(dir, prev), 'utf8')); } catch (_) { return null; }
}

function main() {
  const now = new Date();
  const window = process.env.EVAL_NIGHTLY_WINDOW || '1-5';
  if (!process.argv.includes('--now') && !inWindow(window, now.getHours())) {
    console.log(`eval-nightly: outside the ${window} h window, nothing to do`);
    return 0;
  }
  const agent = process.env.EVAL_NIGHTLY_AGENT || 'hermes';
  const pruned = pruneKept(path.join(os.tmpdir(), 'arunachala-eval'), Number(process.env.EVAL_KEEP_DAYS) || 3);

  const r = spawnSync(process.execPath, [path.join(__dirname, 'eval.js'), '--agent', agent, '--json'], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
  let summary;
  try { summary = JSON.parse(r.stdout); } catch (_) {
    console.error(`eval-nightly: eval.js gave no JSON (exit ${r.status}): ${(r.stderr || '').slice(-500)}`);
    return 2;
  }
  const day = now.toLocaleDateString('en-CA'); // YYYY-MM-DD, local
  const file = path.join(OUT_DIR, `${day}.json`);
  const prev = latestReport(OUT_DIR, file);
  const report = {
    date: day,
    agent,
    passed: summary.passed,
    total: summary.total,
    costUsd: summary.costUsd,
    regressions: regressions(prev, summary),
    results: summary.results.map((x) => ({
      challengeId: x.challengeId, passed: x.passed, score: x.score, turns: x.turns, durationMs: x.durationMs,
      status: x.details.status, flags: ((x.details.trajectory || {}).flags || []).map((f) => f.type),
    })),
  };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
  console.log(`eval-nightly: ${agent} ${report.passed}/${report.total} passed (pruned ${pruned} old temp folders) -> ${file}`);
  for (const id of report.regressions) console.log(`REGRESSION: ${id} passed last time, fails now`);
  return 0;
}

if (require.main === module) process.exit(main());

module.exports = { inWindow, regressions, pruneKept, latestReport };
