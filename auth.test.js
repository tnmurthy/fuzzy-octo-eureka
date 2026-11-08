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

test('auth - verifies default credentials', () => {
  assert.equal(verifyCredentials('sriad', 'arunachala2026!'), true);
  assert.equal(verifyCredentials('SRIAD', 'arunachala2026!'), true); // case insensitive username
  assert.equal(verifyCredentials('sriad', 'wrongpassword'), false);
  assert.equal(verifyCredentials('random', 'arunachala2026!'), false);
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
