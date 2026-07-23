---
name: set-bearings
description: Create or resume Bearing's local plan workspace and repository map when the Bearing journey enters Set Bearings.
user-invocable: false
disable-model-invocation: true
---

# Set Bearings

Create or resume only the bounded plan workspace, `plan-spec.md` stub, and
repository map requested by Bearing. Reuse an exact existing workspace when it
matches the goal. Do not ask planning questions, design, draft implementation,
or edit product code. Never delete an existing plan or `.bearing` state.

Bearing normally performs this stage deterministically. Treat its supplied
stage boundary, repository root, and artifact paths as authoritative.
