# Arunachala - User Guide

How to use Arunachala day to day, and what happens behind each action.
Install first: [`SETUP.md`](../SETUP.md). Design: [`HLD.md`](HLD.md).
Requirements: [`FRD.md`](FRD.md).

---

## 1. What you can do

| You want to | Do this | What answers |
|---|---|---|
| Check that everything is up | Ask your bot in Buzz: `@<bot> is everything up?` | Status built from telemetry - no model call |
| See what agents did today | `@<bot> what did the team run today?`, or the **Agent Runs** tab | Run history |
| Think a problem through | `@<bot> ask the tech lead: should we cache this?` | A persona on a local model |
| Get code written | `@<bot> run claude in <repo>: <task>` | An agent in its own worktree; reply when done |
| Plan work with the team | The task board (API today, see §5) | Shared board in Supabase |
| Find something the team knows | `/api/memory/search?q=...&scope=team` | Memory ranked by meaning |
| See what AI is costing | The ledger (§7) | Every call: model, tokens, time |

---

## 2. Talking to your bot in Buzz

1. Open the Buzz desktop app and switch to the **mytestbed** community.
2. Open your team channel (its id is `BUZZ_BOT_CHANNELS` in `buzz-bridge/.env`).
3. Type `@`, **pick your bot from the popup**, then write your message.

Typing the name as plain text does not create a mention, and the bot ignores
the message (the bridge log shows `Skipped ...: bot not mentioned`). Messages
in another community, such as drisyon-ai, never reach your bot.

**Example messages**

```
@Ravi's Team is everything up?
@Ravi's Team which runs failed today?
@Ravi's Team ask QA how we should test the sync code
@Ravi's Team run noop in arunachala-dashboard: hello
@Ravi's Team run claude in bov: add a unit test for the price formatter
```

**What happens to a message**

```mermaid
flowchart LR
    M[Your message] --> F{"From you,<br/>bot mentioned?"}
    F -- no --> I["Ignored<br/>(logged if it was you)"]
    F -- yes --> R["Local router<br/>decides the kind"]
    R --> S["status: instant reply"]
    R --> P["persona: local model reply,<br/>about 10-40 s"]
    R --> D["dispatch: ack now,<br/>result in thread later"]
    R --> X["risky dispatch / add task:<br/>described, not run yet"]
```

The bot only obeys the Buzz keys in your `BUZZ_OPERATORS`. Each teammate has
their own bot with a unique name, so mention yours.

---

## 3. Dispatching an agent

A dispatch hands one task to one agent. You get an acknowledgement with a run
id at once, and the result in the same thread when the run ends.

| Agent | Runs | Use it for |
|---|---|---|
| `claude` | Claude Code, your login | Real code changes, migrations, security-relevant work |
| `codex` | OpenAI Codex, your login | A second builder on an independent task |
| `hermes` | Local model, offline | Drafts, summaries, small private edits |
| `agy` | Antigravity, plan mode | Read-only review (name the files in the prompt) |
| `noop` | Echoes the prompt | Testing the pipeline |
| `auto` | Local first, claude if tests fail | Saving tokens on small tasks (§4) |

**What the agent may do:** work only in its own git worktree beside the repo
(`<repo>--<branch>`), commit on its branch, never push or merge. You review
and merge. Runs time out after one hour (`AGENT_TIMEOUT`).

**Where to look**

| What | Where |
|---|---|
| Run list | Dashboard → **Agent Runs**, or `/api/runs` (`?scope=team` for everyone) |
| Full agent output | `04_internal\agent-runs\<run id>.log` |
| The agent's work | The worktree folder and its branch |

**Dispatch without Buzz** (same pipeline):

```powershell
Invoke-RestMethod -Method Post http://127.0.0.1:5678/webhook/buzz-dispatch -ContentType application/json `
  -Body '{"agent":"noop","repo":"arunachala-dashboard","task":"hello"}'
