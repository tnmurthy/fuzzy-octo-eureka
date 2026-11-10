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

// Per-person settings (paths, name) live in .env next to this file, so each
// teammate runs the same code with their own values. See .env.example.
// Secrets (e.g. SUPABASE_PASSWORD) can live in a separate file named by
// SECRETS_ENV_FILE, so they stay in the secrets folder (load-env.js).
require('./load-env').loadEnv(__dirname);

const PORT = process.env.PORT || 8787;
// Loopback only: the Cloudflare tunnel and every local caller (telemetry,
// OpenClaw) connect via 127.0.0.1, so nothing on the LAN needs this port.
const HOST = process.env.HOST || '127.0.0.1';

// Second lock behind Cloudflare Access (see access-auth.js). The AUD tag and
// team domain identify the "Arunachala Dashboard" Access app; neither is secret.
const { createAccessGate } = require('./access-auth');
const accessGate = createAccessGate({
  teamDomain: process.env.ACCESS_TEAM_DOMAIN || 'crimson-shape-5caa.cloudflareaccess.com',
  aud: process.env.ACCESS_AUD || 'a1267517591dc2a4da23dba816a1a929d96cc4ff12c926ac17e9303255d6c8bd',
  publicHostnames: (process.env.PUBLIC_HOSTNAMES || 'team.mytestbed.tech').split(','),
  allowedEmails: (process.env.ACCESS_ALLOWED_EMAILS || '').split(',').filter(Boolean),
});
const auth = require('./auth');
const teamManager = require('./team-manager');
const { getHostSpecs } = require('./host-specs');
const DASHBOARD_DIR = __dirname;
const TELEMETRY_FILE = path.join(DASHBOARD_DIR, 'telemetry.json');
const HISTORY_FILE = path.join(DASHBOARD_DIR, 'history.json');
const OPENCLAW_CACHE_FILE = path.join(DASHBOARD_DIR, 'openclaw-status.json');
const STACK_ROOT = process.env.STACK_ROOT || path.resolve(DASHBOARD_DIR, '../../..');
// Written by orchestration/agent-dispatch.sh: one start and one end line per
// task handed to Claude, Codex, Antigravity or Hermes.
const RUNS_FILE = process.env.AGENT_RUNS_FILE ||
  path.join(STACK_ROOT, '04_internal', 'agent-runs', 'runs.jsonl');
// Same default buzz-bridge/bridge.js uses for listRepos(): the parent of
// the active-projects folder this dashboard lives in.
const PROJECTS_DIR = process.env.PROJECTS_DIR || path.resolve(DASHBOARD_DIR, '..');
const { readRuns } = require('./runs-reader');
const { getInvoicingSummary } = require('./invoicing');
const DrisyonMemoryEngine = require('./memory-engine');
const memory = new DrisyonMemoryEngine({
  storagePath: path.join(DASHBOARD_DIR, 'drisyon-memory.json')
});
// Shared team context in Supabase; null (local files only) unless .env has
// the SUPABASE_* settings and TEAM_ID. See team-store/index.js.
const teamStore = require('./team-store').createTeamStore(process.env, {
  readRuns,
  runsFile: RUNS_FILE,
  stateFile: path.join(DASHBOARD_DIR, 'logs', 'run-sync-state.json'),
  callsFile: path.join(DASHBOARD_DIR, 'logs', 'ai-calls.jsonl'),
  callStateFile: path.join(DASHBOARD_DIR, 'logs', 'ai-sync-state.json'),
  readMemories: () => memory.episodicMemory,
  memoryStateFile: path.join(DASHBOARD_DIR, 'logs', 'memory-sync-state.json'),
});
if (teamStore) teamStore.start();
const { parseTasksMd, resolveTasksFile, addLocalTask, moveLocalTask } = require('./tasks-md');
const { validateDispatchSafety } = require('./safety-filter');
const { validateNewTask, validateStatus } = require('./team-store/tasks');
const {
  recordTranscript,
  getTranscripts,
  clearTranscripts,
  exportTranscriptsMarkdown
} = require('./chat-transcripts');

// Ollama connection details (can be local or remote, e.g. a Mac Studio on LAN/VPN)
const OLLAMA_HOST = process.env.OLLAMA_HOST || '127.0.0.1';
const OLLAMA_PORT = Number(process.env.OLLAMA_PORT) || 11434;

// Memory search by meaning: local nomic-embed-text embeddings, cached on
// disk; keyword scoring when Ollama is down or MEMORY_EMBEDDINGS=false.
const { createEmbedder } = require('./embeddings');
const { semanticSearch, docText } = require('./memory-search');
const embedder = process.env.MEMORY_EMBEDDINGS === 'false' ? null : createEmbedder({
  host: OLLAMA_HOST,
  port: OLLAMA_PORT,
  model: process.env.EMBED_MODEL || 'nomic-embed-text',
  cacheFile: path.join(DASHBOARD_DIR, 'logs', 'embeddings-cache.json'),
  onCall: (call) => recordAiCall(AI_CALLS_FILE, call),
});
const { buildDispatchPrompt, withTimeout } = require('./dispatch-context');
const DISPATCH_CONTEXT_TIMEOUT_MS = 4000;
const DISPATCH_CONTEXT_TOP_K = 3;
// Memories for a dispatch: team-wide when team sync is on, scoped to this repo
// plus global/all entries (another repo's client notes stay out).
function dispatchMemories(repo, task) {
  if (process.env.DISPATCH_MEMORY_CONTEXT === 'false') return Promise.resolve([]);
  const entries = teamStore
    ? teamStore.teamMemories().catch(() => memory.episodicMemory)
    : Promise.resolve(memory.episodicMemory);
  const lookup = entries
    .then((list) => searchMemory(list, task, { projectId: repo, topK: DISPATCH_CONTEXT_TOP_K }))
    .then((out) => out.results);
  return withTimeout(lookup, DISPATCH_CONTEXT_TIMEOUT_MS, []);
}
function searchMemory(entries, query, options) {
  if (!embedder) return Promise.resolve({ ranker: 'keywords', results: memory.searchEntries(entries, query, options) });
  return semanticSearch({ engine: memory, embedder, entries, query, options });
}
// Warm the cache for local memories in the background, so the first
// search does not pay for embedding every entry.
const EMBED_WARMUP_DELAY_MS = 15000;
if (embedder) {
  setTimeout(() => {
    embedder.embedDocuments(memory.episodicMemory.map(docText))
      .catch((err) => console.error(`embedding warm-up skipped: ${err.message}`));
  }, EMBED_WARMUP_DELAY_MS);
}

// Persona chat model. gemma3:4b answers at ~6.5 tok/s on this CPU-only box;
// qwen2.5:7b at ~3.1, which runs past the 45 s chat timeout on a full answer.
// A teammate with a GPU can set PERSONA_MODEL=qwen2.5:7b in .env.
const PERSONA_MODEL = process.env.PERSONA_MODEL || 'gemma3:4b';
// Ollama's length cap is num_predict (max_length is not an Ollama option and
// was silently ignored). ~400 tokens fits the 45 s timeout at gemma's speed.
const PERSONA_MAX_TOKENS = Number(process.env.PERSONA_MAX_TOKENS) || 400;

// Every model call goes in logs/ai-calls.jsonl (the bridge appends its router
// calls to the same file); team-store syncs it to Supabase when configured.
const AI_CALLS_FILE = path.join(DASHBOARD_DIR, 'logs', 'ai-calls.jsonl');
const { recordAiCall, readCalls, ollamaUsage } = require('./team-store/ai-ledger');
function recordPersonaCall(purpose, ollamaBody, ok = true) {
  recordAiCall(AI_CALLS_FILE, { provider: 'ollama', model: PERSONA_MODEL, purpose, ok, ...ollamaUsage(ollamaBody) });
}
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
// The person this install belongs to. Under LocalSystem os.homedir() is the
// system profile, so the install script writes OPERATOR_HOME into .env.
const OPENCLAW_HOME = process.env.OPERATOR_HOME || require('os').homedir();
const OPERATOR_NAME = process.env.OPERATOR_NAME || 'Operator';
const OPENCLAW_BIN = process.env.OPENCLAW_BIN ||
  (process.platform === 'win32'
    ? path.join(OPENCLAW_HOME, 'AppData', 'Roaming', 'npm', 'openclaw.cmd')
    : 'openclaw');
