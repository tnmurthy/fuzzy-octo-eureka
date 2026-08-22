// server.js - Arunachala Operations Center local server
//
// Zero external dependencies (only Node's built-in http/fs/path modules),
// so `node server.js` just works without npm install.
//
// Replaces the old script-tag-injection telemetry trick: this dashboard
// used to be opened as a local file:// document, where fetch() of local
// JSON is blocked by CORS. Serving everything over http://localhost lifts
// that restriction, so the frontend can now use plain fetch().
//
// Usage:
//   node server.js
//   -> open http://localhost:8787

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const ReBACEngine = require('./rebac-engine');

const PORT = process.env.PORT || 8787;
const DASHBOARD_DIR = __dirname;
const TELEMETRY_FILE = path.join(DASHBOARD_DIR, 'telemetry.json');
const HISTORY_FILE = path.join(DASHBOARD_DIR, 'history.json');
const OPENCLAW_CACHE_FILE = path.join(DASHBOARD_DIR, 'openclaw-status.json');

const OLLAMA_HOST = '127.0.0.1';
const OLLAMA_PORT = 11434;
const PING_TIMEOUT_MS = 3000;

// openclaw CLI calls can take 30s-several minutes under memory pressure
// (each spawns a Node process that re-resolves the full skill/tool prompt).
// Poll on a slow interval in the background and serve a cache — never
// shell out on the request path, or dashboard polling would pile up
// concurrent `openclaw` processes and make the pressure worse.
const OPENCLAW_POLL_INTERVAL_MS = 60000;
const OPENCLAW_CLI_TIMEOUT_MS = 45000;
const CLOUD_PROVIDERS = new Set(['google', 'openai', 'anthropic']);
// server.js runs as an NSSM/Windows service under LocalSystem, whose PATH
// doesn't include the user's npm global bin dir — the openclaw shim has to
// be addressed by full path rather than relying on PATH resolution.
const OPENCLAW_BIN = 'C:\\Users\\Sriad\\AppData\\Roaming\\npm\\openclaw.cmd';
const OPENCLAW_HOME = 'C:\\Users\\Sriad';
// LocalSystem's own $HOME/$USERPROFILE isn't Sriad's profile, so point the
// CLI at the real config/state explicitly rather than letting it resolve
// (and silently operate on) the wrong home directory.
const OPENCLAW_ENV = Object.assign({}, process.env, {
  USERPROFILE: OPENCLAW_HOME,
  HOME: OPENCLAW_HOME,
  OPENCLAW_STATE_DIR: OPENCLAW_HOME + '\\.openclaw',
  OPENCLAW_CONFIG_PATH: OPENCLAW_HOME + '\\.openclaw\\openclaw.json'
});

// Initialize ReBAC Engine and Seed Permission Nodes & Relations
const rebac = new ReBACEngine();

// Nodes
rebac.addNode('user:sriad', 'User', { name: 'Sriad' });
rebac.addNode('team:opscore', 'Team', { name: 'Ops Core Team' });
rebac.addNode('role:admin', 'Role', { action: '*' });
rebac.addNode('perm:ping', 'Permission', { action: 'ping:execute' });
rebac.addNode('resource:ollama_cluster', 'Resource', { name: 'Ollama Cluster' });
rebac.addNode('resource:telemetry_feed', 'Resource', { name: 'Telemetry Feed' });

// Edges
rebac.addEdge('user:sriad', 'MEMBER_OF', 'team:opscore');
rebac.addEdge('team:opscore', 'GRANTED', 'role:admin');
rebac.addEdge('role:admin', 'INCLUDES', 'perm:ping');
rebac.addEdge('perm:ping', 'APPLIES_TO', 'resource:ollama_cluster');
rebac.addEdge('team:opscore', 'OWNER_OF', 'resource:telemetry_feed');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon'
};

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function serveJsonFile(res, filePath, emptyValue) {
  fs.readFile(filePath, 'utf8', (err, data) => {
    if (err) {
      return sendJson(res, 200, emptyValue);
    }
    try {
      const parsed = JSON.parse(data);
      sendJson(res, 200, parsed);
    } catch (parseErr) {
      sendJson(res, 200, emptyValue);
    }
  });
}

function serveStaticFile(req, res) {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';

  const filePath = path.join(DASHBOARD_DIR, urlPath);

  if (!filePath.startsWith(DASHBOARD_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found: ' + urlPath);
    }
    const ext = path.extname(filePath);
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      // This dashboard is under active edit and served through a Cloudflare
      // tunnel; without this, the CDN edge caches static JS/CSS/HTML past
      // client reloads (client no-store only bypasses the browser cache).
      'Cache-Control': 'no-cache, must-revalidate'
    });
    res.end(data);
  });
}

function handlePing(req, res) {
  // ReBAC Graph Authorization check
  const auth = rebac.canAccess('user:sriad', 'ping:execute', 'resource:ollama_cluster');
  if (!auth.authorized) {
    return sendJson(res, 403, { ok: false, error: 'ReBAC authorization denied', path: auth.path });
  }

  const start = Date.now();
  const timer = setTimeout(() => {
    apiReq.destroy();
    sendJson(res, 200, { ok: false, error: 'timeout', latencyMs: Date.now() - start, rebacPath: auth.path });
  }, PING_TIMEOUT_MS);

  const apiReq = http.get(
    { host: OLLAMA_HOST, port: OLLAMA_PORT, path: '/api/tags', timeout: PING_TIMEOUT_MS },
    (apiRes) => {
      let body = '';
      apiRes.on('data', chunk => { body += chunk; });
      apiRes.on('end', () => {
        clearTimeout(timer);
        const latencyMs = Date.now() - start;
        try {
          const parsed = JSON.parse(body);
          const models = (parsed.models || []).map(m => m.name);
          sendJson(res, 200, { ok: true, latencyMs, statusCode: apiRes.statusCode, models, rebacPath: auth.path });
        } catch (e) {
          sendJson(res, 200, { ok: apiRes.statusCode === 200, latencyMs, statusCode: apiRes.statusCode, models: [], rebacPath: auth.path });
        }
      });
    }
  );

  apiReq.on('error', () => {
    clearTimeout(timer);
    sendJson(res, 200, { ok: false, error: 'connection_failed', latencyMs: Date.now() - start, rebacPath: auth.path });
  });
}

