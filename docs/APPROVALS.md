# Approval levels and approval cards

Patterns borrowed from [OpenMausBot](https://github.com/milind-soni/OpenMausBot) (Apache-2.0):
its permission broker, approval levels, delegated approval and "Always allow" list. Rewritten here;
no code copied.

## What changed for a run

Before: every claude run had one fixed allow-list. Anything outside it was refused, and a headless
run could not ask, so the task failed or worked around the refusal.

Now each run has a **level**, and anything the level does not pre-allow becomes an **Allow / Deny
card** at the top of `/agents` ("Tasks in Progress"). Nobody answering = **deny** at the deadline
(`APPROVAL_TIMEOUT_MS`, default 10 min); the run carries on without that action.

| Level | Allowed without asking | Asked |
|---|---|---|
| `review` | Read, Glob, Grep (exact names; no shell, no edits, no web) | nothing, never waits |
| `ask` | Read, Glob, Grep | every edit and command |
| `edits` | Read, Edit, Write, Glob, Grep | every command |
| `auto` (default) | edits + git, npm, npx, node, supabase, ls, cat, db-lock.sh | the rest |

`git push` and `gh` are denied at every level: the poller pushes and opens PRs. There is no
"full access" level on purpose.

- **Choosing a level:** the "How much it may do without asking" picker on the Run now form, or
  `level` in `POST /api/agents/run` / `/api/agents/followup` / `/api/dispatch/run`.
  `DISPATCH_DEFAULT_LEVEL` sets the default (`auto`).
- **Follow-ups and fix rounds** never get a higher level than the run they continue (the parent's
  `level` in `runs.jsonl`). A level only flows down.
- **PR reviews** always run at `review`. The dispatch writes the diff against the base to
  `.arunachala-review.diff` in the worktree (excluded from git), so the reviewer needs no shell.

## The cards

- **Allow once**, **Always allow this exact action**, **Deny**. Admins only (local at this Mac, or
  `ADMIN_USERS`); decisions are same-site JSON.
- "Always allow" remembers the **exact** action per repo (the command string, the file path, the
  URL), never a prefix: allowing `npm test` does not allow `npm test; rm -rf ~`. Stored in
  `logs/always-allow.json`, at most 200 per repo. Past that a grant is **refused, not dropped**: the
  card stays waiting and says why. Remove a key with `POST /api/agents/approvals/always/remove`;
  it stops applying on the next request.
- A waiting run holds its concurrency slot until the card is answered or times out.

## How it works

```
claude -p --permission-mode <level> --allowedTools ... --permission-prompt-tool mcp__arunachala_approvals__approve
   └─ orchestration/approval-mcp.js  (stdio MCP, started by claude from <run>.mcp.json)
        └─ POST /api/agents/approvals/request  (local only + the run's token)
             └─ approvals.js  → card on /agents → decide → helper answers allow / deny
```

- `approval-levels.js`: levels → claude flags; `effectiveLevel` caps follow-ups.
- `approvals.js`: requests, timeouts, always-allow list. Each run gets a random token at
  dispatch; only that run can file or read its requests.
- `approvals-api.js`: HTTP. `agents-approvals.js`: the cards.
- The helper fails closed: no token, dashboard down, error or deadline = deny.
- `<run>.mcp.json` holds the token, is created with mode 600 and deleted when the run ends.
- Pending requests live in memory: restarting the dashboard drops them, and their runs get a deny
  at the helper's deadline.

Verified live 2026-11-19 with the real CLI (2.1.328, haiku): at `ask`, `touch` was asked, allowed
and ran; denied, it did not run and claude reported the denial. `echo`/`ls` never ask: Claude Code
treats read-only commands as allowed by itself.

Tests: `approval-levels.test.js`, `approvals.test.js`, `approvals-api.test.js`,
`orchestration/approval-mcp.test.js`, and the approval cases in `orchestration/agent-dispatch.test.js`.
