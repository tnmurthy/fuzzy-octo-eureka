# CLAUDE.md - Arunachala Operations Center

## Runtime: PM2 Supervision (macOS Apple Silicon & Cross-Platform)

The production stack runs on an **Apple Silicon Mac Studio (Apple M5 Max, 18 cores, 36GB unified RAM, Metal GPU Assist)** supervised by **PM2**.

**Never kill daemon PIDs directly** with `kill -9` - PM2 will respawn them. Always manage via the PM2 CLI:

The process list is defined in `ecosystem.config.js` (the source of truth -
`pm2 start ecosystem.config.js && pm2 save` rebuilds it on a fresh machine).

| Service Name | Entry Point | Port / Role |
|---|---|---|
| `ArunachalaDashboard` | `server.js` | Port 8787 (`https://team.mytestbed.tech`) |
| `DrisyonDashboard` | `server.js` (`DASHBOARD_ENV_FILE=.env.drisyon`) | Port 8788 (`https://drisyon.mytestbed.tech`) |
| `ArunachalaTelemetry` | `telemetry-daemon.js` | Real-time CPU, GPU & TCP telemetry |
| `IssuePoller` | `orchestration/issue-poller.js` | The agents' work queue: GitHub issues labelled `agent:ready` -> `/api/dispatch/run` on 8787 -> PR. See "Issue queue" below. |

