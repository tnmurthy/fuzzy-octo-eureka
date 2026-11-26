#!/usr/bin/env node
// scripts/eval.js - run the golden eval tasks against an agent.
//
//   npm run eval -- --list
//   npm run eval -- --agent hermes                    every task, free local model
//   npm run eval -- --agent hermes --task security-auth-timing
//   npm run eval -- --agent claude --allow-paid       paid: needs the flag
//
// Flags: --agent <name> (default hermes)  --task <id>[,<id>] (repeatable)
//        --allow-paid  --keep (keep temp repos of passed tasks too)
//        --no-record (do not save to the ledger)  --json
//
// Paid agents (dispatch-cap.js PAID_AGENTS) need --allow-paid and still obey
// the daily paid-run cap: today's paid runs in the dashboard's run log plus
// the eval run log count against it, checked before every task.
// Eval runs log to logs/eval-runs/ (EVAL_RUNS_DIR), never to the dashboard's
// run log, so they do not appear as anyone's request. Results go to the
// ledger, shown at GET /api/eval/leaderboard.
// EVAL_DISPATCH_SCRIPT=<path> grades another checkout's agent-dispatch.sh.
'use strict';

const path = require('path');
const ROOT = path.join(__dirname, '..');

function parseArgs(argv) {
  const o = { agent: 'hermes', tasks: [], allowPaid: false, keep: false, record: true, json: false, list: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--agent') o.agent = argv[++i];
    else if (a === '--task') o.tasks.push(...String(argv[++i] || '').split(',').filter(Boolean));
    else if (a === '--allow-paid') o.allowPaid = true;
    else if (a === '--keep') o.keep = true;
    else if (a === '--no-record') o.record = false;
    else if (a === '--json') o.json = true;
    else if (a === '--list') o.list = true;
    else throw new Error(`unknown flag: ${a}`);
  }
  if (!/^[a-z]+$/.test(o.agent || '')) throw new Error('--agent needs a name');
  return o;
}

/** Picks tasks by id; unknown ids are an error, none = all. */
function selectTasks(all, ids) {
  if (!ids.length) return all;
  const byId = new Map(all.map((t) => [t.id, t]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length) throw new Error(`unknown task: ${missing.join(', ')} (see --list)`);
  return ids.map((id) => byId.get(id));
}

/** Paid-run check over both run logs; returns { ok, error? }. */
function makePaidGuard({ agent, allowPaid, runFiles, cap, PAID_AGENTS, checkDispatchCap, readRuns }) {
  return function checkPaid() {
    if (!PAID_AGENTS.has(agent)) return { ok: true };
    if (!allowPaid) return { ok: false, error: `${agent} is a paid agent: add --allow-paid (each task is one paid run)` };
    const runs = runFiles.flatMap((f) => readRuns(f, 5000).runs || []);
    return checkDispatchCap({ agent, runs, cap });
  };
}

function formatRow(r) {
  const cost = r.costUsd ? `$${r.costUsd.toFixed(4)}` : '$0';
  return `${r.passed ? 'PASS' : 'FAIL'}  ${String(r.score).padStart(3)}/100  ${r.challengeId.padEnd(26)} turns ${String(r.turns).padStart(2)}  ${(r.durationMs / 1000).toFixed(0).padStart(4)}s  ${cost.padStart(8)}  ${r.details.status}`;
}

async function main() {
  require('../load-env').loadEnv(ROOT);
  const { loadGoldenTasks } = require('../evals/golden-tasks');
  const { runTask } = require('../evals/eval-runner');
  const evalHarness = require('../eval-harness');
  const { checkDispatchCap, parseCap, PAID_AGENTS } = require('../dispatch-cap');
  const { readRuns } = require('../runs-reader');
  const { createDispatchSettings } = require('../dispatch-settings');

  const o = parseArgs(process.argv.slice(2));
  const all = loadGoldenTasks();
  if (o.list) {
    for (const t of all) console.log(`${t.id.padEnd(26)} [${t.difficulty}] ${t.name}`);
    return 0;
  }
  const tasks = selectTasks(all, o.tasks);

  const stackRoot = process.env.STACK_ROOT || path.resolve(ROOT, '../../..');
  const mainRuns = process.env.AGENT_RUNS_FILE || path.join(stackRoot, '04_internal', 'agent-runs', 'runs.jsonl');
  const runsDir = process.env.EVAL_RUNS_DIR || path.join(ROOT, 'logs', 'eval-runs');
  const cap = createDispatchSettings({
    file: path.join(ROOT, 'logs', 'dispatch-settings.json'),
    envCap: parseCap(process.env.DISPATCH_DAILY_PAID_RUNS),
  }).cap();
  const checkPaid = makePaidGuard({
    agent: o.agent, allowPaid: o.allowPaid, runFiles: [mainRuns, path.join(runsDir, 'runs.jsonl')],
    cap, PAID_AGENTS, checkDispatchCap, readRuns,
  });

  let ledgerDB = null;
  if (o.record) {
    try { ledgerDB = require('../ledger-db').createLedgerDB(); } catch (err) {
      console.error(`ledger unavailable, results not saved: ${err.message}`);
    }
  }

  // Local agents: refuse to start on a wedged model (its stalls would be
  // recorded as agent failures). EVAL_PREFLIGHT=off skips it.
  if (['hermes', 'auto'].includes(o.agent) && process.env.EVAL_PREFLIGHT !== 'off') {
    const { probeLocalModel, hermesModel } = require('../evals/model-preflight');
    const probe = await probeLocalModel({
      model: hermesModel(),
      host: process.env.OLLAMA_HOST || '127.0.0.1',
      port: Number(process.env.OLLAMA_PORT) || 11434,
      timeoutMs: Number(process.env.EVAL_PREFLIGHT_MS) || 30000,
    });
    if (!probe.ok) {
      console.error(`local model check failed, no tasks run: ${probe.error}`);
      return 3;
    }
    if (!o.json) console.error(`local model answered in ${probe.ms} ms`);
  }

  const results = [];
  for (const task of tasks) {
    const gate = checkPaid();
    if (!gate.ok) { console.error(`stopped before ${task.id}: ${gate.error}`); break; }
    if (!o.json) console.error(`… ${task.id} (${o.agent})`);
    const raw = await runTask(task, { agent: o.agent, runsDir, keep: o.keep });
    const rec = evalHarness.recordBenchmarkResult(
      { ...raw, details: { ...raw.details, targetTurns: task.targetTurns } },
      { ledgerDB }
    );
    results.push(rec);
    if (!o.json) console.log(formatRow(rec) + (rec.details.kept ? `\n      kept: ${rec.details.kept}` : ''));
  }

  const passed = results.filter((r) => r.passed).length;
  const summary = {
    agent: o.agent,
    passed,
    total: results.length,
    skipped: tasks.length - results.length,
    costUsd: Number(results.reduce((s, r) => s + r.costUsd, 0).toFixed(4)),
    results,
  };
  if (o.json) process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  else console.log(`\n${o.agent}: ${passed}/${results.length} passed, $${summary.costUsd} spent${summary.skipped ? `, ${summary.skipped} not run` : ''}`);
  return passed === tasks.length ? 0 : 1;
}

if (require.main === module) {
  main().then((code) => process.exit(code), (err) => { console.error(err.message); process.exit(2); });
}

module.exports = { parseArgs, selectTasks, makePaidGuard, formatRow };
