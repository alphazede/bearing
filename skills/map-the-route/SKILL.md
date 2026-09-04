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

- **Inputs:** confirmed decisions plus owner-answered register and route-review
  answers, repository map, artifact status, requirements, repository evidence,
  lineup/cadence snapshot, repository rules, and return schema.
- **Match:** first specification gate or post-approval planning package is missing.
- **Non-match:** executable tasks already map to current approved artifacts.

## Algorithm

1. Derive and announce `<journey-topic>-spec.md` from the confirmed title; require owner
   input only on ambiguity or collision. Never require generic `plan-spec.md`.
2. Before authoring requirements, establish whether the target repository or system already
   has a requirements register. Inspect repository evidence; when it cannot be determined,
   return `NEEDS_OWNER_DECISION` asking where existing requirements live. Never infer one.
   Where no register exists, author as today. Where a register exists, reference registered
   identities and keep only Journey-local criteria in the specification.
3. Author in dependency order: testable specification, `design.md`, `seit.md`, then
   `implementation.md`. Run prospective checks internally; interrupt owner only on material
   intent, scope, risk, or authority decisions. With a register, `seit.md` references existing
   verification allocations rather than inventing parallel proof; keep only Journey-level rows.
4. Route review: when the implementation graph reveals the actual wave and dependency structure and the
   Journey type is not recorded, return `NEEDS_OWNER_DECISION` with a route-review
   recommendation: Explorer Journey or Expedition, citing the mapped structure and what each
   gives up or buys. Never infer the Journey type from the lineup or graph.
5. Generate one complete self-contained offline `review.html` after all four artifacts and the
   Journey type are current. Include implementation, traceability, roles, waves,
   failure/recovery paths, approval boundaries, register references versus Journey-local
   requirements, and route basis in that review.
6. Give every slice stable requirement/design/SEIT IDs, dependencies, exact write set,
   authority, fresh-session role, evidence, recovery, and stop rule.
7. Copy the confirmed route, lineup, and review cadence into implementation and HTML. Show
   named active, standby, and unused role instances.
8. Open the exact final HTML, verify its launcher/process, and request one integrated owner approval. Use staged owner approvals only when the owner explicitly requests them.

## Return and recovery

Return `PLAN_REVIEW_READY`, `NEEDS_OWNER_DECISION`, or `VALIDATION_FAILED` with artifact
paths, evidence, blocker, and next action. `NEEDS_OWNER_DECISION` pauses for a register or
route-review question; resume with the owner's answer. Owner-decision pauses do
not consume correction rounds. After approval, `review.html` is
authoritative. At most three evidence-changing correction rounds; never invent approval or
implement.
