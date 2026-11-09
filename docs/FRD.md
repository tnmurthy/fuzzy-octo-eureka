# Arunachala - Functional Requirements (FRD)

What the system must do, how each requirement is checked, and its status.
Design: [`HLD.md`](HLD.md). Usage: [`USER_GUIDE.md`](USER_GUIDE.md).

As of 2026-11-05. Status: **Built** (shipped and tested) · **Partial** (works,
with a stated gap) · **Not built**.

---

## 1. Purpose and scope

A small team runs an AI workforce from chat. Each member operates their own
install on Windows, with their own keys; the team shares context (agent runs,
AI calls, memory, tasks) through Supabase. Local models handle the
high-volume work; frontier models run only when needed and within caps.

**In scope:** Buzz chat bot, agent dispatch, monitoring dashboard, shared team
context, AI cost controls, per-person install.
**Out of scope:** hosting for people outside the team, non-Windows installs,
billing, a UI for creating or moving tasks (API only for now).

## 2. Actors

| Actor | Who | Can |
|---|---|---|
| Operator | A teammate, on their own install | Chat with their bot, dispatch agents, use the dashboard, read team context |
| Team owner | Admin of the team in Supabase | Add/remove members, change AI caps |
| Agent | claude, codex, hermes, agy, noop | Work in one worktree, commit on its branch |
| Bridge bot | One per operator, on the Buzz relay | Act only for its operator's Buzz keys |

---

## 3. Functional requirements

### 3.1 Chat (Buzz bridge)

| ID | Requirement | Acceptance criteria | Status | Evidence |
|---|---|---|---|---|
| FR-CHAT-01 | Act only on messages from the operator that mention the bot | Messages from other keys, without a mention, or older than the bridge start get no reply | Built | `buzz-protocol.test.js` |
| FR-CHAT-02 | Explain silence | An operator message without a real mention is logged as `bot not mentioned` | Built | `buzz-protocol.test.js` |
| FR-CHAT-03 | Classify each message locally | A local Ollama model chooses status / persona / dispatch / add-task; on its timeout a smaller model is tried | Built | `router*.test.js`, `local-router-client.test.js` |
| FR-CHAT-04 | Answer status questions without a model | Reply built from telemetry and runs | Built | `handler.test.js` |
| FR-CHAT-05 | Answer persona questions | Reply from one of 5 personas on a local model | Built | live check 2026-11-05 |
| FR-CHAT-06 | Reply in the original thread | Every reply, including run results, threads under the triggering message | Built | live test 2026-11-04 |
| FR-CHAT-07 | Confirm before risky dispatches | Destructive commands (git reset --hard, push -f, rm -rf, drop table) halt and require operator confirmation | Built | `safety-filter.test.js` |
| FR-CHAT-08 | Add tasks from chat & local board | Tasks can be added and moved in local TASKS.md or team-store | Built | `tasks-local.test.js` |
| FR-CHAT-09 | Bridge config has no personal defaults | Empty `BUZZ_OPERATORS` stops the bridge at start | Built | `bridge.js` startup check |

### 3.2 Dispatch

| ID | Requirement | Acceptance criteria | Status | Evidence |
|---|---|---|---|---|
| FR-DISP-01 | Start a run from chat or API and return its id at once | `POST /api/dispatch/run` → 202 with `runId` | Built | live e2e 2026-11-04 |
| FR-DISP-02 | Validate dispatch input | Unknown agent, non-plain repo name, missing repo `.git` or empty task → 400 | Built | `server.js` route |
| FR-DISP-03 | Isolate each run | One git worktree per branch beside the repo; gitignored files listed in `.worktreeinclude` copied in | Built | `agent-dispatch.sh` |
| FR-DISP-04 | Record every run | Start and end lines in `runs.jsonl` (status, exit, duration, commits, head); full output in `<runId>.log` | Built | `runs-reader.test.js` |
| FR-DISP-05 | Bound run time | Runs end after `AGENT_TIMEOUT` (1 h) with status `timed_out` | Built | `agent-dispatch.sh` |
| FR-DISP-06 | Agents never push | claude's tool list denies `git push` and `gh`; the prompt forbids push/merge | Built | `agent-dispatch.sh` |
| FR-DISP-07 | Report the result back to chat | n8n polls `/api/runs` every 10 s, then calls `/notify`; the bridge replies | Built | live test 2026-11-04 |
| FR-DISP-08 | Survive a bridge restart mid-run | The pending reply is kept on disk (6 h) and still delivered | Built | `pending-store.test.js`, live test |
| FR-DISP-09 | Run under the LocalSystem service | git ownership check passed via env; agent CLIs find the operator's logins | Built | live claude run 2026-11-04 |
| FR-DISP-10 | Local first, escalate on failure (`auto`) | Local agent first; repo tests pass → done without claude; fail / no tests → reset worktree, claude runs; `escalated` recorded | Built | `agent-dispatch.test.js` (4 scenarios) |
| FR-DISP-11 | Opt in to local first per install | `DISPATCH_LOCAL_FIRST=true` turns claude requests into `auto` | Built | `server.js` |

