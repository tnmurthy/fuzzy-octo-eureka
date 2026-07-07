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

const PORT = process.env.PORT || 8787;
const DASHBOARD_DIR = __dirname;
const TELEMETRY_FILE = path.join(DASHBOARD_DIR, 'telemetry.json');
const HISTORY_FILE = path.join(DASHBOARD_DIR, 'history.json');

const OLLAMA_HOST = '127.0.0.1';
const OLLAMA_PORT = 11434;
const PING_TIMEOUT_MS = 3000;

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
      // File doesn't exist yet (daemon hasn't run a cycle) - not a hard error.
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

  // Prevent path traversal outside the dashboard directory.
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
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

function handlePing(req, res) {
  const start = Date.now();
  const timer = setTimeout(() => {
    apiReq.destroy();
    sendJson(res, 200, { ok: false, error: 'timeout', latencyMs: Date.now() - start });
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
          sendJson(res, 200, { ok: true, latencyMs, statusCode: apiRes.statusCode, models });
        } catch (e) {
          sendJson(res, 200, { ok: apiRes.statusCode === 200, latencyMs, statusCode: apiRes.statusCode, models: [] });
        }
      });
    }
  );

  apiReq.on('error', () => {
    clearTimeout(timer);
    sendJson(res, 200, { ok: false, error: 'connection_failed', latencyMs: Date.now() - start });
  });
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/telemetry')) {
    return serveJsonFile(res, TELEMETRY_FILE, {});
  }
  if (req.url.startsWith('/api/history')) {
    return serveJsonFile(res, HISTORY_FILE, []);
  }
  if (req.url.startsWith('/api/ping')) {
    return handlePing(req, res);
  }
  return serveStaticFile(req, res);
});

server.listen(PORT, () => {
  console.log(`Arunachala dashboard server running at http://localhost:${PORT}`);
  console.log(`Serving files from: ${DASHBOARD_DIR}`);
});
