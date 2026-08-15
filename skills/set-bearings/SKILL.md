---
name: set-bearings
description: >
  Create or resume the visible Journey workspace and bounded repository map
  after Repository Fit is confirmed. Use for Set Bearings or stale project
  context. Do not use before fit, for owner decisions, design, implementation,
  hidden state, or deleting historical plans.
---

# Set Bearings

Fresh planning node. The Router announces `Setting Our Bearings in <repo>.`

## Inputs and match

- **Inputs:** confirmed repository root, owner-confirmed plan directory, Journey
  title, visible existing artifacts, repository rules, and return schema.
- **Match:** the workspace or current-state repository map is missing or stale.
- **Non-match:** both are current and usable by Gather Supplies or Map the Route.

## Algorithm

1. Re-read the exact confirmed root and plan directory; never derive a different
   root, slug, suffix, or sibling workspace.
2. Preserve every existing artifact and unrelated edit. Resume rather than
   replace an existing Journey.
3. Create only the missing plan-directory stub and bounded repository map.
4. Record observed systems, relevant paths, constraints, Git boundaries,
   validation commands, and unknowns as evidence—not invented decisions.
5. Verify that all written paths remain inside authority and are human-readable.

## Return and recovery

Return `WORKSPACE_READY`, `WORKSPACE_RESUMED`, `NEEDS_EVIDENCE`, or `BLOCKED`
with paths, map freshness, evidence, blocker, and next planning stage. Retry only
from corrected evidence, at most three attempts.

Never ask planning questions, write risk choices, design, implement, create
hidden runtime state, or delete plan content.
