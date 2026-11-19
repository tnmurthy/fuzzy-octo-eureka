const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { createCanvasGateServer, stripAccessCredentials } = require('./canvas-gate');

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function withServers(gate, fn) {
  let seenHeaders = null;
  const upstream = http.createServer((req, res) => {
    seenHeaders = req.headers;
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('openhands');
  });
  upstream.on('upgrade', (req, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.end();
  });
  const upPort = await listen(upstream);
  const gateServer = createCanvasGateServer(gate, { host: '127.0.0.1', port: upPort });
  const gatePort = await listen(gateServer);
  try {
    await fn(gatePort, () => seenHeaders);
  } finally {
    gateServer.close();
    upstream.close();
  }
}

function get(port, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/', headers }, res => {
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

function upgrade(port) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: '/socket.io/',
      headers: { Connection: 'Upgrade', Upgrade: 'websocket' },
    });
    req.on('upgrade', res => { res.socket && res.socket.destroy(); resolve(res.statusCode); });
    req.on('response', res => resolve(res.statusCode));
    req.on('error', reject);
    req.end();
  });
}

const deny = { verifyRequest: async () => ({ ok: false, reason: 'no token' }) };
const allow = { verifyRequest: async () => ({ ok: true, email: 'a@b.c' }) };
const broken = { verifyRequest: async () => { throw new Error('certs down'); } };

test('a request without a valid Access token gets 403 and never reaches OpenHands', async () => {
  await withServers(deny, async (port, seen) => {
    const res = await get(port);
    assert.strictEqual(res.status, 403);
    assert.strictEqual(seen(), null);
  });
});

test('a verifier error fails closed', async () => {
  await withServers(broken, async (port, seen) => {
    assert.strictEqual((await get(port)).status, 403);
    assert.strictEqual(seen(), null);
  });
});

test('a valid token is proxied with the Access credentials stripped', async () => {
  await withServers(allow, async (port, seen) => {
    const res = await get(port, {
      'cf-access-jwt-assertion': 'jwt',
      cookie: 'CF_Authorization=jwt; theme=dark',
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body, 'openhands');
    assert.strictEqual(seen()['cf-access-jwt-assertion'], undefined);
    assert.strictEqual(seen().cookie, 'theme=dark');
  });
});

test('WebSocket upgrades are checked too', async () => {
  await withServers(deny, async (port) => {
    assert.strictEqual(await upgrade(port), 403);
  });
  await withServers(allow, async (port) => {
    assert.strictEqual(await upgrade(port), 101);
  });
});

test('stripAccessCredentials drops the cookie header when only the Access cookie was set', () => {
  const out = stripAccessCredentials({ cookie: 'CF_Authorization=x', host: 'h' });
  assert.strictEqual(out.cookie, undefined);
  assert.strictEqual(out.host, 'h');
});

function getPath(port, path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path }, res => {
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    }).on('error', reject);
  });
}

test('/sandbox/<port> reaches only ports Docker lists as OpenHands sandboxes', async () => {
  const sandbox = http.createServer((req, res) => { res.end(`sandbox ${req.url}`); });
  const sbPort = await listen(sandbox);
  const app = http.createServer((req, res) => { res.end('app'); });
  const appPort = await listen(app);
  const gate = createCanvasGateServer(allow, { host: '127.0.0.1', port: appPort }, {
    isSandboxPort: async p => p === sbPort,
  });
  const gatePort = await listen(gate);
  try {
    const ok = await getPath(gatePort, `/sandbox/${sbPort}/api/x?y=1`);
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.body, 'sandbox /api/x?y=1');
    const refused = await getPath(gatePort, `/sandbox/${appPort}/`);
    assert.strictEqual(refused.status, 404);
  } finally {
    gate.close(); sandbox.close(); app.close();
  }
});

test('localhost sandbox URLs in JSON are rewritten to the public host', async () => {
  const app = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ url: 'http://localhost:41234/api/conversations/1', html: 'http://localhost:9' }));
  });
  const appPort = await listen(app);
  const gate = createCanvasGateServer(allow, { host: '127.0.0.1', port: appPort }, { publicHost: 'canvas.example' });
  const gatePort = await listen(gate);
  try {
    const res = await getPath(gatePort, '/api/v1/app-conversations');
    const data = JSON.parse(res.body);
    assert.strictEqual(data.url, 'https://canvas.example/sandbox/41234/api/conversations/1');
    assert.strictEqual(Number(res.headers['content-length']), Buffer.byteLength(res.body));
  } finally {
    gate.close(); app.close();
  }
});
