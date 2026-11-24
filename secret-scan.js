// secret-scan.js - refuse to push agent work that carries a secret.
//
// Agents can read files outside their worktree (Read is pre-allowed) and
// commit what they read; the issue poller and the Agents page's "Push & PR"
// then push to GitHub, and these repos can be public. Before any push we scan
// the lines the branch adds (and the files it adds) for:
//   1. the actual secret values this Mac holds (process.env keys that look
//      secret, i.e. .env + SECRETS_ENV_FILE) - the strongest signal;
//   2. well-known token formats (GitHub, Anthropic, OpenAI, AWS, Google,
//      Slack, Stripe, private keys, Supabase service_role JWTs);
//   3. files that are secrets by name (.env, id_rsa, *.pem, credentials.json).
// Findings name the file, line and rule, never the value. No dependencies.
'use strict';

// Token formats. A match must also look random (randomish) so fixtures like
// ghp_1234567890... and docs do not block a push.
const RULES = [
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/g],
  ['Anthropic key', /\bsk-ant-[A-Za-z0-9_-]{20,}/g],
  ['OpenAI key', /\bsk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{32,}/g],
  ['AWS access key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['Slack token', /\bxox[abprs]-[0-9A-Za-z-]{10,}/g],
  ['Stripe live key', /\b[rs]k_live_[0-9A-Za-z]{20,}/g],
];
// A private key counts only when its header is followed by key data.
const KEY_HEADER = /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY( BLOCK)?-----/;
const KEY_BODY = /^[A-Za-z0-9+/=]{40,}$/;

function randomish(token) {
  const body = token.replace(/^[a-z]+[-_](?:[a-z0-9]+[-_])?/i, '');
  return new Set(body).size >= 12 && /[A-Za-z]/.test(body) && /\d/.test(body);
}

const SECRET_FILE = /(^|\/)(\.env(\.[\w.-]+)?|id_(rsa|ed25519|ecdsa|dsa)|credentials\.json|service-account[\w-]*\.json|[\w.-]+\.(pem|p12|pfx|key))$/i;
const SAFE_FILE = /(^|\/)\.env\.(example|sample|template)$|\.pub$/i;
const SECRET_ENV_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|MASTER_?KEY|_PAT|_KEY)$/i;
const MIN_VALUE = 12;

/** Secret values from an env object; short or obviously non-secret values are skipped. */
function knownSecrets(env = process.env) {
  const out = [];
  for (const [k, v] of Object.entries(env)) {
    if (!SECRET_ENV_NAME.test(k) || typeof v !== 'string') continue;
    const val = v.trim();
    if (val.length < MIN_VALUE || /^(true|false|null|undefined|off|on)$/i.test(val) || /^https?:\/\/[^@]*$/.test(val)) continue;
    out.push({ name: k, value: val });
  }
  return out;
}

// A Supabase service_role key is a JWT whose payload says so.
function isServiceRoleJwt(token) {
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  try {
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return payload && payload.role === 'service_role';
  } catch (_) { return false; }
}

/**
 * Scan a unified diff (git diff -U0) for secrets on added lines and secret
 * files being added.
 * @param {string} diff
 * @param {{name: string, value: string}[]} [known]
 * @returns {{file: string, line: number|null, rule: string}[]}
 */
function scanDiff(diff, known = []) {
  const findings = [];
  let file = null;
  let line = 0;
  let keyAt = null;
  const seen = new Set();
  const add = (f) => {
    const k = `${f.file}:${f.line}:${f.rule}`;
    if (!seen.has(k)) { seen.add(k); findings.push(f); }
  };
  for (const raw of String(diff || '').split('\n')) {
    if (raw.startsWith('+++ ')) {
      file = raw === '+++ /dev/null' ? null : raw.replace(/^\+\+\+ (b\/)?/, '');
      if (file && SECRET_FILE.test(file) && !SAFE_FILE.test(file)) add({ file, line: null, rule: 'secret file committed' });
      continue;
    }
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) { line = Number(hunk[1]); continue; }
    if (!file || raw.startsWith('---')) continue;
    if (raw.startsWith('+')) {
      const text = raw.slice(1);
      for (const s of known) if (text.includes(s.value)) add({ file, line, rule: `value of ${s.name}` });
      for (const [rule, re] of RULES) {
        if ((text.match(re) || []).some(randomish)) add({ file, line, rule });
      }
      if (keyAt && keyAt.file === file && line - keyAt.line <= 2 && KEY_BODY.test(text.trim())) add({ file, line: keyAt.line, rule: 'private key' });
      if (KEY_HEADER.test(text)) keyAt = { file, line };
      for (const jwt of text.match(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g) || []) {
        if (isServiceRoleJwt(jwt)) add({ file, line, rule: 'Supabase service_role key' });
      }
      line += 1;
    } else if (!raw.startsWith('-') && !raw.startsWith('\\')) {
      line += 1;
    }
  }
  return findings;
}

/**
 * Scan what `head` adds over `base` in a repo. `git(args, cwd)` returns stdout.
 * A failing diff (unknown base) falls back to the commits not on any remote.
 */
function scanRange({ git, cwd, base, head, known = knownSecrets() }) {
  let diff;
  try {
    diff = git(['diff', '--no-color', '--no-ext-diff', '-U0', `${base}...${head}`], cwd);
  } catch (_) {
    diff = git(['log', '--no-color', '-p', '-U0', '--format=', head, '--not', '--remotes'], cwd);
  }
  return scanDiff(diff, known);
}

/** One readable line per finding, for a PR comment or an API error. */
function describe(findings, max = 10) {
  const lines = findings.slice(0, max).map((f) => `- \`${f.file}${f.line ? `:${f.line}` : ''}\`: ${f.rule}`);
  if (findings.length > max) lines.push(`- ...and ${findings.length - max} more`);
  return lines.join('\n');
}

/** Text with known secret values, token formats and private keys replaced by [hidden]. */
function redactText(text, known = knownSecrets()) {
  let out = String(text || '');
  for (const s of known) out = out.split(s.value).join('[hidden]');
  for (const [, re] of RULES) out = out.replace(re, (m) => (randomish(m) ? '[hidden]' : m));
  out = out.replace(/-----BEGIN [A-Z ]*PRIVATE KEY[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[hidden]');
  out = out.replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, (m) => (isServiceRoleJwt(m) ? '[hidden]' : m));
  return out;
}

module.exports = { scanDiff, scanRange, knownSecrets, describe, isServiceRoleJwt, randomish, redactText };
