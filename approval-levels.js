// approval-levels.js - how much a claude run may do without asking (OMB-1, OMB-4).
//
// Pattern borrowed from OpenMausBot (Apache-2.0, server/auto-approve.ts and
// server/agent-tool-policy.ts); rewritten here, no code copied.
//
// Each level is a fixed set of claude flags. Anything a level does not
// pre-allow is not refused outright: it goes to the approval helper
// (orchestration/approval-mcp.js), which shows an Allow/Deny card on /agents
// and denies when nobody answers in time.
//
//   review  PR reviews. Read, Glob and Grep only, named exactly: no shell, no
//           edits, no web. The diff is written to a file for the reviewer to
//           read, so it needs no `git diff` (whose --output flag writes files).
//           Nothing is ever asked: a review must never wait on a person.
//   ask     reads freely; every edit and command is asked.
//   edits   reads and edits freely; every command is asked.
//   auto    today's default: edits plus the common dev commands; the rest is asked.
//
// There is deliberately no "full access" level. git push and gh are denied at
// every level: the poller pushes and opens PRs, never the agent.

'use strict';

const LEVELS = ['review', 'ask', 'edits', 'auto'];
const RANK = { review: 0, ask: 1, edits: 2, auto: 3 };

const ALWAYS_DENIED = 'Bash(git push:*) Bash(gh:*)';

// The scripts dir is passed in so db-lock.sh keeps its pre-approval at `auto`.
function toolsFor(level, { scriptsDir = '' } = {}) {
  switch (level) {
    case 'review':
      return {
        permissionMode: 'default',
        allowed: 'Read Glob Grep',
        denied: `Edit Write NotebookEdit Bash WebFetch WebSearch ${ALWAYS_DENIED}`,
        asks: false,
      };
    case 'ask':
      return { permissionMode: 'default', allowed: 'Read Glob Grep', denied: ALWAYS_DENIED, asks: true };
    case 'edits':
      return { permissionMode: 'acceptEdits', allowed: 'Read Edit Write Glob Grep', denied: ALWAYS_DENIED, asks: true };
    case 'auto':
      return {
        permissionMode: 'acceptEdits',
        allowed: [
          'Read Edit Write Glob Grep',
          'Bash(git:*) Bash(npm:*) Bash(npx:*) Bash(supabase:*) Bash(node:*) Bash(ls:*) Bash(cat:*)',
          scriptsDir ? `Bash(${scriptsDir}/db-lock.sh:*)` : '',
        ].filter(Boolean).join(' '),
        denied: ALWAYS_DENIED,
        asks: true,
      };
    default:
      throw new Error(`unknown approval level: ${level}`);
  }
}

/** A level from user input, or null when it is not one. */
function parseLevel(value) {
  return typeof value === 'string' && LEVELS.includes(value) ? value : null;
}

/**
 * The level a run actually gets. A review is always `review`. A follow-up or
 * fix run never gets more than the run it continues: a level only flows down,
 * never up (OpenMausBot's delegated approval rule).
 */
function effectiveLevel({ requested, readOnly = false, parentLevel = null, fallback = 'auto' }) {
  if (readOnly) return 'review';
  const want = parseLevel(requested) || parseLevel(fallback) || 'auto';
  const parent = parseLevel(parentLevel);
  if (parent && RANK[want] > RANK[parent]) return parent === 'review' ? 'ask' : parent;
  return want;
}

module.exports = { LEVELS, toolsFor, parseLevel, effectiveLevel, ALWAYS_DENIED };
