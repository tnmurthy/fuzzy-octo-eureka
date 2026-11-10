// ESLint flat config.
//
// The codebase predates this linter, so style rules are set to `warn` (or off)
// to avoid a reformat firehose; the goal is to catch *future* drift and real
// bugs, not to police existing style. `node --check` + the test suite remain the
// safety net; this is a lightweight gate on top.
const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  {
    ignores: [
      'node_modules/**',
      'buzz-bridge/node_modules/**',
      'logs/**',
      '*.bak*',
      'supabase/tests/**',
    ],
  },
  js.configs.recommended,
  // .mjs files (orchestration helpers, claude-usage) are ESM.
  {
    files: ['**/*.mjs'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: { ...globals.node } },
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      // Node globals for server/daemon/bridge; browser globals for the dashboard UI.
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      // Lenient on style - the existing code is not yet formatted to taste.
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
      'no-empty': 'off', // `catch (_) {}` is used intentionally for best-effort sync
      'no-console': 'off', // telemetry daemon logs by design
      'no-prototype-builtins': 'warn',
      // Strict on things that are almost always bugs.
      'no-constant-condition': 'error',
      'no-dupe-keys': 'error',
      'no-func-assign': 'error',
      'no-unreachable': 'error',
      // Demoted to warn: pre-existing, safe-to-defer cleanups (not blocking CI).
      'no-useless-assignment': 'warn',
      'preserve-caught-error': 'warn',
    },
  },
];
