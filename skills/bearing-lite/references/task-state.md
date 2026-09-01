# Task state (authoritative text)

The project's human-readable plan is the only task-state record. Diagrams explain; they never authorize a transition, create state, or grant authority.

## States and active owners

| State | Active owner | Meaning |
| --- | --- | --- |
| `PROPOSED` | Parent coordinator | Task exists but is not execution-ready |
| `READY` | Parent coordinator | Dependencies, scope, authority, and route are satisfied |
| `WAITING_ON` | Parent coordinator | Named prerequisite, checkout-lease conflict, or independent-assurance dispatch unavailable |
| `IN_PROGRESS` | Assigned worker or coordinator | Assigned action is being performed |
| `EVIDENCE_READY` | Parent coordinator | Candidate and evidence ready for next missing assurance |
| `VALIDATING` | Validator | Evidence sufficiency under validation |
| `REVIEWING` | Park Ranger when required | Independent defect review active |
| `ACCEPTANCE` | Surveyor, Owner Authority, or parent coordinator when `required_assurance` is `none` | User-facing acceptance or coordinator completion confirmation is active |
| `CORRECTION_REQUIRED` | Navigator or nearest parent coordinator | Agent-owned in-authority correction required |
| `OWNER_DECISION_REQUIRED` | Owner Authority | Authority, scope, security, or replacement-path judgment required |
| `COMPLETE` | Parent coordinator after assurance | Outcome and required assurance satisfied |
| `CANCELLED` | Owner Authority or authorized parent | Task will not proceed |

## Legal transitions

- `PROPOSED` → `READY` when dependencies, scope, authority, assigned role, and assurance are declared and satisfied; else `WAITING_ON`.
- `WAITING_ON` → `READY` when the prerequisite is repaired or replaced; → `EVIDENCE_READY` when fresh assurance becomes available; → `CANCELLED` on owner scope reduction.
- `READY` → `IN_PROGRESS` when the assigned role starts; → `OWNER_DECISION_REQUIRED` on authority or integrity guard.
- `IN_PROGRESS` → `EVIDENCE_READY` with candidate and handoff; → `CORRECTION_REQUIRED` on correctable failure; → `OWNER_DECISION_REQUIRED` on security, authority, or integrity guard.
- `CORRECTION_REQUIRED` → `READY` on attempt 1 or 2 with a new hypothesis and evidence; → `OWNER_DECISION_REQUIRED` on the third failed correction or out-of-contract amendment.
- `EVIDENCE_READY` → `VALIDATING` | `REVIEWING` | `ACCEPTANCE` for the next missing required role; → `WAITING_ON` if assurance dispatch is unavailable.
- During the single assurance round, an accepted Validator or Park Ranger handoff returns to `EVIDENCE_READY` to select the next missing assurance role in declared order.
- `VALIDATING` → `CORRECTION_REQUIRED` when more evidence or repair is needed; otherwise back through `EVIDENCE_READY` for remaining assurance.
- `REVIEWING` → `CORRECTION_REQUIRED` | `EVIDENCE_READY` | `OWNER_DECISION_REQUIRED` by verdict.
- `ACCEPTANCE` → `COMPLETE` when every required assurance accepted the same candidate; when `required_assurance` is `none`, parent-coordinator confirmation satisfies the assurance requirement; → `CORRECTION_REQUIRED` on acceptance gap.
- `OWNER_DECISION_REQUIRED` → `READY` or `CANCELLED` by owner choice.

## Ownership rules

- One parent coordinator writes each task block and its transitions.
- Navigator alone writes cross-wave dependencies and Expedition-wide sequencing.
- Workers and assurance roles return handoffs; they do not race plan edits.
- Candidate authors never provide their own Validator, Park Ranger, or Surveyor verdict.
- Waiting on a prerequisite consumes no correction attempt. Each task has its own three-attempt correction counter; identical retries without new evidence are invalid.
- One Journey receives at most one assurance round and one review-directed repair. Replacement candidates do not reset the count. The coordinator verifies that repair deterministically and does not dispatch assurance again.
- `COMPLETE` is terminal for Bearing assurance. An already authorized deployment keeps operational verification and rollback readiness but does not reopen review; candidate-changing deployment work requires separate scope.

## Checkout lease

The Router inventories visible nonterminal Journeys and holds one
generation-bound checkout lease before any planning write or dispatch.

- Same checkout plus a live other Journey → `WAITING_ON` with sanitized
  competing Journey and controller. Distinct explicitly approved compatible
  worktrees may proceed.
- Resume keeps the same generation and must not duplicate dispatch.
- `COMPLETE` or `CANCELLED` releases the lease exactly once.
- Stale recovery is explicit, recorded, increments generation, and cannot
  steal a live lease. Forged or stale-generation records fail closed.
- Branch or HEAD drift from the leased identity stops the transition before
  mutation. Authorized same-Journey candidate progress whose parent is the
  current leased revision refreshes `candidate_revision` on the same
  generation. Foreign controller, branch/worktree, or unrelated HEAD still
  fail closed as `WAITING_ON`.
