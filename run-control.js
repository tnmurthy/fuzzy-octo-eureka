// run-control.js - stop a running agent from the Agents page.
//
// agent-dispatch.sh writes its pid to <runsDir>/<runId>.pid and traps
// SIGTERM, so it survives the signal and records the run as `stopped`.
// `timeout` puts the agent CLI in its own process group, so a group kill would
// miss it: we signal the script first (sets the trap flag before its children
// exit), then every process below it.
//
// The pid file alone is not trusted: the process must still be
// agent-dispatch.sh with this run id on its command line, so a recycled pid
// is never signalled.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const RUN_ID_RE = /^[A-Za-z0-9._-]{1,80}$/;

/** All processes as {pid, ppid, args}. */
function psList() {
  const out = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,args='], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  return out.split('\n').map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), args: m[3] }));
}

/** pid and all its descendants, parent first. */
function treeOf(rootPid, procs) {
  const kids = new Map();
  for (const p of procs) {
    if (!kids.has(p.ppid)) kids.set(p.ppid, []);
    kids.get(p.ppid).push(p.pid);
  }
  const out = [];
  const queue = [rootPid];
  const seen = new Set();
  while (queue.length) {
    const pid = queue.shift();
    if (seen.has(pid)) continue;
    seen.add(pid);
    out.push(pid);
    for (const k of kids.get(pid) || []) queue.push(k);
  }
  return out;
}

/**
 * @param {object} deps
 * @param {string} deps.runsDir
 * @param {() => object[]} deps.loadRuns   folded run log
 * @param {() => object[]} [deps.listProcesses]
 * @param {(pid: number, sig: string) => void} [deps.kill]
 * @param {(file: string) => string} [deps.readFile]
 * @param {(ms: number) => Promise<void>} [deps.sleep]
 */
function createRunControl({ runsDir, loadRuns, listProcesses = psList, kill = process.kill.bind(process), readFile = (f) => fs.readFileSync(f, 'utf8'), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  function stop(runId) {
    if (!RUN_ID_RE.test(String(runId || ''))) return { ok: false, status: 400, error: 'bad run id' };
    const run = loadRuns().find((r) => r.id === runId);
    if (!run) return { ok: false, status: 404, error: 'run not found' };
    if (run.status !== 'running') return { ok: false, status: 409, error: 'the run has already finished' };
    let pid;
    try { pid = Number(String(readFile(path.join(runsDir, `${runId}.pid`))).trim()); } catch (_) { pid = NaN; }
    if (!Number.isInteger(pid) || pid <= 1) return { ok: false, status: 409, error: 'this run cannot be stopped from here (it started before stop was available)' };
    const procs = listProcesses();
    const root = procs.find((p) => p.pid === pid);
    if (!root || !/agent-dispatch\.sh/.test(root.args) || !root.args.split(/\s+/).includes(runId)) {
      return { ok: false, status: 409, error: 'the run is no longer running' };
    }
    const pids = treeOf(pid, procs);
    let signalled = 0;
    for (const p of pids) {
      try { kill(p, 'SIGTERM'); signalled += 1; } catch (_) { /* already gone */ }
    }
    return { ok: true, signalled };
  }

  /** Resolves with the run once its end line is written, or null on timeout. */
  async function waitForEnd(runId, timeoutMs = 20000, stepMs = 500) {
    for (let waited = 0; waited <= timeoutMs; waited += stepMs) {
      const run = loadRuns().find((r) => r.id === runId);
      if (run && run.status !== 'running') return run;
      await sleep(stepMs);
    }
    return null;
  }

  return { stop, waitForEnd };
}

module.exports = { createRunControl, treeOf, psList };
