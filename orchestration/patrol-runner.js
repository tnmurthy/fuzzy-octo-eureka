#!/usr/bin/env node
// orchestration/patrol-runner.js - Continuous Scheduled Patrol Daemon & Automated Watchdog
// Executes:
// 1. Periodic Google Mantis AppSec security audits (every 6h or custom interval)
// 2. Weekly AI operations & spend digest broadcasts to Buzz channels (Mondays 09:00 IST)
// 3. Periodic health & ReBAC authorization invariant verification (every 5m)
// 4. Exposes state via logs/patrol-state.json and /api/patrol/status

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { isDigestDue } = require('../digest');

const DASHBOARD_DIR = path.resolve(__dirname, '..');
const LOGS_DIR = path.join(DASHBOARD_DIR, 'logs');
const STATE_FILE = path.join(LOGS_DIR, 'patrol-state.json');

const DEFAULT_PORT = Number(process.env.PORT) || 8787;
const DEFAULT_HOST = '127.0.0.1';

// Default schedules
const DEFAULT_INTERVAL_HOURS = Number(process.env.PATROL_INTERVAL_HOURS) || 6;
const DEFAULT_INTERVAL_MS = (Number(process.env.PATROL_INTERVAL_MINUTES) || DEFAULT_INTERVAL_HOURS * 60) * 60 * 1000;
const HEALTH_INTERVAL_MS = (Number(process.env.PATROL_HEALTH_INTERVAL_SEC) || 300) * 1000;
const TICK_INTERVAL_MS = (Number(process.env.PATROL_TICK_SEC) || 30) * 1000;

function readJsonFile(filePath, fallback = {}) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJsonFile(filePath, data) {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = `${filePath}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, filePath);
  } catch (err) {
    console.error(`[patrol] Failed to write state file ${filePath}:`, err.message);
  }
}

function requestJson({ host = DEFAULT_HOST, port = DEFAULT_PORT, pathUrl, method = 'GET', data = null, timeout = 15000 }) {
  return new Promise((resolve, reject) => {
    const payload = data ? JSON.stringify(data) : null;
    const req = http.request({
      host,
      port,
      path: pathUrl,
      method,
      timeout,
      headers: {
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {})
      }
    }, res => {
      let b = '';
      res.on('data', c => { b += c; });
      res.on('end', () => {
        try { resolve({ statusCode: res.statusCode, data: JSON.parse(b) }); }
        catch (_) { resolve({ statusCode: res.statusCode, data: b }); }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Timeout after ${timeout}ms requesting ${pathUrl}`));
    });

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function evaluateSchedules({
  nowMs = Date.now(),
  state = {},
  intervalMs = DEFAULT_INTERVAL_MS,
  healthIntervalMs = HEALTH_INTERVAL_MS,
  isDigestDueFn = isDigestDue
} = {}) {
  const lastMantisMs = state.lastMantisSweep ? Date.parse(state.lastMantisSweep) : 0;
  const isMantisDue = !lastMantisMs || (nowMs - lastMantisMs >= intervalMs);
  const nextMantisDueMs = lastMantisMs ? lastMantisMs + intervalMs : nowMs;

  const lastHealthMs = state.lastHealthCheck ? Date.parse(state.lastHealthCheck) : 0;
  const isHealthDue = !lastHealthMs || (nowMs - lastHealthMs >= healthIntervalMs);

  const isWeeklyDigestDue = isDigestDueFn(nowMs, state.lastWeeklyDigest);

  return {
    isMantisDue,
    nextMantisDueMs,
    isHealthDue,
    isWeeklyDigestDue
  };
}

async function runMantisPatrol({ host = DEFAULT_HOST, port = DEFAULT_PORT, repo = path.basename(DASHBOARD_DIR) } = {}) {
  const timestamp = new Date().toISOString();
  console.log(`🛡️ [patrol ${timestamp}] Initiating automated Google Mantis AppSec audit...`);
  try {
    const task = "Automated security sweep: audit API authorization, verify ReBAC boundaries, and check tenant memory isolation.";
    const branch = `patrol/mantis-${Date.now()}`;
    const res = await requestJson({
      host,
      port,
      pathUrl: '/api/dispatch/run',
      method: 'POST',
      data: { agent: 'mantis', repo, branch, task }
    });

    if (res.data && res.data.ok) {
      console.log(`✅ [patrol] Mantis audit dispatched successfully! Run ID: ${res.data.runId}`);
      // Record episodic memory trace
      await requestJson({
        host,
        port,
        pathUrl: '/api/memory/store',
        method: 'POST',
        data: {
          title: `Automated Mantis Security Sweep (${res.data.runId})`,
          content: `Mantis AppSec scan executed against repository ${repo}. Verification of ReBAC authorization and tenant isolation underway.`,
          category: 'security_audit',
          tenantId: 'tenant:drisyon_core',
          projectId: repo
        }
      }).catch(() => {});

      return { ok: true, runId: res.data.runId, timestamp };
    } else {
      console.error('❌ [patrol] Dispatch returned non-OK response:', res.data);
      return { ok: false, error: res.data, timestamp };
    }
  } catch (err) {
    console.error('❌ [patrol] Failed to trigger Mantis sweep:', err.message);
    return { ok: false, error: err.message, timestamp };
  }
}

