'use strict';
// claude-limit.js - did a claude run end because the account is out of
// usage (the 5-hour or weekly limit, a rate limit, no credit)? Then
// agent-dispatch.sh hands the same task to the free local helper instead of
// failing. Reads the result event stream-log.js saved (<run>.claude.json).
//   node claude-limit.js <run>.claude.json   exit 0 + prints the reason when out of usage, else exit 1

const fs = require('fs');

const LIMIT_RE = /hit your (?:[\w-]+ )*limit|usage limit|limit reached|rate[ _-]?limit|credit balance is too low|out of (?:extra )?usage/i;

/** The limit message (trimmed) when a result says the account is out of usage, else null. */
function limitOf(result) {
  if (!result || typeof result !== 'object') return null;
  const text = String(result.result || result.error || '').trim();
  if (!result.is_error && !/^error/.test(String(result.subtype || ''))) return null;
  if (!LIMIT_RE.test(text)) return null;
  return text.split('\n')[0].slice(0, 160);
}

if (require.main === module) {
  let r = null;
  try { r = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')); } catch (_) { /* no result */ }
  const why = limitOf(r);
  if (!why) process.exit(1);
  process.stdout.write(`${why}\n`);
}

module.exports = { limitOf };
