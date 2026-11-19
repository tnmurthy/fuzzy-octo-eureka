// approvals-api.js - HTTP for approval cards (OMB-3). Store: approvals.js.
//
// Two audiences:
//   * the approval helper inside a run (orchestration/approval-mcp.js):
//       POST /api/agents/approvals/request   {runId, token, tool, input}
//       GET  /api/agents/approvals/status?id=&runId=   header x-run-token
//     Local requests only (never through the tunnel), and only with the
//     run's own token.
//   * people on /agents (admins: same rule as the paid-run cap):
//       GET  /api/agents/approvals            pending, recent, always-allow lists
//       POST /api/agents/approvals/decide     {id, decision: allow|deny, remember}
//       POST /api/agents/approvals/always/remove {repo, key}
//     POSTs are same-site JSON only, so another website cannot approve an
//     action through a browser that is signed in here.

'use strict';

const { isSameSiteJson } = require('./agents-api');

const MAX_BODY = 64 * 1024;

function createApprovalsApi({ store, isLocal, isAdmin, actorOf = () => 'unknown' }) {
  function handle(req, res, { sendJson, readJsonBody }) {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    if (!p.startsWith('/api/agents/approvals')) return false;

    const body = (fn) => readJsonBody(req, MAX_BODY)
      .then(fn)
      .catch((err) => sendJson(res, 400, { ok: false, error: err.message || 'bad request' }));
    const reply = (out) => sendJson(res, out.ok ? 200 : out.status || 400, out);

    // --- the helper inside a run -------------------------------------------
    if (p === '/api/agents/approvals/request' && req.method === 'POST') {
      if (!isLocal(req)) { sendJson(res, 403, { ok: false, error: 'local only' }); return true; }
      body((b) => reply(store.request({ runId: b.runId, token: b.token, tool: b.tool, input: b.input })));
      return true;
    }
    if (p === '/api/agents/approvals/status' && req.method === 'GET') {
      if (!isLocal(req)) { sendJson(res, 403, { ok: false, error: 'local only' }); return true; }
      reply(store.status({
        id: url.searchParams.get('id'), runId: url.searchParams.get('runId'), token: req.headers['x-run-token'],
      }));
      return true;
    }

    // --- people ------------------------------------------------------------
    if (!isAdmin(req)) { sendJson(res, 403, { ok: false, error: 'only an admin can see or answer approvals' }); return true; }
    if (p === '/api/agents/approvals' && req.method === 'GET') {
      sendJson(res, 200, { ok: true, pending: store.pending(), recent: store.recent(), alwaysAllow: store.alwaysAllow() });
      return true;
    }
    if (req.method === 'POST' && !isSameSiteJson(req)) {
      sendJson(res, 403, { ok: false, error: 'send same-origin JSON' });
      return true;
    }
    if (p === '/api/agents/approvals/decide' && req.method === 'POST') {
      body((b) => reply(store.decide({ id: b.id, decision: b.decision, remember: b.remember === true, actor: actorOf(req) })));
      return true;
    }
    if (p === '/api/agents/approvals/always/remove' && req.method === 'POST') {
      body((b) => reply(store.removeAlways({ repo: String(b.repo || ''), key: String(b.key || '') })));
      return true;
    }
    sendJson(res, 404, { ok: false, error: 'not found' });
    return true;
  }
  return { handle };
}

module.exports = { createApprovalsApi };
