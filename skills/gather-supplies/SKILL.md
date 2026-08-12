---
name: gather-supplies
description: >
  Resolve only material owner decisions that block a complete plan after the
  workspace exists. Use for gather supplies, owner decisions, plan-spec
  assumptions, or blocking scope questions. Do not use for design drafting,
  implementation, product edits, or replaying settled owner answers.
---

# Gather Supplies

Procedural stage. Not a persona.

## Match / non-match

- **Match:** material open decisions block scope, architecture, security, authority, or acceptance.
- **Non-match:** decisions already recorded; Map the Route can proceed; pure implementation packets.

## Inputs

Goal, repository evidence, plan workspace, and prior owner Q&A.

## Procedure

1. Ask only material questions; reuse durable prior answers without re-asking.
2. For each question: recommendation, evidence, options/tradeoffs, affected section, safe default.
3. Apply completed answers into the validated plan specification only.
4. Keep requirements testable with stable IDs; record blockers instead of inventing approval.
5. Exit with zero-to-few bounded questions, applied plan-spec, or `OWNER_DECISION_REQUIRED`.

## Never

Design the route, draft implementation slices, edit product code, or overwrite a recorded owner answer with a default.