async function runWeeklyDigest({ host = DEFAULT_HOST, port = DEFAULT_PORT, broadcast = true } = {}) {
  const timestamp = new Date().toISOString();
  console.log(`📊 [digest ${timestamp}] Generating weekly AI operations & spend digest...`);
  try {
    const res = await requestJson({ host, port, pathUrl: '/api/digest' });
    if (res.data && res.data.ok) {
      const digestText = res.data.text;
      console.log('--- WEEKLY DIGEST REPORT ---');
      console.log(digestText);
      console.log('----------------------------');

      let broadcastOk = false;
      if (broadcast) {
        const pubScript = path.join(DASHBOARD_DIR, 'buzz-bridge', 'publish-once.js');
        if (fs.existsSync(pubScript)) {
          console.log('📡 [digest] Broadcasting digest to Buzz channels via publish-once.js...');
          broadcastOk = await new Promise(resolve => {
            const child = spawn('node', [pubScript, digestText], {
              cwd: path.join(DASHBOARD_DIR, 'buzz-bridge'),
              stdio: 'inherit'
            });
            child.on('close', code => {
              console.log(`📡 [digest] Broadcast exited with code: ${code}`);
              resolve(code === 0);
            });
            child.on('error', err => {
              console.error('❌ [digest] Broadcast failed:', err.message);
              resolve(false);
            });
          });
        } else {
          console.log('ℹ️ [digest] publish-once.js not found; broadcast skipped.');
        }
      }
      return { ok: true, timestamp, text: digestText, broadcast: broadcastOk };
    } else {
      console.error('❌ [digest] Failed to generate digest:', res.data);
      return { ok: false, timestamp, error: res.data };
    }
  } catch (err) {
    console.error('❌ [digest] Error requesting digest:', err.message);
    return { ok: false, timestamp, error: err.message };
  }
}

async function runHealthCheck({ host = DEFAULT_HOST, port = DEFAULT_PORT } = {}) {
  const timestamp = new Date().toISOString();
  let serverOnline = false;
  let ollamaOnline = false;
  let rebacAuthorized = false;

  try {
    const pingRes = await requestJson({ host, port, pathUrl: '/api/ping', timeout: 5000 });
    serverOnline = pingRes.statusCode === 200;
    ollamaOnline = Boolean(pingRes.data && pingRes.data.ok);
  } catch (_) {
    serverOnline = false;
  }

  try {
    const inspectRes = await requestJson({ host, port, pathUrl: '/api/rebac/inspect', timeout: 5000 });
    rebacAuthorized = inspectRes.statusCode === 200 && Boolean(inspectRes.data && inspectRes.data.nodes);
  } catch (_) {
    rebacAuthorized = false;
  }

  const healthy = serverOnline && rebacAuthorized;
  return {
    timestamp,
    healthy,
    serverOnline,
    ollamaOnline,
    rebacAuthorized
  };
}

class PatrolDaemon {
  constructor({
    host = DEFAULT_HOST,
    port = DEFAULT_PORT,
    intervalMs = DEFAULT_INTERVAL_MS,
    healthIntervalMs = HEALTH_INTERVAL_MS,
    tickIntervalMs = TICK_INTERVAL_MS,
    stateFile = STATE_FILE
  } = {}) {
    this.host = host;
    this.port = port;
    this.intervalMs = intervalMs;
    this.healthIntervalMs = healthIntervalMs;
    this.tickIntervalMs = tickIntervalMs;
    this.stateFile = stateFile;
    this.timer = null;
    this.running = false;
    this.tickBusy = false;
  }

  getState() {
    return readJsonFile(this.stateFile, {
      daemonPid: process.pid,
      startedAt: new Date().toISOString(),
      status: 'initialized',
      intervalHours: this.intervalMs / (60 * 60 * 1000),
      lastMantisSweep: null,
      lastWeeklyDigest: null,
      lastHealthCheck: null,
      health: { healthy: true },
      ticks: 0
    });
  }

