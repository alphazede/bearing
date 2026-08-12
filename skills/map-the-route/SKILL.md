---
name: map-the-route
description: >
  Build the human-readable task graph when the outcome is approved but
  executable tasks are missing. Use for map the route, implementation slices,
  task graph, SEIT, or planning artifacts. Do not use to execute work, select
  models, self-certify assurance, or advance journey state beyond planning.
---

# Map the Route

Procedural stage. Not a persona.

## Match / non-match

- **Match:** plan-spec/decisions are approved and executable task graph or planning package is incomplete.
- **Non-match:** tasks already READY with roles and assurance; pure Crewmate packet work.

## Inputs

Approved goal, decisions, plan-spec, and required Role routes.

## Procedure

1. Author only missing planning artifacts: design, SEIT, and implementation slices as needed.
2. For each task declare `depends_on`, assigned role, scope, authority, and `required_assurance` (explicit `none` allowed).
3. Prefer the smallest valid route; leave dormant roles unselected.
4. Keep IDs stable; cite acceptance and evidence expectations per task.
5. Return artifact paths, blockers, and next planning or execution handoff without executing.

## Never

Implement product changes, invent owner approval, run phase gates as automatic, or claim independent assurance.
