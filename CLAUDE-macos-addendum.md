# CLAUDE.md addendum - macOS (Mac Studio / teammate node)

Draft. Items marked **[verify]** are taken from README.md and SETUP.md, not yet
checked on this machine. Confirm them before relying on them.

## Scope

The sections of CLAUDE.md above this one describe the Windows host
(`C:\tt-ai-stack`, NSSM services, LocalSystem, PowerShell). On macOS the same
code runs as a teammate node. Do not apply the NSSM, `Restart-Service`, or
`C:\` rules here.

## Runtime: PM2, not NSSM

| Process | Runs | Port |
|---|---|---|
| telemetry daemon | `telemetry-daemon.js` (Node port of the `.ps1`) **[verify which daemon PM2 runs]** | - |
| dashboard | `server.js` | 8787 (127.0.0.1 only) |
| issue poller | `orchestration/issue-poller.js` (`IssuePoller`) | - |

- Status: `pm2 ls`
- Restart one: `pm2 restart <name>`
- Logs: `pm2 logs <name>`
- Persist across reboot: `pm2 save` then `pm2 startup` **[verify]**

PM2 is the supervisor here, so the "never kill the PID" rule still applies:
use `pm2 restart`, not `kill`, because PM2 respawns the process.

## Paths

- Repo: `~/tt-ai-stack/01_projects/active/arunachala-dashboard` (README) **[verify
  against the connected folder, which is `~/fuzzy-octo-eureka`]**
- Team task file, shared context: `~/tt-ai-stack/04_internal/` (the
  `/api/tasks` route resolves relative to the repo; confirm it lands here on
  macOS, otherwise the Task Board is an empty stub)
- Do not use `C:\`, `%USERPROFILE%`, or `$env:` syntax in any command here.
- Use `~/` or `$HOME`. Use `coreutils` (`gtimeout`, `gsed`) where scripts need GNU tools.

## Ollama

- Install: `brew install ollama` or the desktop app.
- Health: `curl -s 127.0.0.1:11434/api/tags`
- The Windows watchdog (`ollama-watchdog.ps1`) does not run on macOS. Use
  launchd or a PM2 cron entry to restart Ollama if it stops **[verify: not yet
  defined in repo]**.
- Models: `gemma3:4b`, `qwen2.5-coder:3b`, `nomic-embed-text`.

## Issue queue

- Work arrives as GitHub issues labelled `agent:ready`; `IssuePoller` (PM2)
  dispatches them. See "Issue queue" in CLAUDE.md.
- Needs `GITHUB_TOKEN` in the secrets file; the branch is pushed over SSH, so
  the Mac needs a working GitHub SSH key.

## Encoding

- The `.ps1` ASCII-only rule does not apply to macOS-only scripts, but JSON
  files written by any script must be UTF-8 without BOM (`telemetry.json`,
  `history.json`). `serveJsonFile` silently returns `{}` on a BOM.

## Secrets

- `.env` stays in the repo folder and must be gitignored. Confirm with
  `git check-ignore -v .env` **[verify]**.
- Never copy the Windows host's `.env` to this machine. Each node has its own
  `OPERATOR_HOME` and `GITHUB_TOKEN`.
