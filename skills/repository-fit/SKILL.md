---
name: repository-fit
description: >
  Verify and propose one target repository and plan directory when repository
  identity is absent or ambiguous. Use for Repository Fit before Set Bearings.
  Do not use after owner-confirmed fit, for parent-wide exploration, planning
  decisions, product edits, role routing, or publication.
---

# Repository Fit

Fresh planning node. It returns evidence; the Router records the decision.

## Inputs and match

- **Inputs:** Journey goal, authorized candidate roots, visible prior decisions,
  repository rules, and discovery limits.
- **Match:** target root, repository identity, or plan location is unresolved.
- **Non-match:** the owner already named and confirmed the repository and plan.

## Algorithm

1. Inspect the selected root only. Open one additional root only when authorized.
2. Cap discovery at depth 4 and 200 paths; prefer Git identity, manifests,
   top-level instructions, and current plan conventions.
3. Reject nested-repository confusion, missing Git identity, or conflicting
   owner evidence with a typed finding.
4. Propose exactly one repository and one plan-directory assumption with path
   evidence and a short reason.
5. Return one owner confirmation question through the Router. A recommendation
   is not confirmation.

## Return and recovery

Return `FIT_PROPOSED`, `FIT_CONFIRMED`, `FIT_UNAVAILABLE`, `FIT_MALFORMED`, or
`FIT_UNDECIDABLE` with root, plan directory, evidence, blocker, and next action.
Retry only from new evidence, at most three attempts.

Never write files, walk unapproved parents, rank endless alternatives, or
advance the Journey itself.
