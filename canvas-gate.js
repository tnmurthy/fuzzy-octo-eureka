// canvas-gate.js - the origin lock in front of OpenHands (Agent Canvas).
//
// canvas.mytestbed.tech -> tunnel -> this gate (127.0.0.1:3001) -> OpenHands
// (127.0.0.1:3000). Cloudflare Access blocks unauthenticated visitors at the
// edge; this gate re-checks the Access JWT on every request and WebSocket
// upgrade, because OpenHands itself has no auth and can start containers on
// this Mac (Docker socket). Sandbox traffic (/sandbox/<port>) is routed by
// canvas-sandbox.js. Fails closed: no AUD configured, no token, bad
// token or unreachable certs -> 403, nothing is forwarded.
//
// Run under PM2 as CanvasGate (ecosystem.config.js). Tests: canvas-gate.test.js

const http = require('http');
const { createAccessGate } = require('./access-auth');
const { parseSandboxPath, rewriteSandboxUrls, createSandboxPortCheck } = require('./canvas-sandbox');

// Headers that carry the Access credential; never forwarded to OpenHands,
// so an agent running in the sandbox cannot read the operator's session.
function stripAccessCredentials(headers) {
  const out = { ...headers };
  delete out['cf-access-jwt-assertion'];
  if (out.cookie) {
    const kept = String(out.cookie)
      .split(/;\s*/)
      .filter(c => c && !/^CF_Authorization=/.test(c));
    if (kept.length) out.cookie = kept.join('; ');
    else delete out.cookie;
  }
  return out;
}

function forwardHeaders(headers) {
  const out = stripAccessCredentials(headers);
  // Plain bodies so sandbox URLs in JSON can be rewritten.
  out['accept-encoding'] = 'identity';
  return out;
}

/**
 * @param {{ verifyRequest: (req) => Promise<{ok: boolean, reason?: string}> }} gate
 * @param {{ host: string, port: number }} target  OpenHands app server
 * @param {{ log?: (msg: string) => void, publicHost?: string,
 *           isSandboxPort?: (port: number) => Promise<boolean> }} [opts]
 */
function createCanvasGateServer(gate, target, opts = {}) {
  const log = opts.log || (() => {});
  const publicHost = opts.publicHost || 'canvas.mytestbed.tech';
  const isSandboxPort = opts.isSandboxPort || createSandboxPortCheck();

  // Where a request goes: /sandbox/<port>/... to a sandbox agent server
  // (only ports Docker lists for OpenHands sandboxes), everything else to
  // OpenHands. null = refuse.
  async function upstreamFor(req) {
    const sb = parseSandboxPath(req.url);
    if (!sb) return { host: target.host, port: target.port, path: req.url };
    if (!(await isSandboxPort(sb.port))) {
      log(`refused /sandbox/${sb.port}: not an OpenHands sandbox port`);
      return null;
    }
    return { host: '127.0.0.1', port: sb.port, path: sb.path };
  }

  async function allowed(req) {
    try {
      const verdict = await gate.verifyRequest(req);
      if (!verdict.ok) log(`denied ${req.method} ${req.url}: ${verdict.reason}`);
      return verdict.ok;
    } catch (err) {
      log(`denied ${req.method} ${req.url}: ${err.message}`);
      return false;
    }
  }

  const server = http.createServer(async (req, res) => {
    if (!(await allowed(req))) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Forbidden');
    }
    const up = await upstreamFor(req);
    if (!up) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    const proxyReq = http.request({
      host: up.host,
      port: up.port,
      path: up.path,
      method: req.method,
      headers: forwardHeaders(req.headers),
    }, (proxyRes) => {
      const type = String(proxyRes.headers['content-type'] || '');
      if (!type.includes('application/json')) {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        return proxyRes.pipe(res);
      }
      const chunks = [];
      proxyRes.on('data', c => chunks.push(c));
      proxyRes.on('end', () => {
        const body = Buffer.from(rewriteSandboxUrls(Buffer.concat(chunks).toString('utf8'), publicHost));
        const headers = { ...proxyRes.headers, 'content-length': String(body.length) };
        delete headers['transfer-encoding'];
        res.writeHead(proxyRes.statusCode, headers);
        res.end(body);
      });
    });
    proxyReq.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('OpenHands is not running');
    });
    req.pipe(proxyReq);
  });

  server.on('upgrade', async (req, socket, head) => {
    socket.on('error', () => socket.destroy());
    if (!(await allowed(req))) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    const up = await upstreamFor(req);
    if (!up) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return;
    }
    const proxyReq = http.request({
      host: up.host,
      port: up.port,
      path: up.path,
      method: req.method,
      headers: stripAccessCredentials(req.headers),
    });
    proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
      proxySocket.on('error', () => socket.destroy());
      const lines = [`HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage}`];
      for (let i = 0; i < proxyRes.rawHeaders.length; i += 2) {
        lines.push(`${proxyRes.rawHeaders[i]}: ${proxyRes.rawHeaders[i + 1]}`);
      }
      socket.write(lines.join('\r\n') + '\r\n\r\n');
      if (proxyHead && proxyHead.length) socket.write(proxyHead);
      if (head && head.length) proxySocket.write(head);
      proxySocket.pipe(socket);
      socket.pipe(proxySocket);
    });
    proxyReq.on('response', (proxyRes) => {
      socket.end(`HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage}\r\nConnection: close\r\n\r\n`);
    });
    proxyReq.on('error', () => socket.destroy());
    proxyReq.end();
  });

  return server;
}

module.exports = { createCanvasGateServer, stripAccessCredentials };

if (require.main === module) {
  const aud = process.env.CANVAS_ACCESS_AUD || '';
  if (!aud) {
    console.error('canvas-gate: CANVAS_ACCESS_AUD is not set; refusing to start (fail closed).');
    process.exit(1);
  }
  const gate = createAccessGate({
    teamDomain: process.env.ACCESS_TEAM_DOMAIN || 'crimson-shape-5caa.cloudflareaccess.com',
    aud,
    publicHostnames: [],
    allowedEmails: (process.env.ACCESS_ALLOWED_EMAILS || '').split(',').filter(Boolean),
  });
  const port = Number(process.env.CANVAS_GATE_PORT) || 3001;
  const target = { host: '127.0.0.1', port: Number(process.env.OPENHANDS_PORT) || 3000 };
  const server = createCanvasGateServer(gate, target, {
    log: (m) => console.log(new Date().toISOString(), m),
    publicHost: process.env.CANVAS_PUBLIC_HOST || 'canvas.mytestbed.tech',
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`canvas-gate on 127.0.0.1:${port} -> ${target.host}:${target.port}`);
  });
}