The Buzz chat integration was removed on 2026-11-17 (#29): the bot obeyed an
operator key that had leaked into git history, and chat is a poor work queue.
Work now arrives as GitHub issues (next section).

### Issue queue - `orchestration/issue-poller.js`

Label an issue `agent:ready` -> the poller (every 60 s) relabels it
`agent:running`, branches `agent/issue-<n>-<ts>` from `origin/<default>`, and
dispatches it. On finish: commits -> it pushes the branch over SSH and opens a
PR that `Closes #n` (`agent:review`); no commits -> `agent:no-changes`;
failed / timed out / never recorded -> `agent:failed` with the log path (the
worktree is kept for inspection).

- Agent: `agent:claude|hermes|codex|noop|auto` label, else
  `POLLER_DEFAULT_AGENT` (claude). Use `agent:hermes` for docs and drafts; code
  goes to claude.
- Only issues opened by `POLLER_AUTHORS` (default: the repo owner) run.
- Text the safety filter refuses needs `agent:confirmed`.
- `POLLER_MAX_CONCURRENT` (2) runs at once across all repos (reviews count).
- Agent review: after opening a PR the poller dispatches a second run on the
  same branch with `readOnly: true` (`POLLER_REVIEW_AGENT`: claude | noop |
  off) and posts its answer as a PR comment - verdict plus findings. The
  dashboard locks read-only runs down: only `claude`/`noop` accepted; Edit,
  Write, commit, push, reset, checkout denied; no team memories in the prompt
  (the comment is public on a public repo). Verified live 2026-11-17: a
  read-only claude run told to Write, Edit and commit changed nothing. If the
  branch's commit count moves during a review, the comment carries a warning.
- Needs `GITHUB_TOKEN` (fine-grained; Issues + Pull requests read/write) in
  the secrets file; idles and logs once an hour without it.
- State: `logs/issue-poller-state.json` (run id -> issue). Tests:
  `orchestration/issue-poller.test.js`.

Not under PM2 on this Mac (as of 2026-11-17): `openclaw` is not installed, and
`cloudflared` has no tunnel credentials in `~/.cloudflared`, so
`drisyon.mytestbed.tech` answers 530 until a tunnel is set up here.

**Reboot:** a per-user LaunchAgent, `~/Library/LaunchAgents/pm2.arunachala.plist`
(installed 2026-11-17, no sudo needed), runs `pm2 resurrect` at login and
restores whatever `pm2 save` last stored. It starts only apps that are not
already running, so loading it by hand is safe. Two caveats: it runs at
**login**, not at boot (like Ollama and the Hermes gateway), so the Mac needs
automatic login or someone signed in; and it names the nvm node path
(`v22.23.5`) - after a node upgrade, update the plist's paths. Logs:
`~/.pm2/launchd.{out,err}.log`. Without it a reboot leaves every service down
and no agent spawns (the 2026-11-16 outage); recover by hand with
`pm2 resurrect`.

**Dispatch failures:** output the dispatch script prints before it records a
run goes to `logs/dispatch.log`.

**Agents page:** `http://127.0.0.1:8787/agents` (🤖 Agents on the dashboard
header). A form that queues a task (opens a GitHub issue labelled
`agent:ready` + `agent:<name>`), the issue queue as four columns (queued,
working, needs review, failed; cached 30 s), running agents with a live log
viewer, and recent runs. API in `agents-api.js` (tests: `agents-api.test.js`):
`GET /api/agents/overview`, `GET /api/agents/log?id=` (only files inside the
runs folder, last 64 KB), `POST /api/agents/task` (repo must be one the poller
watches; JSON-only and same-origin, so another website cannot start a paid
agent through a local browser). Off on the Drisyon portal (8788).
Admins see **Change** next to the paid-runs meter: `POST /api/agents/settings`
{dailyPaidRuns 0-1000} saves `logs/dispatch-settings.json` (who + when), which
wins over `.env` from the next dispatch on, no restart (both dashboards re-read
it on change). Delete the file to fall back to `.env`. Admin = a local request
at this Mac, or a signed-in user in `ADMIN_USERS` (default `AUTH_USERNAME`).

**Context page:** `http://127.0.0.1:8787/context` (🧠 Context on the
dashboard header). Team members table (role, shared memories, agent runs, last
run, AI calls and tokens over 7 days) and memory in three tabs: Mine (written
by you, here or on another machine), Shared (the team's `arunachala_memory`)
and Combined (both, a local entry and its synced row counted once). Badges say
where each entry lives. `GET /api/context/overview`; shaping in
`context-view.js` (pure, `context-view.test.js`), data from
`teamStore.teamContext()`. Without team-store it shows this Mac only. Off on
the Drisyon portal (8788).

**Specialists (The Agency):** 268 personas from
[agency-agents](https://github.com/msitarzewski/agency-agents) (MIT), pinned
in `specialists/catalog.json` (commit, sha256 per file) with bodies in
`specialists/agents/<slug>.md`. A dispatch may name one (`specialist` in
`/api/dispatch/run`, a `specialist:<slug>` issue label, or the picker on
/agents); `specialists.js` appends its guidance after the task, framed as role
guidance that cannot override the task, repo rules or tool limits, trimmed to
6000 chars, and refused if the file no longer matches its sha256. Reviews use
`POLLER_REVIEW_SPECIALIST` (default `engineering-code-reviewer`, `off` for
none). Update: clone the repo, `node scripts/sync-specialists.js <clone>`
(imports only division folders, runs nothing, skips files that try to
override instructions, pipe downloads into a shell, or carry
credential-looking strings), review the diff, commit.

**Watching agents:** `npm run agents` (add `-- --watch` to refresh every 5 s)
lists running runs with the issue or PR each serves, recent runs, and paid
runs used today against the cap. Each running claude run's log fills step by
step: `tail -f <run log path>` shows every file read, edit and command as it
happens (`orchestration/stream-log.js`; tool inputs are summarised, never
dumped).

**Paid-run cap:** `DISPATCH_DAILY_PAID_RUNS` (default 20, 0 = off) caps paid
agent runs per local day - claude, codex, agy, mantis and auto; hermes and
noop are free. It is checked in `spawnAgentDispatch` before any run starts
(API, dashboard chat, Mantis sweep), counting today's run-log start lines
plus runs started but not yet logged (`dispatch-cap.js`). Over the cap the
API answers 429 and the issue poller labels the issue `agent:failed` with the
reason. Each agent PR uses two paid runs (work + review). `/api/costs` reports
`paidRunsToday {used, cap, blocked}`.

### Service Management Commands

```bash
# Check status of all running daemons
pm2 ls

# Restart specific services with updated environment variables
pm2 restart ArunachalaDashboard DrisyonDashboard ArunachalaTelemetry --update-env

# Restart entire stack and persist state
pm2 restart all --update-env && pm2 save

# View live daemon logs
pm2 logs ArunachalaDashboard --lines 50
```

*(Note: Legacy Windows setups used NSSM services `ArunachalaTelemetry`, and `ArunachalaDashboard` under LocalSystem. Cross-platform discovery in `host-specs.js` detects the host automatically).*

## Per-person config (.env)

Each teammate runs the same code with their own values, so nothing personal is
hard-coded. Templates: `.env.example` (read by `server.js` and
`telemetry-daemon.ps1`).
`OPERATOR_HOME` is required under LocalSystem - without it, agent runs and the
telemetry brain dir resolve to the system profile. Secrets can stay in
`04_internal\secrets`: `.env` names the file in `SECRETS_ENV_FILE`
(`load-env.js`; `.env` wins on a clash; a missing file is logged by path).

New teammate: `SETUP.md` (admin steps + teammate steps) and
`install-teammate.ps1` (`-DryRun` first; elevated to install). Note: the
Windows scripts `install-teammate.ps1` and `telemetry-daemon.ps1` still contain
Buzz steps and probes from before #29; ignore them.

## Shared team context - `team-store/` + `supabase/`

Optional: on only when `.env` has all of `SUPABASE_URL`,
`SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_EMAIL`, `SUPABASE_PASSWORD`, `TEAM_ID`
(partial config logs what is missing and stays off). Each person signs in as
their own Supabase user; RLS in `supabase/migrations/` scopes them to their
team - never put a service_role key in `.env`. Tables live in the shared
**Talia** Supabase project (`onsmkbwqucvbzggugmmn`, other apps share it), so
every object is prefixed `arunachala_`.

- Privacy (2026-11-17, migration `20261117000000_arunachala_owner_private`):
  `arunachala_memory` and `arunachala_agent_runs` carry `visibility`
  (`private` | `team`). Team owners' rows default to private (only the author
  can read them); members' rows default to team. RLS select = own rows, or
  `team` rows in your team. `arunachala_ai_calls` follows the same rule
  (`20261117000100`); the cap trigger is security definer, so team caps
  still count every row. Tasks stay team-wide. Verified with rolled-back
  tests as a member: 0 of the owner's memories, runs or AI calls.
- Runs: `runs.jsonl` stays the source of truth and acts as an outbox; every
  30 s new or changed runs upsert into `arunachala_agent_runs` (repo name only, no local
  paths). State in `logs/run-sync-state.json`; offline = retried next tick.
- `GET /api/runs?scope=team` reads the team's runs; falls back to local.
- AI calls: every model call (persona chat, bridge router, TypeSafe) appends
  to `logs/ai-calls.jsonl`; synced to `arunachala_ai_calls` (`client_id`
  dedupes). Local `ollama` calls are exempt from the paid-call caps.
- Memory: new `drisyon-memory.json` entries sync to `arunachala_memory`
  (state = newest `createdAt` sent); `GET /api/memory/search?scope=team`
  ranks the team's entries. Ranking is by meaning: local `nomic-embed-text`
  embeddings (`embeddings.js`, cache `logs/embeddings-cache.json`, ~1 s cold /
  6 ms warm), keyword `searchEntries` when Ollama is down or
  `MEMORY_EMBEDDINGS=false`. Response field `ranker` says which ran.
- Tasks: with team-store on, `/api/tasks` is the shared board
  (`POST /api/tasks` {title, project?, status?, link?}, `PATCH
  /api/tasks/<uuid>` {status}); falls back to read-only `TASKS.md`.
  `node scripts/import-tasks.js [--apply]` copies `TASKS.md` onto the board.
- Local-first dispatch: agent `auto` in `agent-dispatch.sh` runs `LOCAL_AGENT`
  (hermes) first, then the repo's tests (`.arunachala-test`, else `npm test`);
  pass = done, fail / no tests = worktree reset and claude runs. End line
  records `escalated`. `DISPATCH_LOCAL_FIRST=true` turns claude requests into
  `auto` server-side. Tests: `orchestration/agent-dispatch.test.js` (stubs).
- Claude runs: dispatched with `--model $CLAUDE_MODEL` (sonnet), `--max-turns`
  (40) and, with `CLAUDE_LEAN=true`, no MCP servers / skills / user settings
  (measured 64k -> 39k context tokens). `--output-format stream-json` is
  turned into readable progress lines in the run log by `stream-log.js`, which
  saves the final result event to `<runId>.claude.json`; `claude-usage.mjs`
  writes tokens + `cost_usd` from it to the AI ledger (provider `anthropic`,
  purpose `dispatch`) and prints the result after a `== result` line. The
  issue poller posts a review's text from `<runId>.claude.json`, not the log.
- Costs: `GET /api/costs?days=7[&scope=team]` and the dashboard's Costs tab -
  paid vs local calls, tokens, cost by purpose and model, auto-run local
  share, caps, and advice (`team-store/costs.js`, pure + tested).
- Dispatch context: `/api/dispatch/run` adds the top 3 memories for the repo
  (plus global/all) to the prompt after the task, capped at 1500 chars,
  looked up within 4 s (`dispatch-context.js`; `DISPATCH_MEMORY_CONTEXT=false`
  turns it off).
- Weekly digest: `GET /api/digest` returns the text (`digest.js`). Nothing
  broadcasts it any more.
- Schema checks: `bash supabase/tests/run-local.sh` (Docker).

## API surface (server.js)

All routes are unauthenticated unless noted. `GET` unless marked `POST`.

| Route | Purpose |
|---|---|
| `/api/telemetry` | Current snapshot from `telemetry.json` |
| `/api/history` | Rolling CPU/latency series from `history.json` |
| `/api/ping` | Live Ollama handshake test. **Only route that calls `rebac.canAccess`.** |
| `/api/models` | Ollama `/api/tags` passthrough |
| `/api/openclaw` | Cached OpenClaw session/task/token-usage snapshot (see OpenClaw section) |
| `/api/tasks` | Parses `../../04_internal/TASKS.md` (**outside this repo**) into backlog/in_progress/done columns for the Task Board tile. No fallback if that path moves - returns an empty-columns stub. |
| `POST /api/agent/chat` | Routes a message to a local Ollama model (`gemma3:4b`) under one of 5 hardcoded personas (po/tech/qa/infra/doc) |
| `POST /api/team/dispatch` | Ingests an operator dispatch into Drisyon memory (Tier 4 - see below) |
| `POST /api/memory/store` | Writes an entry into Drisyon episodic memory |
| `/api/memory/search` | Cosine-similarity search over episodic memory, `?q=&tenant=&project=` |
| `/api/memory/invariants` | Returns the hardcoded DEC-001/002/003/005 procedural rules |
| `/api/rebac/inspect` | Dumps the full ReBAC node/edge graph - no auth gate on the dump itself |

## Ollama - not a service, kept alive by a watchdog

Every persona (`gemma3:4b`) and Hermes (`qwen2.5-coder:3b`) run on Ollama, so
Ollama down = whole team down while the dashboard still looks healthy. Ollama
is the user-level tray app (Startup-folder shortcut), not a service: it only
runs while Sriad is logged on, because the models live in his profile.

Scheduled task **`Arunachala Ollama Watchdog`** (current user, every 5 min and
at logon) runs `ollama-watchdog.ps1`: if `127.0.0.1:11434/api/tags` doesn't
answer, it starts `ollama app.exe` and logs to `logs\ollama-watchdog.log`.
Note: starting the app can run a pending Ollama update first, so recovery can
take ~1 min.

`restart-arunachala.ps1` gives Cloudflared 15 s to stop, then kills it -
`Restart-Service Cloudflared` alone hangs printing "Waiting for service ... to
stop" while it drains connections.

## Encoding rules (both directions bite)

- `telemetry.json` / `history.json` **must have no BOM**. Node's `JSON.parse`
  rejects one, and `serveJsonFile` swallows the failure and returns `{}` - the
  dashboard then renders static HTML defaults and looks fine while serving
  nothing. `Write-AtomicJsonFile` uses `UTF8Encoding($false)` for this reason;
  do not revert it to `Out-File -Encoding utf8` (PS 5.1 adds a BOM).
- `.ps1` files here are **ASCII-only on purpose**. Windows PowerShell 5.1 reads
  BOM-less `.ps1` as Windows-1252, so a UTF-8 em-dash decodes to a sequence
  containing a double quote and breaks string parsing. No smart quotes, no
  em-dashes, no emoji in PowerShell sources.

## Drisyon memory engine (4-tier) - `memory-engine.js`

Backs the Drisyon brand/branding on the dashboard body and everything under
`/api/memory/*` and `/api/team/dispatch`. Persists to `drisyon-memory.json`
(episodic memory capped at last 1000 entries, operator alignments at last 200
- older entries are silently dropped, not archived).

| Tier | What it is |
|---|---|
| 1 - Working | In-memory `Map`, never persisted, not currently read by any route |
| 2 - Episodic/Semantic | `storeMemory()` entries, partitioned by `tenantId` + `projectId`, ranked by a hand-rolled cosine-similarity/term-frequency search (no embeddings model) |
| 3 - Procedural Invariants | DEC-001 (client-owned infra, zero prod creds), DEC-002 (run-step idempotency), DEC-003 (parked is a health condition not a state), DEC-005 (evidence over assertion for gates) - hardcoded in `_initializeProceduralMemory()`, not editable via API |
| 4 - Operator Alignment | `ingestOperatorDispatch()`, fed by `POST /api/team/dispatch` |

**Tenant isolation caveat:** `search()` only filters by `tenantId` when the
caller passes something other than `tenant:drisyon_core`. Querying as
`tenant:drisyon_core` (the default when no `tenant` param is given) returns
memories across **every** tenant. If BOV multi-tenancy is meant to be a real
boundary rather than an internal convenience, this default needs to change.

## Task board - `/api/tasks`

Reads and parses `C:\tt-ai-stack\04_internal\TASKS.md` as markdown tables
under `## Backlog` / `## In Progress` / `## Done` headers - not a database,
just a live text-file parser. Column headers and separator rows are
skip-matched by string content (`task |`, `---`), so renaming a column header
in `TASKS.md` can silently break parsing for that section.

## OpenClaw model-usage panel - `/api/openclaw`

Backed by a 60s background poll of the `openclaw` CLI (`sessions --all-agents
--json` + `tasks list --json`), never shelled out on the request path -
polling on-request would pile up concurrent `openclaw` processes under memory
pressure, since each CLI call can take 30s-several minutes.

- Cached snapshot persists to `openclaw-status.json` and reseeds on daemon
  restart so the panel isn't empty right after a service bounce.
- Because `server.js` runs as an NSSM/LocalSystem service, `OPENCLAW_BIN` is
  addressed by full path (`C:\Users\Sriad\AppData\Roaming\npm\openclaw.cmd`)
  rather than relying on `PATH` - LocalSystem's PATH doesn't include the npm
  global bin dir. `USERPROFILE`/`HOME`/`OPENCLAW_STATE_DIR`/
  `OPENCLAW_CONFIG_PATH` are likewise forced to Sriad's profile in the child
  process env, or the CLI silently reads/writes LocalSystem's own (wrong)
  profile.
- Token usage is bucketed `local` vs `cloud` by `modelProvider` (`google`,
  `openai`, `anthropic` count as cloud; everything else counts as local).

## ReBAC engine - actual enforcement scope

`rebac-engine.js` is a small in-memory graph (`addNode`/`addEdge`/
`canAccess`) seeded once at server startup with one path: `user:sriad` ->
`team:opscore` -> `role:admin` -> `perm:ping` -> `resource:ollama_cluster`.

**It only gates `/api/ping`.** No other route - not `/api/agent/chat`, not
any `/api/memory/*` route, not `/api/team/dispatch` -
calls `canAccess()`. Treat the "ReBAC Engine" as authorizing one specific
action today, not as a general access-control layer for the app; the
`GET /api/rebac/inspect` route that dumps the whole graph is itself unguarded.

## Public exposure via Cloudflare Tunnel

Tunnel `eb8206da-244d-4fef-81d1-94f138f6a900`, config
`C:\Users\Sriad\.cloudflared\config.yml`, Windows service `Cloudflared`.
A config change needs `Restart-Service Cloudflared -Force` (elevated).

| Hostname | Origin | Note |
|---|---|---|
| `team.mytestbed.tech` | `http://127.0.0.1:8787` | Removed 2026-09-13, restored 2026-10-20 **behind Cloudflare Access** app `Arunachala Dashboard` (`82cd560e-410a-4441-a300-f311a09640e1`, allow = owner email only, 24h session). |

### Origin auth - `access-auth.js`

Two locks since 2026-10-20:

1. **Edge:** the Cloudflare Access app above. No login, no request.
2. **Origin:** `server.js` checks the Access JWT itself on every request that
   came through the tunnel (Host `team.mytestbed.tech` **or** any
   `cf-connecting-ip` header). RS256 against the team JWKS
   (`crimson-shape-5caa.cloudflareaccess.com/cdn-cgi/access/certs`, cached 1h,
   unknown `kid` refetch at most once a minute), plus `aud`, `iss`, `exp`,
   `nbf`. Fails closed (403) - including when certs can't be fetched.

Local requests (Host localhost/127.0.0.1, no Cloudflare headers) skip the
check, so the telemetry daemon, OpenClaw (`127.0.0.1:8787/v1`) and local
browsing are unaffected. The server binds **127.0.0.1 only** (`HOST` env to
override), so the LAN cannot reach the port directly.

Config (env overrides, defaults in `server.js`; none are secrets):
`ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` (the Access app's AUD tag), `PUBLIC_HOSTNAMES`,
`ACCESS_ALLOWED_EMAILS` (optional extra allow-list). **If the Access app is
recreated, its AUD changes** - update `ACCESS_AUD` or every tunnelled request
gets 403. Tests: `npm test`.

Before 2026-10-20 `server.js` had **no authentication of any kind** - the lone
`rebac.canAccess('user:sriad', ...)` asserts the caller is you, and only gates
`/api/ping` (see ReBAC section above). While it was tunnelled,
`POST /api/agent/chat`, `POST /api/team/dispatch` and `POST /api/memory/store`
were callable by anyone on the internet, and `GET /api/telemetry` served the
`app.log` tail. Do not re-add that ingress rule until Cloudflare Access (or
equivalent auth) is in front of it.

Since that note was written, the API surface grew - all of it equally
unauthenticated. Anything re-exposed needs to also cover: `GET
/api/memory/search` and `/api/memory/invariants` (read out Drisyon memory
contents and the hardcoded governance rules), and `GET /api/rebac/inspect`
(dumps the full authorization graph). See "API surface" table above for the
complete route list.

## CI - `.github/workflows/ci.yml`

Runs on push/PR to `main`: `actions/checkout@v7` + `actions/setup-node@v7`
(Node 22), `npm ci || npm install`, `node --check server.js`, `npm audit
--audit-level=high` (both non-blocking, `|| true`), and a PowerShell AST parse
of `telemetry-daemon.ps1` (`[System.Management.Automation.Language.Parser]::ParseFile`,
not `Test-ScriptFileInfo`) to catch the encoding/quoting breakage described
above before it reaches the service.

## Open items

- DONE 2026-11-17: Buzz integration removed (#29); work arrives as GitHub issues.
- DONE 2026-11-09: ReBAC (`rebac-engine.js`) extended to gate all protected endpoints: `/api/ping`, `/api/dispatch/run`, `/api/agent/chat`, `/api/team/dispatch`, `/api/memory/store`, `/api/memory/search`, and `/api/rebac/inspect`.
- DONE 2026-11-09: Risky dispatch guardrail (`FR-CHAT-07`) active: pre-flight filter halts destructive commands (`git reset --hard`, `git push -f`, `rm -rf`, `DROP TABLE`, `chmod 777`) unless confirmed by operator (`confirmed: true`).
- DONE 2026-11-09: `/api/tasks` fallback to local `TASKS.md` with local task creation and section moves when Supabase is not connected (`FR-CHAT-08`).
- DONE 2026-11-08: Cross-platform hardware discovery (`host-specs.js`) detecting Apple Silicon M5 Max, Metal GPU Assist, and unified memory.
- DONE 2026-11-08: Dual portal architecture with Cloudflare Tunnel ingress routing: `team.mytestbed.tech` (:8787) and `drisyon.mytestbed.tech` (:8788).
- Drisyon memory `search()`'s `tenant:drisyon_core` default bypasses the
  per-tenant filter (see Drisyon memory engine section) - confirm that's
  intentional before relying on it as real multi-tenant isolation.
- `PLAN.md`'s checklist (Phase 2-5) hasn't been touched since Sep 8 and
  undercounts what's shipped - e.g. it still shows the NSSM/service move as
  unchecked even though the Runtime section above documents it as live. Worth
  a pass to reconcile or retire in favor of this file.

Backups from the 2026-09-13 session: `*.bak-20260913`.