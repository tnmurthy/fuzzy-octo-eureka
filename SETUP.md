# Arunachala - Team Setup

Every teammate runs their **own** install on their own Windows machine, with
their own keys and logins. What the team shares lives in one place: the
`arunachala_*` tables in the Talia Supabase project (agent runs, AI call
ledger, memory, task board) and the mytestbed Buzz relay.

| Runs on each laptop (yours) | Shared by the team |
|---|---|
| Dashboard, Buzz bridge, telemetry (3 Windows services) | Supabase `arunachala_*` tables, row-level security per team |
| Ollama + local models (routing, personas, embeddings) | Buzz relay `buzz.mytestbed.tech`, channels |
| n8n with the `buzz-dispatch` workflow | |
| Your own Claude / Codex logins and API keys | Daily caps on paid AI calls (per person + team) |

Nobody holds a Supabase service key: each person signs in as themselves, and
the database only lets them read their team's rows and write their own.

---

## Part A - Admin, once per new teammate (about 10 minutes)

1. **Supabase user.** Talia project → Authentication → Add user → their
   email + a temporary password, tick *Auto confirm*.
2. **Team membership.** SQL editor (replace the three values):

   ```sql
   insert into public.arunachala_team_members (team_id, user_id, display_name, buzz_pubkey, role)
   select 'fc4a173d-e64a-4324-b26f-4ef786427e26', id, 'Ravi', '<their 64-hex Buzz pubkey>', 'member'
   from auth.users where email = 'ravi@example.com';
   ```

3. **Buzz relay.** Add their Buzz identity, then their bot's once it exists
   (the bridge prints its npub on first start):

   ```powershell
   docker exec buzz-prod-relay-1 buzz-admin add-member --pubkey <hex> --role member
   ```

4. **Send them** (none of these are secrets): Supabase URL
   `https://onsmkbwqucvbzggugmmn.supabase.co`, the publishable key
   (`sb_publishable_...`), `TEAM_ID`, and the Buzz channel id(s).

---

## Part B - Teammate (30-60 minutes, mostly downloads)

### 1. Prerequisites

Windows 11, 12 GB RAM or more (16 recommended). In PowerShell:

```powershell
winget install OpenJS.NodeJS.LTS Git.Git NSSM.NSSM Docker.DockerDesktop Ollama.Ollama
```

Sign in to the agent CLIs you will dispatch to (`claude`, `codex`) as yourself.

### 2. Get the code and check

```powershell
git clone https://github.com/tnmurthy/fuzzy-octo-eureka.git C:\tt-ai-stack\01_projects\active\arunachala-dashboard
cd C:\tt-ai-stack\01_projects\active\arunachala-dashboard
powershell -ExecutionPolicy Bypass -File .\install-teammate.ps1 -DryRun
```

The dry run changes nothing; it lists what is missing and what it would do.

### 3. Install (elevated PowerShell)

```powershell
powershell -ExecutionPolicy Bypass -File .\install-teammate.ps1 `
  -SupabaseUrl https://onsmkbwqucvbzggugmmn.supabase.co -SupabaseKey sb_publishable_... `
  -TeamId <from admin> -BuzzChannels <from admin>
```

It pulls the local models, asks for your name, Buzz pubkey, a **unique bot
name** and your Supabase email + password (typed hidden, stored only in your
gitignored `.env`), installs the three services as LocalSystem, starts n8n on
`127.0.0.1:5678` and imports the dispatch workflow. Re-running is safe.

### 4. Finish in n8n

Open http://127.0.0.1:5678, create the owner account, open **buzz-dispatch**
and switch it to **Active**. (It polls `/api/runs` every 10 s until the run
ends, then calls the bridge's `/notify`.)

### 5. First message

In Buzz, switch to the **mytestbed** community, open your team channel, type
`@`, **pick your bot from the popup**, and send:

```
@<your bot> run noop in arunachala-dashboard: hello
```

You should get an acknowledgement with a run id, then "finished" in the same
thread. Your run also appears for the team at `/api/runs?scope=team`.

---

## Optional settings (`.env`)

| Setting | Default | Use |
|---|---|---|
| `DISPATCH_LOCAL_FIRST` | `false` | `true`: claude requests try the local agent first; claude runs only if the repo's tests fail. Repos opt in with a `.arunachala-test` file (one-line test command) or an npm test script. |
| `PERSONA_MODEL` | `gemma3:4b` | `qwen2.5:7b` only with a GPU - on CPU it is 2x slower and overruns the 45 s chat timeout. |
| `MEMORY_EMBEDDINGS` | `true` | `false` falls back to keyword memory search. |

All settings: `.env.example` and `buzz-bridge/.env.example`.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Bot never answers, nothing in `logs\buzz-bridge.out.log` | Posted in another community (e.g. drisyon-ai) or another channel | Use the mytestbed channel whose id is in `BUZZ_BOT_CHANNELS` |
| Log says `Skipped ...: bot not mentioned` | Bot name typed as text | Pick the bot from the `@` popup |
| `team-store off: missing SUPABASE_PASSWORD` in `logs\server.err.log` | Team sync not configured | Add it to `.env`, restart `ArunachalaDashboard` |
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