// LocalSystem's own $HOME/$USERPROFILE isn't the operator's profile, so point the
// CLI at the real config/state explicitly rather than letting it resolve
// (and silently operate on) the wrong home directory.
const OPENCLAW_ENV = Object.assign({}, process.env, {
  USERPROFILE: OPENCLAW_HOME,
  HOME: OPENCLAW_HOME,
  OPENCLAW_STATE_DIR: path.join(OPENCLAW_HOME, '.openclaw'),
  OPENCLAW_CONFIG_PATH: path.join(OPENCLAW_HOME, '.openclaw', 'openclaw.json')
});

// Initialize ReBAC Engine and Seed Permission Nodes & Relations
const rebac = new ReBACEngine();

// Nodes
rebac.addNode('user:sriad', 'User', { name: 'Sriad' });
rebac.addNode('user:drisyon', 'User', { name: 'Drisyon AI' });
rebac.addNode('team:opscore', 'Team', { name: 'Ops Core Team' });
rebac.addNode('role:admin', 'Role', { action: '*' });
rebac.addNode('perm:ping', 'Permission', { action: 'ping:execute' });
rebac.addNode('perm:dispatch', 'Permission', { action: 'dispatch:run' });
rebac.addNode('perm:chat', 'Permission', { action: 'chat:interact' });
rebac.addNode('perm:memory_store', 'Permission', { action: 'memory:store' });
rebac.addNode('perm:memory_read', 'Permission', { action: 'memory:read' });
rebac.addNode('resource:ollama_cluster', 'Resource', { name: 'Ollama Cluster' });
rebac.addNode('resource:agent_runner', 'Resource', { name: 'Agent Runner' });
rebac.addNode('resource:telemetry_feed', 'Resource', { name: 'Telemetry Feed' });
rebac.addNode('resource:memory_engine', 'Resource', { name: 'Memory Engine' });

// Edges
rebac.addEdge('user:sriad', 'MEMBER_OF', 'team:opscore');
rebac.addEdge('user:drisyon', 'MEMBER_OF', 'team:opscore');
rebac.addEdge('team:opscore', 'GRANTED', 'role:admin');
rebac.addEdge('role:admin', 'INCLUDES', 'perm:ping');
rebac.addEdge('role:admin', 'INCLUDES', 'perm:dispatch');
rebac.addEdge('role:admin', 'INCLUDES', 'perm:chat');
rebac.addEdge('role:admin', 'INCLUDES', 'perm:memory_store');
rebac.addEdge('role:admin', 'INCLUDES', 'perm:memory_read');
rebac.addEdge('perm:ping', 'APPLIES_TO', 'resource:ollama_cluster');
rebac.addEdge('perm:chat', 'APPLIES_TO', 'resource:ollama_cluster');
rebac.addEdge('perm:dispatch', 'APPLIES_TO', 'resource:agent_runner');
rebac.addEdge('perm:memory_store', 'APPLIES_TO', 'resource:memory_engine');
rebac.addEdge('perm:memory_read', 'APPLIES_TO', 'resource:memory_engine');
rebac.addEdge('team:opscore', 'OWNER_OF', 'resource:telemetry_feed');

function getReqUserNode(req) {
  if (req.headers && req.headers['x-rebac-actor']) {
    return String(req.headers['x-rebac-actor']).trim();
  }
  const user = req.sessionUser || auth.getSessionUser(req);
  if (user) {
    const clean = String(user).toLowerCase().trim();
    if (clean === 'drisyon' || clean.includes('drisyon')) return 'user:drisyon';
    if (clean === 'sriad' || clean.includes('sriad')) return 'user:sriad';
    return `user:${clean}`;
  }
  return 'user:sriad';
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
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
      // PowerShell 5.1 Out-File -Encoding utf8 emits a BOM; JSON.parse rejects it.
      const parsed = JSON.parse(data.replace(/^\ufeff/, ''));
      sendJson(res, 200, parsed);
    } catch (parseErr) {
      sendJson(res, 200, emptyValue);
    }
  });
}

function serveStaticFile(req, res) {
  let urlPath = req.url.split('?')[0];
  const isDrisyon = PORT == 8788 || process.env.STRICT_TENANT_ISOLATION === 'true';
  if (urlPath === '/') urlPath = isDrisyon ? '/drisyon.html' : '/index.html';
  if (urlPath === '/drisyon' || urlPath === '/portal') urlPath = '/drisyon.html';
  if (urlPath === '/wiki') urlPath = '/wiki.html';
  if (urlPath === '/team') urlPath = '/team.html';
  if (urlPath === '/costing') urlPath = '/costing.html';
  if (urlPath === '/invoicing') urlPath = '/invoicing.html';

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
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate'
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

const MAX_TASK_BODY_BYTES = 10 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readJsonBody(req, limit) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > limit) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', async () => {
      try { resolve(JSON.parse(body || '{}')); } catch { reject(new Error('bad JSON')); }
    });
  });
}

const TASK_AUDIT_LOG = path.join(DASHBOARD_DIR, 'logs', 'task-audit.jsonl');

function recordTaskTransitionAudit(taskId, task, newStatus, actor) {
  const entry = {
    timestamp: new Date().toISOString(),
    taskId: taskId || (task && task.id),
    title: (task && (task.task || task.title)) || taskId,
    status: newStatus,
    actor: actor || 'user:operator',
    decisionRights: newStatus === 'human_review' ? 'sovereign' : (newStatus === 'planning' ? 'copilot' : 'autonomous')
  };

  fs.appendFile(TASK_AUDIT_LOG, JSON.stringify(entry) + '\n', (err) => {
    if (err) console.error('Failed to append task audit log:', err.message);
  });

  // If entering Sovereign Review, trigger alert webhook (e.g. n8n or Buzz bridge)
  if (newStatus === 'human_review') {
    const alertPayload = {
      event: 'sovereign_review_required',
      taskId: entry.taskId,
      title: entry.title,
      timestamp: entry.timestamp,
      actor: entry.actor,
      url: 'http://127.0.0.1:8787/#kanban'
    };
    const webhookUrl = process.env.N8N_ALERT_WEBHOOK_URL || 'http://127.0.0.1:5678/webhook/sovereign-alert';
    try {
      fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(alertPayload),
        signal: AbortSignal.timeout(1500)
      }).catch(() => {});
    } catch {}
  }
}

