---
type: seit
status: complete
---

## Required Commands

- **CMD-UNIT** — `pnpm test`
- **PROC-IMPORT** — Run the migration import procedure.
- **PROC-REVIEW** — Run the procedure review.

## Traceability Matrix

| SEIT row ID | Acceptance/risk ID | Design/contract ID | Boundary/test layer | Positive case | Negative/failure case | Command/procedure ID | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| SEIT-1 | AC-1, RISK-1 | DES-1, CONTRACT-1 | unit | bounded plans parse | invalid plans fail closed | CMD-UNIT | test report |
| SEIT-2 | AC-2 | CONTRACT-2 | procedure | schema-preserving migration keeps row semantics | migration that rebinds row meaning fails validation | PROC-IMPORT | focused drift report |
| SEIT-3 | AC-2 | CONTRACT-2 | procedure | every executable row resolves to one matching procedure narrative | an executable row without a matching narrative blocks the plan | PROC-REVIEW | procedure review report |

## Integration Test Procedures

### SEIT-2 — Legacy import procedure

**Command.** PROC-LEGACY
**Positive case.** legacy import semantics are retained
**Negative case.** legacy rejection is retained
**Evidence.** test report

## Cross-cutting Checks

The execution boundary remains unchanged.
