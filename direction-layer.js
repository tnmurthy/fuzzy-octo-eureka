// direction-layer.js - Budgeted Direction & Intent Layer
// Inspired by AI Team OS (CronusL-1141/AI-company) Memory System v2.
//
// Manages developer design intent, constraints, and behavioral preferences:
// 1. Strict Character Budgets:
//    - Global: <= 1200 chars
//    - Per-project: <= 1500 chars
//    - Per-user: <= 300 chars
//    - Overall ceiling: <= 3000 chars
//    - Individual entry: <= 400 chars
// 2. Auditable Invalidation:
//    - Outdated rules are never silently erased; marked superseded_by: <id>.
// 3. Prompt-Injection & Security Defense:
//    - Automatically scans for zero-width characters, injection patterns, and credential shapes.

'use strict';

const crypto = require('crypto');

const BUDGETS = {
  global: 1200,
  project: 1500,
  user: 300,
  total: 3000,
  perEntry: 400
};

// Injection & jailbreak detection patterns
const INJECTION_PATTERNS = [
  /(?:ignore|disregard|forget|bypass|override)\s+(?:all\s+)?(?:previous|prior|system|above)\s+(?:instructions|rules|prompts|directives|guardrails)/i,
  /\b(?:system\s*override|developer\s*mode\s*enabled|jailbreak\s*activated|unrestricted\s*mode)\b/i,
  /\b(?:pretend\s+you\s+are\s+now|you\s+are\s+now\s+free\s+of|act\s+as\s+an\s+unfiltered)\b/i,
  /<script\b[^>]*>/i,
  /\b(?:base64\s*decode\s*and\s*execute|eval\s*\()/i
];

// Zero-width and dangerous invisible Unicode characters
// eslint-disable-next-line no-control-regex
const INVISIBLE_UNICODE_RE = /[\u200B-\u200D\uFEFF\u202A-\u202E\u0000-\u0008\u000B\u000C\u000E-\u001F]/;

// Secret credential formats
const SECRET_SHAPES = [
  /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/,
  /\bsk-[a-zA-Z0-9_-]{24,}\b/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/
];

/**
 * Validates text against prompt injection, invisible characters, and leaked credentials.
 */
function scanSecurity(text) {
  const clean = String(text || '');

  // 1. Invisible characters
  if (INVISIBLE_UNICODE_RE.test(clean)) {
    return { ok: false, violation: 'Rejected: Contains dangerous invisible or zero-width Unicode characters' };
  }

  // 2. Prompt injection patterns
  for (const pat of INJECTION_PATTERNS) {
    if (pat.test(clean)) {
      return { ok: false, violation: `Rejected: Detected potential prompt injection pattern (${pat.source})` };
    }
  }

  // 3. Secret credential shapes
  for (const sec of SECRET_SHAPES) {
    if (sec.test(clean)) {
      return { ok: false, violation: 'Rejected: Appears to contain raw API keys or private credentials' };
    }
  }

  return { ok: true };
}

function createDirectionLayer({ initialRules = [], ledgerDB = null } = {}) {
  // Map of id -> rule object
  const rulesMap = new Map();

  for (const r of initialRules) {
    rulesMap.set(r.id, { ...r });
  }

  function getActiveRules(filter = {}) {
    const { scope = null, targetId = null } = filter;
    const active = [];

    for (const [, r] of rulesMap) {
      if (!r.active) continue;
      if (scope && r.scope !== scope) continue;
      if (targetId && r.targetId && r.targetId !== targetId) continue;
      active.push(r);
    }

    return active;
  }

  function computeUsage() {
    const usage = { global: 0, project: 0, user: 0, total: 0 };
    for (const [, r] of rulesMap) {
      if (!r.active) continue;
      const len = (r.ruleText || '').length;
      if (r.scope === 'global') usage.global += len;
      else if (r.scope === 'project') usage.project += len;
      else if (r.scope === 'user') usage.user += len;
      usage.total += len;
    }
    return usage;
  }

  /**
   * Adds or supersedes a direction rule with strict validation.
   */
  function addRule({
    id = null,
    scope = 'global',
    targetId = null,
    title,
    ruleText,
    supersedesId = null
  }) {
    if (!title || !ruleText) {
      throw new Error('title and ruleText are required');
    }

    const trimmedRule = String(ruleText).trim();
    if (trimmedRule.length > BUDGETS.perEntry) {
      throw new Error(`Rule text exceeds per-entry budget of ${BUDGETS.perEntry} chars (got ${trimmedRule.length})`);
    }

    // Security scanning
    const securityCheck = scanSecurity(`${title} ${trimmedRule}`);
    if (!securityCheck.ok) {
      throw new Error(securityCheck.violation);
    }

    // Budget check
    const currentUsage = computeUsage();
    const scopeBudget = BUDGETS[scope] || BUDGETS.global;
    const currentScopeUsage = currentUsage[scope] || 0;

    // Account for budget freed if superseding an active rule
    let freedChars = 0;
    if (supersedesId && rulesMap.has(supersedesId)) {
      const oldRule = rulesMap.get(supersedesId);
      if (oldRule.active && oldRule.scope === scope) {
        freedChars = (oldRule.ruleText || '').length;
      }
    }

    if (currentScopeUsage - freedChars + trimmedRule.length > scopeBudget) {
      throw new Error(`Scope "${scope}" budget exceeded: max ${scopeBudget} chars, requested ${currentScopeUsage - freedChars + trimmedRule.length}`);
    }

    if (currentUsage.total - freedChars + trimmedRule.length > BUDGETS.total) {
      throw new Error(`Total direction budget exceeded: max ${BUDGETS.total} chars`);
    }

    const ruleId = id || 'DIR-' + crypto.randomBytes(3).toString('hex').toUpperCase();

    // Invalidate superseded rule
    if (supersedesId && rulesMap.has(supersedesId)) {
      const old = rulesMap.get(supersedesId);
      old.active = false;
      old.supersededBy = ruleId;
      old.updatedAt = new Date().toISOString();
      if (ledgerDB && typeof ledgerDB.saveDirectionRule === 'function') {
        ledgerDB.saveDirectionRule(old);
      }
    }

    const ruleRecord = {
      id: ruleId,
      scope,
      targetId: targetId || null,
      title: title.trim(),
      ruleText: trimmedRule,
      active: true,
      supersededBy: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    rulesMap.set(ruleId, ruleRecord);

    if (ledgerDB && typeof ledgerDB.saveDirectionRule === 'function') {
      ledgerDB.saveDirectionRule(ruleRecord);
    }

    return ruleRecord;
  }

  /**
   * Deactivates a rule by marking it superseded / inactive.
   */
  function deactivateRule(ruleId, reason = 'manual_removal') {
    const rule = rulesMap.get(ruleId);
    if (!rule) return false;

    rule.active = false;
    rule.supersededBy = `INACTIVATED:${reason}`;
    rule.updatedAt = new Date().toISOString();

    if (ledgerDB && typeof ledgerDB.saveDirectionRule === 'function') {
      ledgerDB.saveDirectionRule(rule);
    }

    return true;
  }

  /**
   * Formats active direction rules for prompt injection.
   */
  function formatDirectionPrompt({ projectId = null, userId = null } = {}) {
    const active = [];

    // 1. Global rules
    for (const [, r] of rulesMap) {
      if (r.active && r.scope === 'global') active.push(r);
    }

    // 2. Project rules
    if (projectId) {
      for (const [, r] of rulesMap) {
        if (r.active && r.scope === 'project' && (!r.targetId || r.targetId === projectId)) {
          active.push(r);
        }
      }
    }

    // 3. User rules
    if (userId) {
      for (const [, r] of rulesMap) {
        if (r.active && r.scope === 'user' && r.targetId === userId) {
          active.push(r);
        }
      }
    }

    if (!active.length) return '';

    // One line per rule: line breaks flattened so a rule cannot fake a new
    // prompt section (e.g. "Task:"); \s also matches Unicode line breaks.
    const flat = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
    const lines = active.map((r) => `- [${flat(r.id)}] (${flat(r.scope)}): ${flat(r.title).slice(0, 120)} -> ${flat(r.ruleText)}`);
    return `\n\n---\nDirection & Intent Constraints (Budgeted & Verified):\n${lines.join('\n')}\n`;
  }

  function getAllRules() {
    return Array.from(rulesMap.values());
  }

  return {
    addRule,
    deactivateRule,
    getActiveRules,
    getAllRules,
    computeUsage,
    formatDirectionPrompt,
    scanSecurity,
    BUDGETS
  };
}

module.exports = {
  createDirectionLayer,
  scanSecurity,
  BUDGETS
};
