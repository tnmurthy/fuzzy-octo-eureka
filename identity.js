'use strict';
// Who is making a request, and what they may do (P0.3-P0.5).
// - A verified Cloudflare Access email names the person; it wins over the
//   portal's shared password login, which cannot tell teammates apart.
// - Admin = a request at this Mac, or a person listed in ADMIN_USERS. There is
//   no fallback to the shared login or to Access's allow-list: those say who
//   may enter, not who may run everything.
// - The ReBAC tenant comes from the portal, never from the person's name, and
//   the x-rebac-actor header is honoured only for requests made at this Mac.

/**
 * @param {{ accessVerdict?: { ok: boolean, email?: string } | null, sessionUser?: string | null }} o
 * @returns {{ user: string, via: 'access' | 'password' } | null}
 */
function resolveUser({ accessVerdict, sessionUser }) {
  const email = accessVerdict && accessVerdict.ok ? String(accessVerdict.email || '').trim().toLowerCase() : '';
  if (email) return { user: email, via: 'access' };
  if (sessionUser) return { user: String(sessionUser), via: 'password' };
  return null;
}

/** @param {string | undefined} raw comma-separated ADMIN_USERS */
function parseAdminUsers(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** @param {{ local: boolean, user?: string | null, adminUsers: string[] }} o */
function isAdminUser({ local, user, adminUsers }) {
  if (local) return true;
  if (!user) return false;
  return adminUsers.includes(String(user).trim().toLowerCase());
}

/** @param {boolean} isDrisyonPortal */
function portalName(isDrisyonPortal) {
  return isDrisyonPortal ? 'drisyon' : 'team';
}

/**
 * ReBAC actor for a request: the portal's tenant. A local caller (onboarding
 * scripts at this Mac) may name an actor with x-rebac-actor.
 * @param {{ local: boolean, headerActor?: string, isDrisyonPortal: boolean }} o
 */
function tenantActor({ local, headerActor, isDrisyonPortal }) {
  if (local && headerActor && /^user:[a-z0-9._@-]+$/i.test(String(headerActor).trim())) {
    return String(headerActor).trim();
  }
  return isDrisyonPortal ? 'user:drisyon' : 'user:sriad';
}

/** Run author as stored on a run: the person, or who acted at this Mac. */
function runAuthor(by) {
  const s = String(by || '').trim().slice(0, 254);
  return s && /^[A-Za-z0-9._@+ -]+$/.test(s) ? s : 'local operator';
}

module.exports = { resolveUser, parseAdminUsers, isAdminUser, portalName, tenantActor, runAuthor };
