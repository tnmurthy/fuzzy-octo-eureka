// node --test access-auth.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createAccessGate } = require('./access-auth');

const TEAM = 'example.cloudflareaccess.com';
const AUD = 'aud-123';
const HOST = 'team.example.tech';
const NOW = Date.parse('2026-10-20T12:00:00Z');
const nowSec = Math.floor(NOW / 1000);

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256' };

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

function sign(payload, { kid = 'k1', key = privateKey, alg = 'RS256' } = {}) {
  const head = b64({ alg, kid, typ: 'JWT' });
  const body = b64(payload);
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), key).toString('base64url');
  return `${head}.${body}.${sig}`;
}

const good = (over = {}) => ({
  aud: [AUD], iss: `https://${TEAM}`, email: 'owner@example.com',
  iat: nowSec - 10, nbf: nowSec - 10, exp: nowSec + 3600, ...over,
});

function gate(over = {}) {
  let fetches = 0;
  const g = createAccessGate({
    teamDomain: TEAM, aud: AUD, publicHostnames: [HOST],
    now: () => NOW,
    fetchCerts: async () => { fetches++; return { keys: [jwk] }; },
    ...over,
  });
  return { g, fetches: () => fetches };
}

const req = (headers) => ({ headers });

test('local requests do not need a token', () => {
  const { g } = gate();
  assert.equal(g.requiresAccess(req({ host: 'localhost:8787' })), false);
  assert.equal(g.requiresAccess(req({ host: '127.0.0.1:8787' })), false);
});

test('public-hostname and tunnelled requests need a token', () => {
  const { g } = gate();
  assert.equal(g.requiresAccess(req({ host: 'TEAM.example.tech' })), true);
  assert.equal(g.requiresAccess(req({ host: 'team.example.tech:443' })), true);
  // Anything cloudflared forwarded carries cf-connecting-ip, whatever its Host.
  assert.equal(g.requiresAccess(req({ host: 'localhost', 'cf-connecting-ip': '1.2.3.4' })), true);
});

test('accepts a valid token from the header', async () => {
  const { g } = gate();
  const r = await g.verifyRequest(req({ 'cf-access-jwt-assertion': sign(good()) }));
  assert.deepEqual(r, { ok: true, email: 'owner@example.com' });
});

test('accepts a valid token from the CF_Authorization cookie', async () => {
  const { g } = gate();
  const r = await g.verifyRequest(req({ cookie: `a=b; CF_Authorization=${sign(good())}` }));
  assert.equal(r.ok, true);
});

test('accepts aud given as a string', async () => {
  const { g } = gate();
  const r = await g.verifyRequest(req({ 'cf-access-jwt-assertion': sign(good({ aud: AUD })) }));
  assert.equal(r.ok, true);
});

const rejects = [
  ['no token', {}, /no token/],
  ['malformed token', { 'cf-access-jwt-assertion': 'abc' }, /malformed/],
  ['wrong audience', { 'cf-access-jwt-assertion': sign(good({ aud: ['other'] })) }, /audience/],
  ['wrong issuer', { 'cf-access-jwt-assertion': sign(good({ iss: 'https://evil.example' })) }, /issuer/],
  ['expired', { 'cf-access-jwt-assertion': sign(good({ exp: nowSec - 120 })) }, /expired/],
  ['not yet valid', { 'cf-access-jwt-assertion': sign(good({ nbf: nowSec + 600 })) }, /not yet valid/],
  ['alg none', { 'cf-access-jwt-assertion': sign(good(), { alg: 'none' }) }, /algorithm/],
];
for (const [name, headers, reason] of rejects) {
  test(`rejects: ${name}`, async () => {
    const { g } = gate();
    const r = await g.verifyRequest(req(headers));
    assert.equal(r.ok, false);
    assert.match(r.reason, reason);
  });
}

test('rejects a token signed by another key', async () => {
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  const { g } = gate();
  const r = await g.verifyRequest(req({ 'cf-access-jwt-assertion': sign(good(), { key: other }) }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /signature/);
});

test('rejects an email outside the allow-list when one is set', async () => {
  const { g } = gate({ allowedEmails: ['someone@else.com'] });
  const r = await g.verifyRequest(req({ 'cf-access-jwt-assertion': sign(good()) }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /email/);
});

test('caches certs and refetches at most once a minute for an unknown kid', async () => {
  let clock = NOW;
  const { g, fetches } = gate({ now: () => clock });
  await g.verifyRequest(req({ 'cf-access-jwt-assertion': sign(good()) }));
  await g.verifyRequest(req({ 'cf-access-jwt-assertion': sign(good()) }));
  assert.equal(fetches(), 1);
  // Inside the rate-limit window an unknown kid does not trigger a fetch.
  const r0 = await g.verifyRequest(req({ 'cf-access-jwt-assertion': sign(good(), { kid: 'rotated' }) }));
  assert.equal(r0.ok, false);
  assert.equal(fetches(), 1);
  clock += 61 * 1000;
  const r1 = await g.verifyRequest(req({ 'cf-access-jwt-assertion': sign(good(), { kid: 'rotated' }) }));
  const r2 = await g.verifyRequest(req({ 'cf-access-jwt-assertion': sign(good(), { kid: 'rotated' }) }));
  assert.equal(r1.ok, false);
  assert.equal(r2.ok, false);
  assert.equal(fetches(), 2);
});

test('fails closed when certs cannot be fetched', async () => {
  const { g } = gate({ fetchCerts: async () => { throw new Error('offline'); } });
  const r = await g.verifyRequest(req({ 'cf-access-jwt-assertion': sign(good()) }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /certs/);
});
