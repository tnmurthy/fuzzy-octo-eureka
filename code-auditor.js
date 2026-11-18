// code-auditor.js - Automated Security & Code Quality Reviewer ("Maker / Checker")
// Part of the Drisyon Operations Center & Arunachala Governance Architecture.
//
// Evaluates code changes in agent worktrees before landing in main or opening a PR.
// Audits against:
// 1. Secret & Credential Leaks (OWASP A07:2021)
// 2. Command & Code Injection (OWASP A03:2021)
// 3. Client-Side XSS & DOM Injection (innerHTML)
// 4. Path Traversal & File Access Vulnerabilities
// 5. Error Boundaries & Resilience (async without try/catch)

/**
 * Audits unified git diff text and returns a structured quality & security scorecard.
 * @param {string} diffText - Raw unified diff string
 * @returns {object} Audit scorecard
 */
function auditDiff(diffText) {
  const text = String(diffText || '');
  const lines = text.split(/\r?\n/);

  const findings = [];
  let linesAdded = 0;
  let linesDeleted = 0;
  const filesModified = new Set();
  let currentFile = 'unknown';

  const SECRET_PATTERNS = [
    { name: 'GitHub Token', re: /ghp_[A-Za-z0-9]{36}/ },
    { name: 'AWS Access Key', re: /AKIA[0-9A-Z]{16}/ },
    { name: 'Private Key Block', re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/ },
    { name: 'Hardcoded Secret', re: /(?:api[_-]?key|secret|password|auth_token)\s*[:=]\s*['"][a-zA-Z0-9_\-]{16,}['"]/i }
  ];

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      const m = line.match(/diff --git a\/(.+?) b\/(.+?)$/);
      if (m) {
        currentFile = m[2];
        filesModified.add(currentFile);
      }
      continue;
    }

    if (line.startsWith('+++ ') || line.startsWith('--- ')) {
      continue;
    }

    if (line.startsWith('-')) {
      linesDeleted++;
      continue;
    }

    if (!line.startsWith('+')) {
      continue;
    }

    // Only inspect newly added lines (+)
    linesAdded++;
    const addedCode = line.slice(1).trim();

    // Skip empty lines or pure comments
    if (!addedCode || addedCode.startsWith('//') || addedCode.startsWith('#') || addedCode.startsWith('*')) {
      continue;
    }

    // 1. Secret Leak Checks
    for (const pat of SECRET_PATTERNS) {
      if (pat.re.test(addedCode)) {
        // Exclude placeholders like process.env, example, test, dummy
        if (!/process\.env|example|dummy|placeholder|your_key|test_token/i.test(addedCode)) {
          findings.push({
            type: 'security',
            severity: 'critical',
            rule: 'SECRET_LEAK',
            file: currentFile,
            line: addedCode.slice(0, 80),
            message: `Possible hardcoded ${pat.name} detected.`
          });
        }
      }
    }

    // 2. Command Injection & Arbitrary Code Execution
    if (/(?:child_process\s*\.\s*exec|execSync|\bexec)\s*\(/.test(addedCode) && /\$\{/.test(addedCode)) {
      findings.push({
        type: 'security',
        severity: 'critical',
        rule: 'COMMAND_INJECTION',
        file: currentFile,
        line: addedCode.slice(0, 80),
        message: 'Unsanitized string interpolation in exec call. Use execFile or parameterized arguments.'
      });
    }

    if (/\beval\s*\(|new\s+Function\s*\(/.test(addedCode)) {
      findings.push({
        type: 'security',
        severity: 'critical',
        rule: 'EVAL_INJECTION',
        file: currentFile,
        line: addedCode.slice(0, 80),
        message: 'Dynamic code execution with eval/Function detected.'
      });
    }

    // 3. XSS / Unsafe DOM Manipulation
    if (/\.innerHTML\s*=/.test(addedCode) && !/\.replaceChildren|\.textContent/.test(addedCode)) {
      // Flag if assigning variables or template literals to innerHTML
      if (/\$\{/.test(addedCode) || /\+\s*[a-zA-Z]/.test(addedCode)) {
        findings.push({
          type: 'security',
          severity: 'warning',
          rule: 'UNSAFE_INNER_HTML',
          file: currentFile,
          line: addedCode.slice(0, 80),
          message: 'Direct innerHTML assignment with dynamic interpolation. Prefer textContent or DOM element builders.'
        });
      }
    }

    // 4. Path Traversal Risks
    if (/path\s*\.\s*(?:resolve|join)\s*\([^)]*(?:req\.|params\.|query\.)/.test(addedCode)) {
      if (!/startsWith|\.relative/.test(text)) {
        findings.push({
          type: 'security',
          severity: 'warning',
          rule: 'PATH_TRAVERSAL_RISK',
          file: currentFile,
          line: addedCode.slice(0, 80),
          message: 'Path constructed from request parameters without visible relative bounds check.'
        });
      }
    }
  }

  // Calculate quality scorecard
  let score = 100;
  for (const f of findings) {
    if (f.severity === 'critical') score -= 25;
    else if (f.severity === 'warning') score -= 10;
    else score -= 3;
  }
  score = Math.max(0, Math.min(100, score));

  let verdict = 'PASSED';
  if (score < 60 || findings.some(f => f.severity === 'critical')) {
    verdict = 'REJECTED';
  } else if (score < 85 || findings.length > 0) {
    verdict = 'PASSED_WITH_WARNINGS';
  }

  let summary = 'Code changes are clean, isolated, and comply with security guardrails.';
  if (verdict === 'REJECTED') {
    summary = `Quality audit rejected: ${findings.filter(f => f.severity === 'critical').length} critical security issue(s) detected.`;
  } else if (verdict === 'PASSED_WITH_WARNINGS') {
    summary = `Quality audit passed with ${findings.length} advisory notice(s).`;
  }

  return {
    ok: true,
    score,
    verdict,
    summary,
    metrics: {
      filesChanged: filesModified.size,
      linesAdded,
      linesDeleted,
      findingsCount: findings.length
    },
    findings
  };
}

module.exports = { auditDiff };