### 3.3 Shared team context

| ID | Requirement | Acceptance criteria | Status | Evidence |
|---|---|---|---|---|
| FR-TEAM-01 | Work solo with no Supabase settings | Without all five settings, everything runs on local files; partial settings log what is missing | Built | `team-store.test.js` |
| FR-TEAM-02 | Sign in as the teammate, never a service key | Password grant per person; tokens refreshed before expiry; errors never include the password | Built | `team-store.test.js` |
| FR-TEAM-03 | Share agent runs | New or changed runs reach `arunachala_agent_runs` within 30 s; repo name only, no local paths; `/api/runs?scope=team` lists the team's | Built | `team-store.test.js` |
| FR-TEAM-04 | Share memory | New memory entries reach `arunachala_memory`; resends are ignored | Built | `memory-tasks.test.js`, DB check 9 |
| FR-TEAM-05 | Share a task board | `/api/tasks` serves the team board; `POST` creates, `PATCH` moves; any member moves any task | Built (API only) | `memory-tasks.test.js`, DB check 10 |
| FR-TEAM-06 | Seed the board from `TASKS.md` | Import script previews, then applies; existing titles skipped | Built | `scripts/import-tasks.js` |
| FR-TEAM-07 | Survive outages | Offline sync keeps its position and retries; an outage is logged once | Built | `team-store.test.js` |
| FR-TEAM-08 | Isolate teams | A member cannot read another team, write as someone else, or add themselves to a team | Built | DB checks 1-3, 5, 6 |

### 3.4 Memory

| ID | Requirement | Acceptance criteria | Status | Evidence |
|---|---|---|---|---|
| FR-MEM-01 | Store memory entries | `POST /api/memory/store` and directives persist to `drisyon-memory.json` | Built | `memory-engine.js` |
| FR-MEM-02 | Search by meaning | Query ranks entries by local embeddings; a match with no shared words is found | Built | `embeddings.test.js`, live check |
| FR-MEM-03 | Degrade when Ollama is down | Falls back to keyword scoring; response says `ranker: keywords` | Built | `embeddings.test.js` |
| FR-MEM-04 | Respect tenants | A non-core tenant sees only its own entries, in both rankers | Built | `embeddings.test.js` |
| FR-MEM-05 | Isolate the core tenant | Queries as `tenant:drisyon_core` see every tenant | **Partial** - by design today; decide before real multi-tenancy | `CLAUDE.md` open item |

### 3.5 Cost controls

| ID | Requirement | Acceptance criteria | Status | Evidence |
|---|---|---|---|---|
| FR-COST-01 | Log every model call | Persona, router, TypeSafe and embedding calls each write one ledger line: provider, model, purpose, ok, tokens, ms | Built | `ai-ledger.test.js`, `*-client.test.js` |
| FR-COST-02 | Ledger never breaks a call | A failed ledger write is logged; the call continues | Built | `ai-ledger.test.js` |
| FR-COST-03 | Share the ledger | Lines reach `arunachala_ai_calls`; resends ignored; 500 per sync | Built | `ai-ledger.test.js`, DB check 8 |
| FR-COST-04 | Cap paid calls | Paid calls past 200/person or 1000/team per UTC day are rejected by the database | Built | DB check 4 |
| FR-COST-05 | Local calls are free | `ollama` calls are recorded but never count towards or hit the caps | Built | DB check 7 |
| FR-COST-06 | Check the cap before a paid call | A paid call is refused before it is made when over the cap | **Partial** - the bridge's TypeSafe client checks its local daily cap; the team cap is checked at sync | `typesafe-client.test.js` |
| FR-COST-07 | Right-size the persona model | `PERSONA_MODEL` and `PERSONA_MAX_TOKENS` configurable; answers capped | Built | `server.js` |

