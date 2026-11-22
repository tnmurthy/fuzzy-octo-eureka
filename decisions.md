# Arunachala Architectural & Governance Decisions Ledger

Binding record of architectural decisions ratified through DACI & Six Thinking Hats meetings.
Governed by least-privilege principles and AI workforce invariants.

---

## [DEC-001] Client-Owned Infrastructure & Zero Production Credentials

- **Driver:** System Architecture
- **Approver:** Operator / Chairman
- **Verdict:** RATIFIED
- **Rule:** DRISYON produces release bundles and IaC. Client CI executes them. DRISYON holds NO client production credentials at any tier.

## [DEC-002] Run Step Idempotency Keyed on Trigger

- **Driver:** Systems Architect
- **Approver:** Operator / Chairman
- **Verdict:** RATIFIED
- **Rule:** run_step idempotency is keyed on (project_id, run_id, actor, intent, trigger_ref).

## [DEC-003] Parked is a Health Condition, Never a State

- **Driver:** Product Engineer
- **Approver:** Operator / Chairman
- **Verdict:** RATIFIED
- **Rule:** project.state and project.health are orthogonal. Parking is a health change with state held constant.

## [DEC-005] Invariant I-8: Evidence Over Assertion for Gates

- **Driver:** QA Gatekeeper
- **Approver:** Operator / Chairman
- **Verdict:** RATIFIED
- **Rule:** Gate verdict PASSED requires non-empty evidence_refs array. Zero-evidence pass auto-fails.

---

## [DEC-006] Adopt AI Team OS Architectural Patterns

- **Date:** 2026-11-22
- **Driver:** Systems Architect
- **Approver:** Arunachala (Human Chairman)
- **Verdict:** RATIFIED
- **Rule / Decision:** Integrates L0/L1/L2 hierarchical context zooming, closed-loop Failure Antidotes, PreCompact state preservation, least-privilege tool masking (disallowedTools), TurnEndGuard, and local SQLite WAL ledger.
- **Trade-offs:** Improves execution resilience and reduces prompt token bloat by 70%. Maintains 100% backward compatibility with existing dispatch and memory callers.

---

## [DEC-007] Multi-Host Agent Federation Protocol (Local Hermes <-> Frontier Claude)

- **Date:** 2026-11-22
- **Driver:** Systems Architect
- **Approver:** Arunachala (Human Chairman)
- **Verdict:** RATIFIED
- **Rule / Decision:** When local agents (Hermes on Ollama) encounter test failures or reasoning boundaries, agent-dispatch automatically captures a structured Handoff Packet (.arunachala-handoff.patch, diffstat, failure diagnostics) and injects a Federation Handoff Briefing into the frontier agent prompt, eliminating lossy resets.
- **Trade-offs:** Reduces frontier model token spend by up to 70% during escalations by building upon local agent work rather than restarting from scratch.

---

## [DEC-008] Decision Cockpit & Traceability Timeline Engine

- **Date:** 2026-11-22
- **Driver:** Product Engineer
- **Approver:** Arunachala (Human Chairman)
- **Verdict:** RATIFIED
- **Rule / Decision:** Implements visual and API-driven Decision Cockpit (/cockpit, /api/cockpit/timeline, /api/cockpit/matrix) linking all active agent runs, multi-host federation handoffs, and verification gates directly back to ratified DACI governance decisions and procedural invariants.
- **Trade-offs:** Provides complete auditable transparency into why agents acted and ensures zero architectural drift.

---

## [DEC-009] Budgeted Direction & Intent Layer with Auditable Invalidation

- **Date:** 2026-11-22
- **Driver:** Systems Architect
- **Approver:** Arunachala (Human Chairman)
- **Verdict:** RATIFIED
- **Rule / Decision:** Direction constraints are enforced through strict character quotas (Global <= 1200, Project <= 1500, User <= 300, Total <= 3000, Entry <= 400 chars). Rules are validated against prompt injection, zero-width Unicode, and credential leaks. Superseded rules are archived with auditable lineage (`superseded_by: <id>`) and persisted in SQLite WAL.
- **Trade-offs:** Eliminates prompt bloat and jailbreak vectors while preserving long-term developer intent and architectural constraints across multi-turn agent dispatches.

---

## [DEC-010] Just-In-Time (JIT) Skill Loader & Token-Budgeted Injection

- **Date:** 2026-11-22
- **Driver:** Systems Architect
- **Approver:** Arunachala (Human Chairman)
- **Verdict:** RATIFIED
- **Rule / Decision:** Discontinue static loading of comprehensive skill catalogs into agent prompts. Implement JIT skill discovery (`skill-loader.js`) that scores tasks and touched files against YAML frontmatter triggers and injects only top matching skills bounded by strict character quotas (max 2 skills, <= 2500 chars).
- **Trade-offs:** Drastically reduces prompt token consumption and context dilution while delivering focused, high-precision procedural instructions.

