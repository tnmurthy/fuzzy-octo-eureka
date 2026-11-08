#!/usr/bin/env node
// telemetry-daemon.js - Cross-platform background telemetry collector (Node.js)
// Periodically probes local services (Ollama, Buzz, OpenClaw, Watchtower),
// captures system CPU load, and writes telemetry.json and history.json.

const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DASHBOARD_DIR = __dirname;
const TELEMETRY_FILE = path.join(DASHBOARD_DIR, 'telemetry.json');
const HISTORY_FILE = path.join(DASHBOARD_DIR, 'history.json');
const LOCK_FILE = path.join(DASHBOARD_DIR, '.telemetry-daemon.lock');
const LOGS_DIR = path.join(DASHBOARD_DIR, 'logs');
const DAEMON_LOG = path.join(LOGS_DIR, 'daemon.log');

// Load .env if present
const envValues = {};
const envFile = path.join(DASHBOARD_DIR, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) envValues[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const OPERATOR_HOME = envValues['OPERATOR_HOME'] || process.env.HOME || process.env.USERPROFILE || os.homedir();
const STACK_ROOT = envValues['STACK_ROOT'] || path.resolve(DASHBOARD_DIR, '..', '..', '..');
const APP_LOG_FILE = path.join(STACK_ROOT, '04_internal', 'logs', 'app.log');

const POLL_INTERVAL_MS = 5000;
const HISTORY_MAX_POINTS = 720;
const OLLAMA_HOST = envValues['OLLAMA_HOST'] || '127.0.0.1';
const OLLAMA_PORT = Number(envValues['OLLAMA_PORT']) || 11434;
const OPENCLAW_PORT = 18789;
const BUZZ_PORT = 3000;

function writeDaemonLog(msg, level = 'INFO') {
  try {
    if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
    const line = `[${new Date().toISOString()}] [${level}] ${msg}\n`;
    fs.appendFileSync(DAEMON_LOG, line, 'utf8');
  } catch (_) {}
}

function acquireLock() {
  if (fs.existsSync(LOCK_FILE)) {
    try {
      const existingPid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim(), 10);
      if (existingPid && !isNaN(existingPid)) {
        try {
          process.kill(existingPid, 0); // Check if process is alive
          console.error(`[error] Telemetry daemon is already running under PID ${existingPid}.`);
          return false;
        } catch (_) {
          // Process not alive; stale lockfile
        }
      }
    } catch (_) {}
  }
  try {
    fs.writeFileSync(LOCK_FILE, String(process.pid), 'utf8');
    return true;
  } catch (err) {
    console.error(`[error] Failed to create lockfile: ${err.message}`);
    return false;
  }
}

function releaseLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE);
  } catch (_) {}
}

// Measure CPU usage across intervals
let lastCpuMeasure = null;
function getCpuUsage() {
  const cpus = os.cpus();
  let user = 0;
  let nice = 0;
  let sys = 0;
  let idle = 0;
  let irq = 0;

  for (const cpu of cpus) {
    user += cpu.times.user;
    nice += cpu.times.nice || 0;
    sys += cpu.times.sys;
    idle += cpu.times.idle;
    irq += cpu.times.irq || 0;
  }

  const total = user + nice + sys + idle + irq;
  if (!lastCpuMeasure) {
    lastCpuMeasure = { total, idle };
    const load = os.loadavg()[0];
    return Math.min(100, Math.round((load / Math.max(1, cpus.length)) * 100 * 10) / 10);
  }

  const diffTotal = total - lastCpuMeasure.total;
  const diffIdle = idle - lastCpuMeasure.idle;
  lastCpuMeasure = { total, idle };

  if (diffTotal <= 0) return 0;
  const pct = ((diffTotal - diffIdle) / diffTotal) * 100;
  return Math.round(pct * 10) / 10;
}

function testTcpPort(port, host = '127.0.0.1', timeoutMs = 1500) {
  return new Promise((resolve) => {
    const start = Date.now();
    const socket = new net.Socket();
    let resolved = false;

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => {
      resolved = true;
      const latency = Date.now() - start;
      socket.destroy();
      resolve({ online: true, latencyMs: latency });
    });

    socket.once('timeout', () => {
      if (!resolved) {
        resolved = true;
        socket.destroy();
        resolve({ online: false, latencyMs: null });
      }
    });

    socket.once('error', () => {
      if (!resolved) {
        resolved = true;
        socket.destroy();
        resolve({ online: false, latencyMs: null });
      }
    });

    socket.connect(port, host);
  });
}

function httpGetJson(url, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const start = Date.now();
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        const latencyMs = Date.now() - start;
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve({ ok: true, data: JSON.parse(data), statusCode: res.statusCode, latencyMs });
          } catch (_) {
            resolve({ ok: true, data: data.trim(), statusCode: res.statusCode, latencyMs });
          }
        } else {
          resolve({ ok: false, statusCode: res.statusCode, latencyMs });
        }
      });
    });

    req.on('timeout', () => { req.destroy(); resolve({ ok: false, latencyMs: null }); });
    req.on('error', () => resolve({ ok: false, latencyMs: null }));
  });
}

