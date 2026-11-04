# Arunachala Dashboard — Team Setup (Centralized Model)

This describes Option 2: the heavy infrastructure (n8n, Ollama, Buzz relay) runs
once on a shared host. Each teammate only runs a thin client that points at it.
One admin maintains the shared box; everyone else's setup is minutes, not hours.

## Roles

- **Admin (one person)** — runs the shared stack: n8n, Ollama, Buzz relay,
  the dashboard server, agent-dispatch. Owns credentials, uptime, updates.
- **Teammate** — clones this repo, points their local `buzz-bridge` config at
  the admin's shared URLs, talks to Buzz from their own machine.

---

## Part A — Admin: stand up the shared stack

Do this once, on whichever machine/server will host the shared services.
Needs to be reachable by every teammate's machine (same LAN, VPN, or a
tunnel like Cloudflare Tunnel / Tailscale if remote).

### 1. Prerequisites
- Docker Desktop (or Docker Engine) running
- Node.js 18+
- git-bash on Windows (or just bash on Linux/Mac) — `agent-dispatch.sh` needs a
  real bash, not PowerShell/cmd
- Ollama installed: https://ollama.com

### 2. Clone and configure
```bash
git clone <this-repo-url>
cd arunachala-dashboard
cp .env.example .env        # fill in real values, never commit this file
```

Key values in `.env` (admin-only, do not share these literal values):
- `PORT` — dashboard server port (default 8787)
- `AGENT_RUNS_FILE` — where run history is recorded (default `logs/runs.jsonl`)
- Buzz relay token/identity
- n8n basic-auth / owner credentials (set on first n8n login, not in `.env`)

### 3. Start Ollama and pull models
```bash
ollama serve &
ollama pull gemma3:4b
ollama pull qwen3.5
```
Confirm it's reachable from other machines if hosting remotely — bind to
`0.0.0.0` instead of `127.0.0.1` and open port 11434 on the firewall if needed.

### 4. Start n8n
```bash
cd n8n
docker compose up -d
```
Visit `http://<admin-host>:5678`, create the owner account, then generate an
API key (Settings → API). Import `buzz-dispatch-workflow.json` and activate it.
Update the workflow's HTTP Request nodes if the dashboard isn't on the same
host as n8n — replace `host.docker.internal:8787` with the dashboard's real
reachable address.

### 5. Start the dashboard + bridge
```bash
cd arunachala-dashboard
node server.js          # or install as a Windows service (NSSM) / systemd unit
cd buzz-bridge
node bridge.js
```
For production, register these as services so they survive reboots:
- Windows: NSSM (`nssm install ArunachalaDashboard ...`)
- Linux: systemd unit files

### 6. Expose to the team
Decide how teammates reach the admin host:
- Same LAN: share the admin machine's local IP (e.g. `192.168.1.50`)
- Remote: set up a Cloudflare Tunnel or Tailscale and share that hostname

Write down three URLs you'll hand to every teammate:
- `BUZZ_RELAY_URL` (port 3000)
- `N8N_WEBHOOK_URL` (e.g. `http://<admin-host>:5678/webhook/buzz-dispatch`)
- `OLLAMA_URL` (port 11434) — only needed if teammates run their own
  bridge instance that calls the shared model directly

---

## Part B — Teammate: connect to the shared stack

Each teammate does this on their own machine. No Docker, no Ollama, no n8n
required locally — just Node and git.

### 1. Prerequisites
- Node.js 18+
- git

### 2. Clone
```bash
git clone <this-repo-url>
cd arunachala-dashboard/buzz-bridge
cp .env.example .env
```

### 3. Fill in `.env` with the admin's shared URLs
```
BUZZ_RELAY_URL=<from admin>
N8N_WEBHOOK_URL=<from admin>
OLLAMA_URL=<from admin>           # if bridge calls the model directly
BRIDGE_NOTIFY_PORT=3100           # local port the bridge listens on for n8n callbacks
```
Ask the admin for your own Buzz identity/token — never reuse someone else's.

### 4. Run the bridge
```bash
node bridge.js
```
This is the only process a teammate needs running locally. It connects
to the shared Buzz relay, forwards your messages, and receives notify
callbacks from the shared n8n instance when a dispatched agent finishes.

### 5. Verify
- Send a message to Buzz. You should get a response within ~60s (or the
  fallback message if the model is slow/unavailable).
- Ask Buzz to do something that triggers a dispatch (e.g. "check the repo
  status"). You should get a follow-up message once the agent run completes —
  this confirms the notify callback reached your machine.

If step 5 doesn't respond at all: check `BUZZ_RELAY_URL` is reachable
(`curl <BUZZ_RELAY_URL>/health` or similar) and that your bridge process is
actually running, not crashed on startup.

---

## Notes / known gotchas

- **Windows path handling**: `agent-dispatch.sh` uses `git -C <path>` with
  native Windows paths, not MSYS `/c/...` paths. If you see git errors about
  "cannot change to" a directory, check the path format being passed.
- **Credentials never go in git**: `.env`, n8n API keys, Buzz tokens are all
  gitignored. If you accidentally commit one, rotate it immediately.
- **One shared n8n/Ollama instance means one point of failure.** If the admin's
  box goes down, dispatch and the local model stop working for everyone.
  Acceptable for a small team; revisit if this becomes business-critical.
- **Scaling note**: if more than a handful of people start dispatching agents
  concurrently, watch Ollama's queue — one shared GPU/CPU serves everyone's
  requests serially-ish. Consider a beefier host or per-team-sharding if it
  becomes a bottleneck.
