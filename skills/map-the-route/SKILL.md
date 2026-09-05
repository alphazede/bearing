---
name: map-the-route
description: >
  Create or resume Bearing's complete five-artifact planning package after
  material decisions are settled. Use for Map the Route or missing planning
  artifacts. Do not use to implement, select models, self-approve, or bypass
  the single integrated owner review.
---

# Map the Route

Fresh planning node. The Router writes Journey state and owns owner conversation.

## Match, inputs, and non-match

- **Match:** material intent is settled and any specification, design, SEIT,
  implementation graph, or review HTML is missing.
- **Inputs:** confirmed decisions, repository map and evidence, artifact status,
  requirements register, repository rules, proposed owner-supplied lineup and
  `review_cadence: at-end`, plus the return schema.
- **Non-match:** unresolved material scope, behavior, authority, risk, or
  acceptance intent returns `REROUTE_GATHER_SUPPLIES`; generate no
  `implementation.md` or `review.html`.

## Procedure

1. Derive `<journey-topic>-spec.md` from the confirmed title; ask only on
   ambiguity or collision. Establish whether a requirements register exists;
   if repository evidence cannot decide, return `NEEDS_OWNER_DECISION`. Never
   infer one. Registered identities remain references; author only Journey-local
   criteria; author the needed Journey-level proof or return
   `NEEDS_OWNER_DECISION` when register authority is unclear.
2. Author and prospectively check, in dependency order, the testable
   specification, `design.md`, and `seit.md`. Preserve IDs and do not drop
   Journey-level proof or published-standard clause coverage.
3. Map the implementation graph and propose the Explorer Journey or Expedition,
   active/standby/unused role states, lineup, reasoning, and
   `review_cadence: at-end`. Use supplied identities; never invent them.
4. After those stable source inputs, generate `implementation.md` and the
   self-contained offline `review.html` together. Each includes the proposed
   route, lineup, role states, reasoning, cadence, traceability, waves,
   recovery, approval boundaries, and register references versus Journey-local requirements.
5. Give every slice stable requirement/design/SEIT IDs, dependencies, exact
   write set, authority, role, session rule, evidence, recovery, and stop rule.
6. Open and verify final HTML, then request exactly one integrated owner review
   of outcome, design, route, lineup, cadence, and plan. Dispatch remains
   prohibited until approval. An owner change regenerates affected artifacts,
   then returns to this same gate; never insert a lineup or route-review pause.

## Return and recovery

Return `PLAN_REVIEW_READY`, `REROUTE_GATHER_SUPPLIES`,
`NEEDS_OWNER_DECISION`, or `VALIDATION_FAILED` with paths, evidence, blocker,
and next action. Owner-decision pauses do not consume correction rounds. At
most three evidence-changing correction rounds; never implement or invent approval.
