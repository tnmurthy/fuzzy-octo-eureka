# 📚 Agency Knowledge Wiki — Team Arunachala & Drisyon AI Operations

**Unified Operations Manual & Engineering Playbook**  
**Host Machine:** Apple Silicon Mac Studio (Apple M5 Max, 18 cores, 36.0 GB Unified RAM, Metal Assist Enabled)  
**Last Updated:** November 2026

---

## 🔑 1. Portal Credentials & Ingress Endpoints

The stack runs two concurrent isolated dashboard instances under PM2 on the host machine:

| Portal | Local URL | Public URL (Cloudflare) | Username | Password | Designated Purpose |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Team Arunachala** | `http://localhost:8787` | `https://team.mytestbed.tech` | `sriad` | `arunachala2026!` | **Operator Control**: Primary workstation for strategy, agent dispatch, and team task tracking. |
| **Drisyon AI** | `http://localhost:8788` | `https://drisyon.mytestbed.tech` | `drisyon` | `drisyon2026!` | **Autonomous Agency**: Multi-tenant client workspace, isolated memory boundaries, zero-credential IaC. |

> **💡 Multi-Hop Security:**  
> Both web portals authenticate via signed HMAC-SHA256 session cookies (valid for 7 days with sliding expiration). Localhost connections bypass outer auth, while public requests through Cloudflare Tunnels enforce authenticated session validation.

---

## 🧭 2. Agent Hierarchy & Personas

All human directives enter through the **Main Agent (🧭 Arunachala Ramana)**, who decomposes instructions and delegates work across specialized personas, revenue engines, and runners:

### Personas & Subagents
1. **🧭 Arunachala Ramana (Main Agent & PO)**
   - **Persona:** Calm, strategic, practical, precise.
   - **Responsibility:** High-level system strategy, backlog prioritization, gating decisions, subagent orchestration, and human operator communication.
   - **Model:** `gemma3:4b` (128k context) via local Ollama Metal acceleration.
2. **💰 Revenue & Deals Lead (`bizdev`)**
   - **Responsibility:** Client RFP evaluation, Statement of Work (SOW) drafting, project milestone pricing, and client onboarding into isolated tenant partitions.
   - **Model:** `gemma3:4b` (128k context).
3. **📢 DevRel & Growth Marketing (`marketing`)**
   - **Responsibility:** Translating engineering wins into public thought leadership, technical case studies, and driving inbound developer leads across Nostr, X, and LinkedIn.
   - **Model:** `gemma3:4b`.
4. **💻 Tech Lead & Architect (`tech`)**
   - **Responsibility:** System architectures, code implementation, surgical refactors, AST diff analysis, and debugging.
   - **Model:** `qwen2.5-coder:3b` (32k context, tool calling enabled).
   - **Tools:** `view_file`, `replace_file_content`, `grep_search`, `find_by_name`.
5. **🧪 QA Lead & Verification (`qa`)**
   - **Responsibility:** Pre-commit checks, automated unit test execution, regression suites, lint sweeps (Enforces DEC-005: Evidence Over Assertion).
   - **Model:** `qwen2.5-coder:3b`.
   - **Tools:** `run_command (npm test)`, `view_file`, `test_evaluator`.
6. **🛡️ AppSec Specialist (`sec` / Google Mantis)**
   - **Responsibility:** Autonomous vulnerability scanning, CVE reproduction, ReBAC access boundary auditing, zero-dependency validation.
   - **Model:** `qwen2.5-coder:3b` + Google Mantis (19 AppSec skills).
   - **Tools:** `mantis_scan`, `cve_reproduce`, `rebac_verify`, `audit_inspect`.
7. **📊 AI Unit Economics Controller (`cfo`)**
   - **Responsibility:** Auditing token consumption, tracking local-first compute vs frontier API spend, and ensuring every client project maintains 80-90% gross profit margins.
   - **Model:** `gemma3:4b`.
8. **🛠️ DevOps & Infrastructure (`infra`)**
   - **Responsibility:** Container lifecycle, Ollama Metal GPU mappings, PM2 process supervision, and Cloudflare tunnels.
   - **Model:** `gemma3:4b`.
   - **Tools:** `docker-compose`, `cloudflared`, `pm2`, `bash / zsh`.
9. **📝 Doc Scribe (`doc`)**
   - **Responsibility:** Project memory maintenance, changelog logs, task completion tracking, and keeping daily diary files up to date.
   - **Model:** `gemma3:4b`.
