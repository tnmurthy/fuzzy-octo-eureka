#!/usr/bin/env node
// stream-log.js - turns `claude -p --output-format stream-json` into a run log
// you can watch while the agent works (tail -f <run-id>.log).
//
//   claude -p ... --output-format stream-json --verbose | node stream-log.js <result.json>
//
// One line per step: what the agent said, which tool it used on what, and
// tool errors. The final `result` event is written to <result.json> - the
// same object `--output-format json` prints - so claude-usage.mjs can record
// tokens and cost from it unchanged. Tool inputs are summarised (path,
// command, pattern), never dumped: a Write's file content stays out of the log.

const fs = require('fs');

const MAX_TEXT = 300;
const MAX_ARG = 160;

const clip = (s, n) => {
  const one = String(s ?? '').replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

function toolSummary(name, input = {}) {
  const arg = input.file_path || input.path || input.command || input.pattern || input.url || input.description || '';
  return arg ? `${name} ${clip(arg, MAX_ARG)}` : name;
}

function stamp(now) {
  return now.toTimeString().slice(0, 8);
}

/**
 * One stream-json event -> zero or more log lines, plus the result event
 * when this is the last one.
 * @returns {{ lines: string[], result?: object }}
 */
function formatEvent(event, now = new Date()) {
  const t = stamp(now);
  if (!event || typeof event !== 'object') return { lines: [] };

  if (event.type === 'system' && event.subtype === 'init') {
    return { lines: [`${t} == claude started (model ${event.model || '?'})`] };
  }

  if (event.type === 'assistant' && event.message && Array.isArray(event.message.content)) {
    const lines = [];
    for (const part of event.message.content) {
      if (part.type === 'text' && part.text && part.text.trim()) lines.push(`${t} 💬 ${clip(part.text, MAX_TEXT)}`);
      if (part.type === 'tool_use') lines.push(`${t} 🔧 ${toolSummary(part.name, part.input)}`);
    }
    return { lines };
  }

  if (event.type === 'user' && event.message && Array.isArray(event.message.content)) {
    const lines = [];
    for (const part of event.message.content) {
      if (part.type === 'tool_result' && part.is_error) {
        const text = Array.isArray(part.content) ? part.content.map((c) => c.text || '').join(' ') : part.content;
        lines.push(`${t}    ↳ error: ${clip(text, MAX_TEXT)}`);
      }
    }
    return { lines };
  }

  if (event.type === 'result') {
    const cost = Number.isFinite(event.total_cost_usd) ? ` · $${event.total_cost_usd.toFixed(4)}` : '';
    const turns = event.num_turns ? ` · ${event.num_turns} turns` : '';
    return { lines: [`${t} == claude finished: ${event.subtype || (event.is_error ? 'error' : 'success')}${turns}${cost}`], result: event };
  }

  return { lines: [] };
}

module.exports = { formatEvent, toolSummary };

if (require.main === module) {
  const resultFile = process.argv[2];
  let buffer = '';
  let result = null;
  const handle = (line) => {
    if (!line.trim()) return;
    let event;
    try {
      event = JSON.parse(line);
    } catch (_) {
      console.log(line); // not stream-json: a login error, a crash - keep it visible
      return;
    }
    const out = formatEvent(event);
    for (const l of out.lines) console.log(l);
    if (out.result) result = out.result;
  };
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      handle(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
    }
  });
  process.stdin.on('end', () => {
    handle(buffer);
    if (resultFile && result) {
      try { fs.writeFileSync(resultFile, JSON.stringify(result)); } catch (err) { console.error(`stream-log: cannot write ${resultFile}: ${err.message}`); }
    }
  });
}
