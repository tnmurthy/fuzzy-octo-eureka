# Arunachala Operations Center

Local dashboard for monitoring the `tt-ai-stack` AI workspace: Ollama, the
OpenClaw gateway, Hermes subagents, and workspace layout — all read from
files already on disk, no cloud dependency.

## Architecture

```
telemetry-daemon.ps1  --writes-->  telemetry.json, history.json
                                          |
                                          v
                                     server.js  (node, zero deps)
                                          |
                                serves static files + JSON APIs
                                          |
                                          v
                        index.html + dashboard.css + dashboard.js
                              (open http://localhost:8787)
```

- **`telemetry-daemon.ps1`** — PowerShell background loop. Every 5s: reads
  host CPU, checks Ollama/OpenClaw ports, runs a real HTTP handshake against
  Ollama for latency, tails the app log, parses subagent transcripts, and
  writes `telemetry.json` (current snapshot) + appends to `history.json`
  (rolling ~1hr window, capped at 720 points).
- **`server.js`** — tiny Node http server, no npm install required. Serves
  the static dashboard files plus:
  - `GET /api/telemetry` — current snapshot
  - `GET /api/history` — recent CPU/latency series for the charts
  - `GET /api/ping` — on-demand live Ollama handshake test (used by the "Test Handshake" button)
  - `GET /api/tasks` — live Markdown parser reading `TASKS.md` for the interactive Task Board
  - `POST /api/agent/chat` — interactive autonomous agent chat routing to local Ollama (`llama3.1:8b`) with personas (`po`, `tech`, `qa`, `infra`, `doc`)
  - `GET /api/memory/invariants` — active DEC procedural rules (DEC-001, DEC-002, DEC-003, DEC-005)
  - `GET /api/memory/search?q=<query>&tenant=<tenant>` — multi-tenant semantic & vector search
  - `POST /api/memory/store` — ingest new client project requirements or specs
  - `POST /api/team/dispatch` — Human-to-Team Dispatch channel with automatic memory vectorization
- **`memory-engine.js`** — 4-tier cognitive memory model:
  - **Tier 1: Working Memory** (ephemeral agent scratchpads and execution context).
  - **Tier 2: Episodic & Semantic Memory** (multi-tenant vector archive, partitioned by ReBAC boundaries).
  - **Tier 3: Procedural Invariants** (hard architectural rules: DEC-001 zero credentials, DEC-002 trigger idempotency, DEC-003 health orthogonality, DEC-005 evidence gates).
  - **Tier 4: Operator Alignment Memory** (ingested human operator guidance from Dispatch).
- **`drisyon-memory.json`** — persisted memory archive seeded from BOV projects (`08_drisyon_des`, `07_BBAT`, `01_Modular-NeuroClips`, `09_PEM`).
- **`orchestration-for-local.md`** — comprehensive 5-layer AI architecture matrix and workforce orchestration guide.
- **`index.html` / `dashboard.css` / `dashboard.js`** — the frontend. Polls
  `/api/telemetry` every 3s via `fetch()`, seeds its charts from
  `/api/history` once on load, and falls back to simulated data only until
  the first real telemetry fetch succeeds.

## Running it

Installed as two NSSM services, `ArunachalaDashboard` (`node server.js`) and
`ArunachalaTelemetry` (`telemetry-daemon.ps1`), both running from
`C:\tt-ai-stack\01_projects\active\arunachala-dashboard`. After changing
`server.js`, restart from an **elevated** PowerShell:

```powershell
Restart-Service ArunachalaDashboard
```

To run a second copy for testing without touching the service:

```bash
PORT=8799 node server.js
```

Then open `http://localhost:8787` (or the test port).

## Orchestrating agents

`orchestration/` hands tasks to the coding agents on this machine and records
what each one did. The **Agent Runs** tab shows the record.

```bash
# one task, one agent, its own worktree beside the repo
orchestration/agent-dispatch.sh codex  C:/tt-ai-stack/01_projects/active/bov chore/search-path task.md
orchestration/agent-dispatch.sh agy    C:/tt-ai-stack/01_projects/active/bov review/0027      review.md
```

| Agent | Command it runs | Use it for |
|---|---|---|
| `claude` | `claude -p … --permission-mode acceptEdits` | Lead work, migrations, anything security-relevant |
| `codex` | `codex exec -C <worktree> -s workspace-write` | A second builder on an independent task |
| `agy` | `agy --mode plan --prompt=…` | Read-only review. Headless, it cannot ask for tool permissions: put the files to review into the prompt |
| `hermes` | `hermes --in <worktree> -z …` | Local, offline, private: summaries, drafts, classification. Not security-relevant code |
| `noop` | prints the prompt | Testing the script |

Each run appends a start line and an end line to
`C:\tt-ai-stack\04_internal\agent-runs\runs.jsonl` (override with
`AGENT_RUNS_DIR`) and writes the agent's whole output to `<run-id>.log` beside
it. `AGENT_TIMEOUT` (default 3600s) bounds a run. The dashboard reads the same
file (`AGENT_RUNS_FILE` to override); a run with no end line after six hours
shows as `stale`.

Every prompt is prefixed with the rules: stay in the worktree, commit on the
branch, never push to main, and wrap the shared local database in the lock.

### The local database lock

Every project's local Supabase stack is one shared database, so two agents
resetting it or running suites against it at once break each other's runs.
Wrap those commands:

```bash
orchestration/db-lock.sh supabase db reset
orchestration/db-lock.sh npm test
```

The lock is a directory at `~/.agent-locks/supabase-local.lock`. A second caller
waits (up to `DB_LOCK_WAIT`, 1800s) and prints who holds it; a lock older than
`DB_LOCK_STALE` (3600s) is treated as abandoned and broken.

Tests: `node --test runs-reader.test.js`.

`telemetry.json` and `history.json` are runtime output — they're
git-ignored so the daemon can write freely without dirtying the repo.

## Security note

This project previously lived alongside `apis.txt`, a plaintext file
containing live API keys and tokens. That file is **not** part of this
repo and should never be committed. If you're setting this repo up fresh,
double check `git status` before your first commit, and see
`.gitignore` — `apis.txt` is excluded by name as a guard rail, not a
substitute for keeping it out of the folder entirely.
