// auth.js - Username & password authentication and session management for team.mytestbed.tech
// Provides secure HMAC-SHA256 signed session cookies, credential verification,
// and auto-activation hook for the Buzz AI Team. Zero external dependencies.

const crypto = require('crypto');

const COOKIE_NAME = 'arunachala_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DEFAULT_SECRET = 'arunachala-secret-key-studio-mac-2026';

function getSessionSecret() {
  return process.env.AUTH_SESSION_SECRET || DEFAULT_SECRET;
}

function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  const parts = cookieHeader.split(';');
  for (const part of parts) {
    const [key, ...vals] = part.trim().split('=');
    if (key) {
      cookies[key] = decodeURIComponent(vals.join('='));
    }
  }
  return cookies;
}

function signToken(payload) {
  const secret = getSessionSecret();
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const hmac = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${hmac}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot === -1) return null;
  const dataStr = token.slice(0, dot);
  const signature = token.slice(dot + 1);

  const secret = getSessionSecret();
  const expectedSig = crypto.createHmac('sha256', secret).update(dataStr).digest('base64url');

  try {
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSig))) {
      return null;
    }
    const payload = JSON.parse(Buffer.from(dataStr, 'base64url').toString('utf8'));
    if (!payload.exp || Date.now() > payload.exp) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

function getExpectedCredentials() {
  const username = (process.env.AUTH_USERNAME || 'sriad').trim();
  const password = process.env.AUTH_PASSWORD || 'arunachala2026!';
  return { username, password };
}

function verifyCredentials(username, password) {
  if (!username || !password) return false;
  const expected = getExpectedCredentials();

  const userMatch = username.trim().toLowerCase() === expected.username.toLowerCase();
  
  // Constant time comparison for password
  const givenPw = Buffer.from(String(password));
  const expectedPw = Buffer.from(String(expected.password));

  if (givenPw.length !== expectedPw.length) {
    // Timing attack mitigation: compare with dummy buffer
    crypto.timingSafeEqual(givenPw, givenPw);
    return false;
  }

  const pwMatch = crypto.timingSafeEqual(givenPw, expectedPw);
  return userMatch && pwMatch;
}

function createSessionCookie(username) {
  const payload = {
    sub: username,
    iat: Date.now(),
    exp: Date.now() + SESSION_TTL_MS,
  };
  const token = signToken(payload);
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax`;
}

function clearSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`;
}

function getSessionUser(req) {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[COOKIE_NAME];
  const session = verifyToken(token);
  return session ? session.sub : null;
}

module.exports = {
  COOKIE_NAME,
  parseCookies,
  signToken,
  verifyToken,
  verifyCredentials,
  createSessionCookie,
  clearSessionCookie,
  getSessionUser,
  getExpectedCredentials,
};
