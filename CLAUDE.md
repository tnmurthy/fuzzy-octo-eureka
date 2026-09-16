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

## Public exposure via Cloudflare Tunnel

Tunnel `eb8206da-244d-4fef-81d1-94f138f6a900`, config
`C:\Users\Sriad\.cloudflared\config.yml`, Windows service `Cloudflared`.
A config change needs `Restart-Service Cloudflared -Force` (elevated).

| Hostname | Origin | Note |
|---|---|---|
| `buzz.mytestbed.tech` | `http://127.0.0.1:3000` | Buzz relay, TLS at the edge, `wss://` works |
| `team.mytestbed.tech` | **removed 2026-09-13** | was `:8787`; see below |

`server.js` has **no authentication of any kind** - the lone
`rebac.canAccess('user:sriad', ...)` asserts the caller is you. While it was
tunnelled, `POST /api/agent/chat`, `POST /api/team/dispatch` and
`POST /api/memory/store` were callable by anyone on the internet, and
`GET /api/telemetry` served the `app.log` tail. Do not re-add that ingress rule
until Cloudflare Access (or equivalent auth) is in front of it.

Buzz is safe to expose because it authenticates: NIP-11 reports
`auth_required: true`, `restricted_writes: true`, and
`BUZZ_REQUIRE_AUTH_TOKEN=true`. If desktop login ever breaks, that last flag is
the first thing to flip back.

## Open items

- `BUZZ_REQUIRE_RELAY_MEMBERSHIP` is still `false` - revisit now that the relay
  is internet-facing.
- Cloudflare Access in front of `team.mytestbed.tech`, then restore its ingress
  rule so the dashboard is remotely reachable again.
- Second clone at `C:\tt-ai-stack\buzz` is stale; the live one is under
  `01_projects\active\buzz`.

Backups from the 2026-09-13 session: `*.bak-20260913`.