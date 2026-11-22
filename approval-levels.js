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
//   auto    today's default: edits plus named dev subcommands (AUTO_COMMANDS);
//           the rest is asked.
//
// AUTO_COMMANDS names subcommands, never a whole CLI (2026-11-22). Before,
// `Bash(git:*) Bash(npm:*) Bash(npx:*) Bash(node:*) Bash(supabase:*)` let an
// agent run any code (`node -e`, `npx <pkg>`), slip past the push denial
// (`git -C . push` does not start with "git push"), run hooks via
// `git config core.hooksPath`, `npm publish`, or `supabase db push` to a
// linked production project. Running the repo's own scripts (`npm test`,
// `npm run x`) stays pre-allowed: that is what `auto` is for, and it does run
// code the agent may have edited - the worktree, not this list, is the limit.
//
// There is deliberately no "full access" level. git push and gh are denied at
// every level: the poller pushes and opens PRs, never the agent.

'use strict';

const LEVELS = ['review', 'ask', 'edits', 'auto'];
const RANK = { review: 0, ask: 1, edits: 2, auto: 3 };

const ALWAYS_DENIED = 'Bash(git push:*) Bash(gh:*) Bash(npm publish:*)';

const AUTO_COMMANDS = [
  // git: local history only. No -C/-c, config, remote, push, hooks.
  ...['status', 'diff', 'log', 'show', 'add', 'commit', 'restore', 'rm', 'mv', 'stash', 'branch', 'switch', 'checkout', 'rev-parse', 'ls-files', 'grep', 'blame', 'merge-base']
    .map((c) => `Bash(git ${c}:*)`),
  // npm: the repo's own scripts and installs from its manifest.
  'Bash(npm test:*)', 'Bash(npm run:*)', 'Bash(npm ci:*)', 'Bash(npm install)', 'Bash(npm ls:*)', 'Bash(npm outdated:*)',
  // node / npx: test runners, checkers and formatters only, never -e or a fetched package.
  'Bash(node --test:*)', 'Bash(node --check:*)',
  ...['eslint', 'tsc', 'prettier', 'vitest', 'jest', 'playwright test', 'next lint']
    .map((c) => `Bash(npx --no-install ${c}:*)`).concat(['eslint', 'tsc', 'prettier', 'vitest', 'jest', 'playwright test'].map((c) => `Bash(npx ${c}:*)`)),
  // supabase: the local stack only; link / db push / functions deploy are asked.
  ...['status', 'start', 'stop', 'db reset', 'test db', 'migration new', 'migration list --local', 'db lint']
    .map((c) => `Bash(supabase ${c}:*)`),
  'Bash(ls:*)', 'Bash(cat:*)',
];

// Role-based disallowed tool profiles for least-privilege enforcement
const ROLE_DISALLOWED_MAP = {
  researcher: ['Edit', 'Write', 'NotebookEdit', 'Bash'],
  analyst: ['Edit', 'Write', 'NotebookEdit', 'Bash'],
  writer: ['Bash'],
  'product-manager': ['Bash', 'Edit', 'Write', 'NotebookEdit'],
  reviewer: ['Edit', 'Write', 'NotebookEdit', 'Bash']
};

// The scripts dir is passed in so db-lock.sh keeps its pre-approval at `auto`.
function toolsFor(level, { scriptsDir = '', disallowedTools = [], specialistRole = null } = {}) {
  // Determine full disallowed list from explicit parameter or role profile
  const roleDisallowed = specialistRole && ROLE_DISALLOWED_MAP[specialistRole.toLowerCase()]
    ? ROLE_DISALLOWED_MAP[specialistRole.toLowerCase()]
    : [];
  const activeDisallowed = Array.from(new Set([...disallowedTools, ...roleDisallowed]));

  let result;
  switch (level) {
    case 'review':
      result = {
        permissionMode: 'default',
        allowed: 'Read Glob Grep',
        denied: `Edit Write NotebookEdit Bash WebFetch WebSearch ${ALWAYS_DENIED}`,
        asks: false,
      };
      break;
    case 'ask':
      result = { permissionMode: 'default', allowed: 'Read Glob Grep', denied: ALWAYS_DENIED, asks: true };
      break;
    case 'edits':
      result = { permissionMode: 'acceptEdits', allowed: 'Read Edit Write Glob Grep', denied: ALWAYS_DENIED, asks: true };
      break;
    case 'auto':
      result = {
        permissionMode: 'acceptEdits',
        allowed: [
          'Read Edit Write Glob Grep',
          AUTO_COMMANDS.join(' '),
          scriptsDir ? `Bash(${scriptsDir}/db-lock.sh:*)` : '',
        ].filter(Boolean).join(' '),
        denied: ALWAYS_DENIED,
        asks: true,
      };
      break;
    default:
      throw new Error(`unknown approval level: ${level}`);
  }

  // If disallowed tools exist, strip them from allowed and append to denied
  if (activeDisallowed.length > 0) {
    let allowedTokens = result.allowed.split(/\s+/).filter(Boolean);
    for (const dis of activeDisallowed) {
      allowedTokens = allowedTokens.filter(tok => {
        if (dis === 'Bash' && tok.startsWith('Bash')) return false;
        return tok !== dis;
      });
    }
    result.allowed = allowedTokens.join(' ');
    const deniedTokens = new Set([...result.denied.split(/\s+/).filter(Boolean), ...activeDisallowed]);
    result.denied = Array.from(deniedTokens).join(' ');
  }

  return result;
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

module.exports = {
  LEVELS,
  toolsFor,
  parseLevel,
  effectiveLevel,
  ALWAYS_DENIED,
  AUTO_COMMANDS,
  ROLE_DISALLOWED_MAP
};
