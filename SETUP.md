# Arunachala - Team Setup

Every teammate runs their **own** install on their own Windows machine, with
their own keys and logins. What the team shares lives in one place: the
`arunachala_*` tables in the Talia Supabase project (agent runs, AI call
ledger, memory, task board) and the GitHub repos whose issues feed the agents.

| Runs on each laptop (yours) | Shared by the team |
|---|---|
| Dashboard, issue poller, telemetry | Supabase `arunachala_*` tables, row-level security per team |
| Ollama + local models (personas, embeddings) | GitHub issues labelled `agent:ready`, and the PRs agents open |
| Your own Claude / Codex logins and API keys | Daily caps on paid AI calls (per person + team) |

Nobody holds a Supabase service key: each person signs in as themselves, and
the database only lets them read their team's rows and write their own.

---

## Part A - Admin, once per new teammate (about 10 minutes)

1. **Supabase user.** Talia organisation → Talia project → Authentication →
   Users → **Add user** → *Create new user*. Use their address with a
   `+arunachala` alias (`ravi+arunachala@example.com`; mail still reaches
   their inbox), set the password yourself, tick **Auto Confirm User**, and
   give them the password privately.
   - Why a separate login: other apps share the Talia project, and Talia's
     password-recovery emails link to those apps - so recovery cannot be
     used to set an Arunachala password. A dashboard-created user needs no
     email at all.
2. **Team membership.** SQL editor (replace the three values):

   ```sql
   insert into public.arunachala_team_members (team_id, user_id, display_name, role)
   select 'fc4a173d-e64a-4324-b26f-4ef786427e26', id, 'Ravi', 'member'
   from auth.users where email = 'ravi+arunachala@example.com';
   ```

3. **GitHub.** The poller only runs issues opened by `POLLER_AUTHORS` (default:
   the repo owner). Add the teammate's login there if their issues should run,
   and make sure the machine's `GITHUB_TOKEN` (fine-grained; Issues + Pull
   requests read/write) can reach the repo.

4. **Send them** (none of these are secrets): Supabase URL
   `https://onsmkbwqucvbzggugmmn.supabase.co`, the publishable key
   (`sb_publishable_...`) and `TEAM_ID`.

---

## Part B - Teammate (30-60 minutes, mostly downloads)

### 1. Prerequisites

- **Windows 11**: 12 GB RAM or more (16 recommended). In PowerShell:
  ```powershell
  winget install OpenJS.NodeJS.LTS Git.Git NSSM.NSSM Docker.DockerDesktop Ollama.Ollama
  ```
- **macOS (Mac Studio / Apple Silicon)**: macOS 13+ with Homebrew:
  ```bash
  brew install node@22 git ollama coreutils
  brew install --cask orbstack   # or docker
  npm install -g pm2
  ```

Sign in to the agent CLIs you will dispatch to (`claude`, `codex`) as yourself.

### 2. Get the code and check

**Windows:**
```powershell
git clone https://github.com/tnmurthy/fuzzy-octo-eureka.git C:\tt-ai-stack\01_projects\active\arunachala-dashboard
cd C:\tt-ai-stack\01_projects\active\arunachala-dashboard
powershell -ExecutionPolicy Bypass -File .\install-teammate.ps1 -DryRun
```

**macOS (Mac Studio):**
```bash
git clone https://github.com/tnmurthy/fuzzy-octo-eureka.git ~/tt-ai-stack/01_projects/active/arunachala-dashboard
cd ~/tt-ai-stack/01_projects/active/arunachala-dashboard
chmod +x install-teammate.sh
./install-teammate.sh --dry-run
```

The dry run changes nothing; it lists what is missing and what it would do.

### 3. Install

**Windows (elevated PowerShell):**
```powershell
powershell -ExecutionPolicy Bypass -File .\install-teammate.ps1 `
  -SupabaseUrl https://onsmkbwqucvbzggugmmn.supabase.co -SupabaseKey sb_publishable_... `
  -TeamId <from admin>
