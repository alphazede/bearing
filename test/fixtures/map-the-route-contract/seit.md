---
type: seit
status: complete
---

## Required Commands

- **CMD-UNIT** — `pnpm test`
- **PROC-IMPORT** — `pnpm proc:import`
- **PROC-REVIEW** — `pnpm proc:review`

## Traceability Matrix

| SEIT row ID | Acceptance/risk ID | Design/contract ID | Boundary/test layer | Positive case | Negative/failure case | Command/procedure ID | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| SEIT-1 | AC-1, RISK-1 | DES-1, CONTRACT-1 | unit | imports bounded data | invalid input fails closed | CMD-UNIT | unit test report |
| SEIT-2 | AC-2 | DES-1 | procedure | imports bounded data through the migration | migration that rebinds row meaning fails validation | PROC-IMPORT | focused drift report |
| SEIT-3 | AC-1 | DES-1 | procedure | reviews the procedure narrative | an executable row without a matching narrative blocks the plan | PROC-REVIEW | procedure review report |

## Cross-cutting Checks

Traceability rows cover every AC and RISK id declared in the plan.

## Integration Test Procedures

### SEIT-2 — Import procedure

**Command.** PROC-IMPORT.

**Positive case.** imports bounded data through the migration.

**Negative case.** migration that rebinds row meaning fails validation.

**Evidence.** focused drift report.

### SEIT-3 — Review procedure

**Command.** PROC-REVIEW.

**Positive case.** reviews the procedure narrative.

**Negative case.** an executable row without a matching narrative blocks the plan.

**Evidence.** procedure review report.
