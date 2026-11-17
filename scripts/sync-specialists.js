#!/usr/bin/env node
// scripts/sync-specialists.js - import agent personas ("specialists") from a
// local clone of https://github.com/msitarzewski/agency-agents (MIT).
//
//   git clone --depth 1 https://github.com/msitarzewski/agency-agents.git /tmp/aa
//   node scripts/sync-specialists.js /tmp/aa
//
// Writes specialists/catalog.json (metadata, pinned source commit, sha256 per
// file) and specialists/agents/<slug>.md (the persona body). Only files in the
// divisions listed in the clone's divisions.json are read; integrations/,
// scripts/ and the rest are ignored, nothing from the clone is executed.
//
// The personas become part of agent prompts, so each file is scanned first;
// one that tries to override instructions, pipe a download into a shell, or
// embed a credential-looking string is skipped and reported.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'specialists');
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,60}$/;
const MAX_BYTES = 40 * 1024;

const RISKS = [
  // Imperative overrides only: a quoted example ("Ignore all previous
  // instructions" as a test input) is how defensive personas teach.
  [/(^|[^"'\u201c`])\b(ignore|disregard) (all |any )?(the )?(previous|prior|above|system) (instructions|rules|prompt)/im, 'instruction override'],
  [/(curl|wget)\b[^\n]*\|\s*(sudo\s+)?(ba|z)?sh\b/i, 'download piped into a shell'],
  [/base64\s+(-d|--decode)[^\n]*\|\s*(ba|z)?sh/i, 'encoded payload into a shell'],
  [/\b(ghp_|github_pat_|sk-ant-|sk-[A-Za-z0-9]{20}|AKIA[0-9A-Z]{16})/, 'credential-looking string'],
  // Commands to leak, not defensive talk about exfiltration as a threat.
  [/\b(send|post|upload|email) (the |all |any )?(\.env|env vars|secrets|credentials|api keys|tokens) to\b/i, 'exfiltration instruction'],
];

/** Minimal frontmatter parser: `key: value` lines between the first two `---`. */
function parseAgent(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return null;
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim();
  }
  return { meta, body: m[2].trim() };
}

function scan(text) {
  return RISKS.filter(([re]) => re.test(text)).map(([, why]) => why);
}

/**
 * Pure core: turn division -> [{file, text}] into catalog entries.
 * @returns {{ entries: object[], bodies: Record<string,string>, skipped: {file: string, why: string}[] }}
 */
function buildCatalog(divisions, filesByDivision) {
  const entries = [];
  const bodies = {};
  const skipped = [];
  for (const [division, files] of Object.entries(filesByDivision)) {
    for (const { file, text } of files) {
      const slug = path.basename(file, '.md').toLowerCase();
      if (!SLUG_RE.test(slug)) { skipped.push({ file, why: 'unusable file name' }); continue; }
      if (Buffer.byteLength(text) > MAX_BYTES) { skipped.push({ file, why: 'larger than 40 KB' }); continue; }
      const parsed = parseAgent(text);
      if (!parsed || !parsed.meta.name || !parsed.body) { skipped.push({ file, why: 'no agent frontmatter' }); continue; }
      const risks = scan(text);
      if (risks.length) { skipped.push({ file, why: risks.join(', ') }); continue; }
      if (bodies[slug]) { skipped.push({ file, why: 'duplicate slug' }); continue; }
      bodies[slug] = parsed.body;
      entries.push({
        slug,
        name: parsed.meta.name.slice(0, 80),
        description: (parsed.meta.description || '').slice(0, 400),
        division,
        divisionLabel: (divisions[division] && divisions[division].label) || division,
        emoji: (parsed.meta.emoji || '').slice(0, 8),
        vibe: (parsed.meta.vibe || '').slice(0, 200),
        bytes: Buffer.byteLength(parsed.body),
        sha256: crypto.createHash('sha256').update(parsed.body).digest('hex'),
      });
    }
  }
  entries.sort((a, b) => a.division.localeCompare(b.division) || a.name.localeCompare(b.name));
  return { entries, bodies, skipped };
}

module.exports = { parseAgent, scan, buildCatalog };

if (require.main === module) {
  const src = process.argv[2];
  if (!src || !fs.existsSync(path.join(src, 'divisions.json'))) {
    console.error('usage: node scripts/sync-specialists.js <path to an agency-agents clone>');
    process.exit(2);
  }
  const divisions = JSON.parse(fs.readFileSync(path.join(src, 'divisions.json'), 'utf8')).divisions || {};
  const filesByDivision = {};
  for (const division of Object.keys(divisions)) {
    if (!/^[a-z0-9-]+$/.test(division)) continue;
    const dir = path.join(src, division);
    if (!fs.existsSync(dir)) continue;
    filesByDivision[division] = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.md') && fs.lstatSync(path.join(dir, f)).isFile())
      .map((f) => ({ file: `${division}/${f}`, text: fs.readFileSync(path.join(dir, f), 'utf8') }));
  }
  const { entries, bodies, skipped } = buildCatalog(divisions, filesByDivision);
  let commit = 'unknown';
  try { commit = execFileSync('git', ['-C', src, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch (_) { /* not a git clone */ }

  fs.rmSync(path.join(OUT, 'agents'), { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT, 'agents'), { recursive: true });
  for (const [slug, body] of Object.entries(bodies)) fs.writeFileSync(path.join(OUT, 'agents', `${slug}.md`), `${body}\n`);
  fs.writeFileSync(path.join(OUT, 'catalog.json'), `${JSON.stringify({
    source: 'https://github.com/msitarzewski/agency-agents',
    license: 'MIT (see specialists/LICENSE-agency-agents)',
    commit,
    importedAt: new Date().toISOString(),
    divisions: Object.fromEntries(Object.entries(divisions).map(([k, v]) => [k, { label: v.label, color: v.color }])),
    specialists: entries,
    skipped,
  }, null, 2)}\n`);
  const lic = path.join(src, 'LICENSE');
  if (fs.existsSync(lic)) fs.copyFileSync(lic, path.join(OUT, 'LICENSE-agency-agents'));
  console.log(`imported ${entries.length} specialists from ${commit.slice(0, 12)}; skipped ${skipped.length}`);
  for (const s of skipped) console.log(`  skipped ${s.file}: ${s.why}`);
}
