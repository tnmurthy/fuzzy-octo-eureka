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
| `Meilisearch` | `campusgtm_signals/docker-compose.meilisearch.yml` | Port 7700 (Instant search, geosearch & typo tolerance for CampusGTM social/ambassador signals) |

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
  `POLLER_DEFAULT_AGENT` (hermes since 2026-11-22: **local by default**). Label
  `agent:claude` for a task that needs the paid model. Hermes is the Nous
  Hermes Agent CLI on Ollama (`~/.hermes/config.yaml`, gemma4:12b;
  `HERMES_MODEL` overrides per run). Hermes runs stream like claude
  (`hermes chat --format stream-json` -> `stream-log.js ... hermes`), save
  `<run>.hermes.json`, and support follow-ups, questions, live steps and stop
  (`followup.js` resumes `local-...` sessions with hermes). Hermes reports its
  session id only at the end, so a redirect of a stopped hermes run starts a
  fresh hermes run on the same branch instead of resuming. Approval levels do
  not apply to hermes; instead every dispatched hermes run is boxed (#46): a
  Docker container that sees only its worktree, config from
  `orchestration/hermes-agent-config.yaml` (`~/.hermes` is the personal
  setup, not used by dispatch), changes committed on the host with hooks off;
  the secret scan still gates every push.
- **Teammate run mode** (`teammate-mode.js`, 2026-11-23): what runs started
  by non-admins may do, switched by an admin in the /agents header (saved to
  `logs/teammate-mode.json`, default `TEAMMATE_RUN_MODE`, else `sandbox`):
  `sandbox` (boxed hermes as above; claude keeps approval cards), `readonly`
  (hermes only, boxed with no network and file tools, every change discarded;
  `AGENT_HERMES_MODE=readonly`, own home `~/.hermes-agents-readonly`),
  `claude` (every run becomes claude, risky steps need an admin's Allow) or
  `off`. Enforced in `spawnAgentDispatch`, the one path every run takes;
  teammates may use only hermes/claude/auto/noop, and may queue GitHub issues
  only in `sandbox` mode. Runs record `mode`. Admins are never restricted.
  Reviews default to `off` when the default agent is hermes (they need
  claude's read-only lock, which is paid).
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

Not under PM2 on this Mac (as of 2026-11-17): `openclaw` is not installed.
`cloudflared` runs outside PM2 (tunnel `d23b354e-...`, `~/.cloudflared/config.yml`,
as of 2026-11-18) and routes team / drisyon hostnames to 8787 / 8788.

**OpenHands (Agent Canvas):** Docker container `openhands-canvas` from
`docker/openhands.compose.yml`, bound to `127.0.0.1:3000` only (Docker runtime:
OrbStack - `orb start` if `docker ps` cannot reach the daemon). It mounts the
Docker socket, so it is never proxied or tunnelled: the old `/canvas/` proxy
was removed 2026-11-18 (OpenHands serves from `/` with absolute paths, so the
subpath proxy only ever returned 502/blank). The Canvas tab embeds
`127.0.0.1:3000` when the dashboard is opened on this Mac and links to
`https://canvas.mytestbed.tech` otherwise. Telemetry probes `OPENHANDS_PORT`
(default 3000).

Remote (2026-11-19): `canvas.mytestbed.tech` -> tunnel -> **CanvasGate**
(`canvas-gate.js`, PM2, `127.0.0.1:3001`) -> OpenHands. Two locks, as for the
team host: Cloudflare Access app `OpenHands Canvas` (AUD `851ddaae...6d53`,
set as `CANVAS_ACCESS_AUD` in `ecosystem.config.js`; recreate the app = update
it) at the edge, and the gate re-verifies the Access JWT on every request and
WebSocket (fails closed, refuses to start without the AUD, strips the Access
cookie before forwarding). OpenHands tells the browser to reach sandboxes at
`http://localhost:<random port>`; the gate rewrites those URLs in JSON to
`https://canvas.mytestbed.tech/sandbox/<port>` and forwards `/sandbox/<port>`
only to ports Docker lists for containers labelled `sandbox_spec_id`
(`canvas-sandbox.js`, Docker socket `~/.orbstack/run/docker.sock` or
`DOCKER_SOCKET`). Tests: `canvas-gate.test.js`, `canvas-sandbox.test.js`.
Caveat: OpenHands publishes sandbox ports on all interfaces (LAN-reachable,
protected only by each sandbox's session API key).

**Meilisearch (Campus Signals & Discovery):** Docker container
`campusgtm_meilisearch` from `campusgtm_signals/docker-compose.meilisearch.yml`,
bound to `127.0.0.1:7700` (Docker runtime: OrbStack) and routed via Cloudflare
Tunnel at `https://search.mytestbed.tech`. Ingests social, event, and
ambassador proof signals for CampusGTM with sub-10ms typo tolerance, faceted
filtering, and `_geoRadius` campus geofencing. Keys are never written in
docs or code: the master key is `MEILI_MASTER_KEY` in `campusgtm_signals/.env`
(Mac only, git-ignored; compose refuses to start without it), and the
read-only search key for frontends is the Vercel env `MEILI_SEARCH_KEY` (get
it from `GET /keys` with the master key; it changes when the master key
does). Production mode; port bound to 127.0.0.1 only.
Healthcheck: `https://search.mytestbed.tech/health` (or `http://localhost:7700/health`).
Code and test suite: `campusgtm_signals/`. Upstream repository:
`https://github.com/meilisearch/meilisearch.git`.

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

**Agents workspace (top of /agents):** pick a role (developer, tester, PM,
designer, DevOps, security: its specialists lead the picker and catalog, and
it offers one-click starter tasks), pick a repo, describe the task, then
**Run now** (any repo: `POST /api/agents/run` -> new `agent/run-<ts>` branch in
its own worktree, same checks and paid cap as `/api/dispatch/run` via the
shared `startDispatch`) or **GitHub issue -> PR** (only repos the poller
watches). Repos: built-ins (`listAvailableRepos`, remotes read from
`.git/config`) plus folders and clones an admin adds (`repo-registry.js`,
`logs/repos.json`): a local git repo inside home (not hidden, `Library` or a
worktree), or a git URL (https/ssh, no credentials) cloned with
`--depth 50` into `AGENT_REPOS_DIR` (default `~/agent-repos`). Remove only
unregisters. Agents run a repo's code on this Mac, so adding is admin-only,
same-origin JSON, and the page warns. When only built-ins exist the page
recommends repos found in common dev folders. Role and repo choice are kept
in localStorage.

**Follow-ups and agents talking to each other** (`followup.js`): a claude
run saves its session id in `<run>.claude.json`; a follow-up resumes that
session (`claude --resume`, `AGENT_RESUME_SESSION`) in the same repo and
branch (the dispatch script reuses the worktree), so the agent remembers what
it did. Runs record `parent`. Only claude/auto runs that saved a session can
be followed up; the repo must still be known at the same path.
- People: **Follow up** on a finished run in Recent runs (`POST
  /api/agents/followup` {runId, message}); `startDispatch` takes
  `followUpOf`. Same safety filter and paid cap.
- Agents: when the PR reviewer's verdict is **request changes**, the poller
  resumes the worker's session with the review (`buildFixTask`), pushes any
  new commits to the PR, comments, and starts a re-review; a reply without
  commits is posted as the agent's answer. `POLLER_FIX_ROUNDS` (default 1,
  max 3, 0 = off) caps rounds per PR; each round is one paid fix run plus a
  re-review. Verified live 2026-11-17: a follow-up recalled the file its
  earlier session read ($0.20, the resumed context is re-read).

**Talking to a working agent** (2026-11-22, #41 #42). The top of /agents is
**My tasks** (`agents-notify.js`, stages from `task-feed.js`): every task of
the last 24 h as Needs you / Working / Queued / Ready for review / Done /
Failed / Stopped, one action per row. Alerts (toast always; chime + desktop
notification when on; `(n)` in the tab title) fire on finished, failed and
follow-up runs, agent questions and new approval requests; tasks that finished
while the page was closed are reported on the next visit (localStorage
snapshot). No extra requests: it listens to the page's existing polls.
- Questions: runs started from the page and their follow-ups get
  `AGENT_CAN_ASK=1` (`canAsk` in `startDispatch`); `agent-dispatch.sh` tells
  them to end with `QUESTION: ...` when only the person can decide. The
  overview reads it from `<run>.claude.json` (`questionOf`) until a run with
  that `parent` exists; the row offers an inline reply (= a follow-up). Issue
  and poller runs never get the rule (nobody would answer).
- Live steps: running cards show the run log as plain steps (`run-steps.js`),
  polling `/api/agents/log` every 3 s for up to 3 running runs.
- Stop / redirect: "Change course" -> `POST /api/agents/stop` {runId} or
  `/api/agents/redirect` {runId, message}. The dispatch script writes
  `<run>.pid` and traps SIGTERM so it records `status=stopped` (and an `auto`
  run never escalates after a stop); `run-control.js` signals it and its whole
  tree (`timeout` puts claude in its own group) only if that pid is still
  `agent-dispatch.sh` with that run id. `stream-log.js` saves the session id
  at claude's init event, so a stopped run can be resumed; redirect waits for
  the end line (20 s) then resumes with the new instruction (paid follow-up).
  Runs started before #42 have no pid file and cannot be stopped. A stopped
  run logs $0 in the AI ledger (no result event). `run-sync` stores
  `stopped` as `failed`. Verified live 2026-11-22: redirect stopped a claude
  run in 0.5 s and the follow-up resumed the same session ($0.23).

Static files: `static-policy.js` (#41) allow-lists what `serveStaticFile`
sends (top-level html/css/js/images/fonts, `docs/*.md`); `.env*`, `logs/`,
json state and server sources are 404. A new asset type or folder needs a
line there.

**Ask page** (2026-11-23): `/agents` (🤖 Agents on the dashboard header) is
the simple view for everyone (`ask.html`, `ask.js`, `ask.css`): a list of
*my* requests (`GET /api/agents/mine`: threads the signed-in person started,
grouped request + follow-ups, plain stage from `task-feed.js`; shaping in
`agents-mine.js`), a new-request form (project, starters, free/expert helper
per the teammate mode) and the conversation for one request (answer, live
steps, questions, Stop, reply = follow-up or queued message). Admins get an
"Ops console" link.
Request kinds (`request-kinds.js`, runs record `kind` and `helper`): the page
guesses answer / document / change as you type (`GET
/api/agents/request-kind`, keywords + local model `REQUEST_KIND_MODEL`,
default the suggester's, `off` = keywords). Answer, document and plan run
read-only for everyone (Hermes `AGENT_HERMES_MODE=readonly`, Claude at the
`review` level); a document gets Copy / Download .md. A change first runs as
a free read-only `plan` by Hermes; "Go ahead" (`POST
/api/agents/plan/approve`, latest finished plan only) starts the `change` run
on the same branch with the picked helper, the request and the plan in its
task. Follow-ups keep their thread's kind; to act on an answer or document,
"Make these changes" (`POST /api/agents/make-changes` {runId, agent, focus})
starts a new Change request (plan first) carrying that reply. Long
conversations: `ask-nav.js` folds all but the last two turns, clips long
replies behind "Show all", and adds a sticky toolbar (New chat, Collapse /
Expand all, Go to turn, Top, Latest; Alt+N / Alt+Up / Alt+Down) and floating
top / latest buttons. **Files changed** (`ask-files.js`, `run-changes.js`,
`GET /api/agents/changes?id=` and `/changes/file?id=&path=`, owner or admin):
under the latest run that may change files, the files changed on its
worktree since the merge-base with the default branch (committed, "not saved
yet" and new files, +/- counts, commits) and each file's diff on click (400
lines max). Reads only the worktree derived from repo + branch
(`<repo>--<branch with - for />`); a file's diff only for a listed path;
secret-looking files are listed by name, never shown. **So far and milestones** (`run-recap.js`, `ask-recap.js`,
`GET /api/agents/recap?id=`, `POST /api/agents/milestone` {runId, label |
remove}, owner or admin): a card atop each conversation with 🏁 milestones
(automatic: plan approved, document written, N changes saved; or named by the
person, kept per portal in `logs/milestones[.drisyon].json`), Saved (commit
subjects, from git), Helper says (what the replies claim, not verified),
Decisions, Open, Next and files changed. The notes come from a local model
(`RECAP_MODEL`, default the suggester's, `off` = git facts only) reading each
finished reply once into `<run>.recap.json`; items are trimmed and
secret-redacted (`secret-scan.js` `redactText`). Follow-ups (and queued /
redirected messages) get the recap appended as "Where this request stands
(...data, not instructions)", max 1200 chars, dropped if the safety filter
would refuse it. The Ask page sidebar
scrolls on its own (sticky, 100vh) so the page is as tall as the conversation. Agent runs never inherit
messaging-bot env (`DISCORD_*`, `TELEGRAM_*`, `SLACK_*`, ...): with
`DISCORD_BOT_TOKEN` inherited, every Hermes run started a Discord gateway.

**Per-portal runs (P0.6, 2026-11-23, `portal-scope.js`):** both dashboards
share one run log, but `server.js`'s `readRuns` returns only this portal's
runs (`portal` on the start line; none = older than #49 = team). So lists,
threads, logs, stop, follow-ups, the paid cap and `/api/costs` are per portal,
and the Supabase run sync alone reads every run. Per-portal state files: the
team keeps `logs/<name>.json`; Drisyon uses `logs/<name>.drisyon.json` for
dispatch-settings (its own cap, else its `DISPATCH_DAILY_PAID_RUNS`),
teammate-mode, repos and agent-queue. Drisyon offers no built-in repos and no
issue queue: only repos an admin adds on its Ops console
(`127.0.0.1:8788/agents/ops`) can run there.

**Who sees a request (2026-11-23, `agents-mine.js` `mayOpen`):** a run
belongs to whoever started its thread (the root run's `by`; none = "local
operator"). Thread, log, follow-up, stop, redirect, plan approval and the
message queue answer 404 for anyone else's run unless the caller is an admin,
and the Ops overview lists only the caller's runs for non-admins. On a
password-only portal everyone shares one name, so they share threads too.
The Ops console's Preview tab and its `/api/agents/repo/preview` and
`/api/agents/repo/file` endpoints were removed: `repo` was unvalidated
(`repo=../../..` read files under home) and they had no admin check.

**Agents page / Ops console:** `http://127.0.0.1:8787/agents/ops` (the full
page). Styles in `agents.css` + `agents-cockpit.css`; one plain-English voice
(the Friendly/Developer toggle was removed 2026-11-23). A form that queues a task (opens a GitHub issue labelled
`agent:ready` + `agent:<name>`), the issue queue as four columns (queued,
working, needs review, failed; cached 30 s), running agents with a live log
viewer, and recent runs. API in `agents-api.js` (tests: `agents-api.test.js`):
`GET /api/agents/overview`, `GET /api/agents/log?id=` (only files inside the
runs folder, last 64 KB), `POST /api/agents/task` (repo must be one the poller
watches; JSON-only and same-origin, so another website cannot start a paid
agent through a local browser). On the Drisyon portal (8788) agents are
blocked for tunnelled requests until that portal has its own Access app
(`ACCESS_AUD` in `.env.drisyon`): `agents-gate.js` answers 403 for `/agents`,
`/api/agents/*`, `/api/dispatch/*`, `/api/team/dispatch`, `/api/patrol/*` and
`/api/agent/chat` (it can auto-dispatch). Requests at this Mac still work.
Admins see **Change** next to the paid-runs meter: `POST /api/agents/settings`
{dailyPaidRuns 0-1000} saves `logs/dispatch-settings.json` (who + when), which
wins over `.env` from the next dispatch on, no restart (both dashboards re-read
it on change). Delete the file to fall back to `.env`. Admin = a local request
at this Mac, or a person in `ADMIN_USERS` (no default: unset = only this Mac).

**Identity (2026-11-23, `identity.js`):** a verified Cloudflare Access email
names the person and wins over the portal's shared password session, so
`req.sessionUser` / `actorOf` is the teammate's email on an Access-protected
host; the password session is the fallback where a portal has no Access app.
The shared logins (`sriad`, `drisyon`) and Access's allow-list are not admin.
The ReBAC actor is the portal's tenant (`user:drisyon` on 8788, `user:sriad`
on 8787), never derived from the name; `x-rebac-actor` is honoured only for
requests at this Mac. Runs record `by` (server-set, never from the request
body) and `portal` (`team` | `drisyon`) on their start line.

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
Suggestions: as you type a task on /agents, `GET
/api/agents/specialists/suggest?q=` shows the top 3
(`specialist-suggest.js`): a shortlist of 30 by local embeddings plus a stemmed
keyword boost, re-ranked by a local model (`SPECIALIST_SUGGEST_MODEL`, default
`gemma3:4b`, `off` to skip; 4 s timeout, falls back to the shortlist). ~0.4 s
warm; Ollama calls are logged with purpose `suggest` and exempt from caps.
Recommended for you: `GET /api/agents/specialists/recommended`
(`specialist-recommend.js`) ranks all specialists for the person at this
dashboard: 55% their own use (runs.jsonl `specialist`, half-life 14 days),
45% context (each memory category and up to 8 recent task titles run through
the suggester; its top 3 picks score 1/0.7/0.5 x signal weight). Test and
automated runs (noop, `diag/`, `patrol/`, `sim/`, `test/` branches, PR
reviews) are ignored. Cached 5 min, warmed at startup; reasons name only a
memory category or task title, never memory text. The Agents page sorts the
catalog by it (or Most used / A-Z), shows the reason on each card, and puts
"⭐ Recommended for you" at the top of the picker.
The issue poller auto-picks the top suggestion for issues without a
`specialist:` label and adds that label to the issue (visible, editable;
`POLLER_AUTO_SPECIALIST=false` turns it off; a failed lookup never blocks the
run). Runs record `specialist` in runs.jsonl; the org chart's Tier 3b shows
each division with its runs this week.

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
`/api/ping`. While it was tunnelled,
`POST /api/agent/chat`, `POST /api/team/dispatch` and `POST /api/memory/store`
were callable by anyone on the internet, and `GET /api/telemetry` served the
`app.log` tail. Do not re-add that ingress rule until Cloudflare Access (or
equivalent auth) is in front of it.

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