  saveState(updates) {
    const current = this.getState();
    const updated = {
      ...current,
      ...updates,
      daemonPid: process.pid,
      updatedAt: new Date().toISOString()
    };
    writeJsonFile(this.stateFile, updated);
    return updated;
  }

  async tick() {
    if (this.tickBusy || !this.running) return;
    this.tickBusy = true;

    try {
      const state = this.getState();
      const nowMs = Date.now();
      const sched = evaluateSchedules({
        nowMs,
        state,
        intervalMs: this.intervalMs,
        healthIntervalMs: this.healthIntervalMs
      });

      // 1. Health check
      if (sched.isHealthDue) {
        const health = await runHealthCheck({ host: this.host, port: this.port });
        this.saveState({
          lastHealthCheck: health.timestamp,
          health: {
            healthy: health.healthy,
            serverOnline: health.serverOnline,
            ollamaOnline: health.ollamaOnline,
            rebacAuthorized: health.rebacAuthorized
          }
        });
      }

      // 2. Weekly Digest (Monday 09:00 IST schedule)
      if (sched.isWeeklyDigestDue) {
        console.log(`⏰ [patrol] Weekly digest schedule trigger fired!`);
        const digestResult = await runWeeklyDigest({ host: this.host, port: this.port, broadcast: true });
        this.saveState({
          lastWeeklyDigest: digestResult.timestamp,
          lastWeeklyDigestOk: digestResult.ok
        });
      }

      // 3. Mantis AppSec Audit Sweep
      if (sched.isMantisDue) {
        console.log(`⏰ [patrol] Scheduled AppSec patrol sweep trigger fired!`);
        const mantisResult = await runMantisPatrol({ host: this.host, port: this.port });
        const nextSweepIso = new Date(nowMs + this.intervalMs).toISOString();
        this.saveState({
          lastMantisSweep: mantisResult.timestamp,
          lastMantisRunId: mantisResult.runId || null,
          lastMantisOk: mantisResult.ok,
          nextMantisScheduled: nextSweepIso
        });
      }

      const ticks = (state.ticks || 0) + 1;
      this.saveState({ ticks, status: 'online' });
    } catch (err) {
      console.error('[patrol] Error in daemon tick cycle:', err.message);
    } finally {
      this.tickBusy = false;
    }
  }

  start() {
    if (this.running) return;
    this.running = true;

    console.log(`=== Arunachala Continuous Scheduled Patrol Daemon Started ===`);
    console.log(`• Process PID: ${process.pid}`);
    console.log(`• Target Endpoint: http://${this.host}:${this.port}`);
    console.log(`• Security Audit Sweep Interval: ${(this.intervalMs / (60 * 60 * 1000)).toFixed(1)} hours`);
    console.log(`• Health Check Interval: ${(this.healthIntervalMs / 1000)} seconds`);
    console.log(`• State File: ${this.stateFile}`);

    this.saveState({
      daemonPid: process.pid,
      startedAt: new Date().toISOString(),
      status: 'online',
      intervalHours: this.intervalMs / (60 * 60 * 1000)
    });

    // Execute first tick immediately
    this.tick().catch(err => console.error('[patrol] Initial tick error:', err.message));

    // Schedule regular ticks
    this.timer = setInterval(() => this.tick(), this.tickIntervalMs);

    const cleanup = () => {
      console.log('\n[patrol] Received shutdown signal. Gracefully stopping daemon...');
      this.stop();
      process.exit(0);
    };

    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
  }

  stop() {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.saveState({ status: 'stopped', stoppedAt: new Date().toISOString() });
    console.log('[patrol] Patrol daemon stopped.');
  }
}

async function main() {
  const mode = (process.argv[2] || 'daemon').replace(/^--/, '');
  console.log(`=== Arunachala Watchdog Patrol CLI (Mode: ${mode}) ===`);

  if (mode === 'daemon') {
    const daemon = new PatrolDaemon();
    daemon.start();
  } else if (mode === 'mantis') {
    await runMantisPatrol();
  } else if (mode === 'digest') {
    await runWeeklyDigest();
  } else if (mode === 'health') {
    const res = await runHealthCheck();
    console.log('Health Check Verdict:', JSON.stringify(res, null, 2));
  } else if (mode === 'once' || mode === 'all') {
    await runHealthCheck();
    await runWeeklyDigest();
    await runMantisPatrol();
  } else {
    console.log(`Unknown mode: "${mode}". Available modes: daemon, mantis, digest, health, once`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  PatrolDaemon,
  evaluateSchedules,
  runMantisPatrol,
  runWeeklyDigest,
  runHealthCheck,
  readJsonFile,
  writeJsonFile,
  STATE_FILE
};
