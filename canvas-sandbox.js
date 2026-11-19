// canvas-sandbox.js - lets a remote browser reach OpenHands sandboxes through
// canvas-gate.js.
//
// OpenHands 1.x tells the browser to talk to each sandbox's agent server at
// http://localhost:<random port>. That only works on this Mac. Through the
// tunnel, the gate rewrites those URLs in OpenHands' JSON responses to
// https://<public host>/sandbox/<port> and forwards /sandbox/<port>/... to
// 127.0.0.1:<port> - but only for ports Docker says belong to an OpenHands
// sandbox container (label sandbox_spec_id). Every other port is refused, so
// the route cannot reach the dashboard, Ollama or anything else on this Mac.

const http = require('http');
const os = require('os');
const path = require('path');

const SANDBOX_LABEL = 'sandbox_spec_id';
const PORTS_TTL_MS = 5000;
const LOCAL_URL = /\b(?:https?|wss?):\/\/(?:localhost|127\.0\.0\.1):(\d{2,5})/g;

/** /sandbox/<port>/<rest> -> { port, path } or null. */
function parseSandboxPath(url) {
  const m = /^\/sandbox\/(\d{2,5})(\/.*)?$/.exec(url || '');
  if (!m) return null;
  const port = Number(m[1]);
  if (port < 1 || port > 65535) return null;
  return { port, path: m[2] || '/' };
}

/** Rewrites sandbox URLs in a response body for a browser on publicHost. */
function rewriteSandboxUrls(body, publicHost) {
  return body.replace(LOCAL_URL, (_all, port) => `https://${publicHost}/sandbox/${port}`);
}

function dockerSocketPath() {
  if (process.env.DOCKER_SOCKET) return process.env.DOCKER_SOCKET;
  return path.join(os.homedir(), '.orbstack', 'run', 'docker.sock');
}

/** Host ports published by running OpenHands sandbox containers. */
function defaultListSandboxPorts(socketPath = dockerSocketPath()) {
  const filters = encodeURIComponent(JSON.stringify({ label: [SANDBOX_LABEL], status: ['running'] }));
  return new Promise((resolve, reject) => {
    const req = http.get({ socketPath, path: `/containers/json?filters=${filters}`, timeout: 3000 }, res => {
      let raw = '';
      res.on('data', d => { raw += d; });
      res.on('end', () => {
        try {
          const ports = new Set();
          for (const c of JSON.parse(raw)) {
            for (const p of c.Ports || []) if (p.PublicPort) ports.add(p.PublicPort);
          }
          resolve(ports);
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('docker timeout')));
    req.on('error', reject);
  });
}

/** Cached allow-list check; any Docker error means "not allowed". */
function createSandboxPortCheck(listPorts = defaultListSandboxPorts, now = Date.now) {
  let ports = new Set();
  let fetchedAt = -Infinity;
  return async function isSandboxPort(port) {
    if (!ports.has(port) || now() - fetchedAt > PORTS_TTL_MS) {
      try {
        ports = await listPorts();
        fetchedAt = now();
      } catch {
        return false;
      }
    }
    return ports.has(port);
  };
}

module.exports = {
  parseSandboxPath,
  rewriteSandboxUrls,
  createSandboxPortCheck,
  defaultListSandboxPorts,
};