10. **🐍 Hermes Local Reasoning Runner (`hermes`)**
    - **Responsibility:** Autonomous local reasoning loops running directly on local Ollama weights with zero API cost.
    - **Model:** `gemma3:4b` / `qwen2.5-coder:3b`.
11. **👐 OpenHands Canvas Sandbox (`openhands`)**
    - **Responsibility:** Containerized full-stack development sandbox with interactive web canvas on Port 8000.
    - **Access URL:** `http://127.0.0.1:8000/canvas/`

---

## 💼 3. Agency Business Model & Unit Economics

Drisyon AI operates on an **asymmetric margin model**: by executing code generation, refactoring, and test sweeps locally on the **Apple Silicon M5 Max Metal GPU**, delivery cost is virtually zero, generating **85–95% gross profit margins** on software deliverables.

### Revenue Streams
1. **Fixed-Scope Autonomous Sprints ($5,000 – $15,000):** Turnkey delivery of APIs, auth layers, or refactors within 7–14 days.
2. **Dedicated Autonomous Engineering Pod ($8,000/mo retainer):** Continuous sprint cycles with Tech Lead, QA, and Mantis AppSec dedicated to a client repo.
3. **Autonomous AppSec Audit Badge ($3,500/audit):** Comprehensive 19-skill Google Mantis security scan + reproducible exploit diffs + verification certificate.

### The Asymmetric Margin Advantage
| Cost Factor | Cloud-Only Agency | Drisyon AI Mesh (Local-First) |
| :--- | :--- | :--- |
| **Dev Iteration Spend** | $500 – $2,000/sprint (OpenAI/Anthropic) | **$0.00** (Apple M5 Max Metal GPU) |
| **Escalation Tokens** | 100% of all turns billed | < 8% (Only on test regression failure) |
| **Gross Profit Margin** | 50% – 65% | **88% – 96%** |

### 🔄 The $10,000 Project Delivery Lifecycle
```
Client Brief Ingestion (bizdev)
       ▼
Human Approval & 50% Deposit ($5,000)
       ▼
Tenant Memory Partitioning (onboard)
       ▼
Local-First Development (tech on M5 Max)
       ▼
Evidence Verification (qa + Mantis DEC-005)
       ▼
Interactive Preview (OpenHands Canvas :8000)
       ▼
Final Git Bundle & Remaining 50% Payment ($5,000)
       ▼
Margin Audit (cfo: ~99.7% delivery margin)
```

---

## 🎯 4. Task Routing & Delegation Matrix

| Target Agent | Task Category | Example Operator Prompt | Expected Output / Artifact |
| :--- | :--- | :--- | :--- |
| **🧭 Arunachala (PO)** | Architecture & Strategy | `"Analyze trade-offs between Redis vs in-memory Map for session caching on Apple Silicon M5 Max."` | Technical ADR with performance benchmarks. |
| **💰 BizDev Lead (`bizdev`)** | Client RFP & SOW Scoping | `"Analyze client requirements for an enterprise ReBAC auth system and generate a 14-day milestone SOW."` | Structured Statement of Work (SOW) + milestone budget estimate. |
| **📢 Growth & DevRel (`marketing`)** | Proof-of-Work Distribution | `"Draft an architectural teardown of our Apple Silicon M5 Max Metal GPU acceleration for Nostr and Twitter."` | Technical blog post + multi-thread social broadcast bundle. |
| **💻 Tech Lead (`tech`)** | Feature Implementation | `"Implement sliding session cookie expiration in auth.js with HMAC-SHA256 signatures."` | Clean code diff + updated helper functions with zero external dependencies. |
| **🧪 QA Lead (`qa`)** | Test & Verification | `"Run the full unit test suite and verify that all edge cases for expired tokens fail closed."` | Evidence log showing `ℹ pass 59 ℹ fail 0` (Invariant DEC-005 compliant). |
| **🛡️ AppSec (Mantis)** | Security & Access Audit | `"Audit all /api endpoints for ReBAC authorization and test for tenant memory isolation leaks."` | Vulnerability scan report + reproduction script + verified remediation diff. |
| **📊 Finance Controller (`cfo`)** | Margin & Unit Economics | `"Audit token consumption for client project alpha and calculate gross profit margin vs invoice amount."` | Profitability ledger showing token burn vs revenue (target: > 85% gross margin). |
| **🛠️ DevOps (`infra`)** | Process & Ingress Ops | `"Check PM2 process health, verify Ollama Metal latency, and ensure Cloudflare tunnel routes both domains."` | PM2 status dump + latency histogram + tunnel ingress table. |
| **👐 OpenHands** | Visual UI / Sandboxed Build | `"Build an interactive telemetry widget in the Canvas sandbox and preview on port 8000."` | Live preview in OpenHands Canvas + exportable frontend bundle. |

