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
const DASHBOARD_DIR = __dirname;
const TELEMETRY_FILE = path.join(DASHBOARD_DIR, 'telemetry.json');
const HISTORY_FILE = path.join(DASHBOARD_DIR, 'history.json');
const OPENCLAW_CACHE_FILE = path.join(DASHBOARD_DIR, 'openclaw-status.json');
// Written by orchestration/agent-dispatch.sh: one start and one end line per
// task handed to Claude, Codex, Antigravity or Hermes.
const RUNS_FILE = process.env.AGENT_RUNS_FILE ||
  path.resolve(DASHBOARD_DIR, '../../../04_internal/agent-runs/runs.jsonl');
// Same default buzz-bridge/bridge.js uses for listRepos(): the parent of
// the active-projects folder this dashboard lives in.
const PROJECTS_DIR = process.env.PROJECTS_DIR || path.resolve(DASHBOARD_DIR, '..');
const { readRuns } = require('./runs-reader');
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
const { parseTasksMd } = require('./tasks-md');
const { validateNewTask, validateStatus } = require('./team-store/tasks');

// Memory search by meaning: local nomic-embed-text embeddings, cached on
// disk; keyword scoring when Ollama is down or MEMORY_EMBEDDINGS=false.
const { createEmbedder } = require('./embeddings');
const { semanticSearch, docText } = require('./memory-search');
const embedder = process.env.MEMORY_EMBEDDINGS === 'false' ? null : createEmbedder({
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

const OLLAMA_HOST = '127.0.0.1';
const OLLAMA_PORT = 11434;
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
  path.join(OPENCLAW_HOME, 'AppData', 'Roaming', 'npm', 'openclaw.cmd');
// LocalSystem's own $HOME/$USERPROFILE isn't the operator's profile, so point the
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

const MAX_TASK_BODY_BYTES = 10 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readJsonBody(req, limit) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > limit) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); } catch { reject(new Error('bad JSON')); }
    });
  });
}

