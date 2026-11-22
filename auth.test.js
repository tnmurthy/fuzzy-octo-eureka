const test = require('node:test');
const assert = require('node:assert/strict');
const {
  signToken,
  verifyToken,
  verifyCredentials,
  createSessionCookie,
  clearSessionCookie,
  getSessionUser,
  parseCookies
} = require('./auth');

// Test-only credentials; the real ones live in the secrets file.
process.env.AUTH_PASSWORD = 'test-only-password';
process.env.AUTH_SESSION_SECRET = 'test-only-session-secret-0123456789';

test('auth - signs and verifies valid token', () => {
  const payload = { sub: 'sriad', exp: Date.now() + 10000 };
  const token = signToken(payload);
  const verified = verifyToken(token);
  assert.equal(verified.sub, 'sriad');
});

test('auth - rejects tampered token', () => {
  const payload = { sub: 'sriad', exp: Date.now() + 10000 };
  const token = signToken(payload);
  const tampered = token.slice(0, -4) + 'abcd';
  assert.equal(verifyToken(tampered), null);
});

test('auth - rejects expired token', () => {
  const payload = { sub: 'sriad', exp: Date.now() - 1000 };
  const token = signToken(payload);
  assert.equal(verifyToken(token), null);
});

test('auth - verifies configured credentials', () => {
  assert.equal(verifyCredentials('sriad', 'test-only-password'), true);
  assert.equal(verifyCredentials('SRIAD', 'test-only-password'), true); // case insensitive username
  assert.equal(verifyCredentials('sriad', 'wrongpassword'), false);
  assert.equal(verifyCredentials('random', 'test-only-password'), false);
});

test('auth - cookie header extraction', () => {
  const cookie = createSessionCookie('sriad');
  assert.match(cookie, /arunachala_session=/);
  assert.match(cookie, /HttpOnly/);
  
  const tokenPart = cookie.split(';')[0].split('=')[1];
  const req = { headers: { cookie: `other=123; arunachala_session=${tokenPart}` } };
  assert.equal(getSessionUser(req), 'sriad');

  const emptyReq = { headers: {} };
  assert.equal(getSessionUser(emptyReq), null);
});

test('auth - no password configured means no password login', () => {
  const saved = process.env.AUTH_PASSWORD;
  delete process.env.AUTH_PASSWORD;
  try {
    assert.equal(verifyCredentials('sriad', ''), false);
    assert.equal(verifyCredentials('sriad', 'anything'), false);
  } finally { process.env.AUTH_PASSWORD = saved; }
});

test('auth - without a session secret, tokens are signed with a random one', () => {
  const saved = process.env.AUTH_SESSION_SECRET;
  delete process.env.AUTH_SESSION_SECRET;
  try {
    const token = signToken({ sub: 'sriad', exp: Date.now() + 10000 });
    assert.equal(verifyToken(token).sub, 'sriad');
    const crypto = require('crypto');
    const [data] = token.split('.');
    const forged = `${data}.${crypto.createHmac('sha256', 'arunachala-secret-key-studio-mac-2026').update(data).digest('base64url')}`;
    assert.equal(verifyToken(forged), null, 'the old public default no longer signs');
  } finally { process.env.AUTH_SESSION_SECRET = saved; }
});
