'use strict';
// teammate-mode.js - what an agent run started by a teammate (not an admin)
// may do. An admin picks the mode on the Agents page; it is kept in a small
// JSON file (like dispatch-settings.js) so it applies to the next run on both
// dashboards without a restart. TEAMMATE_RUN_MODE in .env is the default.
//
//   sandbox   Hermes in its Docker sandbox (agent-dispatch.sh, #46): sees only
//             the worktree, changes committed on the host. Claude runs keep
//             their approval cards. Today's behaviour.
//   readonly  Hermes only, in the sandbox with no network and file tools only;
//             any file change is thrown away. Answers and documents in the reply.
//   claude    Every run becomes Claude, whose risky steps wait for an admin's
//             Allow/Deny card. Paid.
//   off       Teammates cannot start agents.
//
// Admins (and requests at this Mac) are never affected. Teammates may use
// only hermes, claude, auto and noop in any mode.

const fs = require('fs');
const path = require('path');

const MODES = ['sandbox', 'readonly', 'claude', 'off'];
const TEAMMATE_AGENTS = new Set(['hermes', 'claude', 'auto', 'noop']);

const LABELS = {
  sandbox: 'Docker sandbox (free, can change code)',
  readonly: 'Read-only (answers and documents only)',
  claude: 'Claude only (paid, risky steps approved by an admin)',
  off: 'Off (teammates cannot start agents)',
};

function parseMode(value) {
  return typeof value === 'string' && MODES.includes(value) ? value : null;
}

/**
 * The agent a run actually gets.
 * @param {{ mode: string, admin: boolean, agent: string }} o
 * @returns {{ ok: true, agent: string, hermesMode: 'sandbox'|'readonly'|null, mode: string }
 *         | { ok: false, status: number, error: string }}
 */
function applyTeammateMode({ mode, admin, agent }) {
  if (admin) return { ok: true, agent, hermesMode: null, mode: 'admin' };
  const m = parseMode(mode) || 'sandbox';
  if (m === 'off') {
    return { ok: false, status: 403, error: 'Agents are switched off for teammates right now. Ask an admin.' };
  }
  if (!TEAMMATE_AGENTS.has(agent)) {
    return { ok: false, status: 403, error: `the ${agent} agent is for admins only` };
  }
  if (agent === 'noop') return { ok: true, agent, hermesMode: null, mode: m };
  if (m === 'readonly') return { ok: true, agent: 'hermes', hermesMode: 'readonly', mode: m };
  if (m === 'claude') return { ok: true, agent: 'claude', hermesMode: null, mode: m };
  return { ok: true, agent, hermesMode: 'sandbox', mode: m };
}

/**
 * @param {{ file: string, envMode?: string, now?: () => Date }} o
 */
function createTeammateModeSetting({ file, envMode, now = () => new Date() }) {
  const fallback = parseMode(envMode) || 'sandbox';
  let current = null;
  let seenMtime = -1;
  function refresh() {
    let mtime = 0;
    try { mtime = fs.statSync(file).mtimeMs; } catch (_) { mtime = 0; }
    if (mtime === seenMtime) return;
    seenMtime = mtime;
    current = null;
    if (!mtime) return;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parseMode(raw.mode)) current = raw;
    } catch (_) { /* corrupt: .env applies */ }
  }
  return {
    get() {
      refresh();
      return current ? current.mode : fallback;
    },
    describe() {
      refresh();
      const mode = current ? current.mode : fallback;
      return {
        mode,
        modes: MODES.map((m) => ({ value: m, label: LABELS[m] })),
        source: current ? 'admin' : 'env',
        ...(current ? { updatedBy: current.updatedBy, updatedAt: current.updatedAt } : {}),
        envDefault: fallback,
      };
    },
    set(value, actor) {
      const mode = parseMode(value);
      if (!mode) return { ok: false, error: `mode is one of: ${MODES.join(', ')}` };
      const next = { mode, updatedBy: String(actor || 'unknown').slice(0, 80), updatedAt: now().toISOString() };
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
      fs.renameSync(tmp, file);
      current = next;
      seenMtime = fs.statSync(file).mtimeMs;
      return { ok: true, value: next };
    },
  };
}

module.exports = { MODES, LABELS, parseMode, applyTeammateMode, createTeammateModeSetting };
