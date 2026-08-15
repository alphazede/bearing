---
name: map-the-route
description: >
  Create or resume Bearing's topic-specific specification, design, SEIT,
  implementation graph, and self-contained review HTML after decisions are
  resolved. Use for Map the Route or missing planning artifacts. Do not use to
  implement, select agents/models, self-approve, or bypass owner review.
---

# Map the Route

Fresh planning node. The Router remains the plan-state writer and user contact.

## Inputs and match

- **Inputs:** confirmed decisions, repository map, artifact status, requirements,
  owner-selected lineup/cadence, repository rules, and return schema.
- **Match:** first specification gate or post-approval planning package is missing.
- **Non-match:** executable tasks already map to current approved artifacts.

## Algorithm

1. Derive `<journey-topic>-spec.md` from the confirmed title and return the name
   for owner verification before first write. Never require generic `plan-spec.md`.
2. Write the testable specification and self-contained offline `review.html`.
   Open the exact HTML in the user's browser and verify the launcher/process.
3. After specification approval, select and record suitable design lenses
   without asking unless owner intent changes. Write `design.md`, then `seit.md`;
   draft `implementation.md` only after both prospective gates are complete.
4. Give every slice stable requirement/design/SEIT IDs, dependencies, exact
   write set, authority, fresh-session role, evidence, recovery, and stop rule.
5. Copy the confirmed lineup and review cadence into implementation and HTML.
   Show named active, standby, and unused role instances.
6. Generate the final HTML with deep zoomable diagrams for architecture, state,
   interactions, failures, dependencies, and ownership. Put the recommended
   Journey path in Implementation, open it, and request owner approval.

## Return and recovery

Return `SPEC_REVIEW_READY`, `PLAN_REVIEW_READY`, `NEEDS_OWNER_DECISION`, or
`VALIDATION_FAILED` with artifact paths, evidence, blocker, and next action.
After final approval, `review.html` is authoritative. At most three
evidence-changing correction rounds; never invent approval or implement.
