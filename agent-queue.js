// agent-queue.js - talk to an agent while it works (pattern from OpenClaw's
// composer queue, MIT; rewritten here, no code copied).
//
// A "thread" is a task and its chain of follow-ups (runs linked by `parent`).
// Messages written while the thread's latest run is still working wait in a
// queue; when that run ends, the next message goes out as a follow-up (same
// session, same branch). People can edit, reorder or drop queued messages, or
// "steer" one in now (the API stops the run and redirects it).
//
// Safety: a failed delivery keeps the message with its error and pauses that
// thread's queue - each try is a paid run, so it never retries in a loop. A
// person edits or retries it. State: logs/agent-queue.json (atomic writes).
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_TEXT = 8000;
const MAX_PER_THREAD = 20;
const INFLIGHT_MS = 2 * 60 * 1000; // a just-dispatched run may take a moment to log its start line

/** The first run of the thread `runId` belongs to. */
function rootOf(runs, runId) {
  const byId = new Map(runs.map((r) => [r.id, r]));
  let cur = byId.get(runId);
  const seen = new Set();
  while (cur && cur.parent && byId.has(cur.parent) && !seen.has(cur.id)) {
    seen.add(cur.id);
    cur = byId.get(cur.parent);
  }
  return cur ? cur.id : null;
}

/** All runs of a thread, oldest first. */
function threadRuns(runs, rootId) {
  return runs.filter((r) => rootOf(runs, r.id) === rootId)
    .sort((a, b) => String(a.started_at || '').localeCompare(String(b.started_at || '')));
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

/**
 * @param {object} deps
 * @param {string} deps.file
 * @param {() => object[]} deps.loadRuns     folded run log, newest first or any order
 * @param {(run: object, text: string) => Promise<{ok: boolean, runId?: string, error?: string}>} deps.continueRun
 */
function createAgentQueue({ file, loadRuns, continueRun, now = Date.now, log = () => {} }) {
  let state = readJson(file) || { threads: {} };
  if (!state.threads) state.threads = {};
  const save = () => writeJsonAtomic(file, state);
  const thread = (id) => state.threads[id] || (state.threads[id] = { items: [], inflight: null });

  function resolve(runId) {
    const runs = loadRuns();
    const root = rootOf(runs, String(runId || ''));
    return root ? { runs, root } : null;
  }

  function view(runId) {
    const r = resolve(runId);
    if (!r) return null;
    const t = state.threads[r.root] || { items: [], inflight: null };
    return { threadId: r.root, items: t.items.map((i) => ({ ...i })), inflight: t.inflight };
  }

  function add({ runId, text, by = 'unknown', helper = null }) {
    const msg = String(text || '').trim();
    if (!msg) return { ok: false, status: 400, error: 'write a message' };
    if (msg.length > MAX_TEXT) return { ok: false, status: 400, error: 'message is too long' };
    const r = resolve(runId);
    if (!r) return { ok: false, status: 404, error: 'run not found' };
    const t = thread(r.root);
    if (t.items.length >= MAX_PER_THREAD) return { ok: false, status: 409, error: `at most ${MAX_PER_THREAD} queued messages per task` };
    const item = { id: crypto.randomBytes(6).toString('hex'), text: msg, by, createdAt: new Date(now()).toISOString(), error: null, ...(helper ? { helper } : {}) };
    t.items.push(item);
    save();
    return { ok: true, threadId: r.root, item };
  }

  function find(threadId, itemId) {
    const t = state.threads[String(threadId || '')];
    const i = t ? t.items.findIndex((x) => x.id === itemId) : -1;
    return i < 0 ? null : { t, i };
  }

  /** Edit text (also clears a delivery error, so it is retried), move up/down, or remove. */
  function update({ threadId, itemId, text, move, remove }) {
    const f = find(threadId, itemId);
    if (!f) return { ok: false, status: 404, error: 'queued message not found' };
    const { t, i } = f;
    if (remove) {
      const [gone] = t.items.splice(i, 1);
      save();
      return { ok: true, removed: gone };
    }
    if (move === 'up' || move === 'down') {
      const j = move === 'up' ? i - 1 : i + 1;
      if (j >= 0 && j < t.items.length) [t.items[i], t.items[j]] = [t.items[j], t.items[i]];
    }
    if (text != null) {
      const msg = String(text).trim();
      if (!msg) return { ok: false, status: 400, error: 'write a message' };
      if (msg.length > MAX_TEXT) return { ok: false, status: 400, error: 'message is too long' };
      t.items[i] = { ...t.items[i], text: msg, error: null };
    }
    save();
    return { ok: true, items: t.items.map((x) => ({ ...x })) };
  }

  /** Take an item out of the queue (for "steer now", which the API delivers itself). */
  function take({ threadId, itemId }) {
    const f = find(threadId, itemId);
    if (!f) return null;
    const [item] = f.t.items.splice(f.i, 1);
    save();
    return item;
  }

  let ticking = false;
  /** Deliver the next message of every thread whose latest run has ended. */
  async function tick() {
    if (ticking) return [];
    ticking = true;
    const delivered = [];
    try {
      const runs = loadRuns();
      for (const [rootId, t] of Object.entries(state.threads)) {
        if (!t.items.length) continue;
        const head = t.items[0];
        if (head.error) continue; // paused until a person edits or retries
        const chain = threadRuns(runs, rootId);
        if (!chain.length) continue;
        if (t.inflight) {
          const started = chain.find((r) => r.id === t.inflight.runId);
          if (!started && now() - t.inflight.at < INFLIGHT_MS) continue;
          t.inflight = null;
        }
        const latest = chain[chain.length - 1];
        if (latest.status === 'running') continue;
        let res;
        try { res = await continueRun(latest, head.text, head); } catch (err) { res = { ok: false, error: err.message }; }
        if (res && res.ok) {
          t.items.shift();
          t.inflight = { runId: res.runId, at: now() };
          delivered.push({ threadId: rootId, runId: res.runId, itemId: head.id });
          log(`[queue] ${rootId}: delivered a queued message as ${res.runId}`);
        } else {
          head.error = String((res && res.error) || 'could not start the follow-up');
          log(`[queue] ${rootId}: delivery failed (${head.error}); paused`);
        }
        save();
      }
    } finally {
      ticking = false;
    }
    return delivered;
  }

  return { view, add, update, take, tick, threadOf: (runId) => { const r = resolve(runId); return r ? { threadId: r.root, runs: threadRuns(r.runs, r.root) } : null; } };
}

module.exports = { createAgentQueue, rootOf, threadRuns, MAX_PER_THREAD };
