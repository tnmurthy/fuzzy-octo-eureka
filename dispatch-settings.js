// dispatch-settings.js - admin-editable dispatch settings, kept in a small
// JSON file so a change from the Agents page takes effect without a restart
// and survives one. Today: the daily paid-run cap. The file wins over
// DISPATCH_DAILY_PAID_RUNS in .env; delete it to fall back to .env.

const fs = require('fs');
const path = require('path');

const MAX_CAP = 1000;

/** Integer 0..MAX_CAP, or an error string. */
function validateCap(value) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (!Number.isInteger(n) || n < 0 || n > MAX_CAP) return { ok: false, error: `daily paid runs must be a whole number from 0 to ${MAX_CAP}` };
  return { ok: true, value: n };
}

/**
 * @param {object} o
 * @param {string} o.file       settings JSON path
 * @param {number} o.envCap     cap from .env (already parsed)
 * @param {() => Date} [o.now]
 */
function createDispatchSettings({ file, envCap, now = () => new Date() }) {
  let current = null;
  let seenMtime = -1;
  // Re-read when the file changes, so both dashboards (8787 and 8788 share
  // the logs folder) see an admin's change without a restart.
  function refresh() {
    let mtime = 0;
    try { mtime = fs.statSync(file).mtimeMs; } catch (_) { mtime = 0; }
    if (mtime === seenMtime) return;
    seenMtime = mtime;
    current = null;
    if (!mtime) return;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (validateCap(raw.dailyPaidRuns).ok) current = raw;
    } catch (_) { /* corrupt: .env applies */ }
  }

  return {
    cap() {
      refresh();
      return current ? current.dailyPaidRuns : envCap;
    },
    describe() {
      refresh();
      return current
        ? { dailyPaidRuns: current.dailyPaidRuns, source: 'admin', updatedBy: current.updatedBy, updatedAt: current.updatedAt, envDefault: envCap }
        : { dailyPaidRuns: envCap, source: 'env', envDefault: envCap };
    },
    setCap(value, actor) {
      const v = validateCap(value);
      if (!v.ok) return v;
      const next = { dailyPaidRuns: v.value, updatedBy: String(actor || 'unknown').slice(0, 80), updatedAt: now().toISOString() };
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

module.exports = { createDispatchSettings, validateCap, MAX_CAP };