let openclawCache = { ok: false, error: 'not_polled_yet', updatedAt: null };
let openclawPollInFlight = false;

function runOpenclaw(args) {
  return new Promise((resolve, reject) => {
    execFile(OPENCLAW_BIN, args, { timeout: OPENCLAW_CLI_TIMEOUT_MS, windowsHide: true, shell: true, env: OPENCLAW_ENV, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      // CLI prints occasional non-JSON notice lines before the JSON payload.
      const jsonStart = stdout.indexOf('{');
      const jsonStart2 = stdout.indexOf('[');
      const start = jsonStart === -1 ? jsonStart2 : (jsonStart2 === -1 ? jsonStart : Math.min(jsonStart, jsonStart2));
      if (start === -1) return reject(new Error('no JSON in output'));
      try {
        resolve(JSON.parse(stdout.slice(start)));
      } catch (parseErr) {
        reject(parseErr);
      }
    });
  });
}

function summarizeTokenUsage(sessions) {
  const usage = {
    local: { tokens: 0, sessions: 0, models: {} },
    cloud: { tokens: 0, sessions: 0, models: {} }
  };
  for (const s of sessions) {
    const bucket = CLOUD_PROVIDERS.has(s.modelProvider) ? usage.cloud : usage.local;
    bucket.sessions += 1;
    const tokens = typeof s.totalTokens === 'number' ? s.totalTokens : 0;
    bucket.tokens += tokens;
    const key = s.model || 'unknown';
    bucket.models[key] = (bucket.models[key] || 0) + tokens;
  }
  return usage;
}

async function pollOpenclawStatus() {
  if (openclawPollInFlight) return;
  openclawPollInFlight = true;
  try {
    const [sessionsResult, tasksResult] = await Promise.all([
      runOpenclaw(['sessions', '--all-agents', '--json']),
      runOpenclaw(['tasks', 'list', '--json'])
    ]);

    const sessions = sessionsResult.sessions || [];
    const tasks = tasksResult.tasks || [];
    const pending = tasks.filter(t => t.status === 'queued' || t.status === 'running');

    // A session "reset" is a fresh sessionId taking over an existing
    // conversation slot (agent:main:main, etc.) rather than the very
    // first session ever created for it.
    const resets = sessions.filter(s => s.sessionStartedAt && s.updatedAt && s.sessionStartedAt !== s.updatedAt).length;

    openclawCache = {
      ok: true,
      updatedAt: Date.now(),
      tokenUsage: summarizeTokenUsage(sessions),
      sessions: sessions.map(s => ({
        key: s.key,
        model: s.model,
        modelProvider: s.modelProvider,
        totalTokens: s.totalTokens,
        contextTokens: s.contextTokens,
        sessionStartedAt: s.sessionStartedAt,
        lastInteractionAt: s.lastInteractionAt || s.updatedAt,
        abortedLastRun: !!s.abortedLastRun
      })),
      sessionResets: resets,
      pendingTasks: pending.map(t => ({
        taskId: t.taskId,
        task: t.task,
        status: t.status,
        createdAt: t.createdAt,
        startedAt: t.startedAt
      })),
      pendingCount: pending.length,
      recentTasks: tasks.slice(0, 10).map(t => ({
        taskId: t.taskId,
        task: t.task,
        status: t.status,
        createdAt: t.createdAt,
        endedAt: t.endedAt,
        error: t.error || null
      }))
    };
    fs.writeFile(OPENCLAW_CACHE_FILE, JSON.stringify(openclawCache), () => {});
  } catch (err) {
    openclawCache = { ...openclawCache, ok: false, error: err.message, erroredAt: Date.now() };
  } finally {
    openclawPollInFlight = false;
  }
}

// Seed from last on-disk cache immediately, then poll on an interval.
fs.readFile(OPENCLAW_CACHE_FILE, 'utf8', (err, data) => {
  if (!err) {
    try { openclawCache = JSON.parse(data); } catch (parseErr) { /* keep default */ }
  }
});
pollOpenclawStatus();
setInterval(pollOpenclawStatus, OPENCLAW_POLL_INTERVAL_MS);

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/telemetry')) {
    return serveJsonFile(res, TELEMETRY_FILE, {});
  }
  if (req.url.startsWith('/api/history')) {
    return serveJsonFile(res, HISTORY_FILE, []);
  }
  if (req.url.startsWith('/api/rebac/inspect')) {
    return sendJson(res, 200, {
      nodes: Array.from(rebac.nodes.entries()),
      edges: rebac.edges
    });
  }
  if (req.url.startsWith('/api/ping')) {
    return handlePing(req, res);
  }
  if (req.url.startsWith('/api/openclaw')) {
    return sendJson(res, 200, openclawCache);
  }
  return serveStaticFile(req, res);
});

server.listen(PORT, () => {
  console.log(`Arunachala dashboard server running at http://localhost:${PORT}`);
  console.log(`Serving files from: ${DASHBOARD_DIR}`);
});

