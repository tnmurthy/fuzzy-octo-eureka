# Arunachala Operations Center

Run a small team's AI workforce from GitHub issues. Each teammate runs Arunachala on
their own machine: a dashboard, an issue poller, local models and a
dispatcher that hands coding tasks to agents (Claude, Codex, Hermes). The team
shares its context - agent runs, AI call ledger, memory, task board - through
Supabase. Local models do the routine work; frontier models run only when a
task needs them, inside daily caps.

| Document | For |
|---|---|
| [SETUP.md](SETUP.md) | Step-by-step install, admin and teammate |
| [docs/USER_GUIDE.md](docs/USER_GUIDE.md) | Using it day to day, and how each part works |
| [docs/HLD.md](docs/HLD.md) | High-level design: components, flows, data model, security, costs |
| [docs/FRD.md](docs/FRD.md) | Functional requirements, acceptance criteria and status |
| [CLAUDE.md](CLAUDE.md) | Operating notes for agents working on this repo |

**Contents:** [At a glance](#at-a-glance) · [Onboarding](#1-onboarding) ·
[Setup](#2-setup-and-configuration) · [Infrastructure](#3-infrastructure) ·
[Using it](#4-using-it) · [Costs](#5-costs-and-tokens) ·
[Operations](#6-operations) · [Development](#7-development) ·
[Security](#8-security)

---

## At a glance

```mermaid
flowchart LR
    OP["You: GitHub issue<br/>label agent:ready"] --> P["IssuePoller<br/>every 60 s"]
    P -- "dispatch" --> D["Dashboard<br/>:8787"]
    D --> AG["Agent run<br/>own worktree"]
    AG --> LOG[(runs.jsonl)]
    P -- "push branch, open PR" --> OP
    D <-- "sync as you, RLS" --> SB[("Supabase<br/>team context")]
    D --> OL["Ollama<br/>local models"]
```

1. You open a GitHub issue and label it `agent:ready`. The poller relabels it
   `agent:running`.
2. The poller branches `agent/issue-<n>-<ts>` from the default branch and
   dispatches an agent in its own git worktree, with the team's relevant
   memories added to its prompt.
3. The agent commits on its branch. The poller pushes it and opens a PR that
   `Closes #n` (`agent:review`). A second, read-only agent run reviews the PR
   and posts its verdict as a comment. No commits: `agent:no-changes`. Failed
   or timed out: `agent:failed`.
4. Runs, AI calls and memory are written locally first and copied to the
   team's Supabase tables every 30 seconds.

---

## 1. Onboarding

### 1.1 Admin - add a teammate (about 10 minutes)

| Step | Where | What |
|---|---|---|
| 1 | Supabase → **Talia** org → **Talia** project → Authentication → Users → **Add user** → *Create new user* | Email: their address with a `+arunachala` alias (e.g. `ravi+arunachala@example.com` - mail still reaches their inbox). Set a password, tick **Auto Confirm User**. Give them the password privately. |
| 2 | Supabase SQL editor | Add them to the team (SQL below). |
| 3 | Send them | Supabase URL, publishable key (`sb_publishable_...`) and `TEAM_ID`. None of these are secrets. |

```sql
insert into public.arunachala_team_members (team_id, user_id, display_name, role)
select 'fc4a173d-e64a-4324-b26f-4ef786427e26', id, 'Ravi', 'member'
from auth.users where email = 'ravi+arunachala@example.com';
```

Why a separate `+arunachala` login: it keeps Arunachala apart from the other
apps that share the Talia project, and a dashboard-created user needs no
recovery email (Talia's recovery emails point at other apps).

### 1.2 Teammate - install (30-60 minutes, mostly downloads)

**Windows:**
```powershell
winget install OpenJS.NodeJS.LTS Git.Git NSSM.NSSM Docker.DockerDesktop Ollama.Ollama
git clone https://github.com/tnmurthy/fuzzy-octo-eureka.git C:\tt-ai-stack\01_projects\active\arunachala-dashboard
cd C:\tt-ai-stack\01_projects\active\arunachala-dashboard
powershell -ExecutionPolicy Bypass -File .\install-teammate.ps1 -DryRun   # checks, changes nothing
powershell -ExecutionPolicy Bypass -File .\install-teammate.ps1           # elevated: installs
```

**macOS (Mac Studio / Apple Silicon):**
```bash
brew install node@22 git ollama coreutils
brew install --cask orbstack   # or docker
npm install -g pm2
git clone https://github.com/tnmurthy/fuzzy-octo-eureka.git ~/tt-ai-stack/01_projects/active/arunachala-dashboard
cd ~/tt-ai-stack/01_projects/active/arunachala-dashboard
chmod +x install-teammate.sh
./install-teammate.sh --dry-run                                         # check, changes nothing
./install-teammate.sh                                                   # interactive install
```

The installer pulls the local models, asks for your name and your Supabase
login, and installs background services (NSSM on Windows, PM2 on macOS). The
Windows installer script still contains Buzz steps from before #29; ignore
them. Then:

1. Put a fine-grained `GITHUB_TOKEN` (Issues + Pull requests read/write) in
   the secrets file. Without it the poller idles.
2. Open an issue in your repo, label it `agent:ready`, and wait for the PR.

Full walkthrough and troubleshooting: [SETUP.md](SETUP.md).

---

## 2. Setup and configuration

Everything personal is in one gitignored `.env` file plus one secrets file - no
personal value is in the code.

| File | Holds | Required |
|---|---|---|
| `.env` (from `.env.example`) | `OPERATOR_NAME`, `OPERATOR_HOME`, Supabase URL / publishable key / email, `TEAM_ID`, `SECRETS_ENV_FILE` | `OPERATOR_HOME` |
| `04_internal\secrets\arunachala-team.env` | `SUPABASE_PASSWORD` (team sync) and `GITHUB_TOKEN` (issue queue) - named by `SECRETS_ENV_FILE` in `.env` | for team sync / issue queue |

Team sync is on only when all five Supabase settings resolve (URL, key,
email, password, `TEAM_ID`); otherwise the install runs solo on local files.

| Optional setting | Default | Effect |
|---|---|---|
| `DISPATCH_LOCAL_FIRST` | `false` | `true`: claude requests try the local agent first; claude only if the repo's tests fail |
| `CLAUDE_MODEL` / `CLAUDE_MAX_TURNS` / `CLAUDE_LEAN` | `sonnet` / `40` / `true` | Model, turn cap and lean context for dispatched claude runs |
| `DISPATCH_MEMORY_CONTEXT` | `true` | Add the 3 most relevant team memories to each dispatch prompt |
| `PERSONA_MODEL` | `gemma3:4b` | Persona chat model; `qwen2.5:7b` only with a GPU |
| `MEMORY_EMBEDDINGS` | `true` | Memory search by meaning; `false` = keywords |
| `POLLER_REPOS` / `POLLER_AUTHORS` | see `.env.example` | Repos the poller watches; only issues opened by these authors run (default: the repo owner) |
| `POLLER_MAX_CONCURRENT` | `2` | Runs at once across all repos (reviews count) |
| `POLLER_DEFAULT_AGENT` | `claude` | Agent when the issue has no `agent:*` label |
| `POLLER_REVIEW_AGENT` | `claude` | `claude`, `noop` or `off`: the read-only review run on each PR |

All settings with comments: `.env.example`.

---

## 3. Infrastructure

**On each teammate's machine**

| Component | Runs as | Port | Role |
|---|---|---|---|
| `ArunachalaDashboard` | NSSM service, LocalSystem | 127.0.0.1:8787 | UI, API, dispatch, persona chat, team sync, memory search |
| `IssuePoller` | PM2 | - | Watches GitHub for `agent:ready` issues, dispatches runs, opens PRs |
| `ArunachalaTelemetry` | NSSM service, LocalSystem | - | Health probes and snapshots |
| Ollama | User app + watchdog task | 11434 | `gemma3:4b`, `qwen2.5-coder:3b`, `nomic-embed-text` |
| Agent runs | git-bash, one per run | - | `orchestration/agent-dispatch.sh`, own worktree per run |

**Shared by the team**

| Service | Where | Role |
|---|---|---|
| Supabase | **Talia** project (`onsmkbwqucvbzggugmmn`) | `arunachala_*` tables: team, members, runs, AI calls, limits, memory, tasks - row-level security per team |
| GitHub | The repos you label issues in | The work queue: issues in, branches and PRs out |
| Cloudflare | Tunnel + Access | `team.mytestbed.tech` (dashboard, owner only) |

Why LocalSystem: a service logon as the user fails with Windows Hello-only
sign-in; `OPERATOR_HOME` gives agent runs the user's profile and CLI logins.
Design detail and diagrams: [docs/HLD.md](docs/HLD.md).

---

## 4. Using it

| You want to | Do this |
|---|---|
| Check that everything is up | Dashboard, or `pm2 ls` |
| Ask a persona | Dashboard persona chat (`POST /api/agent/chat`) |
| Get code written | Open a GitHub issue, label it `agent:ready` (add `agent:claude`, `agent:hermes`, `agent:codex`, `agent:noop` or `agent:auto` to pick the agent) - a PR that closes it appears when done |
| See runs | Dashboard → **Agent Runs**, or `/api/runs?scope=team` |
| Plan work | Dashboard → **Kanban Board** (team board; create/move via `POST`/`PATCH /api/tasks`) |
| Find what the team knows | `/api/memory/search?q=...&scope=team` (ranked by meaning) |
| See what AI costs | Dashboard → **Costs** |

| Agent | Use it for |
|---|---|
| `claude` | Real code changes, migrations, security-relevant work |
| `codex` | A second builder on an independent task |
| `hermes` | Local, offline: drafts, summaries, small edits |
| `agy` | Read-only review (plan mode; name the files in the prompt) |
| `auto` | Local first, claude only if the repo's tests fail (repos with `npm test` or a `.arunachala-test` file) |
| `noop` | Testing the pipeline |

Details: [docs/USER_GUIDE.md](docs/USER_GUIDE.md).

---

## 5. Costs and tokens

| Lever | Effect (measured on a CPU-only i7) |
|---|---|
| Local routing, personas, embeddings | No per-token cost for the high-volume calls |
| Lean dispatch (`CLAUDE_LEAN`) | Context loaded per claude run 64k → 39k tokens (32k after trimming duplicate global rules) |
| `CLAUDE_MODEL=sonnet`, `CLAUDE_MAX_TURNS=40` | Routine runs off the most expensive model; no runaway runs |
| `auto` local-first | Claude runs only when the local attempt fails the repo's tests |
| Ledger | Every call (local and paid) with tokens, time and cost in `arunachala_ai_calls`; the Costs tab and weekly digest read it |
| Caps | Paid calls stop at 200/person and 1000/team per day, enforced by the database |

---

## 6. Operations

| Task | Command |
|---|---|
| Restart after a code or `.env` change | `pm2 restart all --update-env && pm2 save` (Windows: `Restart-Service ArunachalaDashboard -Force`, elevated) |
| Issue not picked up? | `pm2 logs IssuePoller`; check the label, the author is in `POLLER_AUTHORS`, and `GITHUB_TOKEN` is set. Failed runs get `agent:failed` with the log path; the worktree is kept |
| Team sync failing? | `logs\server.err.log`: `team-store ... failed` names the reason (e.g. `invalid_credentials`) |
| A run's full output | `C:\tt-ai-stack\04_internal\agent-runs\<run id>.log` |
| Check an install | `.\install-teammate.ps1 -DryRun` |
| Seed the task board from `TASKS.md` | `node scripts/import-tasks.js` then `--apply` |

**Never kill the services' node PIDs** - NSSM restarts them and leaves
duplicates; restart the service instead. More symptoms: the troubleshooting
table in [SETUP.md](SETUP.md).

**Local database lock.** Every project's local Supabase stack is one shared
database; wrap resets and test suites so two agents don't collide:
`orchestration/db-lock.sh supabase db reset`, `orchestration/db-lock.sh npm test`
(lock `~/.agent-locks/supabase-local.lock`, waits up to `DB_LOCK_WAIT`
1800 s, breaks locks older than `DB_LOCK_STALE` 3600 s).

---

## 7. Development

| Path | What |
|---|---|
| `server.js` | Dashboard server (zero npm dependencies) |
| `index.html`, `dashboard.js`, `dashboard.css`, `team.html` | UI: Dashboard, Kanban, Agents, Infrastructure, Logs, Agent Runs, Costs |
| `telemetry-daemon.ps1` | Health probes and snapshots |
| `orchestration/` | `issue-poller.js` (GitHub issue queue), `agent-dispatch.sh` (worktrees, `auto`, claude usage), `db-lock.sh`, `runlog.mjs`, `claude-usage.mjs` |
| `team-store/` | Supabase sync: session, REST, runs, ledger, memory, tasks, costs |
| `memory-*.js`, `embeddings.js`, `dispatch-context.js`, `digest.js`, `load-env.js` | Memory, search, prompt context, digest, settings |
| `supabase/` | Migrations for `arunachala_*` and their DB checks |
| `n8n/`, `scripts/`, `install-teammate.ps1`, `docs/` | Workflow, one-off scripts, installer, documentation |

| Check | Command |
|---|---|
| All Node tests | `npm test` |
| Shared-table security checks (Docker) | `bash supabase/tests/run-local.sh` |
| A second copy for testing | `PORT=8799 node server.js` |

Work on a branch, open a PR to `main`; CI runs `npm test` and checks the
PowerShell scripts parse and stay ASCII. Commits follow Conventional Commits.

---

## 8. Security

- Secrets live only in gitignored `.env` files and `04_internal\secrets`; the
  Supabase key in `.env` is the publishable one.
- Each person signs in to Supabase as themselves; row-level security limits
  them to their team. Never put a `service_role` key on a laptop.
- The dashboard binds to 127.0.0.1; the public hostname sits behind
  Cloudflare Access plus an origin JWT check.
- Only issues opened by `POLLER_AUTHORS` run; text the safety filter refuses
  needs `agent:confirmed`. Agents commit; the poller pushes the branch and
  opens the PR, and nothing merges to `main` without review.
- `apis.txt` (an old plaintext key file) is excluded in `.gitignore` as a
  guard rail - check `git status` before your first commit.
