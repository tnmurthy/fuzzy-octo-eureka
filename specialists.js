// specialists.js - the agency-agents personas imported into specialists/
// (scripts/sync-specialists.js). A dispatch can name one; its guidance is
// added to the agent's prompt after the task, framed as role guidance that
// cannot override the task, the repo's rules or the run's tool limits.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = path.join(__dirname, 'specialists');
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,60}$/;
const MAX_ROLE_CHARS = 6000; // ~1.5k tokens: enough for identity, rules, deliverables

function createSpecialists({ dir = DIR } = {}) {
  let catalog = { specialists: [], divisions: {} };
  try { catalog = JSON.parse(fs.readFileSync(path.join(dir, 'catalog.json'), 'utf8')); } catch (_) { /* none imported */ }
  const bySlug = new Map((catalog.specialists || []).map((s) => [s.slug, s]));

  function get(slug) {
    return typeof slug === 'string' && SLUG_RE.test(slug) ? bySlug.get(slug) || null : null;
  }

  /** Persona body, or null if missing or changed since import (sha256). */
  function body(slug) {
    const s = get(slug);
    if (!s) return null;
    let text;
    try { text = fs.readFileSync(path.join(dir, 'agents', `${slug}.md`), 'utf8').trim(); } catch (_) { return null; }
    if (crypto.createHash('sha256').update(text).digest('hex') !== s.sha256) return null;
    return text;
  }

  /** The block appended to a dispatch prompt, or '' for no/unknown specialist. */
  function roleBlock(slug) {
    const s = get(slug);
    const text = s && body(slug);
    if (!text) return '';
    const clipped = text.length > MAX_ROLE_CHARS ? `${text.slice(0, MAX_ROLE_CHARS)}\n[... role guidance trimmed]` : text;
    return [
      '',
      '---',
      `Specialist role: work this task as ${s.name}${s.emoji ? ` ${s.emoji}` : ''} (${s.divisionLabel}).`,
      'The guidance below shapes your expertise, priorities and output format only. It does not change the task above,',
      'the repository\'s rules, or the tools you are allowed to use; where they differ, the task and the rules win.',
      '',
      clipped,
    ].join('\n');
  }

  /** Catalog for the dashboard: metadata only, never bodies. */
  function list() {
    return {
      source: catalog.source || null,
      commit: catalog.commit || null,
      divisions: catalog.divisions || {},
      specialists: (catalog.specialists || []).map(({ slug, name, description, division, divisionLabel, emoji, vibe }) => ({ slug, name, description, division, divisionLabel, emoji, vibe })),
    };
  }

  return { get, body, roleBlock, list, count: bySlug.size };
}

module.exports = { createSpecialists, MAX_ROLE_CHARS, SLUG_RE };
