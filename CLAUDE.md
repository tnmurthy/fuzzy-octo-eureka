# CLAUDE.md - Arunachala Operations Center

## Runtime: NSSM services, not loose processes

Two Windows services run this stack. **Never kill their PIDs** - NSSM respawns
them within milliseconds, which looks like processes "surviving" a kill and
leads to duplicate unsupervised copies.

| Service | Runs |
|---|---|
| `ArunachalaTelemetry` | `telemetry-daemon.ps1` |
| `ArunachalaDashboard` | `server.js` (port 8787) |

Restart (elevated only):

```powershell
.\restart-arunachala.ps1
# or: Restart-Service ArunachalaTelemetry, ArunachalaDashboard -Force
```

Both services run as Administrator. An unelevated shell sees blank
`Win32_Process.CommandLine` for them, so any filter on command line silently
returns nothing - do not conclude from that that they are not running.

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
| `POST /api/buzz/events` | **Unauthenticated-by-design webhook.** Accepts a NIP-01-shaped event, stores it in Drisyon memory, and forwards it to the same local Ollama chat used by `/api/agent/chat`. Meant to receive Buzz relay directives, but nothing currently verifies the sender - see Open items. |

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

## Buzz relay integration

`Get-BuzzStatus` in `telemetry-daemon.ps1` emits `services.buzz`:
`online, ui, metrics, containers, realMembers, latencyMs, port`.
`realMembers` is cached 60s - `docker exec psql` is slow and the value rarely
changes.

Buzz specifics:

- Relay is **host-routed** by the Host header. Two communities exist:
  `localhost:3000` (local, what the dashboard probe uses) and
  `buzz.mytestbed.tech` (public, via Cloudflare Tunnel). `127.0.0.1:3000`
  matches neither and returns
  `404 relay: no community is configured for this host`.
- One person owning N communities has N `relay_members` rows. Count members
  with `count(DISTINCT pubkey)`, or the tile reads "2 members" for one person.
- Relay owner is the Buzz desktop identity
  `768ee3b1eccb49856271187b66d3095b70bb23d3fa883a63183c5b7f3c5235cd`,
  the sole row in `relay_members`. Without a holdable owner key nobody can mint
  an invite (`POST /api/invites` requires owner/admin), so login is impossible -
  that was the original "cannot log in" cause.
- Compose lives at `C:\tt-ai-stack\01_projects\active\buzz\deploy\compose\`
  (project `buzz-prod`). Relay publishes `3000`, plus `127.0.0.1:9102` (metrics)
  and `127.0.0.1:8081` (health).
- `docker compose up -d relay` needs `--no-deps` only if `minio-init` breaks;
  its image was repointed to `quay.io/minio/mc`.

Dashboard tile states: `OFFLINE` / `UNCLAIMED` (realMembers 0) /
`HOST MISMATCH` / `NO METRICS` / `HEALTHY`.

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
| 4 - Operator Alignment | `ingestOperatorDispatch()`, fed by `POST /api/team/dispatch` and by `POST /api/buzz/events` |

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
any `/api/memory/*` route, not `/api/team/dispatch`, not `/api/buzz/events` -
calls `canAccess()`. Treat the "ReBAC Engine" as authorizing one specific
action today, not as a general access-control layer for the app; the
`GET /api/rebac/inspect` route that dumps the whole graph is itself unguarded.

## Public exposure via Cloudflare Tunnel

Tunnel `eb8206da-244d-4fef-81d1-94f138f6a900`, config
`C:\Users\Sriad\.cloudflared\config.yml`, Windows service `Cloudflared`.
A config change needs `Restart-Service Cloudflared -Force` (elevated).

| Hostname | Origin | Note |
|---|---|---|
| `buzz.mytestbed.tech` | `http://127.0.0.1:3000` | Buzz relay, TLS at the edge, `wss://` works |
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
unauthenticated. Anything re-exposed needs to also cover: `POST
/api/buzz/events` (explicitly built as an open webhook receiver - accepts and
acts on unsigned input, forwarding it straight to the local model), `GET
/api/memory/search` and `/api/memory/invariants` (read out Drisyon memory
contents and the hardcoded governance rules), and `GET /api/rebac/inspect`
(dumps the full authorization graph). See "API surface" table above for the
complete route list.

Buzz is safe to expose because it authenticates: NIP-11 reports
`auth_required: true`, `restricted_writes: true`, and
`BUZZ_REQUIRE_AUTH_TOKEN=true`. If desktop login ever breaks, that last flag is
the first thing to flip back.

## CI - `.github/workflows/ci.yml`

Runs on push/PR to `main`: `actions/checkout@v7` + `actions/setup-node@v7`
(Node 22), `npm ci || npm install`, `node --check server.js`, `npm audit
--audit-level=high` (both non-blocking, `|| true`), and a PowerShell AST parse
of `telemetry-daemon.ps1` (`[System.Management.Automation.Language.Parser]::ParseFile`,
not `Test-ScriptFileInfo`) to catch the encoding/quoting breakage described
above before it reaches the service.

## Open items

- `POST /api/buzz/events` is an unauthenticated-by-design webhook (see API
  surface table) - decide whether it needs a shared secret or signature check
  before it's ever reachable from outside localhost, same class of risk as
  the endpoints already flagged below.
- ReBAC (`rebac-engine.js`) currently authorizes only `/api/ping`. If the
  intent is to protect the Drisyon/agent/team-dispatch endpoints too, they
  need explicit `canAccess()` calls added - right now the graph exists but
  doesn't gate them.
- Drisyon memory `search()`'s `tenant:drisyon_core` default bypasses the
  per-tenant filter (see Drisyon memory engine section) - confirm that's
  intentional before relying on it as real multi-tenant isolation.
- `/api/tasks` depends on `C:\tt-ai-stack\04_internal\TASKS.md`, a file
  outside this repo, with no documented behavior if that path is renamed or
  moved beyond returning empty columns.
- `BUZZ_REQUIRE_RELAY_MEMBERSHIP` is still `false` - revisit now that the relay
  is internet-facing.
- DONE 2026-10-20: Cloudflare Access in front of `team.mytestbed.tech`, then restore its ingress
  rule so the dashboard is remotely reachable again.
- Second clone at `C:\tt-ai-stack\buzz` is stale; the live one is under
  `01_projects\active\buzz`.
- `PLAN.md`'s checklist (Phase 2-5) hasn't been touched since Sep 8 and
  undercounts what's shipped - e.g. it still shows the NSSM/service move as
  unchecked even though the Runtime section above documents it as live. Worth
  a pass to reconcile or retire in favor of this file.

Backups from the 2026-09-13 session: `*.bak-20260913`.