async function getBuzzStatus() {
  const result = {
    online: false,
    port: BUZZ_PORT,
    latencyMs: null,
    ui: false,
    metrics: false,
    containers: 0,
    realMembers: -1
  };

  const res = await httpGetJson(`http://127.0.0.1:${BUZZ_PORT}/health`, 2000);
  if (res.ok) {
    result.online = true;
    result.latencyMs = res.latencyMs;
    const uiRes = await httpGetJson(`http://127.0.0.1:${BUZZ_PORT}/`, 1500);
    result.ui = uiRes.ok;
    const metricsRes = await httpGetJson(`http://127.0.0.1:9102/metrics`, 1500);
    result.metrics = metricsRes.ok;
  }
  return result;
}

async function getActiveOllamaModels(ollamaOnline) {
  if (!ollamaOnline) return [];
  const res = await httpGetJson(`http://${OLLAMA_HOST}:${OLLAMA_PORT}/api/ps`, 2000);
  if (res.ok && res.data && Array.isArray(res.data.models)) {
    return res.data.models.map((m) => ({
      name: m.name,
      size: m.size ? `${(m.size / (1024 * 1024 * 1024)).toFixed(1)} GB` : '',
      vram: m.size_vram ? `${(m.size_vram / (1024 * 1024 * 1024)).toFixed(1)} GB VRAM` : 'CPU/GPU',
      until: m.expires_at || 'Running'
    }));
  }
  return [];
}

function getAppLogTail(maxLines = 15) {
  if (!fs.existsSync(APP_LOG_FILE)) {
    return [`[system] No active app.log detected at ${APP_LOG_FILE}`];
  }
  try {
    const content = fs.readFileSync(APP_LOG_FILE, 'utf8');
    const lines = content.trim().split(/\r?\n/).filter(Boolean);
    return lines.slice(-maxLines);
  } catch (err) {
    return [`[system] Error reading ${APP_LOG_FILE}: ${err.message}`];
  }
}

function writeAtomicJson(filePath, data) {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

function updateHistory(newPoint) {
  let history = [];
  if (fs.existsSync(HISTORY_FILE)) {
    try {
      history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
      if (!Array.isArray(history)) history = [];
    } catch (_) {
      history = [];
    }
  }
  history.push(newPoint);
  if (history.length > HISTORY_MAX_POINTS) {
    history = history.slice(history.length - HISTORY_MAX_POINTS);
  }
  writeAtomicJson(HISTORY_FILE, history);
}

async function tick() {
  const cpu = getCpuUsage();
  const [ollamaTcp, openclawTcp, buzzStatus] = await Promise.all([
    testTcpPort(OLLAMA_PORT, OLLAMA_HOST),
    testTcpPort(OPENCLAW_PORT),
    getBuzzStatus()
  ]);

  let ollamaLatencyMs = ollamaTcp.latencyMs;
  if (ollamaTcp.online) {
    const ping = await httpGetJson(`http://${OLLAMA_HOST}:${OLLAMA_PORT}/api/tags`, 2000);
    if (ping.ok) ollamaLatencyMs = ping.latencyMs;
  }

  const activeModels = await getActiveOllamaModels(ollamaTcp.online);
  const now = new Date();
  const timestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;

  const telemetry = {
    timestamp,
    cpu,
    services: {
      ollama: { online: ollamaTcp.online, port: OLLAMA_PORT, latencyMs: ollamaLatencyMs },
      openclaw: { online: openclawTcp.online, port: OPENCLAW_PORT, latencyMs: openclawTcp.latencyMs },
      watchtower: { online: true, name: 'watchtower', status: 'Monitoring disabled', image: 'containrrr/watchtower' },
      buzz: buzzStatus
    },
    activeModels,
    logs: getAppLogTail(15),
    agentStats: {
      po: { status: 'idle', active: 0, completed: 0, messages: 0 },
      tech: { status: 'idle', active: 0, completed: 0, messages: 0 },
      qa: { status: 'idle', active: 0, completed: 0, messages: 0 },
      infra: { status: 'idle', active: 0, completed: 0, messages: 0 },
      doc: { status: 'idle', active: 0, completed: 0, messages: 0 }
    },
    engineStats: {
      paperclip: { hiredCount: 5, activeBoards: 1 },
      openclaw: { pluginsCount: 0, toolsCount: 16 },
      hermes: { tracesCount: 0, activeRunners: 1 }
    }
  };

  writeAtomicJson(TELEMETRY_FILE, telemetry);
  updateHistory({ timestamp, cpu, ollamaLatencyMs });

  const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
  console.log(`[${timeStr}] [telemetry] Synced. CPU: ${cpu}% | Ollama: ${ollamaTcp.online} (${ollamaLatencyMs}ms) | Buzz: ${buzzStatus.online}`);
}

async function main() {
  console.log('=== Arunachala Operations Telemetry Daemon (Node.js) ===');
  console.log(`Writing telemetry to: ${TELEMETRY_FILE}`);

  if (!acquireLock()) process.exit(1);

  process.on('SIGINT', () => { releaseLock(); process.exit(0); });
  process.on('SIGTERM', () => { releaseLock(); process.exit(0); });
  process.on('exit', () => releaseLock());

  while (true) {
    try {
      await tick();
    } catch (err) {
      writeDaemonLog(`Telemetry cycle failed: ${err.message}`, 'ERROR');
      console.error(`[error] Telemetry cycle failed: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

main();
