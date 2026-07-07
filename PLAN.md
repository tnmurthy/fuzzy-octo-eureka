# Arunachala Dashboard — Enhancement Plan & Checklist

## Status: Phase 1 (real server + history) — done, needs a live test pass

### Phase 1 — Real server + persistent history
- [x] Split monolithic `index.html` into `index.html` / `dashboard.css` / `dashboard.js`
- [x] Remove dead modal code (`openAgentModal`/`closeAgentModal`, unused markup)
- [x] Refactor `telemetry-daemon.ps1` into named functions with error isolation per cycle
- [x] Build `server.js` — static file serving + `/api/telemetry`, `/api/history`, `/api/ping`
- [x] Daemon: switch output from `window.x = ...` JS wrapper to plain `telemetry.json`
- [x] Daemon: add real Ollama handshake latency (`Test-OllamaHandshake`) instead of faked frontend latency
- [x] Daemon: add rolling `history.json` writer, capped at ~1hr of points
- [x] Frontend: replace script-tag-injection polling with `fetch()`-based polling
- [x] Frontend: seed CPU/latency charts from `/api/history` on load
- [x] Frontend: "Test Handshake" button calls real `/api/ping` instead of a `setTimeout` fake
- [x] Frontend: `telemetryLive` flag gates the simulated-data fallback correctly
- [x] Repo scaffolding: `package.json`, `.gitignore`, `README.md`
- [ ] **You:** copy the 5 files into `C:\tt-ai-stack\04_internal\dashboard\`, run `node server.js`, run the daemon, and confirm in-browser that:
  - [ ] CPU/latency numbers update within ~3s of daemon start
  - [ ] Charts show real (not random) data after a page refresh once `history.json` has a few points
  - [ ] "Test Handshake" button returns real latency/model list from Ollama
  - [ ] Killing the daemon doesn't crash the page (should just stop updating)
- [ ] Git: initialize repo, first commit (see below)

### Phase 2 — Make the daemon durable (not yet started)
- [ ] Register `telemetry-daemon.ps1` as a Windows Scheduled Task (or NSSM service) so it survives reboots without a manual `.\telemetry-daemon.ps1`
- [ ] Add a lockfile/PID check so two instances can't run at once and clobber `telemetry.json`
- [ ] Route daemon errors to a dedicated rotating log file instead of only stdout
- [ ] Decide whether `server.js` should also auto-start (Scheduled Task or `pm2`), or stay manual

### Phase 3 — Security hardening
- [ ] Rotate every credential that was in `apis.txt` (separate from this checklist, but blocking — see prior warning)
- [ ] Confirm `apis.txt` is deleted or moved outside any git-tracked folder
- [ ] If `server.js` is ever exposed beyond `localhost` (e.g. bound to `0.0.0.0` for LAN access), add basic auth or a bearer token check before doing so
- [ ] Review file permissions on `04_internal/` given it holds logs and previously held secrets

### Phase 4 — UX polish
- [ ] Add a "last synced" timestamp in the sidebar so a stalled daemon is obvious at a glance
- [ ] Desktop/toast notification when a service (Ollama/OpenClaw) flips offline
- [ ] Pull the Infrastructure tab's model list live from `ollama list` instead of the hardcoded array
- [ ] Consider WebSocket/SSE push from `server.js` instead of 3s polling, if snappier updates matter

### Phase 5 — Testing
- [ ] Pester tests for the daemon's parsing functions (`Get-ActiveOllamaModels`, `Get-AgentStats`, `Get-RoleKeyFromFirstLine`)
- [ ] Basic smoke test for `server.js` endpoints (e.g. a small Node test hitting `/api/telemetry` with a fixture file)
- [ ] Frontend: at least a manual test checklist per PR (see Phase 1's "You" checklist above as a template)

---

## Suggested git setup

```bash
cd C:\tt-ai-stack\04_internal\dashboard
git init
git add .
git commit -m "Refactor dashboard: split files, add real server + history"
```

If this should live in its own repo (recommended, since `04_internal`
previously held secrets and is a mixed-purpose folder):

```bash
mkdir C:\tt-ai-stack\01_projects\arunachala-dashboard
# copy index.html, dashboard.css, dashboard.js, server.js,
# telemetry-daemon.ps1, package.json, .gitignore, README.md there
cd C:\tt-ai-stack\01_projects\arunachala-dashboard
git init
git add .
git commit -m "Initial commit: dashboard with real server + history"
```

Either way, **do not** `git add apis.txt` — it's excluded by name in
`.gitignore`, but double-check `git status` before the first commit since
`.gitignore` only stops *future* additions, not files already staged.
