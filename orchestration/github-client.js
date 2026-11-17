// github-client.js - the few GitHub REST calls the issue poller needs, over
// plain fetch so the dashboard stays dependency-free.
//
// Auth: a fine-grained token (GITHUB_TOKEN) scoped to the polled repos with
// Issues: read/write and Pull requests: read/write. Pushing branches goes over
// git's own SSH remote, so the token needs no Contents permission. Errors name
// the call and the HTTP status, never the token.

const API = 'https://api.github.com';
const TIMEOUT_MS = 15000;

/**
 * @param {{ token: string, fetchImpl?: typeof fetch, api?: string }} opts
 */
function createGitHubClient({ token, fetchImpl = fetch, api = API }) {
  if (!token) throw new Error('GITHUB_TOKEN is not set');

  async function call(method, urlPath, body) {
    const res = await fetchImpl(api + urlPath, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'arunachala-issue-poller',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { /* non-JSON error page */ }
    if (!res.ok) {
      const msg = (json && json.message) || `HTTP ${res.status}`;
      const err = new Error(`GitHub ${method} ${urlPath.split('?')[0]}: ${res.status} ${msg}`);
      err.status = res.status;
      throw err;
    }
    return json;
  }

  const enc = encodeURIComponent;
  const repoPath = (repo) => {
    const [owner, name] = String(repo).split('/');
    if (!owner || !name) throw new Error(`repo must be owner/name, got ${repo}`);
    return `/repos/${enc(owner)}/${enc(name)}`;
  };

  return {
    async getRepo(repo) {
      return call('GET', repoPath(repo));
    },

    // Open issues carrying a label, oldest first. The issues API also returns
    // pull requests; those are dropped.
    async listIssuesWithLabel(repo, label) {
      const list = await call('GET', `${repoPath(repo)}/issues?state=open&labels=${enc(label)}&sort=created&direction=asc&per_page=50`);
      return (list || []).filter((i) => !i.pull_request);
    },

    async addLabels(repo, number, labels) {
      return call('POST', `${repoPath(repo)}/issues/${number}/labels`, { labels });
    },

    async removeLabel(repo, number, label) {
      try {
        await call('DELETE', `${repoPath(repo)}/issues/${number}/labels/${enc(label)}`);
      } catch (err) {
        if (err.status !== 404) throw err; // already off: fine
      }
    },

    async comment(repo, number, body) {
      return call('POST', `${repoPath(repo)}/issues/${number}/comments`, { body });
    },

    async createPull(repo, { head, base, title, body }) {
      return call('POST', `${repoPath(repo)}/pulls`, { head, base, title, body });
    },

    // Creates any missing label; an existing one (422) is left as it is.
    async ensureLabel(repo, { name, color, description }) {
      try {
        await call('POST', `${repoPath(repo)}/labels`, { name, color, description });
      } catch (err) {
        if (err.status !== 422) throw err;
      }
    },
  };
}

module.exports = { createGitHubClient };