// Task Board. With team-store on, the shared board in Supabase (create with
// POST /api/tasks, move with PATCH /api/tasks/<id>); otherwise, or if the
// team board can't be reached, the read-only 04_internal/TASKS.md.
function handleTasks(req, res) {
  const tasksFile = resolveTasksFile(DASHBOARD_DIR);
  const readLocal = (note) => {
    fs.readFile(tasksFile, 'utf8', (err, data) => {
      if (err) {
        return sendJson(res, 200, { ok: false, error: 'TASKS.md not found', columns: { backlog: [], in_progress: [], done: [] } });
      }
      try {
        sendJson(res, 200, { ok: true, source: 'local', file: tasksFile, ...(note ? { note } : {}), columns: parseTasksMd(data) });
      } catch (e) {
        sendJson(res, 500, { ok: false, error: e.message });
      }
    });
  };

  const id = req.url.split('?')[0].split('/')[3];

  if (req.method === 'GET') {
    if (id === 'audit') {
      return fs.readFile(TASK_AUDIT_LOG, 'utf8', (err, data) => {
        if (err) return sendJson(res, 200, { ok: true, audit: [] });
        const entries = data.trim().split('\n').filter(Boolean).map(l => {
          try { return JSON.parse(l); } catch { return null; }
        }).filter(Boolean).reverse().slice(0, 50);
        return sendJson(res, 200, { ok: true, audit: entries });
      });
    }
    if (!id) {
      if (!teamStore) return readLocal();
      teamStore.teamTasks()
        .then((body) => sendJson(res, 200, body))
        .catch((err) => readLocal(`team board unavailable: ${err.message}`));
      return;
    }
  }

  const actor = (req.sessionUser && String(req.sessionUser).toLowerCase().includes('drisyon')) ? 'user:drisyon' : 'user:sriad';

  if (req.method === 'POST' && !id) {
    readJsonBody(req, MAX_TASK_BODY_BYTES)
      .then((input) => {
        const v = validateNewTask(input);
        if (!v.ok) return sendJson(res, 400, { ok: false, error: v.error });
        if (teamStore) {
          return teamStore.createTask(v.task).then((task) => {
            recordTaskTransitionAudit(task.id, task, task.status, actor);
            return sendJson(res, 201, { ok: true, task });
          });
        }
        try {
          const task = addLocalTask(tasksFile, v.task);
          recordTaskTransitionAudit(task.id, task, task.status, actor);
          return sendJson(res, 201, { ok: true, source: 'local', task });
        } catch (e) {
          return sendJson(res, 500, { ok: false, error: e.message });
        }
      })
      .catch((err) => sendJson(res, 400, { ok: false, error: err.message }));
    return;
  }
  if (req.method === 'PATCH' && id && id !== 'audit') {
    readJsonBody(req, MAX_TASK_BODY_BYTES)
      .then((input) => {
        if (!validateStatus(input.status)) return sendJson(res, 400, { ok: false, error: 'status must be backlog, in_progress or done' });
        if (teamStore) {
          if (!UUID_RE.test(id)) return sendJson(res, 400, { ok: false, error: 'task id must be a UUID' });
          return teamStore.moveTask(id, input.status).then((task) => {
            if (task) recordTaskTransitionAudit(id, task, input.status, actor);
            return task
              ? sendJson(res, 200, { ok: true, task })
              : sendJson(res, 404, { ok: false, error: 'no such task on your team board' });
          });
        }
        try {
          const task = moveLocalTask(tasksFile, id, input.status);
          if (task) recordTaskTransitionAudit(id, task, input.status, actor);
          return task
            ? sendJson(res, 200, { ok: true, source: 'local', task })
            : sendJson(res, 404, { ok: false, error: `no such task found: ${id}` });
        } catch (e) {
          return sendJson(res, 500, { ok: false, error: e.message });
        }
      })
      .catch((err) => sendJson(res, 400, { ok: false, error: err.message }));
    return;
  }
  return sendJson(res, 405, { ok: false, error: 'use GET, POST /api/tasks or PATCH /api/tasks/<id>' });
}

// Costs tab: what the AI cost in the last ?days (1-90, default 7), from the
// local ledger or, with ?scope=team, the team's; plus advice on cutting it.
const { summarizeCalls, paidCallsSince, autoStats, advice, fromTeamRow } = require('./team-store/costs');
const MAX_COST_DAYS = 90;
function computeCosts(days, wantTeam) {
  const auto = autoStats(readRuns(RUNS_FILE, 1000).runs || []);
  const midnight = new Date(new Date().toISOString().slice(0, 10)).getTime();
  const build = (source, calls, limits, note) => {
    const summary = summarizeCalls(calls, { days });
    const paidCallsToday = paidCallsSince(calls, midnight);
    return {
      ok: true, source, days, summary, auto, limits, paidCallsToday,
      advice: advice({ summary, auto, limits, paidCallsToday, localFirstEnabled: process.env.DISPATCH_LOCAL_FIRST === 'true' }),
      ...(note ? { note } : {}),
    };
  };
  const local = (note) => build('local', readCalls(AI_CALLS_FILE), null, note);
  if (!teamStore || !wantTeam) return Promise.resolve(local());
  return Promise.all([teamStore.teamCalls(days), teamStore.teamLimits()])
    .then(([rows, limits]) => build('team', rows.map(fromTeamRow), limits))
    .catch((err) => local(`team costs unavailable: ${err.message}`));
}

function handleCosts(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const days = Math.min(MAX_COST_DAYS, Math.max(1, Number(url.searchParams.get('days')) || 7));
  computeCosts(days, url.searchParams.get('scope') === 'team')
    .then((body) => sendJson(res, 200, body))
    .catch((err) => sendJson(res, 500, { ok: false, error: err.message }));
}

// Weekly digest text for Buzz (the bridge posts it Monday 09:00 IST): the
// team's view when team sync is on, else this machine's.
const { buildDigest } = require('./digest');
const DIGEST_DAYS = 7;
function handleDigest(req, res) {
  const since = Date.now() - DIGEST_DAYS * 24 * 60 * 60 * 1000;
  const recent = (runs) => runs.filter((r) => Date.parse(r.started_at) >= since);
  const runsP = teamStore
    ? teamStore.teamRuns().then((b) => b.runs).catch(() => readRuns(RUNS_FILE, 1000).runs || [])
    : Promise.resolve(readRuns(RUNS_FILE, 1000).runs || []);
  Promise.all([computeCosts(DIGEST_DAYS, true), runsP])
    .then(([costs, runs]) => sendJson(res, 200, { ok: true, text: buildDigest({ costs, runs: recent(runs) }) }))
    .catch((err) => sendJson(res, 500, { ok: false, error: err.message }));
}

function listAvailableRepos() {
  const dirs = [
    DASHBOARD_DIR,
    PROJECTS_DIR,
    path.resolve(DASHBOARD_DIR, '..'),
    path.resolve(process.env.STACK_ROOT || '/Users/Sriad/tt-ai-stack', 'tools')
  ];
  const repos = new Map();
  repos.set(path.basename(DASHBOARD_DIR), DASHBOARD_DIR);

  for (const d of dirs) {
    if (!fs.existsSync(d)) continue;
    try {
      const entries = fs.readdirSync(d, { withFileTypes: true });
      for (const ent of entries) {
        if (ent.isDirectory() && !ent.name.includes('--') && !ent.name.startsWith('.')) {
          const fullPath = path.join(d, ent.name);
          if (fs.existsSync(path.join(fullPath, '.git'))) {
            repos.set(ent.name, fullPath);
          }
        }
      }
    } catch (_) {}
  }
  return Array.from(repos.entries()).map(([name, repoPath]) => ({ name, path: repoPath }));
}

function resolveRepoPath(repo) {
  if (repo === path.basename(DASHBOARD_DIR) || repo === '.') return DASHBOARD_DIR;
  const repos = listAvailableRepos();
  const match = repos.find(r => r.name === repo);
  if (match) return match.path;
  return path.resolve(PROJECTS_DIR, repo);
}

