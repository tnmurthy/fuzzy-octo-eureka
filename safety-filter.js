// safety-filter.js - Pre-flight safety filter for agent dispatches (FR-CHAT-07)
// Guards against destructive commands by requiring explicit operator confirmation.

const RISKY_PATTERNS = [
  { pattern: /git\s+reset\s+--hard/i, name: 'git reset --hard' },
  { pattern: /git\s+push\s+.*(--force|-f\b)/i, name: 'git push --force' },
  { pattern: /rm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r|--recursive\s+--force)/i, name: 'rm -rf' },
  { pattern: /drop\s+(table|database)|truncate\s+table/i, name: 'DROP/TRUNCATE table' },
  { pattern: /mkfs\b|fdisk\b|dd\s+if=/i, name: 'destructive disk/block write' },
  { pattern: /chmod\s+(-[a-zA-Z]*R|--recursive)?\s*777/i, name: 'insecure chmod 777' }
];

function checkPromptSafety(prompt) {
  if (!prompt || typeof prompt !== 'string') return { safe: true };
  for (const { pattern, name } of RISKY_PATTERNS) {
    if (pattern.test(prompt)) {
      return { safe: false, matchedPattern: name };
    }
  }
  return { safe: true };
}

function validateDispatchSafety(prompt, options = {}) {
  const safety = checkPromptSafety(prompt);
  if (safety.safe) {
    return { ok: true };
  }
  if (options.confirmed === true || options.force === true) {
    return {
      ok: true,
      confirmed: true,
      warning: `Dispatched with explicit operator confirmation (${safety.matchedPattern})`
    };
  }
  return {
    ok: false,
    risky: true,
    requiresConfirmation: true,
    matchedPattern: safety.matchedPattern,
    error: `High-risk operation detected: [${safety.matchedPattern}]. Explicit operator confirmation required (pass { confirmed: true }).`
  };
}

module.exports = {
  checkPromptSafety,
  validateDispatchSafety,
  RISKY_PATTERNS
};
