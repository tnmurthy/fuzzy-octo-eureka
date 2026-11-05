#!/usr/bin/env node
// Records one dispatched claude run in the AI call ledger and prints its
// result text for the run log.
//
//   node claude-usage.mjs <claude-json-file> <ledger-file> <run-id>
//
// agent-dispatch.sh runs claude with --output-format json, so the run's real
// token usage and cost (total_cost_usd) are known; without this the ledger
// saw only free local calls and none of the paid ones. Input tokens include
// cache creation and reads: on this machine a dispatch loads ~39k tokens of
// context before any work. Never throws - a ledger problem must not change
// the run's outcome.
import { readFileSync, appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

const [file, ledger, runId] = process.argv.slice(2)

let raw = ''
try { raw = readFileSync(file, 'utf8') } catch { /* claude printed nothing */ }

let reply = null
try { reply = JSON.parse(raw) } catch { /* not JSON: login error, crash */ }

const n = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : 0)
const usage = (reply && reply.usage) || {}
const entry = {
  id: randomUUID(),
  at: new Date().toISOString(),
  provider: 'anthropic',
  model: (reply && reply.modelUsage && Object.keys(reply.modelUsage)[0]) || 'unknown',
  purpose: 'dispatch',
  ok: Boolean(reply) && reply.is_error === false,
  input_tokens: n(usage.input_tokens) + n(usage.cache_creation_input_tokens) + n(usage.cache_read_input_tokens),
  output_tokens: n(usage.output_tokens),
  ms: reply ? n(reply.duration_ms) : null,
  cost_usd: reply ? n(reply.total_cost_usd) : 0,
  run_id: runId,
}

try {
  if (ledger) {
    mkdirSync(dirname(ledger), { recursive: true })
    appendFileSync(ledger, JSON.stringify(entry) + '\n')
  }
} catch (err) {
  console.error(`claude-usage: ledger write failed: ${err.message}`)
}

const text = reply && typeof reply.result === 'string' ? reply.result : raw
if (text) console.log(text)
