---
type: implementation
status: complete
---

## Dependency graph

Wave 1: **S1**
Wave 2: **S2**

### Slice S1 — Bounded focus

**Goal.** Keep Focus bounded.
**Requirement IDs.** AC-1, RISK-1
**Design IDs.** DES-1, CONTRACT-1
**SEIT proof rows.** SEIT-1
**Type.** Fixture coverage
**Design lenses.** CDD
**Implementation role.** Backend Engineer
**Agent model route.** Codex agent default
**Agent reasoning level.** high
**Ponytail mode.** full
**Review path.** native review

### S1 execution manifest

**Write set.** Write only `src/notifier.ts`.
**Command IDs.** CMD-UNIT
**Stop condition.** Stop if the focused test fails.
**Human decision.** None.

### Slice S2 — Selected slice

**Goal.** Validate per-slice creation through the real Focus boundary.
**Requirement IDs.** AC-1, RISK-1
**Design IDs.** DES-1, CONTRACT-1
**SEIT proof rows.** SEIT-1
**Type.** Fixture coverage
**Design lenses.** CDD
**Implementation role.** Backend Engineer
**Agent model route.** Codex agent default
**Agent reasoning level.** high
**Ponytail mode.** full
**Review path.** native review

### S2 execution manifest

**Write set.** Write only `test/focus-mode.test.ts`.
**Command IDs.** CMD-UNIT
**Stop condition.** Stop if the focused test fails.
**Human decision.** None.
