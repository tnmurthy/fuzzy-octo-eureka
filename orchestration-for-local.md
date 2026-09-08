  # 🧭 Local Multi-Agent Orchestration & Optimization Guide

    > **Workspace Root:** `C:\tt-ai-stack`
    > **Dashboard Host:** `http://localhost:8787` ➔ `https://team.mytestbed.tech`
    > **Hardware Profile:** Intel Core i7-13700H (16 Cores), 32GB RAM, Intel Iris Xe (Vulkan Assist)
    > **Version:** 1.0.0

    ---

    ## 1. System Architecture & 5-Layer Stack


  ┌─────────────────────────────────────────────────────────────────────────────┐
  │  LAYER 1: STRATEGY & FRONTIER REASONING (Claude 3.7 / Gemini 2.0 / GPT-4o)  │
  │  • Architecture design, deep debugging, complex refactoring.                │
  ├─────────────────────────────────────────────────────────────────────────────┤
  │  LAYER 2: GOVERNANCE & WORKFORCE (Paperclip)                                │
  │  • Task board, gated approvals, token limits, hired agent cards (PO, Tech). │
  ├─────────────────────────────────────────────────────────────────────────────┤
  │  LAYER 3: COGNITIVE RUNTIMES & AGENT LOOPS (Hermes)                         │
  │  • Long-running execution loops, skills compiler, execution traces (.jsonl). │
  ├─────────────────────────────────────────────────────────────────────────────┤
  │  LAYER 4: GATEWAY & TOOL PROTOCOL (OpenClaw / MCP)                          │
  │  • Universal Model Context Protocol (MCP) router, stdio/TCP sandboxing.     │
  │  • Headroom: Context compression proxy at :8787/v1 (saves context tokens).  │
  ├─────────────────────────────────────────────────────────────────────────────┤
  │  LAYER 5: LOCAL INFERENCE & SPECIALIZED EXECUTION (Ollama / Docker)         │
  │  • qwen2.5-coder:7b (Coding), llama3.1:8b (Planning), nomic-embed (RAG).    │
  │  • Docker & Watchtower: Containerized daemons & automated image updates.    │
  └─────────────────────────────────────────────────────────────────────────────┘


    ---

    ## 2. Agent Workforce & Role Allocation

    | Agent Persona | Role & Focus | Assigned Model | Key Tools |
    | :--- | :--- | :--- | :--- |
    | **🧭 Product Owner (`po`)** | Strategy, scope breakdown, human interface. | `llama3.1:8b` (Local) / Claude | `send_message`, `manage_task`, `schedule` |
    | **💻 Tech Lead (`tech`)** | Implementation, refactoring, code edits. | `qwen2.5-coder:7b` | `view_file`, `replace_file_content`, `grep_search` |
    | **🧪 QA Specialist (`qa`)** | Pre-commit validation, linting, test sweeps. | `qwen2.5-coder:1.5b` | `run_command` (`npm test`, `npm run lint`) |
    | **🛠️ DevOps (`infra`)** | Docker, Watchtower, daemon health, tunnels. | `qwen2.5-coder:7b` | `run_command` (`docker`, `powershell`), `cloudflared` |
    | **📝 Documentation (`doc`)** | Memory logs, changelogs, `MEMORY.md`. | `gemma2:9b` / `llama3.1:8b` | `write_to_file`, `view_file` |

    ---

    ## 3. End-to-End Task Orchestration Pipeline

    ```mermaid
    sequenceDiagram
        autonumber
        actor User as Human Operator
        participant PO as 🧭 PO (Arunachala Ramana)
        participant Tech as 💻 Tech Lead
        participant QA as 🧪 QA Specialist
        participant Doc as 📝 Doc Specialist
        participant Dash as 📊 Live Dashboard (:8787)

        User->>PO: "Implement Feature / Fix Bug"
        PO->>PO: Load MEMORY.md & create task checklist
        PO->>Tech: Dispatch implementation subtask
        Tech->>Tech: Inspect & write minimal viable diff
        Tech-->>PO: Implementation complete

        PO->>QA: Dispatch pre-commit test sweep
        QA->>QA: Run linting & unit tests
        alt Test Fails
            QA-->>Tech: Return error trace (Loop back)
            Tech->>Tech: Patch code
        else Test Passes
            QA-->>PO: PASS Certified (0 Regressions)
        end

        PO->>Doc: Dispatch documentation & memory update
        Doc->>Doc: Update memory/YYYY-MM-DD.md & MEMORY.md
        PO->>Dash: Background daemon syncs metrics to https://team.mytestbed.tech
        PO-->>User: Final Completion Report & Git Commit
  ──────
  ## 4. Key Recommendations & Hardening Checklist

  ### Priority 0: Background Service Auto-Start

  Currently, running node server.js, powershell .\telemetry-daemon.ps1, and cloudflared.exe requires open terminal windows.

  1. Install Cloudflare as a Windows Service:
    C:\tt-ai-stack\cloudflared.exe service install
    Start-Service cloudflared

  2. Auto-Start Daemon & Server on Logon:
  Register a Windows Task Scheduler job running:
    # In Task Scheduler:
    powershell.exe -WindowStyle Hidden -ExecutionPolicy Bypass -File "C:\tt-ai-stack\01_projects\active\arunachala-dashboard\telemetry-daemon.ps1"

  ──────
  ### Priority 1: Zero Trust Security on Domain

  Because https://team.mytestbed.tech is publicly reachable over the internet:

  1. Open the Cloudflare Zero Trust Dashboard https://one.dash.cloudflare.com/.
  2. Navigate to Access ➔ Applications ➔ Add an Application (Self-hosted).
  3. Set domain: team.mytestbed.tech.
  4. Add an Allow Policy restricted to your email address via Google/GitHub OAuth or One-Time PIN (OTP).
  ──────
  ### Priority 2: Automated Dev ↔ QA Quality Gate

  Enforce that the tech agent cannot merge changes until the qa agent executes npm test and returns PASS. If tests fail, automatically retry with the error log (up to a maximum of 3 attempts).
  ──────
  ## 5. Hardware Sizing & Scaling Guidelines

  • Current Rig (Intel i7-13700H + 32GB RAM + Vulkan Iris Xe):
      • Optimal Capacity: 1–3 concurrent active agents running qwen2.5-coder:7b + llama3.1:8b.
      • Monthly Cost: ~$12–$18/mo in electricity vs. $450–$550/mo for an equivalent Google Cloud / RunPod GPU VPS.
  • Future Upgrade Recommendation:
      • When scaling to 5+ simultaneous subagents or running Qwen 32B / Llama 70B locally, add a dedicated GPU workstation with a 24GB RTX 3090 / RTX 4090 (~$1,500–$2,000 one-time cost, breaking even in ~3.5 months compared to cloud VPS).



    ---

    ### Summary
    This guide is saved in markdown format so all participating agents (`po`, `tech`, `qa`, `infra`, `doc`) and human operators can reference it as the single source of truth for the local orchestration stack.