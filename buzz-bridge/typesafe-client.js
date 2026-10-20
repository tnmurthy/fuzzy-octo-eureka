// typesafe-client.js - minimal TypeSafe System One client with spend guards.
//
// Plain HTTP (no SDK) to keep the bridge's dependencies to nostr-tools. Every
// billable call is appended to a JSONL ledger; the ledger is also what the
// daily cap counts, so the cap survives a service restart.

const fs = require('fs');
const path = require('path');

const API_URL = 'https://api.typesafe.ai/v1/systemone';
const DEFAULT_MODEL = 'jev-latest';
const DEFAULT_DAILY_CAP = 200;
const DEFAULT_TIMEOUT_MS = 15000;

function dayOf(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function countToday(ledgerFile, today) {
  let text;
  try { text = fs.readFileSync(ledgerFile, 'utf8'); } catch { return 0; }
  return text.split('\n').filter(l => l.includes(`"day":"${today}"`)).length;
}

/**
 * @param {{ apiKey: string, ledgerFile: string, model?: string, dailyCap?: number,
 *           timeoutMs?: number, fetch?: typeof fetch, now?: () => number }} opts
 */
function createTypeSafeClient(opts) {
  const fetchFn = opts.fetch || fetch;
  const now = opts.now || Date.now;
  const model = opts.model || DEFAULT_MODEL;
  const dailyCap = opts.dailyCap || DEFAULT_DAILY_CAP;
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;

  function record(entry) {
    fs.mkdirSync(path.dirname(opts.ledgerFile), { recursive: true });
    fs.appendFileSync(opts.ledgerFile, JSON.stringify(entry) + '\n');
  }

  async function systemOne(request, { purpose = 'route' } = {}) {
    if (!opts.apiKey) throw new Error('TYPESAFE_API_KEY is not set');
    const today = dayOf(now());
    if (countToday(opts.ledgerFile, today) >= dailyCap) {
      throw new Error(`TypeSafe daily cap of ${dailyCap} calls reached`);
    }

    const started = now();
    const entry = { day: today, at: new Date(started).toISOString(), purpose, model };
    let res;
    try {
      res = await fetchFn(API_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, ...request }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      record({ ...entry, ok: false, error: err.message });
      throw new Error(`TypeSafe request failed: ${err.message}`);
    }

    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300);
      record({ ...entry, ok: false, status: res.status });
      throw new Error(`TypeSafe HTTP ${res.status}: ${detail}`);
    }
    const body = await res.json();
    const usage = body.usage || {};
    record({ ...entry, ok: true, ms: now() - started, input_tokens: usage.input_tokens, output_tokens: usage.output_tokens });
    return body;
  }

  return { systemOne };
}

module.exports = { createTypeSafeClient };
