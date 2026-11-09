# Arunachala Operations Center - High-Level Design

Arunachala lets a small team run an AI workforce from chat and unified dashboards:
the host environment (Apple Silicon Mac Studio with Metal GPU acceleration, or Windows rigs)
runs the operations dashboard, Drisyon agency workspace, a Buzz Nostr chat bridge, local Ollama models,
and an autonomous dispatcher that hands coding tasks to agents, while the team shares context
(agent runs, AI call ledger, 4-tier memory, task board) through Supabase and local storage.
Local models do high-volume work; frontier models run only when a task needs escalation.

As of November 2026. Setup: [`SETUP.md`](../SETUP.md). Working notes for agents
editing this repo: [`CLAUDE.md`](../CLAUDE.md). Agency Wiki: [`docs/WIKI.md`](WIKI.md).

---

## 1. Context

```mermaid
flowchart LR
    subgraph People
        OP["Operator / Teammate<br/>Buzz Desktop"]
        BR["Browser<br/>Dashboard & Wiki"]
    end

    subgraph Host["Host Node (Mac Studio M5 Max / Rig)"]
        ARU["Arunachala Dashboard :8787<br/>+ Drisyon Dashboard :8788"]
        BRG["Buzz Bridge + Nostr Relay<br/>NIP-42 Auth"]
        LLM["Ollama Metal GPU (:11434)<br/>gemma3:4b, qwen2.5-coder:3b"]
        AG["Agent Mesh<br/>Tech, QA, Mantis, Infra, OpenHands"]
        SAFE["Safety Filter & ReBAC<br/>FR-CHAT-07 Guardrails"]
    end

    subgraph Shared["Shared Services"]
        BUZZ["Buzz Relay<br/>wss://drisyon-ai.communities.buzz.xyz"]
        SB[("Supabase - Talia Project<br/>arunachala_* tables")]
        CF["Cloudflare Tunnels<br/>team.mytestbed.tech<br/>drisyon.mytestbed.tech"]
    end

    OP -- "@mention bot" --> BUZZ
    BUZZ <-- "websocket, NIP-42" --> BRG
    BR -- "HTTPS" --> CF --> ARU
    ARU --> SAFE --> AG
    ARU -- "route, chat, embed" --> LLM
    ARU <-- "sync as own user, RLS" --> SB
```

| Concern | Choice | Why |
|---|---|---|
| Where it runs | Every teammate runs their own install | Own keys and logins; no shared server to maintain |
| What is shared | Supabase tables, scoped by team with row-level security | One place for context, no service key on laptops |
| Which model | Local Ollama first, frontier on escalation | Routing, chat and search are high-volume and cheap locally |
| Chat surface | Buzz (Nostr relay) | Already the team's channel; signed, authenticated messages |

---

## 2. Components on one machine

```mermaid
flowchart TB
    subgraph NSSM["Windows services (NSSM, LocalSystem)"]
        TEL["ArunachalaTelemetry<br/>telemetry-daemon.ps1"]
        DASH["ArunachalaDashboard<br/>server.js :8787"]
        BRG["ArunachalaBuzzBridge<br/>bridge.js, notify :3100"]
    end

    subgraph Docker
        N8N["n8n :5678<br/>buzz-dispatch workflow"]
    end

    subgraph User["User-level"]
        OLL["Ollama :11434<br/>gemma3:4b, qwen2.5-coder:3b,<br/>nomic-embed-text"]
        OC["OpenClaw gateway :18789"]
    end

    subgraph InDash["Inside server.js"]
        TS["team-store/<br/>Supabase sync"]
        MEM["memory-engine +<br/>memory-search (embeddings)"]
        LED["AI call ledger"]
    end

    DISP["orchestration/agent-dispatch.sh<br/>(git-bash, per run)"]
    FILES[("Local files<br/>runs.jsonl, ai-calls.jsonl,<br/>drisyon-memory.json, telemetry.json")]

    TEL -- "probe" --> OLL & OC
    TEL -- "write" --> FILES
    BRG -- "classify" --> OLL
    BRG -- "status, chat" --> DASH
    BRG -- "webhook" --> N8N
    N8N -- "start run, poll" --> DASH
    N8N -- "notify" --> BRG
    DASH -- "spawn" --> DISP
    DISP -- "append" --> FILES
    DASH --- TS & MEM & LED
    DASH -- "persona chat" --> OLL
    MEM -- "embed" --> OLL
    LED & TS --- FILES
```