function spawnAgentDispatch({ agent, repo, repoPath, branch, task, runId }) {
  const safeBranch = (branch && /^[a-zA-Z0-9._/-]+$/.test(branch)) ? branch : `buzz/${Date.now()}`;
  const effectiveRunId = runId || `${new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)}-${agent}-${Math.random().toString(36).slice(2, 8)}`;

  return dispatchMemories(repo, task).then((memories) => {
    const tmpDir = path.join(DASHBOARD_DIR, 'logs', 'dispatch-prompts');
    fs.mkdirSync(tmpDir, { recursive: true });
    const promptFile = path.join(tmpDir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
    fs.writeFileSync(promptFile, buildDispatchPrompt(task, memories), 'utf8');

    const scriptPath = path.resolve(DASHBOARD_DIR, 'orchestration', 'agent-dispatch.sh');
    const bashBin = process.env.DISPATCH_BASH_BIN || (process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : '/bin/bash');
    const isWin = process.platform === 'win32';
    const pathDirs = [
      path.dirname(process.execPath),
      path.join(OPENCLAW_HOME, '.local', 'bin'),
      isWin ? path.join(OPENCLAW_HOME, 'AppData', 'Roaming', 'npm') : path.join(OPENCLAW_HOME, '.npm-global', 'bin'),
      isWin ? path.join(OPENCLAW_HOME, 'AppData', 'Local', 'Programs', 'OpenAI', 'Codex', 'bin') : '/opt/homebrew/bin',
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
      process.env.PATH || '',
    ].filter(Boolean);

    const dispatchEnv = Object.assign({}, process.env, {
      AGENT_RUNS_DIR: path.dirname(RUNS_FILE),
      AI_CALLS_FILE,
      PATH: pathDirs.join(path.delimiter),
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'safe.directory',
      GIT_CONFIG_VALUE_0: `${PROJECTS_DIR.replace(/\\/g, '/')}/*`,
      USERPROFILE: OPENCLAW_HOME,
      HOME: OPENCLAW_HOME,
    });

    if (isWin) {
      dispatchEnv.APPDATA = path.join(OPENCLAW_HOME, 'AppData', 'Roaming');
      dispatchEnv.LOCALAPPDATA = path.join(OPENCLAW_HOME, 'AppData', 'Local');
    }

    const child = require('child_process').spawn(
      bashBin,
      [scriptPath, agent, repoPath, safeBranch, promptFile, effectiveRunId],
      {
        cwd: DASHBOARD_DIR,
        windowsHide: true,
        detached: true,
        stdio: 'ignore',
        env: dispatchEnv,
      }
    );
    child.unref();
    child.on('error', (err) => console.error('dispatch spawn failed:', err.message));

    return { runId: effectiveRunId, agent, repo, branch: safeBranch };
  });
}

function detectActionableTask(message, agentKey) {
  if (!message || typeof message !== 'string') return { actionable: false };
  const text = message.trim();
  if (text.length < 3) return { actionable: false };

  // Explicit directive prefix patterns
  const directivePrefixRegex = /^(?:task|todo|do|assign|directive|instruction|command|run|dispatch):\s*(.+)$/i;
  const prefixMatch = text.match(directivePrefixRegex);
  const taskContent = prefixMatch ? prefixMatch[1].trim() : text;

  // Conversational / greeting patterns that should NOT trigger dispatch on their own
  const conversationalRegex = /^(hi|hello|hey|greetings|good\s+(morning|afternoon|evening)|who\s+are\s+you\??|what\s+can\s+you\s+do\??|what\s+is\s+your\s+role\??|are\s+you\s+(there|up|ready)\??|status\??|help\??|test)$/i;
  if (!prefixMatch && taskContent.length < 35 && conversationalRegex.test(taskContent)) {
    return { actionable: false };
  }

  // Action verbs / imperative keywords indicating real work
  const actionVerbRegex = /\b(build|fix|implement|create|add|update|refactor|audit|test|scan|write|deploy|generate|delete|remove|patch|repair|clean|setup|configure|verify|inspect|run|investigate|execute|dispatch|benchmark|monitor|migrate|resolve|develop|scaffold|optimize|automate)\b/i;

  if (prefixMatch || actionVerbRegex.test(taskContent)) {
    // Determine target subagent
    let targetAgent = 'auto'; // default: local hermes first with claude fallback
    const lower = taskContent.toLowerCase();

    const isSecurityAudit = (agentKey === 'sec') ||
      /\b(security\s+(audit|scan|review|assessment|probe|check|test)|vulnerability|mantis|rebac|cve|penetration|pentest|exploit|threat\s+model|access\s+control\s+audit)\b/i.test(taskContent);
    const isQA = (agentKey === 'qa') ||
      /\b(unit\s+test|e2e|integration\s+test|lint|pre-commit|test\s+suite|coverage|vitest|jest)\b/i.test(taskContent);
    const isAdvisory = /\b(plan|strategy|enroll|enrolling|marketing|campaign|pitch|outreach|proposal|deck|copy|advisory|gtm|funnel|pricing|sow)\b/i.test(taskContent) &&
      !/\b(code|script|api|endpoint|unit\s+test|refactor|function|database|schema|docker|bug|fix|pr|commit|repo)\b/i.test(taskContent);

    if (isAdvisory) {
      targetAgent = 'advisory';
    } else if (isSecurityAudit) {
      targetAgent = 'mantis';
    } else if (isQA) {
      targetAgent = 'auto';
    } else if (agentKey === 'hermes' || lower.includes('@hermes') || lower.includes('hermes runner')) {
      targetAgent = 'hermes';
    } else if (agentKey === 'openhands' || lower.includes('canvas') || lower.includes('openhands')) {
      targetAgent = 'openhands';
    } else if (lower.includes('@claude')) {
      targetAgent = 'claude';
    } else if (lower.includes('@codex')) {
      targetAgent = 'codex';
    } else if (lower.includes('@mantis')) {
      targetAgent = 'mantis';
    }

    return {
      actionable: true,
      task: taskContent,
      targetAgent,
      isAdvisory
    };
  }

  return { actionable: false };
}

function handleRequest(req, res) {
  // ── OpenHands Canvas Proxy (Phase 2) ──
  if (req.url.startsWith('/canvas') || req.url.startsWith('/vscode')) {
    const proxyReq = http.request({
      host: '127.0.0.1',
      port: 8000,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: '127.0.0.1:8000' }
    }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });
    proxyReq.on('error', (err) => {
      res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<h3>502 Bad Gateway: OpenHands container unreachable on port 8000</h3><p>${err.message}</p>`);
    });
    req.pipe(proxyReq);
    return;
  }

  // ── Auth & Team Management Endpoints ──
  if (req.url.startsWith('/login')) {
    const user = auth.getSessionUser(req);
    if (user && req.method === 'GET') {
      res.writeHead(302, { Location: '/' });
      return res.end();
    }
    req.url = '/login.html';
    return serveStaticFile(req, res);
  }

  if (req.url.startsWith('/logout')) {
    res.writeHead(302, {
      'Set-Cookie': auth.clearSessionCookie(),
      Location: '/login'
    });
    return res.end();
  }

  if (req.url.startsWith('/api/auth/login') && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { username, password, activateTeam } = JSON.parse(body || '{}');
        if (!auth.verifyCredentials(username, password)) {
          return sendJson(res, 401, { ok: false, error: 'Invalid username or password' });
        }

        let teamActivation = null;
        if (activateTeam !== false) {
          teamActivation = teamManager.activateTeam(`Login by ${username}`);
        }

        const cookie = auth.createSessionCookie(username);
        res.writeHead(200, {
          'Set-Cookie': cookie,
          'Content-Type': 'application/json'
        });
        res.end(JSON.stringify({
          ok: true,
          user: username,
          activated: true,
          teamActivation,
          message: 'Logged in successfully. Buzz AI Team activated on Mac Studio.'
        }));
      } catch (err) {
        sendJson(res, 400, { ok: false, error: err.message });
      }
    });
    return;
  }

  if (req.url.startsWith('/api/auth/logout')) {
    res.writeHead(200, {
      'Set-Cookie': auth.clearSessionCookie(),
      'Content-Type': 'application/json'
    });
    return res.end(JSON.stringify({ ok: true, message: 'Logged out successfully' }));
  }

  if (req.url.startsWith('/api/auth/me') || req.url.startsWith('/api/auth/status')) {
    const user = auth.getSessionUser(req);
    return sendJson(res, 200, {
      authenticated: !!user,
      user: user || null,
      teamStatus: teamManager.getTeamStatus()
    });
  }

  if (req.url.startsWith('/api/team/status')) {
    return sendJson(res, 200, teamManager.getTeamStatus());
  }

  if (req.url.startsWith('/api/team/activate') && req.method === 'POST') {
    const user = auth.getSessionUser(req) || 'dashboard';
    const result = teamManager.activateTeam(`Manual activation by ${user}`);
    return sendJson(res, result.ok ? 200 : 500, result);
  }

  if (req.url.startsWith('/api/team/deactivate') && req.method === 'POST') {
    const result = teamManager.deactivateTeam();
    return sendJson(res, result.ok ? 200 : 500, result);
  }

  if (req.url.startsWith('/api/team/directive') && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { channelId, content } = JSON.parse(body || '{}');
        if (!channelId || !content) {
          return sendJson(res, 400, { ok: false, error: 'channelId and content required' });
        }
        const result = teamManager.sendDirective(channelId, content);
        return sendJson(res, 200, { ok: true, result });
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: err.message });
      }
    });
    return;
  }

  if (req.url.startsWith('/api/telemetry')) {
    let telemetry = {};
    if (fs.existsSync(TELEMETRY_FILE)) {
      try {
        telemetry = JSON.parse(fs.readFileSync(TELEMETRY_FILE, 'utf8'));
      } catch (_) {}
    }
    if (!telemetry.host) {
      telemetry.host = getHostSpecs();
    }
    return sendJson(res, 200, telemetry);
  }
  if (req.url.startsWith('/api/digest')) {
    return handleDigest(req, res);
  }
  if (req.url.startsWith('/api/costs')) {
    return handleCosts(req, res);
  }
  if (req.url.startsWith('/api/invoicing/summary')) {
    const url = new URL(req.url, 'http://localhost');
    const clientKey = url.searchParams.get('client') || 'telangana-live';
    const summary = getInvoicingSummary({
      baseDir: DASHBOARD_DIR,
      tasksFile: resolveTasksFile(DASHBOARD_DIR),
      runsFile: RUNS_FILE,
      callsFile: AI_CALLS_FILE,
      clientKey
    });
    return sendJson(res, 200, summary);
  }
  if (req.url.startsWith('/api/config')) {
    return sendJson(res, 200, { operatorName: OPERATOR_NAME, personaModel: PERSONA_MODEL, host: getHostSpecs() });
  }
  if (req.url.startsWith('/api/history')) {
    return serveJsonFile(res, HISTORY_FILE, []);
  }
  if (req.url.startsWith('/api/runs')) {
    // ?scope=team: every teammate's runs from Supabase; local file if that fails.
    if (teamStore && /[?&]scope=team(&|$)/.test(req.url)) {
      teamStore.teamRuns()
        .then((body) => sendJson(res, 200, body))
        .catch((err) => sendJson(res, 200, { ...readRuns(RUNS_FILE), source: 'local', note: `team runs unavailable: ${err.message}` }));
      return;
    }
    return sendJson(res, 200, readRuns(RUNS_FILE));
  }
  if (req.url.startsWith('/api/repos')) {
    return sendJson(res, 200, { ok: true, repos: listAvailableRepos() });
  }
  if (req.url.startsWith('/api/rebac/inspect')) {
    const actor = (req.sessionUser && String(req.sessionUser).toLowerCase().includes('drisyon')) ? 'user:drisyon' : 'user:sriad';
    const authVerdict = rebac.canAccess(actor, 'ping:execute', 'resource:ollama_cluster');
    if (!authVerdict.authorized) {
      return sendJson(res, 403, { ok: false, error: 'ReBAC authorization denied' });
    }
    return sendJson(res, 200, {
      nodes: Array.from(rebac.nodes.entries()),
      edges: rebac.edges
    });
  }
  if (req.url.startsWith('/api/tasks')) {
    return handleTasks(req, res);
  }
  if (req.url.startsWith('/api/agent/transcripts')) {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const agentFilter = parsedUrl.searchParams.get('agent');
    const limit = parseInt(parsedUrl.searchParams.get('limit') || '100', 10);
    const exportMode = parsedUrl.searchParams.get('export');

    if (req.method === 'DELETE') {
      const cleared = clearTranscripts({ agent: agentFilter });
      return sendJson(res, 200, { ok: cleared, clearedAgent: agentFilter || 'all' });
    }

    if (exportMode === 'md' || exportMode === 'markdown') {
      const mdContent = exportTranscriptsMarkdown({ agent: agentFilter });
      const filename = `transcript-${agentFilter || 'all-agents'}-${new Date().toISOString().slice(0, 10)}.md`;
      res.writeHead(200, {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`
      });
      return res.end(mdContent);
    }

    const transcripts = getTranscripts({ agent: agentFilter, limit });
    return sendJson(res, 200, {
      ok: true,
      agent: agentFilter || 'all',
      count: transcripts.length,
      transcripts
    });
  }
  if (req.url.startsWith('/api/agent/chat') && req.method === 'POST') {
    const actor = getReqUserNode(req);
    const authVerdict = rebac.canAccess(actor, 'chat:interact', 'resource:ollama_cluster');
    if (!authVerdict.authorized) {
      return sendJson(res, 403, { ok: false, error: 'ReBAC authorization denied: chat:interact required', path: authVerdict.path });
    }
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        const userMessage = payload.message || '';
        const agentKey = payload.agent || 'po';
        const agentTitles = {
          po: "🧭 Arunachala Ramana",
          bizdev: "💼 Vikram Patel",
          marketing: "📢 Priya Nair",
          tech: "💻 Tech Lead & Architect",
          qa: "🧪 QA & Verification Specialist",
          sec: "🛡️ AppSec Lead (Mantis)",
          cfo: "📊 Ananya Sundaram",
          infra: "🛠️ DevOps & Infrastructure",
          doc: "📝 Documentation Specialist",
          hermes: "🐍 Hermes Local Runner"
        };
        const agentSystemPrompts = {
          po: "You are Arunachala Ramana, AI Product Strategist & Product Owner for tt-ai-stack. You are calm, strategic, practical, and precise. Help the user break down scope, plan architectures, orchestrate tech/qa/infra/doc subagents, and prioritize tasks.",
          bizdev: "You are the Revenue & Client Acquisition Lead for Drisyon AI. You evaluate client RFPs, draft Statements of Work (SOWs), price project milestones, and ensure deals are structured for high gross margins.",
          marketing: "You are the DevRel & Growth Marketing Specialist for Drisyon AI. You write technical case studies, distill engineering wins into public thought leadership, and drive inbound demand across Nostr, X, and LinkedIn.",
          tech: "You are Tech Lead & Architect for tt-ai-stack. You specialize in code implementation, refactoring, and system architecture.",
          qa: "You are QA & Verification Specialist for tt-ai-stack. You focus on automated testing, validation, and pre-commit checks.",
          sec: "You are the AppSec Specialist & Security Auditor (Google Mantis). You audit API routes, reproduce vulnerabilities, and verify ReBAC tenant isolation.",
          cfo: "You are the AI Unit Economics & Finance Controller. You audit token consumption, calculate gross margins per client, and ensure delivery remains 80-90% profitable through local-first compute.",
          infra: "You are DevOps & Infrastructure Specialist for tt-ai-stack. You manage Docker, Ollama configurations, and runtime health.",
          doc: "You are Documentation Specialist for tt-ai-stack. You maintain memory logs, changelogs, and project state."
        };

        const targetRepo = payload.repo || path.basename(DASHBOARD_DIR);
        const targetRepoPath = resolveRepoPath(targetRepo);

        // Detect if the directive is actionable
        const taskInfo = (payload.dispatch === true)
          ? { actionable: true, task: userMessage, targetAgent: payload.targetAgent || 'auto' }
          : detectActionableTask(userMessage, agentKey);

        let dispatchPromise = Promise.resolve(null);
        let dispatchWarning = null;

        if (taskInfo.actionable) {
          if (taskInfo.isAdvisory) {
            // Advisory / GTM initiative: persist in memory and tasks board without spawning code runners
            try {
              memory.storeMemory({
                title: `Advisory Directive: [${agentKey.toUpperCase()}] ${taskInfo.task.slice(0, 50)}`,
                content: `Strategist (${agentKey}) logged advisory initiative: "${taskInfo.task}".`,
                category: 'advisory_plan',
                tenantId: actor.includes('drisyon') ? 'tenant:drisyon_core' : 'tenant:default',
                projectId: targetRepo
              });
            } catch (_) {}

            try {
              const tasksFile = resolveTasksFile(DASHBOARD_DIR);
              const taskObj = {
                title: taskInfo.task,
                project: targetRepo,
                owner: agentKey,
                status: 'intake',
                decision: 'copilot'
              };
              if (teamStore) {
                teamStore.createTask(taskObj).catch(() => {});
              } else {
                addLocalTask(tasksFile, taskObj);
              }
            } catch (_) {}
          } else {
            const safetyCheck = validateDispatchSafety(taskInfo.task, payload);
            if (!safetyCheck.ok) {
              dispatchWarning = safetyCheck.error;
            } else {
              const branch = `${agentKey}/${taskInfo.targetAgent}-${Date.now().toString(36)}`;
              dispatchPromise = spawnAgentDispatch({
                agent: taskInfo.targetAgent,
                repo: targetRepo,
                repoPath: targetRepoPath,
                branch,
                task: taskInfo.task
              }).then((dispatchRes) => {
                // Record in episodic memory
                try {
                  memory.storeMemory({
                    title: `Task Dispatched: [${taskInfo.targetAgent.toUpperCase()}] ${taskInfo.task.slice(0, 50)}`,
                    content: `Strategist (${agentKey}) dispatched subagent ${taskInfo.targetAgent} on branch ${branch} for repository ${targetRepo}. Task: "${taskInfo.task}". Run ID: ${dispatchRes.runId}.`,
                    category: 'task_dispatch',
                    tenantId: actor.includes('drisyon') ? 'tenant:drisyon_core' : 'tenant:default',
                    projectId: targetRepo
                  });
                } catch (_) {}

                // Record in task board (TASKS.md / teamStore)
                try {
                  const tasksFile = resolveTasksFile(DASHBOARD_DIR);
                  const taskObj = {
                    title: taskInfo.task,
                    project: targetRepo,
                    owner: taskInfo.targetAgent,
                    status: 'in_execution',
                    decision: 'autonomous'
                  };
                  if (teamStore) {
                    teamStore.createTask(taskObj).catch(() => {});
                  } else {
                    addLocalTask(tasksFile, taskObj);
                  }
                } catch (_) {}

                return dispatchRes;
              }).catch((err) => {
                console.error('Task dispatch spawn failed:', err.message);
                return { error: err.message };
              });
            }
          }
        }

        let contextBlock = '';
        try {
          const memories = await dispatchMemories(targetRepo, userMessage);
          if (memories && memories.length > 0) {
            contextBlock = '\n\n---\nTeam & Project Context (shared memory):\n' +
              memories.map(m => `- [${m.category || 'context'}] ${m.title}: ${(m.content || '').replace(/\s+/g, ' ').slice(0, 300)}`).join('\n');
          }
        } catch (_) {}

        const baseSystemPrompt = agentSystemPrompts[agentKey] || agentSystemPrompts.po;
        const systemPrompt = baseSystemPrompt + contextBlock;
        const ollamaReqData = JSON.stringify({
          model: PERSONA_MODEL,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage }
          ],
          stream: false,
          options: { temperature: 0.3, num_predict: PERSONA_MAX_TOKENS }
        });

        const ollamaReq = http.request({
          host: OLLAMA_HOST,
          port: OLLAMA_PORT,
          path: '/api/chat',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(ollamaReqData)
          },
          timeout: 45000
        }, (ollamaRes) => {
          let resData = '';
          ollamaRes.on('data', chunk => { resData += chunk; });
          ollamaRes.on('end', async () => {
            try {
              const parsed = JSON.parse(resData);
              recordPersonaCall('persona', parsed);
              // Handle different model response formats
              let reply = 'No response from model.';
              if (parsed.message && parsed.message.content) {
                reply = parsed.message.content;
              } else if (parsed.choices && parsed.choices[0] && parsed.choices[0].text) {
                reply = parsed.choices[0].text;
              } else if (typeof parsed === 'string') {
                reply = parsed;
              }

              const dispatchResult = await dispatchPromise;
              if (dispatchResult && dispatchResult.runId) {
                reply += `\n\n---\n🚀 **Autonomous Subagent Dispatched**\n- **Subagent:** \`${dispatchResult.agent}\`\n- **Run ID:** \`${dispatchResult.runId}\`\n- **Branch:** \`${dispatchResult.branch}\`\n- **Repository:** \`${dispatchResult.repo}\`\n- **Status:** Active in isolated git worktree. Live tracking in the **Agent Runs** tab.`;
              } else if (dispatchWarning) {
                reply += `\n\n---\n⚠️ **Dispatch Notice:** ${dispatchWarning}`;
              }

              recordTranscript({
                agent: agentKey,
                agentTitle: agentTitles[agentKey] || agentKey,
                user: actor.replace('user:', ''),
                message: userMessage,
                reply,
                isAdvisory: Boolean(taskInfo.isAdvisory),
                spawned: (dispatchResult && dispatchResult.runId) ? dispatchResult : null
              });

              sendJson(res, 200, {
                ok: true,
                reply,
                agent: agentKey,
                spawned: (dispatchResult && dispatchResult.runId) ? dispatchResult : null
              });
            } catch (e) {
              recordPersonaCall('persona', null, false);
              const dispatchResult = await dispatchPromise.catch(() => null);
              let reply = `[Local model error]: ${resData.slice(0, 150)}`;
              if (dispatchResult && dispatchResult.runId) {
                reply += `\n\n🚀 **Autonomous Subagent Dispatched:** Run ID \`${dispatchResult.runId}\` on branch \`${dispatchResult.branch}\`.`;
              }

              recordTranscript({
                agent: agentKey,
                agentTitle: agentTitles[agentKey] || agentKey,
                user: actor.replace('user:', ''),
                message: userMessage,
                reply,
                isAdvisory: Boolean(taskInfo.isAdvisory),
                spawned: (dispatchResult && dispatchResult.runId) ? dispatchResult : null
              });

              sendJson(res, 200, {
                ok: true,
                reply,
                agent: agentKey,
                spawned: (dispatchResult && dispatchResult.runId) ? dispatchResult : null
              });
            }
          });
        });

        ollamaReq.on('error', async (e) => {
          recordPersonaCall('persona', null, false);
          const dispatchResult = await dispatchPromise.catch(() => null);
          let reply = `Hello ${OPERATOR_NAME}! I am Arunachala Ramana. Received: "${userMessage}".`;
          if (dispatchResult && dispatchResult.runId) {
            reply += `\n\nStrategic priority established: Task dispatched directly to subagent \`${dispatchResult.agent}\` in an isolated git worktree.\n\n---\n🚀 **Autonomous Subagent Dispatched**\n- **Subagent:** \`${dispatchResult.agent}\`\n- **Run ID:** \`${dispatchResult.runId}\`\n- **Branch:** \`${dispatchResult.branch}\`\n- **Repository:** \`${dispatchResult.repo}\`\n- **Status:** Active. Live tracking in the **Agent Runs** tab.`;
          } else {
            reply += ` Local Ollama service is currently busy or offline, but I am standing by to orchestrate the workforce.`;
          }

          recordTranscript({
            agent: agentKey,
            agentTitle: agentTitles[agentKey] || agentKey,
            user: actor.replace('user:', ''),
            message: userMessage,
            reply,
            isAdvisory: Boolean(taskInfo.isAdvisory),
            spawned: (dispatchResult && dispatchResult.runId) ? dispatchResult : null
          });
          sendJson(res, 200, {
            ok: true,
            reply,
            agent: agentKey,
            spawned: (dispatchResult && dispatchResult.runId) ? dispatchResult : null
          });
        });

        ollamaReq.write(ollamaReqData);
        ollamaReq.end();
      } catch (err) {
        sendJson(res, 400, { ok: false, error: err.message });
      }
    });
    return;
  }
  if (req.url.startsWith('/api/ping')) {
    return handlePing(req, res);
  }
  if (req.url.startsWith('/api/models')) {
    const apiReq = http.get(
      { host: OLLAMA_HOST, port: OLLAMA_PORT, path: '/api/tags', timeout: PING_TIMEOUT_MS },
      (apiRes) => {
        let body = '';
        apiRes.on('data', chunk => { body += chunk; });
        apiRes.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            sendJson(res, 200, { ok: true, models: parsed.models || [] });
          } catch (e) {
            sendJson(res, 200, { ok: false, error: 'Failed to parse models', models: [] });
          }
        });
      }
    );
    apiReq.on('error', (err) => {
      sendJson(res, 200, { ok: false, error: err.message, models: [] });
    });
    return;
  }
  if (req.url.startsWith('/api/openclaw')) {
    return sendJson(res, 200, openclawCache);
  }
  // ── Drisyon Brain & Multi-Tenant Memory API ──
  if (req.url.startsWith('/api/memory/invariants')) {
    return sendJson(res, 200, { ok: true, invariants: memory.proceduralInvariants });
  }
  if (req.url.startsWith('/api/memory/search')) {
    const actor = getReqUserNode(req);
    const authVerdict = rebac.canAccess(actor, 'memory:read', 'resource:memory_engine');
    if (!authVerdict.authorized) {
      return sendJson(res, 403, { ok: false, error: 'ReBAC authorization denied: memory:read required', path: authVerdict.path });
    }
    const parsedUrl = new URL(req.url, 'http://localhost:8787');
    const query = parsedUrl.searchParams.get('q') || '';
    const options = {
      tenantId: parsedUrl.searchParams.get('tenant') || 'tenant:drisyon_core',
      projectId: parsedUrl.searchParams.get('project') || null,
      category: parsedUrl.searchParams.get('category') || null,
      topK: Number(parsedUrl.searchParams.get('topK')) || 10,
    };
    const wantTeam = teamStore && parsedUrl.searchParams.get('scope') === 'team';
    // ?scope=team: every teammate's memory (local if the team store fails).
    const source = wantTeam
      ? teamStore.teamMemories().then((entries) => ({ source: 'team', entries }))
        .catch((err) => ({ source: 'local', entries: memory.episodicMemory, note: `team memory unavailable: ${err.message}` }))
      : Promise.resolve({ source: 'local', entries: memory.episodicMemory });
    source
      .then(({ source: from, entries, note }) => searchMemory(entries, query, options)
        .then((out) => sendJson(res, 200, {
          ok: true, source: from, ranker: out.ranker, count: out.results.length, memories: out.results,
          ...((note || out.note) ? { note: [note, out.note].filter(Boolean).join('; ') } : {}),
        })))
      .catch((err) => sendJson(res, 500, { ok: false, error: err.message }));
    return;
  }
  if (req.url.startsWith('/api/memory/store') && req.method === 'POST') {
    const actor = getReqUserNode(req);
    const authVerdict = rebac.canAccess(actor, 'memory:store', 'resource:memory_engine');
    if (!authVerdict.authorized) {
      return sendJson(res, 403, { ok: false, error: 'ReBAC authorization denied: memory:store required', path: authVerdict.path });
    }
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        const stored = memory.storeMemory(payload);
        sendJson(res, 200, { ok: true, memory: stored });
      } catch (e) {
        sendJson(res, 400, { ok: false, error: e.message });
      }
    });
    return;
  }
  if (req.url.startsWith('/api/team/dispatch') && req.method === 'POST') {
    const actor = getReqUserNode(req);
    const authVerdict = rebac.canAccess(actor, 'dispatch:run', 'resource:agent_runner');
    if (!authVerdict.authorized) {
      return sendJson(res, 403, { ok: false, error: 'ReBAC authorization denied: dispatch:run required', path: authVerdict.path });
    }
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        const taskText = payload.task || payload.prompt || payload.directive || '';
        const safetyCheck = validateDispatchSafety(taskText, payload);
        if (!safetyCheck.ok) {
          return sendJson(res, 400, safetyCheck);
        }
        const ingested = memory.ingestOperatorDispatch(payload);
        sendJson(res, 200, {
          ok: true,
          message: 'Operator dispatch delivered and ingested into Drisyon Memory',
          record: ingested,
          ...(safetyCheck.confirmed ? { safetyWarning: safetyCheck.warning } : {})
        });
      } catch (e) {
        sendJson(res, 400, { ok: false, error: e.message });
      }
    });
    return;
  }
  // ── Agent dispatch: hands one task to one coding agent via
  // orchestration/agent-dispatch.sh, which does the real work (worktree,
  // allowed-tools, run logging into RUNS_FILE). This route only spawns it
  // and returns the run id immediately — the caller (n8n) polls /api/runs
  // for completion, same format readRuns() already understands. Script
  // runs under git-bash explicitly: server.js is an NSSM/LocalSystem
  // service, so PATH has no bash.
  if (req.url.startsWith('/api/dispatch/run') && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      let payload;
      try {
        payload = JSON.parse(body || '{}');
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: `bad JSON: ${e.message}` });
      }
      const { repo, branch, task } = payload;
      // ReBAC authorization check
      const actor = (req.sessionUser && String(req.sessionUser).toLowerCase().includes('drisyon')) ? 'user:drisyon' : 'user:sriad';
      const dispatchAuth = rebac.canAccess(actor, 'dispatch:run', 'resource:agent_runner');
      if (!dispatchAuth.authorized) {
        return sendJson(res, 403, { ok: false, error: 'ReBAC authorization denied: lacking perm:dispatch', path: dispatchAuth.path });
      }
      // DISPATCH_LOCAL_FIRST=true: a claude request runs as `auto` - the local
      // agent first, claude only if the repo's tests fail (agent-dispatch.sh).
      const agent = payload.agent === 'claude' && process.env.DISPATCH_LOCAL_FIRST === 'true' ? 'auto' : payload.agent;
      const allowedAgents = new Set(['claude', 'codex', 'agy', 'hermes', 'noop', 'auto', 'mantis', 'openhands']);
      if (!allowedAgents.has(agent)) {
        return sendJson(res, 400, { ok: false, error: `unknown agent: ${agent}` });
      }
      if (typeof repo !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(repo)) {
        return sendJson(res, 400, { ok: false, error: 'repo must be a plain directory name' });
      }
      const repoPath = resolveRepoPath(repo);
      if (!fs.existsSync(path.join(repoPath, '.git'))) {
        return sendJson(res, 400, { ok: false, error: `not a known repo: ${repo}` });
      }
      if (typeof task !== 'string' || !task.trim()) {
        return sendJson(res, 400, { ok: false, error: 'task text is required' });
      }
      const safetyCheck = validateDispatchSafety(task, payload);
      if (!safetyCheck.ok) {
        return sendJson(res, 400, safetyCheck);
      }
      spawnAgentDispatch({ agent, repo, repoPath, branch, task })
        .then((result) => sendJson(res, 202, { ok: true, ...result, note: 'started; poll /api/runs for completion' }))
        .catch((err) => sendJson(res, 500, { ok: false, error: `dispatch failed: ${err.message}` }));
    });
    return;
  }
  // ── Phase 3: Automated Agency Watchdog & Patrol Routes ──
  if (req.url.startsWith('/api/patrol/mantis') && req.method === 'POST') {
    const actor = getReqUserNode(req);
    const dispatchAuth = rebac.canAccess(actor, 'dispatch:run', 'resource:agent_runner');
    if (!dispatchAuth.authorized) {
      return sendJson(res, 403, { ok: false, error: 'ReBAC authorization denied: dispatch:run required', path: dispatchAuth.path });
    }
    const repo = path.basename(DASHBOARD_DIR);
    const repoPath = DASHBOARD_DIR;
    const task = "Automated security sweep: audit API authorization, verify ReBAC boundaries, and check tenant memory isolation.";
    const branch = `patrol/mantis-${Date.now()}`;
    spawnAgentDispatch({ agent: 'mantis', repo, repoPath, branch, task })
      .then((result) => {
        // Record in episodic memory
        try {
          memory.storeMemory({
            title: `Automated Mantis Security Sweep (${result.runId})`,
            content: `Mantis AppSec scan executed against repository ${repo}. Verification of ReBAC authorization and tenant isolation underway.`,
            category: 'security_audit',
            tenantId: actor.includes('drisyon') ? 'tenant:drisyon_core' : 'tenant:default',
            projectId: repo
          });
        } catch (_) {}
        sendJson(res, 202, {
          ok: true,
          ...result,
          note: 'Mantis security sweep initiated; poll /api/runs for completion'
        });
      })
      .catch((err) => sendJson(res, 500, { ok: false, error: `Mantis sweep failed: ${err.message}` }));
    return;
  }

  if (req.url.startsWith('/api/patrol/digest') && req.method === 'POST') {
    const actor = getReqUserNode(req);
    const dispatchAuth = rebac.canAccess(actor, 'dispatch:run', 'resource:agent_runner');
    if (!dispatchAuth.authorized) {
      return sendJson(res, 403, { ok: false, error: 'ReBAC authorization denied: dispatch:run required', path: dispatchAuth.path });
    }
    const since = Date.now() - DIGEST_DAYS * 24 * 60 * 60 * 1000;
    const recent = (runs) => runs.filter((r) => Date.parse(r.started_at) >= since);
    const runsP = teamStore
      ? teamStore.teamRuns().then((b) => b.runs).catch(() => readRuns(RUNS_FILE, 1000).runs || [])
      : Promise.resolve(readRuns(RUNS_FILE, 1000).runs || []);
    Promise.all([computeCosts(DIGEST_DAYS, true), runsP])
      .then(([costs, runs]) => {
        const digestText = buildDigest({ costs, runs: recent(runs) });
        const pubScript = path.join(DASHBOARD_DIR, 'buzz-bridge', 'publish-once.js');
        let broadcast = false;
        if (fs.existsSync(pubScript)) {
          const child = require('child_process').spawn('node', [pubScript, digestText], {
            cwd: path.join(DASHBOARD_DIR, 'buzz-bridge'),
            stdio: 'ignore',
            detached: true
          });
          child.unref();
          child.on('error', (err) => console.error('digest broadcast spawn failed:', err.message));
          broadcast = true;
        }
        sendJson(res, 200, {
          ok: true,
          broadcast,
          text: digestText,
          message: broadcast ? 'Weekly digest generated and broadcast initiated to Buzz channels.' : 'Weekly digest generated (broadcast script not found).'
        });
      })
      .catch((err) => sendJson(res, 500, { ok: false, error: err.message }));
    return;
  }

  if (req.url.startsWith('/api/patrol/status')) {
    const allRuns = (readRuns(RUNS_FILE, 100).runs || []);
    const mantisRuns = allRuns.filter(r => r.agent === 'mantis');
    const latestMantis = mantisRuns.length ? mantisRuns[0] : null;
    let daemonState = null;
    const stateFile = path.join(DASHBOARD_DIR, 'logs', 'patrol-state.json');
    if (fs.existsSync(stateFile)) {
      try {
        daemonState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      } catch (_) {}
    }
    return sendJson(res, 200, {
      ok: true,
      daemon: daemonState,
      buzzDigestEnabled: process.env.BUZZ_DIGEST === 'true',
      latestMantisRun: latestMantis,
      timestamp: new Date().toISOString()
    });
  }

  // ── Buzz Integration: Message Receiver ──
  // Deprecated (FR-SEC-05): Nostr bridge connects directly to relays (wss://drisyon-ai.communities.buzz.xyz)
  if (req.url.startsWith('/api/buzz/events')) {
    return sendJson(res, 410, {
      ok: false,
      status: 'gone',
      error: 'Endpoint deprecated (FR-SEC-05). Directives are handled natively via Nostr relay (wss://drisyon-ai.communities.buzz.xyz) or authenticated dashboard dispatch (/api/dispatch/run).'
    });
  }
  // ── END Buzz Integration ──
  return serveStaticFile(req, res);
}

