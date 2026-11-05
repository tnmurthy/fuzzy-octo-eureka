// supabase-session.js - one teammate's Supabase sign-in, kept fresh.
//
// Each person signs in as their own Supabase user (row level security scopes
// them to their team), so no service_role key ever sits on a laptop. Plain
// fetch against the Auth REST API: server.js stays dependency-free.

const REFRESH_MARGIN_MS = 60 * 1000;

function createSession({ url, key, email, password, fetch = globalThis.fetch, now = Date.now }) {
  let current = null; // { token, refresh, userId, expiresAt }

  async function grant(type, body) {
    const res = await fetch(`${url}/auth/v1/token?grant_type=${type}`, {
      method: 'POST',
      headers: { apikey: key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      // Never include the request body: it holds the password or refresh token.
      // Current Auth replies { error_code, msg }; older ones { error, error_description }.
      const reason = data.msg || data.error_description || data.error || 'no token';
      const code = data.error_code ? ` (${data.error_code})` : '';
      throw new Error(`Supabase sign-in failed (${res.status}): ${reason}${code}`);
    }
    return {
      token: data.access_token,
      refresh: data.refresh_token,
      userId: data.user && data.user.id,
      expiresAt: now() + Number(data.expires_in || 3600) * 1000,
    };
  }

  const signIn = () => grant('password', { email, password });

  async function getToken() {
    if (!current) {
      current = await signIn();
    } else if (current.expiresAt - now() < REFRESH_MARGIN_MS) {
      // Supabase refresh tokens are single-use; a refused one means sign in again.
      current = await grant('refresh_token', { refresh_token: current.refresh }).catch(signIn);
    }
    return { token: current.token, userId: current.userId };
  }

  return { getToken };
}

module.exports = { createSession };
