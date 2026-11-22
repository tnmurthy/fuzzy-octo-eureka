---
name: security-audit
description: OWASP Top 10 mitigation rules for secrets, injection, and client-side XSS.
triggers: [security, audit, xss, injection, secret, token, vulnerability, owasp]
file_patterns: ["*.js", "*.ts", "*.html", "*.sh"]
---

# Security Audit Principles

## Core Invariants
1. Never commit hardcoded tokens, passwords, or private keys.
2. Disallow dynamic eval() or new Function().
3. In shell scripts and node child_process, prefer execFile() with discrete array arguments over shell string concatenation.
4. Avoid unescaped innerHTML dynamic interpolation; use textContent or strict DOM escaping.
5. In path resolutions, assert target paths stay within allowed root directory bounds.