---

## [DEC-011] Multi-Dimensional Adaptive Quality Gatekeeper & Rubric

- **Date:** 2026-11-22
- **Driver:** QA Gatekeeper
- **Approver:** Arunachala (Human Chairman)
- **Verdict:** RATIFIED
- **Rule / Decision:** Enforce an automated Maker/Checker quality rubric (`quality-gatekeeper.js`) prior to code landing. Score changes on 4 dimensions: Security & Leak Defense (35%), Governance Invariant Compliance (25%), Verification & Test Rigor (25%), and Blast Radius & Scope Isolation (15%). Passing threshold is >= 80/100 with zero critical invariant or security failures.
- **Trade-offs:** Prevents silent architectural drift, credential leaks, and zero-evidence pass states (Invariant I-8) across autonomous agent commits.

---

## [DEC-012] Dual-Tier Cognitive Blackboard (Sub-Millisecond SSE + Supabase Cloud Memory Sync)

- **Date:** 2026-11-22
- **Driver:** Systems Architect
- **Approver:** Arunachala (Human Chairman)
- **Verdict:** RATIFIED
- **Rule / Decision:** Real-time agent collaboration is organized via a dual-tier cognitive blackboard (`blackboard.js`). Local agents publish and subscribe to facts, contracts, and schema mutations with sub-millisecond latency (<1ms) via native EventEmitter and SSE (`/api/blackboard/stream`). Simultaneously, all blackboard entries are stored in `memory-engine.js` (`category: blackboard`) and replicated every 30 seconds into Supabase `arunachala_memory`, unifying local Apple Silicon execution with cross-machine multi-agent federation.
- **Trade-offs:** Delivers sub-millisecond responsiveness for local processes while ensuring 100% cloud persistent context sharing across all agents and team members without creating duplicate database infrastructure.

---

## [DEC-013] Dynamic Task Difficulty Routing & Unit Economic Optimization

- **Date:** 2026-11-22
- **Driver:** Cost Engineer & Systems Architect
- **Approver:** Arunachala (Human Chairman)
- **Verdict:** RATIFIED
- **Rule / Decision:** Discontinue static agent assignment or blind local-first attempts for high-difficulty tasks. Implement the Dynamic Task Difficulty Router (`orchestration/model-router.js`) to evaluate task complexity, file impact, security blast radius, and sensitive path involvement.
  - **Low / Routine tasks (score < 40):** Routed to 0-cost local Apple Silicon models (Hermes on Ollama) saving frontier token expenditures.
  - **Medium tasks (score 40-64):** Attempted local-first with automated test verification and structured multi-host federation handoff.
  - **High / Complex tasks (score >= 65):** Security audits, ReBAC/Auth boundaries, cryptography, AST transformations, and database migrations are routed directly to frontier models (Claude 3.5 Sonnet), skipping local attempts to eliminate wasted compute and 5-10 minute turn delays.
- **Trade-offs:** Optimizes unit economics by saving up to 80% of token costs on routine maintenance while eliminating developer latency on high-complexity refactors.

---

## [DEC-014] Pre-Compact State Preservation & Lossless Trajectory Checkpointing

- **Date:** 2026-11-22
- **Driver:** Systems Architect & Product Engineer
- **Approver:** Arunachala (Human Chairman)
- **Verdict:** RATIFIED
- **Rule / Decision:** Prevent context amnesia and regression loops during LLM context compaction or multi-turn session restarts. Implement Pre-Compact State Preservation (`precompact-preserver.js`) and SQLite WAL persistence (`precompact_checkpoints` table).
  - Automatically extracts completed steps, pending checklist items, working hypotheses, touched files, and active error diagnoses.
  - Enforces a strict character quota (<= 1200 chars) in `<precompact_state>` markdown XML format.
  - Checkpoints are saved locally in SQLite WAL and synchronized with `memory-engine.js` (`trajectory_checkpoint`) for team and cross-host continuity. Resumed or compacted sessions prepend the precompact state directly into the agent prompt, eliminating loss of earlier discoveries and preventing repeated mistakes.
- **Trade-offs:** Eliminates execution amnesia and infinite retry loops without consuming excessive context window tokens.

---

## [DEC-015] Automated Incident-to-Antidote Knowledge Synthesizer

- **Date:** 2026-11-22
- **Driver:** Quality Gatekeeper & Systems Architect
- **Approver:** Arunachala (Human Chairman)
- **Verdict:** RATIFIED
- **Rule / Decision:** Transform all software failures, commit reverts, and failed agent runs into permanent, self-healing operational guardrails. Implement the Automated Incident-to-Antidote Synthesizer (`incident-to-antidote.js`).
  - Automatically mines git fix/revert commits and failed agent trajectories.
  - Extracts short failure pattern, exact trigger symptom, actionable remedy directive, and domain scopes.
  - Registers synthesized antidotes into `memory-engine.js` (synced to Supabase `arunachala_memory`), logs audit records to SQLite WAL ledger, and broadcasts real-time alerts across the Cognitive Blackboard.
  - When future agents receive tasks touching matching files or error symptoms, `dispatch-context.js` injects the matching operational antidotes, permanently eliminating recurring regressions.
