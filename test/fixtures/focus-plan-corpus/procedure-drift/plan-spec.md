---
type: plan-spec
status: complete
---

## Acceptance criteria

- **AC-1** — Keep Focus bounded.
- **AC-2** — Schema-preserving migrations keep SEIT row semantics.

## Risks and open questions

- **RISK-1** — Invalid input must fail closed.

## Entry criteria

Requirements are approved.

## Exit criteria

All evidence commands pass.

## Rollback or repair

Repair the fixture and rerun validation.

## Accountable controller

Navigator controls the phase.
