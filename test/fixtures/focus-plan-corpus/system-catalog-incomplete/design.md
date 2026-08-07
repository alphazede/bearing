---
type: design
status: complete
---

## Use Cases and Communication Flows

The owner dispatches one bounded slice.

## Interface Option Check

No new interface is needed.

## OOPDSA Implementation Design

- **DES-1** — Reuse the bounded Focus boundary.
- **CONTRACT-1** — Invalid input fails closed.

## System Catalog

| System ID | System | Responsibility |
| --- | --- | --- |
| SYS-1 | Focus boundary | Keep the Focus boundary bounded |
| SYS-2 | Import boundary | Import bounded data |

### SYS-1 — Focus boundary

**Ownership.** Backend Engineering.
**Inputs.** Validated plan documents.
**Outputs.** Bounded slice context.
**APIs.** createFocusContext.
**Data ownership.** Plan artifacts.
**Invariants.** Focus boundaries never widen.
**Trust boundary.** None beyond the existing boundary.
**Failure modes.** Invalid plans fail closed.
**Observability.** Focus completion events.

## Requirement Trace

| Requirement ID | System ID | Contract ID | SEIT row ID | Slice ID | Path |
| --- | --- | --- | --- | --- | --- |
| AC-1, RISK-1 | SYS-1, SYS-2 | CONTRACT-1 | SEIT-1 | S1 | `src/notifier.ts` |