---

## 🧠 5. 4-Tier Cognitive Memory & Shared Tables

Institutional memory is preserved across reboots and agent runs through a multi-tiered memory architecture:

| Tier | Scope & Persistence | Storage Mechanism | Example Content |
| :--- | :--- | :--- | :--- |
| **Tier 1: Working** | Ephemeral (single session) | In-memory Map buffer | Active terminal inputs, temporary tool outputs, recent bash commands. |
| **Tier 2: Episodic & Semantic** | Permanent, Vectorized | `drisyon-memory.json` + `arunachala_memory` | Technical solutions, API behavior notes, architectural patterns indexed by `nomic-embed-text`. |
| **Tier 3: Procedural Invariants** | Immutable Rules | Enforced in `memory-engine.js` | DEC-001 (Zero prod credentials), DEC-005 (Evidence over assertion). |
| **Tier 4: Operator Alignment** | Permanent Log | Nostr/Buzz Relays + Disk | Directives sent by verified cryptographic operator keys via Buzz relay. |

### Shared Context Memory Schema
```json
{
  "tenantId": "tenant:drisyon_core",
  "projectId": "auth_system",
  "category": "architecture_decision",
  "title": "Sliding Session Cookie Expiry",
  "content": "Session cookies expire in 7 days; use /api/auth/me to refresh expiration. HttpOnly and SameSite=Lax.",
  "tags": ["auth", "cookies", "security"]
}
```

---

## 💻 6. AI Developers Playbook

### Storing Knowledge via REST API
```bash
curl -X POST http://127.0.0.1:8787/api/memory/store \
  -H "Content-Type: application/json" \
  -d '{
    "tenantId": "tenant:drisyon_core",
    "projectId": "auth_system",
    "category": "architecture_decision",
    "title": "Sliding Session Cookie Expiry",
    "content": "Session cookies expire in 7 days; use /api/auth/me to refresh expiration. HttpOnly and SameSite=Lax.",
    "tags": ["auth", "cookies", "security"]
  }'
```

### Querying Memory via Vector Semantic Search
```bash
curl -s "http://127.0.0.1:8787/api/memory/search?q=How%20are%20tokens%20signed%20and%20verified" | jq .
```

### Local-First Execution Protocol
Configure `DISPATCH_LOCAL_FIRST=true` in `.env`. The dispatcher executes tasks on the local `qwen2.5-coder:3b` model first. If and only if the test suite fails or regression breaks occur, it escalates to Claude, slashing external API costs by over 90%.

---

## 🛠️ 7. DevOps & Runtime Playbook

### PM2 Process Supervision
```bash
# Check status of running daemons
pm2 ls

# View real-time output logs
pm2 logs ArunachalaDashboard --lines 40

# Restart specific services with updated environment variables
pm2 restart ArunachalaDashboard DrisyonDashboard ArunachalaTelemetry --update-env

# Persist active configuration across system reboots
pm2 save
```

### Hardware Health & Metal Verification
```bash
# Verify dynamic Apple Silicon host specs detection
curl -s http://127.0.0.1:8787/api/config | jq .host

# Verify Ollama Metal GPU inference
curl -s http://127.0.0.1:11434/api/tags | jq .

# Inspect ReBAC authorization graph
curl -s http://127.0.0.1:8787/api/rebac/inspect | jq .
```

---

## 💡 8. Agency Pro Tips & Core Invariants

1. **Invariant DEC-005: Evidence Over Assertion**  
   Never accept an agent's claim that "all tests pass" without evidence. Every QA pass verdict requires a verified `evidence_refs` payload with actual test runner output (e.g., `ℹ pass 59 ℹ fail 0`). Unverified passes auto-fail.
2. **Invariant DEC-001: Zero Production Credentials**  
   Drisyon produces code bundles and IaC templates. Client CI executes them. The agency repository holds zero production credentials. Staging environments use synthetic data only.
3. **Browser Cache Flushing**  
   If changes to the dashboard UI appear missing after a deployment, press `Cmd + Shift + R` (macOS) or `Ctrl + F5` (Windows) to flush browser-cached CSS and JavaScript.
4. **Unit Economics Guardrail**  
   Ensure at least 85% of all agent reasoning turns run on local `qwen2.5-coder:3b` / `gemma3:4b` to maintain asymmetric profit margins.
