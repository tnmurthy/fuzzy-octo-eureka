#!/usr/bin/env node
// Appends one JSON line to the agent run log.
//
//   node runlog.mjs <file> key=value ... key:=<json literal> ...
//
// `key=value` is stored as a string, `key:=value` as parsed JSON (numbers,
// booleans, null). Built in Node rather than printf so a prompt, path or
// branch containing quotes cannot produce a line the dashboard fails to parse.
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const [file, ...pairs] = process.argv.slice(2)
if (!file || pairs.length === 0) {
  console.error('usage: runlog.mjs <file> key=value [key:=json] ...')
  process.exit(2)
}

const entry = {}
for (const pair of pairs) {
  const raw = pair.indexOf(':=')
  const eq = pair.indexOf('=')
  if (raw > 0 && raw < eq + 1) {
    entry[pair.slice(0, raw)] = JSON.parse(pair.slice(raw + 2))
  } else if (eq > 0) {
    entry[pair.slice(0, eq)] = pair.slice(eq + 1)
  } else {
    console.error(`runlog: ignoring malformed pair ${JSON.stringify(pair)}`)
  }
}

mkdirSync(dirname(file), { recursive: true })
appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8')
