#!/usr/bin/env node
// scripts/agents.js - which agents are running, on what, and what ran lately.
//
//   npm run agents            one snapshot
//   npm run agents -- --watch  refresh every 5 s (Ctrl+C to stop)
//
// Reads local files only (no dashboard needed): the run log (AGENT_RUNS_FILE),
// the issue poller's state (logs/issue-poller-state.json, run id -> issue)
// and the paid-run cap (dispatch-cap.js).

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

const clip = (s, n) => {
  const one = String(s || '').replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

/**
 * @param {object} o
 * @param {object[]} o.runs         folded run log, newest first
 * @param {object} o.active         poller state.active (run id -> job)
 * @param {{used: number, cap: number}} o.cap
 * @param {number} o.now
 * @param {number} [o.recent]
 * @returns {string}
 */
function formatAgents({ runs, active = {}, cap, now, recent = 8 }) {
  const out = [];
  const issueOf = (id) => {
    const job = active[id];
    if (!job) return '';
    return job.kind === 'review' ? `review of PR #${job.pr}` : `issue #${job.number}`;
  };
  // A finished run's job is gone from the poller state; recover the issue
  // number from the task text the poller wrote ("GitHub issue owner/repo#N").
  const issueFromTask = (r) => {
    const m = String(r.task || '').match(/GitHub issue \S+#(\d+)/) || String(r.task || '').match(/Review pull request #(\d+)/);
    if (!m) return '';
    return /Review pull request/.test(r.task) ? `review #${m[1]}` : `#${m[1]}`;
  };

  out.push(`Paid agent runs today: ${cap.used} of ${cap.cap}${cap.used >= cap.cap ? '  (CAP REACHED - paid dispatches refused)' : ''}`);
  out.push('');

  const running = runs.filter((r) => r.status === 'running');
  out.push(`RUNNING (${running.length})`);
  if (!running.length) out.push('  nothing running');
  for (const r of running) {
    const started = Date.parse(r.started_at);
    const what = issueOf(r.id) || issueFromTask(r);
    out.push(`  ${String(r.agent).padEnd(7)} ${ago(now - started).padStart(7)}  ${what ? `${what}  ` : ''}${clip(r.task, 60)}`);
    out.push(`          run ${r.id}`);
    if (r.log) out.push(`          live: tail -f ${r.log}`);
  }

  const done = runs.filter((r) => r.status !== 'running').slice(0, recent);
  out.push('');
  out.push(`RECENT (${done.length})`);
  for (const r of done) {
    const took = Number.isFinite(r.duration_s) ? ago(r.duration_s * 1000) : '-';
    const commits = r.commits_ahead ? `${r.commits_ahead} commit${r.commits_ahead === 1 ? '' : 's'}` : '';
    const what = issueFromTask(r);
    out.push(`  ${String(r.status).padEnd(9)} ${String(r.agent).padEnd(7)} ${took.padStart(7)}  ${commits.padEnd(10)} ${what ? `${what} ` : ''}${clip(r.task, 50)}`);
  }
  return out.join('\n');
}

module.exports = { formatAgents, ago };

if (require.main === module) {
  require('../load-env').loadEnv(ROOT);
  const { readRuns } = require('../runs-reader');
  const { checkDispatchCap, parseCap } = require('../dispatch-cap');
  const RUNS_FILE = process.env.AGENT_RUNS_FILE || path.join(ROOT, '..', '..', '04_internal', 'agent-runs', 'runs.jsonl');
  const STATE_FILE = path.join(ROOT, 'logs', 'issue-poller-state.json');

  const snapshot = () => {
    const runs = readRuns(RUNS_FILE, 5000).runs || [];
    let active = {};
    try { active = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).active || {}; } catch (_) { /* poller never ran */ }
    const cap = checkDispatchCap({ agent: 'claude', runs, cap: parseCap(process.env.DISPATCH_DAILY_PAID_RUNS) });
    return formatAgents({ runs, active, cap, now: Date.now() });
  };

  if (process.argv.includes('--watch')) {
    const draw = () => {
      process.stdout.write('\x1b[2J\x1b[H');
      console.log(`${new Date().toLocaleTimeString()}  (refreshing every 5 s, Ctrl+C to stop)\n`);
      console.log(snapshot());
    };
    draw();
    setInterval(draw, 5000);
  } else {
    console.log(snapshot());
  }
}