// Task Board. With team-store on, the shared board in Supabase (create with
// POST /api/tasks, move with PATCH /api/tasks/<id>); otherwise, or if the
// team board can't be reached, the read-only 04_internal/TASKS.md.
function handleTasks(req, res) {
  const readLocal = (note) => {
    const tasksFile = process.env.TASKS_FILE || path.resolve(DASHBOARD_DIR, '../../../04_internal/TASKS.md');
    fs.readFile(tasksFile, 'utf8', (err, data) => {
      if (err) {
        return sendJson(res, 200, { ok: false, error: 'TASKS.md not found', columns: { backlog: [], in_progress: [], done: [] } });
      }
      try {
        sendJson(res, 200, { ok: true, source: 'local', ...(note ? { note } : {}), columns: parseTasksMd(data) });
      } catch (e) {
        sendJson(res, 500, { ok: false, error: e.message });
      }
    });
  };

  if (req.method === 'GET') {
    if (!teamStore) return readLocal();
    teamStore.teamTasks()
      .then((body) => sendJson(res, 200, body))
      .catch((err) => readLocal(`team board unavailable: ${err.message}`));
    return;
  }
  if (!teamStore) {
    return sendJson(res, 409, { ok: false, error: 'team board not configured: set SUPABASE_* and TEAM_ID in .env' });
  }
  const id = req.url.split('?')[0].split('/')[3];
  if (req.method === 'POST' && !id) {
    readJsonBody(req, MAX_TASK_BODY_BYTES)
      .then((input) => {
        const v = validateNewTask(input);
        if (!v.ok) return sendJson(res, 400, { ok: false, error: v.error });
        return teamStore.createTask(v.task).then((task) => sendJson(res, 201, { ok: true, task }));
      })
      .catch((err) => sendJson(res, 400, { ok: false, error: err.message }));
    return;
  }
  if (req.method === 'PATCH' && id) {
    if (!UUID_RE.test(id)) return sendJson(res, 400, { ok: false, error: 'task id must be a UUID' });
    readJsonBody(req, MAX_TASK_BODY_BYTES)
      .then((input) => {
        if (!validateStatus(input.status)) return sendJson(res, 400, { ok: false, error: 'status must be backlog, in_progress or done' });
        return teamStore.moveTask(id, input.status).then((task) => (task
          ? sendJson(res, 200, { ok: true, task })
          : sendJson(res, 404, { ok: false, error: 'no such task on your team board' })));
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

function handleRequest(req, res) {
  if (req.url.startsWith('/api/telemetry')) {
    return serveJsonFile(res, TELEMETRY_FILE, {});
  }
  if (req.url.startsWith('/api/digest')) {
    return handleDigest(req, res);
  }
  if (req.url.startsWith('/api/costs')) {
    return handleCosts(req, res);
  }
  if (req.url.startsWith('/api/config')) {
    return sendJson(res, 200, { operatorName: OPERATOR_NAME, personaModel: PERSONA_MODEL });
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
  if (req.url.startsWith('/api/rebac/inspect')) {
    return sendJson(res, 200, {
      nodes: Array.from(rebac.nodes.entries()),
      edges: rebac.edges
    });
  }
  if (req.url.startsWith('/api/tasks')) {
    return handleTasks(req, res);
  }
  if (req.url.startsWith('/api/agent/chat') && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const userMessage = payload.message || '';
        const agentKey = payload.agent || 'po';
        const agentSystemPrompts = {
          po: "You are Arunachala Ramana, AI Product Strategist & Product Owner for tt-ai-stack. You are calm, strategic, practical, and precise. Help the user break down scope, plan architectures, orchestrate tech/qa/infra/doc subagents, and prioritize tasks.",
          tech: "You are Tech Lead & Architect for tt-ai-stack. You specialize in code implementation, refactoring, and system architecture.",
          qa: "You are QA & Verification Specialist for tt-ai-stack. You focus on automated testing, validation, and pre-commit checks.",
          infra: "You are DevOps & Infrastructure Specialist for tt-ai-stack. You manage Docker, Ollama configurations, and runtime health.",
          doc: "You are Documentation Specialist for tt-ai-stack. You maintain memory logs, changelogs, and project state."
        };

        const systemPrompt = agentSystemPrompts[agentKey] || agentSystemPrompts.po;
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
          ollamaRes.on('end', () => {
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
              sendJson(res, 200, { ok: true, reply, agent: agentKey });
            } catch (e) {
              recordPersonaCall('persona', null, false);
              sendJson(res, 200, { ok: false, reply: `[Local model error]: ${resData.slice(0, 150)}` });
            }
          });
        });

        ollamaReq.on('error', (e) => {
          recordPersonaCall('persona', null, false);
          sendJson(res, 200, { ok: true, reply: `[Offline fallback response]: Hello ${OPERATOR_NAME}! I am Arunachala Ramana. Received: "${userMessage}". Local Ollama service is currently busy or offline, but I am standing by to orchestrate the workforce.` });
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
    const parsedUrl = new URL(req.url, 'http://localhost:8787');
    const query = parsedUrl.searchParams.get('q') || '';
    const options = {
      tenantId: parsedUrl.searchParams.get('tenant') || 'tenant:drisyon_core',
      projectId: parsedUrl.searchParams.get('project') || null,
      topK: 10,
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
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
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
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const ingested = memory.ingestOperatorDispatch(payload);
        sendJson(res, 200, { ok: true, message: 'Operator dispatch delivered and ingested into Drisyon Memory', record: ingested });
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
    req.on('end', () => {
      let payload;
      try {
        payload = JSON.parse(body || '{}');
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: `bad JSON: ${e.message}` });
      }
      const { repo, branch, task } = payload;
      // DISPATCH_LOCAL_FIRST=true: a claude request runs as `auto` - the local
      // agent first, claude only if the repo's tests fail (agent-dispatch.sh).
      const agent = payload.agent === 'claude' && process.env.DISPATCH_LOCAL_FIRST === 'true' ? 'auto' : payload.agent;
      const allowedAgents = new Set(['claude', 'codex', 'agy', 'hermes', 'noop', 'auto']);
      if (!allowedAgents.has(agent)) {
        return sendJson(res, 400, { ok: false, error: `unknown agent: ${agent}` });
      }
      if (typeof repo !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(repo)) {
        return sendJson(res, 400, { ok: false, error: 'repo must be a plain directory name' });
      }
      const repoPath = path.resolve(PROJECTS_DIR, repo);
      if (!repoPath.startsWith(PROJECTS_DIR) || !fs.existsSync(path.join(repoPath, '.git'))) {
        return sendJson(res, 400, { ok: false, error: `not a known repo: ${repo}` });
      }
      if (typeof task !== 'string' || !task.trim()) {
        return sendJson(res, 400, { ok: false, error: 'task text is required' });
      }
      const safeBranch = (branch && /^[a-zA-Z0-9._/-]+$/.test(branch)) ? branch : `buzz/${Date.now()}`;
      const runId = `${new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)}-${agent}-${Math.random().toString(36).slice(2, 8)}`;

      // Team context for the agent: the most relevant memories for this repo,
      // looked up within DISPATCH_CONTEXT_TIMEOUT_MS; no context on any failure.
      dispatchMemories(repo, task).then((memories) => {
        const tmpDir = path.join(DASHBOARD_DIR, 'logs', 'dispatch-prompts');
        fs.mkdirSync(tmpDir, { recursive: true });
        const promptFile = path.join(tmpDir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
        fs.writeFileSync(promptFile, buildDispatchPrompt(task, memories), 'utf8');

        const scriptPath = path.resolve(DASHBOARD_DIR, 'orchestration', 'agent-dispatch.sh');
        const bashBin = process.env.DISPATCH_BASH_BIN || 'C:\\Program Files\\Git\\bin\\bash.exe';
        const child = require('child_process').spawn(
          bashBin,
          [scriptPath, agent, repoPath, safeBranch, promptFile, runId],
          {
            cwd: DASHBOARD_DIR,
            windowsHide: true,
            detached: true,
            stdio: 'ignore',
            env: Object.assign({}, process.env, {
              AGENT_RUNS_DIR: path.dirname(RUNS_FILE),
              // claude runs record their real tokens and cost in the same ledger.
              AI_CALLS_FILE,
              // Service runs under LocalSystem, whose PATH may not include
              // node's install dir, so agent-dispatch.sh's bare `node` calls
              // (runlog.mjs) fail silently (spawn is detached/stdio:'ignore').
              // process.execPath always knows exactly where this node is.
              // The agent CLIs (claude via npm, codex) live in the operator's profile.
              PATH: [
                path.dirname(process.execPath),
                OPENCLAW_HOME + '\\AppData\\Roaming\\npm',
                OPENCLAW_HOME + '\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin',
                process.env.PATH || '',
              ].join(';'),
              // LocalSystem does not own the repos, so git's dubious-ownership
              // check kills the script's first git call (set -e, stdio ignored:
              // silent). safe.directory is honoured from command-line config,
              // which GIT_CONFIG_COUNT/KEY/VALUE is; scoped to the projects dir
              // (repos and their sibling worktrees), not '*'.
              GIT_CONFIG_COUNT: '1',
              GIT_CONFIG_KEY_0: 'safe.directory',
              GIT_CONFIG_VALUE_0: `${PROJECTS_DIR.replace(/\\/g, '/')}/*`,
              // Same reason as OPENCLAW_ENV: claude/codex/hermes keep their
              // logins in the operator's profile, not LocalSystem's.
              USERPROFILE: OPENCLAW_HOME,
              HOME: OPENCLAW_HOME,
              APPDATA: OPENCLAW_HOME + '\\AppData\\Roaming',
              LOCALAPPDATA: OPENCLAW_HOME + '\\AppData\\Local',
            }),
          }
        );
        child.unref();
        child.on('error', (err) => console.error('dispatch spawn failed:', err.message));

        sendJson(res, 202, { ok: true, runId, agent, repo, branch: safeBranch, note: 'started; poll /api/runs for completion' });
      }).catch((err) => sendJson(res, 500, { ok: false, error: `dispatch failed: ${err.message}` }));
    });
    return;
  }
  // ── Buzz Integration: Message Receiver ──
  // Receives unauthenticated messages and routes to agent chat
  if (req.url.startsWith('/api/buzz/events') && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        // Parse Buzz event format (NIP-01 event with content)
        const payload = JSON.parse(body || '{}');
        const message = payload.content || payload.event?.content || '';
        const sender = payload.pubkey || payload.sender || 'buzz';
        
        if (!message) {
          return sendJson(res, 400, { ok: false, error: 'No message content' });
        }
        
        // Store immediately in memory (intent captured)
        memory.storeMemory({
          tenantId: 'tenant:drisyon_core',
          projectId: 'buzz_integration',
          category: 'operator_directive',
          title: `Directive from Buzz: ${sender}`,
          content: message,
          tags: ['buzz', 'dispatcher', sender],
          metadata: { source: 'buzz_events', sender }
        });
        
        // Forward to agent chat (route to PO for autonomous agent spawning)
        const ollamaReqData = JSON.stringify({
          model: PERSONA_MODEL,
          messages: [
            { role: 'system', content: 'You are Arunachala Ramana. Process Buzz directives as operator commands and respond with clear, actionable next steps.' },
            { role: 'user', content: `Buzz directive from ${sender}: ${message}` }
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
          ollamaRes.on('end', () => {
            try {
              const parsed = JSON.parse(resData);
              recordPersonaCall('buzz_event', parsed);
              // Handle different model response formats
              let reply = 'Agent spawning initiated.';
              if (parsed.message && parsed.message.content) {
                reply = parsed.message.content;
              } else if (parsed.choices && parsed.choices[0] && parsed.choices[0].text) {
                reply = parsed.choices[0].text;
              } else if (typeof parsed === 'string') {
                reply = parsed;
              }
              sendJson(res, 200, { ok: true, reply, agent: 'po', stored: true });
            } catch (e) {
              recordPersonaCall('buzz_event', null, false);
              sendJson(res, 200, { ok: true, reply: resData.slice(0, 500), raw: true });
            }
          });
        });
        
        ollamaReq.on('error', (e) => {
          recordPersonaCall('buzz_event', null, false);
          // Intent already stored above
          sendJson(res, 200, { ok: true, reply: 'Agent spawning initiated', stored: true, from: sender });
        });
        
        ollamaReq.write(ollamaReqData);
        ollamaReq.end();
      } catch (err) {
        sendJson(res, 400, { ok: false, error: err.message });
      }
    });
    return;
  }
  // ── END Buzz Integration ──
  return serveStaticFile(req, res);
}

const server = http.createServer(async (req, res) => {
  if (accessGate.requiresAccess(req)) {
    const verdict = await accessGate.verifyRequest(req);
    if (!verdict.ok) {
      console.error(`Access denied ${req.method} ${req.url}: ${verdict.reason}`);
      return sendJson(res, 403, { ok: false, error: 'Cloudflare Access login required' });
    }
  }
  return handleRequest(req, res);
});

server.listen(PORT, HOST, () => {
  console.log(`Arunachala dashboard server running at http://${HOST}:${PORT}`);
  console.log(`Serving files from: ${DASHBOARD_DIR}`);
});