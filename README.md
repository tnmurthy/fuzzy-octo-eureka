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

```bash
# from C:\tt-ai-stack\04_internal\dashboard
node server.js
```

Then open `http://localhost:8787`. In a separate terminal, start the
telemetry daemon:

```powershell
.\telemetry-daemon.ps1
```

`telemetry.json` and `history.json` are runtime output — they're
git-ignored so the daemon can write freely without dirtying the repo.

## Security note

This project previously lived alongside `apis.txt`, a plaintext file
containing live API keys and tokens. That file is **not** part of this
repo and should never be committed. If you're setting this repo up fresh,
double check `git status` before your first commit, and see
`.gitignore` — `apis.txt` is excluded by name as a guard rail, not a
substitute for keeping it out of the folder entirely.