const server = http.createServer(async (req, res) => {
  const urlPath = req.url.split('?')[0];
  const isPublicAuth = urlPath === '/login' || 
                       urlPath === '/logout' || 
                       urlPath === '/api/auth/login' || 
                       urlPath === '/api/auth/status' || 
                       urlPath === '/api/auth/logout';
  const isStaticAsset = /\.(css|js|jpg|jpeg|png|gif|svg|ico|woff|woff2|ttf|map)$/i.test(urlPath);
  const isOpenHandsAsset = urlPath.startsWith('/canvas/assets/') || urlPath.startsWith('/vscode/assets/');

  // 1. Allow public auth pages and static assets
  if (isPublicAuth || isStaticAsset || isOpenHandsAsset) {
    return handleRequest(req, res);
  }

  // 2. Localhost requests bypass external auth
  if (!accessGate.requiresAccess(req)) {
    return handleRequest(req, res);
  }

  // 3. Valid session cookie authentication
  const sessionUser = auth.getSessionUser(req);
  if (sessionUser) {
    req.sessionUser = sessionUser;
    return handleRequest(req, res);
  }

  // 4. Cloudflare Access assertion token (if used)
  const cfVerdict = await accessGate.verifyRequest(req);
  if (cfVerdict && cfVerdict.ok) {
    req.sessionUser = cfVerdict.email || 'cf-user';
    return handleRequest(req, res);
  }

  // 5. Unauthenticated: return 401 for API, redirect to /login for pages
  if (req.url.startsWith('/api/')) {
    return sendJson(res, 401, {
      ok: false,
      error: 'Authentication required. Please login with username and password at /login',
      loginUrl: '/login'
    });
  }

  const redirectParam = encodeURIComponent(req.url);
  res.writeHead(302, { Location: `/login?redirect=${redirectParam}` });
  return res.end();
});

// Proxy WebSocket connections for OpenHands live canvas & terminal
server.on('upgrade', (req, socket, head) => {
  if (req.url.startsWith('/canvas') || req.url.startsWith('/vscode')) {
    const proxyReq = http.request({
      host: '127.0.0.1',
      port: 8000,
      path: req.url,
      method: 'GET',
      headers: { ...req.headers, host: '127.0.0.1:8000' }
    });
    proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\n` +
        Object.entries(proxyRes.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') +
        `\r\n\r\n`
      );
      if (proxyHead && proxyHead.length) socket.write(proxyHead);
      proxySocket.pipe(socket);
      socket.pipe(proxySocket);
    });
    proxyReq.on('error', () => socket.destroy());
    proxyReq.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Arunachala dashboard server running at http://${HOST}:${PORT}`);
  console.log(`Serving files from: ${DASHBOARD_DIR}`);
});