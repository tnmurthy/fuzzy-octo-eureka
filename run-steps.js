// run-steps.js - a run log (orchestration/stream-log.js lines) as steps a
// person can follow: "Reading src/auth.js", "Running npm test", "Error: ...".
// Pure; window.RunSteps in the browser, require() in run-steps.test.js.
//
// Log lines look like:
//   12:01:02 == claude started (model sonnet)
//   12:01:05 💬 I'll start by reading the auth module.
//   12:01:06 🔧 Read /repo--agent-run-x/src/auth.js
//   12:01:07    ↳ error: File does not exist.
//   12:03:40 == claude finished: success · 12 turns · $0.1234
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RunSteps = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const VERBS = {
    Read: 'Reading', Edit: 'Editing', MultiEdit: 'Editing', Write: 'Writing', NotebookEdit: 'Editing',
    Bash: 'Running', Grep: 'Searching for', Glob: 'Looking for files', WebFetch: 'Opening', WebSearch: 'Searching the web for',
    Task: 'Delegating', TodoWrite: 'Updating its plan', LS: 'Listing',
    // hermes (local) tool names
    terminal: 'Running', read_file: 'Reading', write_file: 'Writing', patch: 'Editing',
    search_files: 'Searching for', web_search: 'Searching the web for', web_extract: 'Opening', todo: 'Updating its plan',
  };
  const ICONS = { read: '📖', edit: '✏️', run: '▶️', search: '🔎', say: '💬', error: '⚠️', phase: '•', other: '🔧' };
  const KIND = { Reading: 'read', Listing: 'read', Editing: 'edit', Writing: 'edit', Running: 'run' };

  // Worktree paths are long and the same on every line: keep the part a
  // person recognises (last 3 segments).
  function shortPath(arg) {
    return String(arg).replace(/(?:\/[^\s/]+){4,}\/([^\s/]+\/[^\s/]+\/[^\s/]+)(?=\s|$)/g, '…/$1');
  }

  function parseLine(line) {
    const m = String(line).match(/^(\d\d:\d\d:\d\d) (.*)$/);
    if (!m) return null;
    const [, t, rest] = m;
    let x;
    if ((x = rest.match(/^🔧 (\S+)\s*(.*)$/))) {
      const tool = x[1].replace(/^mcp__\w+__/, '');
      const verb = VERBS[tool];
      const kind = verb ? (KIND[verb] || (/^Search|^Looking/.test(verb) ? 'search' : 'other')) : 'other';
      const arg = shortPath(x[2]);
      return { t, kind, icon: ICONS[kind], text: verb ? `${verb}${arg ? ` ${arg}` : ''}` : `${tool}${arg ? ` ${arg}` : ''}` };
    }
    if ((x = rest.match(/^💬 (.*)$/))) return { t, kind: 'say', icon: ICONS.say, text: x[1] };
    if ((x = rest.match(/^\s*↳ error: (.*)$/))) return { t, kind: 'error', icon: ICONS.error, text: x[1] };
    if (/^== (?:claude|hermes) started/.test(rest)) return { t, kind: 'phase', icon: ICONS.phase, text: rest.includes('hermes') ? 'Local agent started' : 'Agent started' };
    if ((x = rest.match(/^== (?:claude|hermes) finished: (\w+)/))) return { t, kind: 'phase', icon: ICONS.phase, text: x[1] === 'success' ? 'Agent finished' : `Agent stopped (${x[1].replace(/_/g, ' ')})` };
    return null;
  }

  /** Steps from a log tail, oldest first; at most `limit` (the newest). */
  function parseSteps(text, limit = 12) {
    const steps = String(text || '').split(/\r?\n/).map(parseLine).filter(Boolean);
    return steps.slice(-limit);
  }

  /** One-line counts for the header: "14 steps · 5 files read · 3 edits · 2 commands". */
  function summary(text) {
    const all = parseSteps(text, Infinity);
    const n = (k) => all.filter((s) => s.kind === k).length;
    const parts = [`${all.length} steps`];
    if (n('read')) parts.push(`${n('read')} read`);
    if (n('edit')) parts.push(`${n('edit')} edits`);
    if (n('run')) parts.push(`${n('run')} commands`);
    if (n('error')) parts.push(`${n('error')} errors`);
    return parts.join(' · ');
  }

  return { parseLine, parseSteps, summary, shortPath };
});
