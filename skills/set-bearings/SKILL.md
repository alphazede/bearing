---
name: set-bearings
description: >
  Create or resume the bounded plan workspace and repository map when project
  context or current-state map is missing after fit. Use for set bearings,
  plan workspace, or repository map. Do not use before fit is confirmed, for
  owner decisions, design drafts, product edits, or risk-profile authoring.
---

# Set Bearings

Procedural stage. Not a persona.

## Match / non-match

- **Match:** fit is confirmed and plan workspace or repository map is missing or stale.
- **Non-match:** workspace already ready; Gather Supplies or later stages apply.

## Inputs

Repository root, work goal, and owner-confirmed plan directory (verbatim).

## Procedure

1. Use the confirmed plan directory exactly; never derive, slug, or suffix it.
2. Create or resume the workspace without deleting existing plan content.
3. Write only the plan-directory stub and sibling repository map.
4. Leave risk-profile content to Gather Supplies / owner; do not invent it.
5. Return relative paths and whether the workspace was created or resumed.

## Never

Ask planning questions, design, implement, edit product code, or delete plans or hidden runtime state.
