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
  owner-selected route/lineup/cadence, repository rules, and return schema.
- **Match:** first specification gate or post-approval planning package is missing.
- **Non-match:** executable tasks already map to current approved artifacts.

## Algorithm

1. Derive and announce `<journey-topic>-spec.md` from the confirmed title;
   require owner input only on ambiguity or collision. Never require generic
   `plan-spec.md`.
2. Author in dependency order: testable specification, `design.md`, `seit.md`,
   then `implementation.md`. Run prospective checks internally; interrupt the
   owner only when evidence creates a material intent, scope, risk, or authority
   decision.
3. Generate one complete self-contained offline `review.html` after all four
   artifacts are current. Include implementation, traceability, roles, waves,
   failure/recovery paths, and approval boundaries in that review.
4. Give every slice stable requirement/design/SEIT IDs, dependencies, exact
   write set, authority, fresh-session role, evidence, recovery, and stop rule.
5. Copy the confirmed route, lineup, and review cadence into implementation and
   HTML. Show named active, standby, and unused role instances.
6. Open the exact final HTML, verify its launcher/process, and request one
   integrated owner approval. Use staged owner approvals only when the owner
   explicitly requests them.

## Return and recovery

Return `PLAN_REVIEW_READY`, `NEEDS_OWNER_DECISION`, or `VALIDATION_FAILED` with
artifact paths, evidence, blocker, and next action. After approval,
`review.html` is authoritative. At most three evidence-changing correction
rounds; never invent approval or implement.
