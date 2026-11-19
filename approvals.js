// approvals.js - permission requests from running agents, and what to remember (OMB-2, OMB-3).
//
// Pattern borrowed from OpenMausBot (Apache-2.0, server/always-allow.ts and its
// permission broker); rewritten here, no code copied.
//
// A claude run asks through orchestration/approval-mcp.js when its level does
// not pre-allow a tool. Each run is registered at dispatch with a random
// token; a request must carry its run's token, so nothing else on this Mac can
// file approvals in a run's name.
//
// Rules:
//   * a request nobody answers is denied at its deadline (the run carries on
//     without that action and its slot is freed);
//   * "Always allow" remembers the exact action per repo: a command string, a
//     file path, a URL. Never a prefix: allowing `npm test` does not allow
//     `npm test; rm -rf ~`;
//   * a repo's list holds at most MAX_ALWAYS_ALLOW keys. Past that the grant is
//     refused, never dropped: the card stays pending and says why;
//   * removing a key takes effect on the next request, including from runs
//     already going.
// Pending requests live in memory: a dashboard restart drops them, and the
// helper then denies at its own deadline.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_ALWAYS_ALLOW = 200;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_INPUT_CHARS = 2000;

/** What "Always allow" remembers for one tool call: the exact action, never a prefix. */
function actionKey(tool, input) {
  const i = input && typeof input === 'object' ? input : {};
  const name = String(tool || '').slice(0, 200);
  if (name === 'Bash' && typeof i.command === 'string') return `Bash:${i.command.trim()}`;
  if (typeof i.file_path === 'string') return `${name}:${i.file_path}`;
  if (typeof i.notebook_path === 'string') return `${name}:${i.notebook_path}`;
  if (typeof i.url === 'string') return `${name}:${i.url}`;
  return name;
}

/** A short, safe-to-show summary of the input for the card. */
function summarise(tool, input) {
  const i = input && typeof input === 'object' ? input : {};
  const text = i.command ?? i.file_path ?? i.notebook_path ?? i.url ?? i.pattern ?? JSON.stringify(i);
  return String(text).slice(0, MAX_INPUT_CHARS);
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

function createApprovals({ file, now = Date.now, timeoutMs = DEFAULT_TIMEOUT_MS, onChange = () => {} }) {
  const runs = new Map();      // runId -> { token, repo, level }
  const requests = new Map();  // id -> request
  let always = readJson(file, {}); // repo -> [keys]
  if (!always || typeof always !== 'object' || Array.isArray(always)) always = {};

  function registerRun({ runId, repo, level }) {
    const token = crypto.randomBytes(24).toString('hex');
    runs.set(String(runId), { token, repo: String(repo), level });
    return token;
  }

  function forgetRun(runId) {
    runs.delete(String(runId));
  }

  function authRun(runId, token) {
    const r = runs.get(String(runId));
    if (!r || typeof token !== 'string' || token.length !== r.token.length) return null;
    return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(r.token)) ? r : null;
  }

  function expire() {
    const t = now();
    for (const r of requests.values()) {
      if (r.status === 'pending' && t >= r.deadline) {
        Object.assign(r, { status: 'denied', reason: 'nobody answered in time', decidedAt: t, decidedBy: 'timeout' });
        onChange(r);
      }
    }
    // Keep settled requests for an hour so the helper and the page can read the outcome.
    for (const [id, r] of requests) if (r.status !== 'pending' && t - r.decidedAt > 60 * 60 * 1000) requests.delete(id);
  }

  /** A run asks to use a tool. Already-remembered actions are allowed at once. */
  function request({ runId, token, tool, input }) {
    const run = authRun(runId, token);
    if (!run) return { ok: false, status: 403, error: 'unknown run or token' };
    if (typeof tool !== 'string' || !tool) return { ok: false, status: 400, error: 'tool is required' };
    expire();
    const key = actionKey(tool, input);
    const t = now();
    const r = {
      id: crypto.randomUUID(), runId: String(runId), repo: run.repo, level: run.level,
      tool, summary: summarise(tool, input), key, createdAt: t, deadline: t + timeoutMs,
      status: 'pending', reason: null, decidedAt: null, decidedBy: null,
    };
    if ((always[run.repo] || []).includes(key)) {
      Object.assign(r, { status: 'allowed', reason: 'always allowed for this repo', decidedAt: t, decidedBy: 'always-allow' });
    }
    requests.set(r.id, r);
    onChange(r);
    return { ok: true, request: r };
  }

  /** The helper polls its own request, with its run's token. */
  function status({ id, runId, token }) {
    if (!authRun(runId, token)) return { ok: false, status: 403, error: 'unknown run or token' };
    expire();
    const r = requests.get(String(id));
    if (!r || r.runId !== String(runId)) return { ok: false, status: 404, error: 'no such request' };
    return { ok: true, request: r };
  }

  /** A person decides. `remember` adds the exact action to the repo's always-allow list. */
  function decide({ id, decision, remember = false, actor = 'unknown' }) {
    expire();
    const r = requests.get(String(id));
    if (!r) return { ok: false, status: 404, error: 'no such request' };
    if (r.status !== 'pending') return { ok: false, status: 409, error: `already ${r.status}` };
    if (decision !== 'allow' && decision !== 'deny') return { ok: false, status: 400, error: 'decision is allow or deny' };
    if (decision === 'allow' && remember) {
      const list = always[r.repo] || [];
      if (!list.includes(r.key)) {
        if (list.length >= MAX_ALWAYS_ALLOW) {
          return { ok: false, status: 409, error: `this repo already remembers ${MAX_ALWAYS_ALLOW} actions; remove some first` };
        }
        always = { ...always, [r.repo]: [...list, r.key] };
        writeJsonAtomic(file, always);
      }
    }
    Object.assign(r, {
      status: decision === 'allow' ? 'allowed' : 'denied',
      reason: decision === 'allow' ? (remember ? 'allowed and remembered' : 'allowed once') : 'denied by a person',
      decidedAt: now(), decidedBy: String(actor).slice(0, 120),
    });
    onChange(r);
    return { ok: true, request: r };
  }

  function removeAlways({ repo, key }) {
    const list = always[repo] || [];
    if (!list.includes(key)) return { ok: false, status: 404, error: 'not on the list' };
    always = { ...always, [repo]: list.filter((k) => k !== key) };
    writeJsonAtomic(file, always);
    return { ok: true };
  }

  function pending() {
    expire();
    return [...requests.values()].filter((r) => r.status === 'pending').sort((a, b) => a.createdAt - b.createdAt);
  }

  function recent(limit = 20) {
    expire();
    return [...requests.values()].filter((r) => r.status !== 'pending')
      .sort((a, b) => b.decidedAt - a.decidedAt).slice(0, limit);
  }

  return {
    registerRun, forgetRun, request, status, decide, removeAlways, pending, recent,
    alwaysAllow: () => always,
  };
}

module.exports = { createApprovals, actionKey, summarise, MAX_ALWAYS_ALLOW, DEFAULT_TIMEOUT_MS };