### 3.6 Monitoring dashboard

| ID | Requirement | Acceptance criteria | Status | Evidence |
|---|---|---|---|---|
| FR-MON-01 | Show service health | Ollama, OpenClaw, Buzz, Watchtower up/down with latency, refreshed every few seconds | Built | `telemetry-daemon.ps1` |
| FR-MON-02 | Show CPU and latency history | Charts from `/api/history` | Built | dashboard |
| FR-MON-03 | Show agent runs | Agent Runs tab; runs without an end line after 6 h show as `stale` | Built | `runs-reader.test.js` |
| FR-MON-04 | Show model usage | OpenClaw sessions and token usage, polled every 60 s | Built | `/api/openclaw` |
| FR-MON-05 | Greet the configured operator | Name comes from `OPERATOR_NAME` via `/api/config` | Built | `server.js` |

### 3.7 Security

| ID | Requirement | Acceptance criteria | Status | Evidence |
|---|---|---|---|---|
| FR-SEC-01 | Gate the public dashboard | Cloudflare Access at the edge plus origin JWT check; fails closed | Built | `access-auth.test.js` |
| FR-SEC-02 | Bind locally | Server and bridge notify port listen on 127.0.0.1 only | Built | `server.js`, `bridge.js` |
| FR-SEC-03 | Keep secrets out of git | `.env` files gitignored; installer types the password hidden | Built | `.gitignore`, installer |
| FR-SEC-04 | Limit request bodies | Task routes cap bodies at 10 KB; task ids must be UUIDs | Built | `server.js` |
| FR-SEC-05 | Remove the open webhook | `POST /api/buzz/events` deprecated with HTTP 410 Gone; Nostr relay bridge used | Built | `server.js` |

### 3.8 Install and operations

| ID | Requirement | Acceptance criteria | Status | Evidence |
|---|---|---|---|---|
| FR-OPS-01 | Per-person config | No personal values in code; `.env.example` lists every setting | Built | `.env.example` files |
| FR-OPS-02 | One-command install | Installer checks prerequisites, pulls models, writes both `.env` files, installs 3 services, sets up n8n | Built | `install-teammate.ps1` |
| FR-OPS-03 | Safe dry run | `-DryRun` reports and changes nothing, without elevation | Built | dry run 2026-11-05 |
| FR-OPS-04 | CI guards | `npm test` and a PowerShell parse + ASCII check on every PR to main | Built | `.github/workflows/ci.yml` |

---

## 4. Non-functional requirements

| ID | Requirement | Target | Measured / status |
|---|---|---|---|
| NFR-01 | Persona reply time | Within the 45 s chat timeout | gemma3:4b about 15 s for a short answer on CPU |
| NFR-02 | Memory search time | Under 2 s cold, instant cached | 997 ms cold, 6 ms cached (13 entries) |
| NFR-03 | Team sync delay | Under 1 minute | 30 s interval |
| NFR-04 | Offline tolerance | No data lost while offline | Local files are the outbox; verified by tests |
| NFR-05 | Platform | Windows 11, 12 GB RAM+ | Windows only (NSSM, PowerShell) |
| NFR-06 | Footprint | No paid infrastructure beyond Supabase free tier | Shares the Talia project; free plan |
| NFR-07 | Test coverage of new modules | Every new module has tests | 141 Node tests + 11 DB checks |

## 5. Acceptance test (end to end)

1. `install-teammate.ps1 -DryRun` reports no missing prerequisites.
2. `@<bot> is everything up?` → status reply in thread.
3. `@<bot> run noop in arunachala-dashboard: hello` → ack with run id, then
   "finished" in the same thread.
4. Within 30 s the run appears in `/api/runs?scope=team`.
5. A persona question adds a line to `logs/ai-calls.jsonl`, and it appears in
   `arunachala_ai_calls` within 30 s.
6. `/api/memory/search?q=...&scope=team` returns `ranker: embeddings`.
