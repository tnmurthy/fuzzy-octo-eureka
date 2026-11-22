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