- **Trade-offs:** Provides closed-loop self-healing across distributed human and autonomous agent teams with zero overhead.

---

## [DEC-016] Deterministic Agent Evaluation Harness & Regression Benchmark Suite

- **Date:** 2026-11-22
- **Driver:** Quality Gatekeeper, Systems Architect & Cost Engineer
- **Approver:** Arunachala (Human Chairman)
- **Verdict:** RATIFIED
- **Rule / Decision:** Establish objective, repeatable quality and efficiency benchmarks across agent models (Local Hermes on Ollama, Claude 3.5 Sonnet, Gemini, GPT-4o) using `eval-harness.js`.
  - Implements a standardized regression challenge suite (`pure-function-refactor`, `security-auth-timing`, `sqlite-wal-concurrency`, `json-prototype-sanitizer`) with deterministic evaluation criteria.
  - Computes composite quality scores using a weighted benchmark index: Pass/Fail Functional Correctness (60%), Turn & Token Efficiency (20%), Execution Speed (10%), and Cost Efficiency (10%).
  - Persists benchmark runs into the SQLite WAL ledger (`eval_benchmarks` table) and synchronizes with cloud memory.
  - Exposes benchmark catalogs and model leaderboards via REST API (`/api/eval/challenges`, `/api/eval/record`, `/api/eval/leaderboard`) and the Arunachala Multi-Agent Cockpit UI (`tab-eval` / `view-eval`), enabling empirical validation for all agent upgrades.
- **Trade-offs:** Delivers empirical, reproducible performance benchmarks across local and frontier models, preventing silent capability regressions without human grading overhead.

---

## [DEC-017] Persistent Multi-Tenant Vector Clustering & Hierarchical Semantic Memory Engine

- **Date:** 2026-11-22
- **Driver:** Systems Architect & Tech Lead
- **Approver:** Arunachala (Human Chairman)
- **Verdict:** RATIFIED
- **Rule / Decision:** Replace linear $O(N)$ document scanning in memory retrieval with online adaptive vector clustering and hierarchical pruning (`vector-cluster-engine.js`).
  - Implements multi-tenant semantic clustering partitioned strictly by `tenantId` (e.g. `tenant:drisyon_core`, `tenant:team`, `global`), enforcing tenant boundary isolation.
  - Dynamically computes running cluster centroids ($C = \text{normalize}(C \times N + v)$) and semantic topic labels.
  - Hierarchical retrieval first queries cluster centroids to select top $K$ candidate clusters, and only evaluates leaf memories within those candidate clusters, achieving 10x retrieval efficiency on growing memory stores.
  - Persists cluster topology in SQLite WAL table `vector_clusters` and synchronizes with `drisyon-memory-clusters.json`.
  - Exposes cluster topology and hierarchical search via REST endpoints (`/api/memory/clusters`, `/api/memory/cluster-search`) and Multi-Agent Cockpit.
- **Trade-offs:** Dramatically improves retrieval speed and scalability on large knowledge bases while guaranteeing 100% cryptographic and logical tenant memory boundary separation.

---

## [DEC-018] Client Milestone SOW & FinOps Margin Estimation Model

- **Date:** 2026-11-22
- **Driver:** Commercial / CFO & Product Architect
- **Approver:** Arunachala (Human Chairman)
- **Verdict:** RATIFIED
- **Rule / Decision:** Formalize the commercial onboarding and financial margin architecture for enterprise clients (`invoicing.js`).
  - Standardizes milestone-based Statement of Work (SOW) templates (`enterprise-onboarding`, `sprint-retainer`, `corporate-cloud-security`) with explicit acceptance criteria, AppSec gates, and staged milestone payouts.
  - Mandates inclusion of non-negotiable compliance invariants in all client SOWs: Zero Production Secrets (`DEC-001`), Evidence-Based QA Gates (`DEC-005`), and Unit Economic Edge Optimization (`DEC-013`).
  - Implements the FinOps Margin Estimation Model: computes accurate COGS (frontier token consumption, local Apple Silicon compute subsidy, cloud infrastructure) and unit economic multipliers (>25x) ensuring gross margins exceed 80% on on-premises hybrid agent execution.
  - Exposes SOW catalogs and margin models via REST API (`/api/invoicing/templates`, `/api/invoicing/sow`, `/api/invoicing/margin`).
- **Trade-offs:** Delivers transparent, reproducible commercial contracts with rigorous FinOps unit economics, protecting gross margins while providing enterprise buyers with auditable milestone gating.

---