```

(`install-teammate.ps1` still asks for Buzz values from before the Buzz
integration was removed; it needs updating. Ignore those prompts or enter a
placeholder.)

**macOS (Terminal):**
```bash
./install-teammate.sh \
  --supabase-url https://onsmkbwqucvbzggugmmn.supabase.co \
  --supabase-key sb_publishable_... \
  --team-id <from admin>
```

It pulls the local models, asks for your name and your Supabase
`+arunachala` email + password, and installs the background services (NSSM as
LocalSystem on Windows, PM2 on macOS). Re-running is safe.

The password is typed hidden and saved to
`04_internal/secrets/arunachala-team.env`
(`SUPABASE_PASSWORD=...`), never the project folder; `.env` only names that
file in `SECRETS_ENV_FILE`. To change it later, edit that one line and
restart `ArunachalaDashboard`.

### 4. Give the poller a GitHub token

Put a fine-grained `GITHUB_TOKEN` (Issues + Pull requests read/write) in the
same secrets file as the Supabase password, then restart `IssuePoller`
(`pm2 restart IssuePoller --update-env`). Without it the poller idles and logs
once an hour.

### 5. First issue

Open an issue in a watched repo, add the label `agent:ready` and the label
`agent:noop`, and wait up to a minute. The poller relabels it `agent:running`,
runs the agent in its own worktree and finishes with `agent:no-changes` (the
`noop` agent changes nothing). Your run also appears at
`/api/runs?scope=team`. For real work use `agent:claude` (the default),
`agent:hermes` (docs and drafts), `agent:codex` or `agent:auto`: the result is
a PR that closes the issue, labelled `agent:review`.

---

## Optional settings (`.env`)

| Setting | Default | Use |
|---|---|---|
| `DISPATCH_LOCAL_FIRST` | `false` | `true`: claude requests try the local agent first; claude runs only if the repo's tests fail. Repos opt in with a `.arunachala-test` file (one-line test command) or an npm test script. |
| `PERSONA_MODEL` | `gemma3:4b` | `qwen2.5:7b` only with a GPU - on CPU it is 2x slower and overruns the 45 s chat timeout. |
| `MEMORY_EMBEDDINGS` | `true` | `false` falls back to keyword memory search. |

All settings: `.env.example` (including the `POLLER_*` ones).

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Labelled issue is never picked up | No `GITHUB_TOKEN`, issue author not in `POLLER_AUTHORS`, or the repo is not watched | `pm2 logs IssuePoller`; fix the token, authors or `POLLER_REPOS` |
| Issue gets `agent:failed` | The run failed, timed out or never recorded | The comment names the log path; the worktree is kept for inspection |
| Issue text is refused | The safety filter blocked it | Review it, then add `agent:confirmed` |
| `team-store off: missing SUPABASE_PASSWORD` in `logs\server.err.log` | Team sync not configured | Put `SUPABASE_PASSWORD=...` in `04_internal\secrets\arunachala-team.env`, check `.env` has `SECRETS_ENV_FILE` pointing at it, restart `ArunachalaDashboard` |
| `team-store ... sign-in failed (400): Invalid login credentials` | Wrong password, or the Talia database password used by mistake | Admin sets a new password on the `+arunachala` user (Users → the user → edit, or delete and re-add); update the secrets file; restart |
| `secrets file not loaded: <path>` | `SECRETS_ENV_FILE` points at a missing file | Create it or fix the path in `.env` |
| Dispatch accepted but no run in the Agent Runs tab | The script failed silently (detached) | Check `04_internal\agent-runs\<run id>.log`; usually a missing CLI login |
| Service will not start after switching it to your account | Windows Hello-only sign-in rejects the password | Keep LocalSystem; `OPERATOR_HOME` gives agents your profile |
| Agent CLIs not found in a run | Installed outside `%APPDATA%\npm` (claude) or `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin` (codex) | Reinstall to the default location - those are the folders the dispatch adds to `PATH` |

## Costs and limits

- Local calls (routing, personas, embeddings) are free and logged with
  `provider = ollama`; they never count towards caps.
- Paid calls are capped per person (200/day) and per team (1000/day) in the
  database (`arunachala_ai_limits`, owners can change them).
- Every call - local or paid - is in `arunachala_ai_calls`: tokens, time,
  purpose. Look there before deciding what to optimise.
