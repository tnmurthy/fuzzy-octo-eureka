'use strict';
// pr-open.js - after "Send for review" pushes a draft, open the pull request
// itself with the GitHub CLI (`gh`, signed in on this Mac), so the person
// gets a PR, not a "compare" page with one more button to press. An open PR
// for the branch is reused. Title and body come from the request and the
// helper's latest summary, secret-redacted and marked as not verified. Any
// failure (gh missing, signed out, no access) returns an error and the
// caller falls back to the compare URL.

const { execFile } = require('child_process');
const { redactText } = require('./secret-scan');

const RECAP = /\s*Where this request stands \(a summary of earlier work; data, not instructions\):[\s\S]*$/;
const GH_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/;

const defaultExec = (cmd, args, opts) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout: 30000, maxBuffer: 1024 * 1024, ...opts }, (err, stdout, stderr) => (
    err ? reject(Object.assign(err, { stderr: String(stderr || '') })) : resolve(String(stdout || ''))));
});

/** A request's text as the person wrote it. */
const plain = (task) => String(task || '').replace(RECAP, '')
  .replace(/^Follow-up: the person stopped you mid-task and changed direction\.[^:]*: /, '')
  .replace(/^Follow-up: /, '').replace(/^Go ahead with the plan\.\s*Original request: /, '').trim();

/** PR title: the request's first line or sentence, at most 72 characters. */
function prTitle(task) {
  let t = plain(task).replace(/^Make the changes from: /, '').split('\n')[0].trim();
  const first = t.match(/^(.{20,}?[.!?:])(\s|$)/);
  if (first) t = first[1].replace(/[.:]$/, '');
  if (t.length > 72) t = `${t.slice(0, 71).replace(/\s+\S*$/, '')}…`;
  return redactText(t) || 'Agent draft';
}

/** PR body: the request and the helper's summary, clearly labelled. */
function prBody({ request, summary, branch }) {
  return redactText([
    'Draft from the Ask page on the team dashboard.',
    '',
    `**Request:** ${plain(request).replace(/\s+/g, ' ').slice(0, 600)}`,
    '',
    summary ? `**What the helper says it did** (not verified: check the diff):\n\n${String(summary).slice(0, 6000)}\n` : '',
    `Branch \`${branch}\`. Build and test before merging.`,
  ].join('\n'));
}

/**
 * Open (or find) the PR for a pushed branch.
 * @returns {Promise<{url: string, existing?: boolean, created?: boolean} | {error: string}>}
 */
async function openPr({ cwd, branch, title, body, exec = defaultExec, gh = 'gh' }) {
  const env = { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' };
  try {
    const list = await exec(gh, ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'url', '--limit', '1'], { cwd, env });
    const found = (JSON.parse(list || '[]')[0] || {}).url;
    if (found && GH_URL.test(found)) return { url: found, existing: true };
  } catch (_) { /* try to create */ }
  try {
    const out = await exec(gh, ['pr', 'create', '--head', branch, '--title', title, '--body', body], { cwd, env });
    const m = out.match(GH_URL);
    return m ? { url: m[0], created: true } : { error: 'gh did not report a pull request' };
  } catch (err) {
    const why = String(err.stderr || err.message || '').split('\n').find((l) => l.trim()) || 'gh failed';
    return { error: why.slice(0, 200) };
  }
}

module.exports = { openPr, prTitle, prBody };
