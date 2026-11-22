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