```

---

## 4. Saving tokens: local first

Turn on `DISPATCH_LOCAL_FIRST=true` in `.env` and restart
`ArunachalaDashboard`. Every `claude` dispatch then runs as `auto`:

1. The local agent (hermes) tries the task.
2. The repo's own tests decide: the one-line command in `.arunachala-test` at
   the repo root, else `npm test` if `package.json` has a test script.
3. Tests pass: done, no frontier tokens spent. Tests fail, the local agent
   fails, or the repo has no tests: the worktree is reset and claude runs.

To opt a repo in, commit a `.arunachala-test` file, for example:

```
npm test -- --run
```

The run record says whether it escalated (`escalated: true/false`), so the
team can see how often local was enough.

---

## 5. The shared task board

When team sync is on, the **Kanban Board** tab shows the team's board from
Supabase; otherwise it shows `04_internal/TASKS.md` (read-only). Creating and
moving tasks is API-only for now:

```powershell
# create (status: backlog | in_progress | done; project and link optional)
Invoke-RestMethod -Method Post http://127.0.0.1:8787/api/tasks -ContentType application/json `
  -Body '{"title":"Write the onboarding video","project":"docs"}'

# move
Invoke-RestMethod -Method Patch http://127.0.0.1:8787/api/tasks/<task id> -ContentType application/json `
  -Body '{"status":"in_progress"}'
```

Seed the board once from `TASKS.md`: `node scripts/import-tasks.js` (preview),
then `node scripts/import-tasks.js --apply`. Already-present titles are skipped.

---

## 6. Team memory

Anything stored in memory (directives, notes, `POST /api/memory/store`) syncs
to the team within 30 seconds. Search ranks by meaning, not keywords:

```
http://127.0.0.1:8787/api/memory/search?q=how do we deploy&scope=team
```

The response's `ranker` is `embeddings` normally, or `keywords` if Ollama is
down. Leave out `scope=team` to search only your machine.

---

## 7. Costs

Every model call is written to `logs/ai-calls.jsonl` and synced to
`arunachala_ai_calls`. Local calls (`provider = ollama`) are free and never
count towards the caps; paid calls stop at 200 per person and 1000 per team
per day (owners change `arunachala_ai_limits`).

Useful queries (Supabase SQL editor):

```sql
-- this week by person, provider and purpose
select m.display_name, c.provider, c.purpose, count(*) calls,
       sum(c.input_tokens + c.output_tokens) tokens
from arunachala_ai_calls c
join arunachala_team_members m on m.user_id = c.owner and m.team_id = c.team_id
where c.created_at > now() - interval '7 days'
group by 1, 2, 3 order by tokens desc;

-- how often local-first was enough
select escalated, count(*) from arunachala_agent_runs where agent = 'auto' group by 1;
```

---

## 8. How it all works

**Your machine runs three services** (`ArunachalaTelemetry`,
`ArunachalaDashboard`, `ArunachalaBuzzBridge`), plus Ollama and n8n:

- The **telemetry service** checks every few seconds that Ollama, OpenClaw,
  Buzz and Watchtower answer, and writes a snapshot the dashboard reads.
- The **dashboard** (http://127.0.0.1:8787) serves the UI and the API, starts
  agent runs, answers persona chats on a local model, searches memory, and
  copies your runs, AI calls and memory to the team every 30 seconds.
- The **bridge** is your bot on the Buzz relay. A local model reads each
  message you send it and decides what kind it is; the bridge then answers,
  asks a persona, or starts a dispatch through n8n.
- **n8n** starts the run, checks every 10 seconds whether it has finished, and
  tells the bridge, which replies in your thread.

**Your files stay the source of truth.** Runs, AI calls and memory are written
locally first and copied up afterwards, so nothing is lost when the internet
or Supabase is down; the copy catches up on the next tick.

**The team sees what you share, nothing else.** You sign in to Supabase as
yourself. The database lets you read your team's rows and change only your
own (tasks are the exception: anyone moves any task).

---

## 9. Everyday operations

| Task | Command (elevated PowerShell where noted) |
|---|---|
| Restart everything | `Restart-Service ArunachalaDashboard -Force; Start-Service ArunachalaBuzzBridge` (elevated) |
| Did a setting change apply? | Restart `ArunachalaDashboard` - it reads `.env` at start |
| Bot silent? | `Get-Content logs\buzz-bridge.out.log -Tail 20` |
| Team sync working? | `logs\server.err.log` - `team-store ... failed` lines; silence means fine |
| Check the install | `.\install-teammate.ps1 -DryRun` |

More symptoms and fixes: the troubleshooting table in [`SETUP.md`](../SETUP.md).