| Component | Runtime | Responsibility | Key files |
|---|---|---|---|
| Dashboard | NSSM, Node, 127.0.0.1:8787 | UI and every `/api/*` route; spawns runs; team sync; memory search | `server.js`, `team-store/`, `memory-*.js`, `embeddings.js` |
| Buzz bridge | NSSM, Node, notify on 127.0.0.1:3100 | Bot on the relay: filter, route, reply in thread | `buzz-bridge/` |
| Telemetry | NSSM, PowerShell | Service probes, CPU, agent stats to JSON snapshots | `telemetry-daemon.ps1` |
| n8n | Docker, 127.0.0.1:5678 | Webhook → start run → poll every 10 s → notify | `n8n/buzz-dispatch-workflow.json` |
| Dispatcher | git-bash child, one per run | Worktree per run, agent call, run log, `auto` escalation | `orchestration/agent-dispatch.sh` |
| Ollama | User tray app + watchdog task | Routing, personas, embeddings | `ollama-watchdog.ps1` |

All three services run as LocalSystem. Per-person values come from `.env`
(`OPERATOR_HOME` gives agent runs the operator's profile and CLI logins).

---

## 3. Key flows

### 3.1 Buzz message to agent run and back

```mermaid
sequenceDiagram
    autonumber
    actor Op as Operator (Buzz)
    participant R as Buzz relay
    participant B as Bridge
    participant O as Ollama router
    participant N as n8n
    participant D as Dashboard
    participant S as agent-dispatch.sh
    participant F as runs.jsonl
    participant SB as Supabase

    Op->>R: @bot run noop in arunachala-dashboard: hello
    R->>B: channel event (mention, operator key)
    B->>O: classify (route, executor, repo, risky)
    O-->>B: dispatch, safe
    B->>N: POST /webhook/buzz-dispatch
    N->>D: POST /api/dispatch/run
    D->>S: spawn detached
    D-->>N: 202 runId
    N-->>B: runId
    B->>B: save runId in pending-dispatch.json
    B->>R: ack in thread
    S->>F: start line
    S->>S: worktree + agent (1 h timeout)
    S->>F: end line (status, exit, escalated)
    loop every 10 s until the run ends
        N->>D: GET /api/runs
    end
    N->>B: POST :3100/notify
    B->>R: result in the original thread
    D-->>SB: run synced within 30 s
```

### 3.2 Message routing

```mermaid
flowchart LR
    E[Channel event] --> G{shouldHandle}
    G -- "operator, mentioned" --> RT["Router<br/>gemma3:4b → qwen2.5-coder:3b"]
    G -- "operator, no mention" --> L1["Logged: bot not mentioned"]
    G -- "stranger / old / no channel" --> L2[Logged skip]
    G -- "own or others' chatter" --> X[Dropped]
    RT --> D{decide}
    D -- status --> S["Reply from telemetry + runs<br/>no model call"]
    D -- persona --> P["Persona reply<br/>Ollama"]
    D -- "dispatch, safe" --> W["n8n → agent run"]
    D -- "dispatch, risky" --> C["Described; confirm not built"]
    D -- add_task --> T["Described; not built"]
```

### 3.3 Local-first dispatch (`auto`)

```mermaid
flowchart TD
    A["claude request<br/>DISPATCH_LOCAL_FIRST=true"] --> AU[agent = auto]
    AU --> T{"Repo has tests?<br/>.arunachala-test or npm test"}
    T -- no --> CL["claude runs<br/>escalated = true"]
    T -- yes --> H["Local agent (hermes)<br/>LOCAL_TIMEOUT 900 s"]
    H -- fails --> RS["Reset worktree to start<br/>(gitignored files kept)"]
    H -- finishes --> TE{"Tests pass?"}
    TE -- yes --> OK["Done, no frontier tokens<br/>escalated = false"]
    TE -- no --> RS
    RS --> CL
```

### 3.4 Team sync (outbox pattern)

```mermaid
flowchart LR
    subgraph Local["Local files - source of truth"]
        R1[runs.jsonl]
        R2[ai-calls.jsonl]
        R3[drisyon-memory.json]
    end
    J["team-store<br/>every 30 s"]
    ST[("logs/*-sync-state.json<br/>what was sent")]
    subgraph Supa["Supabase (own user, RLS)"]
        T1[arunachala_agent_runs]
        T2[arunachala_ai_calls]
        T3[arunachala_memory]
        T4[arunachala_tasks]
    end
    R1 -- "new / changed runs, upsert by id" --> J
    R2 -- "lines after last sent, client_id" --> J
    R3 -- "entries newer than last sent, client_id" --> J
    J <--> ST
    J --> T1 & T2 & T3
    UI["Dashboard /api/tasks<br/>POST, PATCH"] <--> T4
```

Offline or refused: the state is not advanced, so the same rows go on the
next tick, and the outage is logged once. Resends are no-ops (`id` /
`client_id` unique). Team sync is off unless all five `SUPABASE_*` /
`TEAM_ID` settings are present; a solo install runs on local files alone.

---

## 4. Data model (Supabase, shared)

```mermaid
erDiagram
    arunachala_teams ||--o{ arunachala_team_members : has
    arunachala_teams ||--o{ arunachala_agent_runs : records
    arunachala_teams ||--o{ arunachala_ai_calls : bills
    arunachala_teams ||--|| arunachala_ai_limits : caps
    arunachala_teams ||--o{ arunachala_memory : knows
    arunachala_teams ||--o{ arunachala_tasks : plans

    arunachala_teams {
        uuid id PK
        text name
    }
    arunachala_team_members {
        uuid team_id PK
        uuid user_id PK
        text display_name
        text buzz_pubkey
        text role
    }
    arunachala_agent_runs {
        text id PK
        uuid owner
        text agent
        text repo
        text status
        bool escalated
        int exit_code
    }
    arunachala_ai_calls {
        bigint id PK
        text client_id UK
        uuid owner
        text provider
        text model
        text purpose
        int input_tokens
        int output_tokens
    }
    arunachala_ai_limits {
        uuid team_id PK
        int member_daily_calls
        int team_daily_calls
    }
    arunachala_memory {
        uuid id PK
        text client_id UK
        uuid owner
        text tenant_id
        text title
        text content
    }
    arunachala_tasks {
        uuid id PK
        uuid owner
        text title
        text status
        uuid assignee
    }
```

| Rule (row-level security) | Effect |
|---|---|
| Read | Members read their own team's rows only |
| Write | Rows are inserted as yourself (`owner = auth.uid()`); runs and memory change only by their owner |
| Tasks | A shared board: any member creates and moves tasks |
| Membership | Only team owners add or remove members |
| AI caps | A trigger rejects paid calls past 200 per member or 1000 per team per UTC day; `ollama` calls are exempt |

Migrations: `supabase/migrations/`. Checks (11, Postgres in Docker):
`bash supabase/tests/run-local.sh`.

---

## 5. Security and trust boundaries

```mermaid
flowchart LR
    subgraph Internet
        U[Operator]
        X[Anyone]
    end
    subgraph Edge["Cloudflare"]
        ACC["Access: owner email,<br/>24 h session"]
        TUN[Tunnel]
    end
    subgraph Host["Teammate machine - 127.0.0.1 only"]
        D["Dashboard :8787<br/>re-checks Access JWT"]
        RL["Buzz relay :3000"]
        B["Bridge: obeys BUZZ_OPERATORS only"]
        A["Agents: SYSTEM rights + operator profile;<br/>no git push, no gh"]
    end
    SB[("Supabase<br/>publishable key + own login, RLS")]

    U --> ACC --> TUN --> D
    X -. "blocked without Access" .-> ACC
    U -- "NIP-42, auth token" --> TUN --> RL
    RL --> B
    D --> A
    D & B -.-> SB
```

| Boundary | Control |
|---|---|
| Public dashboard | Cloudflare Access at the edge plus origin JWT check (`access-auth.js`), fails closed |
| Public relay | NIP-42 auth, restricted writes, auth token required |
| Bridge commands | Only the owner's Buzz pubkeys (`BUZZ_OPERATORS`, no default) |
| Dispatch API | Loopback only; agent allow-list; repo must be a plain directory name; 10 KB body caps on task routes |
| Agents | Run in their own worktree; commit, never push or merge; claude has a tool allow-list |
| Supabase | No service key on laptops; RLS per team; `security definer` helpers not callable by `anon` |
| Secrets | `.env` files are gitignored; the installer types the Supabase password hidden |

Known gaps: agents run with SYSTEM rights while using the operator's profile
(acceptable on a single-user machine); `POST /api/buzz/events` is an open
webhook nothing calls and should be deleted; ReBAC gates only `/api/ping`.

---

## 6. Cost controls

| Lever | Where | Effect |
|---|---|---|
| Local routing, personas, embeddings | Ollama | No per-token cost for the high-volume calls |
| Local-first dispatch | `DISPATCH_LOCAL_FIRST`, `agent-dispatch.sh auto` | Claude runs only when the local attempt fails the repo's tests |
| Ledger of every call | `logs/ai-calls.jsonl` → `arunachala_ai_calls` | Tokens, time and purpose per call, per person |
| Hard daily caps | `arunachala_ai_limits` + trigger | Paid calls stop at the cap; owners change the limits |
| Right-sized persona model | `PERSONA_MODEL` | gemma3:4b on CPU (6.5 tok/s); qwen2.5:7b only with a GPU (3.1 tok/s on CPU) |

---

## 7. API surface (`server.js`)

| Route | Purpose |
|---|---|
| `GET /api/telemetry`, `/api/history` | Service health snapshot and CPU/latency series |
| `GET /api/config` | Operator name and persona model for the UI |
| `GET /api/runs[?scope=team]` | Agent runs, local or the whole team's |
| `POST /api/dispatch/run` | Start an agent run (n8n calls this) |
| `GET /api/tasks`, `POST /api/tasks`, `PATCH /api/tasks/<id>` | Task board: team board in Supabase, else read-only `TASKS.md` |
| `GET /api/memory/search?q=[&scope=team]` | Memory search by meaning (embeddings), keyword fallback |
| `POST /api/memory/store`, `POST /api/team/dispatch` | Add memory / operator directives |
| `POST /api/agent/chat` | Persona chat on Ollama |
| `GET /api/openclaw`, `/api/models`, `/api/ping` | OpenClaw usage, Ollama models, handshake test |

---

## 8. Open items

| Item | Next step |
|---|---|
| Risky dispatches and add-task only described | Build a confirm step in the bridge |
| Bridge listens to one relay (mytestbed) | Multi-relay only if drisyon-ai becomes the team's channel |
| Memory search threshold (0.5) is loose on a small store | Tune once there are more memories |
| `codex` / `hermes` untested as live dispatch targets | One real run each |
| n8n per person | Replace with a poller inside the bridge to drop a component |
