---
type: implementation
status: complete
---

## Dependency graph

S1 --> S2

## Execution waves

Wave 1: **S1**

Wave 2: **S2**

### Slice S1 — Import

**Goal.** Import bounded data through src/import.ts.

**Requirement IDs.** AC-1, AC-2

**Design IDs.** DES-1

**SEIT proof rows.** SEIT-1, SEIT-2

**Type.** module

**Design lenses.** correctness, boundary

**Implementation role.** Implement the import module under the documented schema.

**Agent model route.** grok

**Agent reasoning level.** medium

**Review path.** native review.

### S1 execution manifest

**Write set.** Write only `src/import.ts`.

**Command IDs.** CMD-UNIT

**Stop condition.** Stop if the focused test fails.

**Human decision.** Escalate only on nondeterministic output.

### Slice S2 — Procedure review

**Goal.** Review the import procedure against the traceability contract.

**Requirement IDs.** AC-1

**Design IDs.** DES-1

**SEIT proof rows.** SEIT-2, SEIT-3

**Type.** procedure

**Design lenses.** traceability, drift

**Implementation role.** Verify the procedure narrative matches its traceability row.

**Agent model route.** grok

**Agent reasoning level.** medium

**Review path.** native review.

### S2 execution manifest

**Write set.** Write only `test/import.test.ts`.

**Command IDs.** PROC-IMPORT, PROC-REVIEW

**Stop condition.** Stop if the procedure fails.

**Human decision.** Escalate only on nondeterministic output.
