// access-auth.js - verifies Cloudflare Access tokens at the origin.
//
// Cloudflare Access already blocks unauthenticated visitors at the edge. This
// is the second lock: anything that reached server.js through the tunnel must
// also carry a valid Access JWT, so a deleted or loosened Access app (or a
// tunnel rule pointed here by mistake) does not silently expose the API.
//
// Requests from this machine (Host localhost/127.0.0.1, no cf-connecting-ip)
// are left alone - the telemetry daemon, OpenClaw and local browsing use them.
//
// Zero dependencies: Node's crypto verifies RS256 against the team's JWKS.

const crypto = require('crypto');

const CERTS_TTL_MS = 60 * 60 * 1000;
const UNKNOWN_KID_REFETCH_MS = 60 * 1000;
const CLOCK_SKEW_SEC = 60;

function decodePart(part) {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

function readToken(headers) {
  const header = headers['cf-access-jwt-assertion'];
  if (header) return String(header);
  const cookie = headers.cookie || '';
  const match = cookie.match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
  return match ? match[1] : '';
}

async function defaultFetchCerts(teamDomain) {
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * @param {{ teamDomain: string, aud: string, publicHostnames: string[],
 *           allowedEmails?: string[], now?: () => number,
 *           fetchCerts?: (teamDomain: string) => Promise<{ keys: object[] }> }} opts
 */
function createAccessGate(opts) {
  const { teamDomain, aud } = opts;
  const hosts = new Set(opts.publicHostnames.map(h => h.toLowerCase()));
  const allowed = (opts.allowedEmails || []).map(e => e.toLowerCase());
  const now = opts.now || Date.now;
  const fetchCerts = opts.fetchCerts || defaultFetchCerts;
  let keys = new Map();
  let fetchedAt = 0;

  async function refreshKeys() {
    const jwks = await fetchCerts(teamDomain);
    keys = new Map((jwks.keys || []).map(k => [k.kid, crypto.createPublicKey({ key: k, format: 'jwk' })]));
    fetchedAt = now();
  }

  async function keyFor(kid) {
    const age = now() - fetchedAt;
    const stale = age > CERTS_TTL_MS;
    const unknownAndRetryable = !keys.has(kid) && age > UNKNOWN_KID_REFETCH_MS;
    if (stale || unknownAndRetryable) await refreshKeys();
    return keys.get(kid);
  }

  function requiresAccess(req) {
    if (req.headers['cf-connecting-ip']) return true;
    const host = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
    return hosts.has(host);
  }

  async function verifyToken(token) {
    if (!token) return { ok: false, reason: 'no token' };
    const parts = token.split('.');
    if (parts.length !== 3) return { ok: false, reason: 'malformed token' };

    let head, claims;
    try {
      head = decodePart(parts[0]);
      claims = decodePart(parts[1]);
    } catch {
      return { ok: false, reason: 'malformed token' };
    }
    if (head.alg !== 'RS256') return { ok: false, reason: `algorithm ${head.alg} not allowed` };

    let key;
    try {
      key = await keyFor(head.kid);
    } catch (err) {
      return { ok: false, reason: `could not fetch Access certs: ${err.message}` };
    }
    if (!key) return { ok: false, reason: 'signature key not found' };

    const signed = Buffer.from(`${parts[0]}.${parts[1]}`);
    const sig = Buffer.from(parts[2], 'base64url');
    if (!crypto.verify('RSA-SHA256', signed, key, sig)) return { ok: false, reason: 'bad signature' };

    const audList = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audList.includes(aud)) return { ok: false, reason: 'wrong audience' };
    if (claims.iss !== `https://${teamDomain}`) return { ok: false, reason: 'wrong issuer' };

    const t = Math.floor(now() / 1000);
    if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_SEC < t) return { ok: false, reason: 'token expired' };
    if (typeof claims.nbf === 'number' && claims.nbf - CLOCK_SKEW_SEC > t) return { ok: false, reason: 'token not yet valid' };

    const email = String(claims.email || '').toLowerCase();
    if (allowed.length && !allowed.includes(email)) return { ok: false, reason: `email ${email || '(none)'} not allowed` };

    return { ok: true, email: claims.email };
  }

  return {
    requiresAccess,
    verifyRequest: (req) => verifyToken(readToken(req.headers)),
  };
}

module.exports = { createAccessGate };
