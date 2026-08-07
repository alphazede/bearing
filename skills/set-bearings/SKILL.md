---
name: set-bearings
description: Create or resume Bearing's local plan workspace and repository map when the Bearing journey enters Set Bearings.
user-invocable: false
disable-model-invocation: true
---

# Set Bearings

## Mission and non-goals

Create or resume only the bounded plan workspace, `plan-spec.md` stub, and
repository map requested by Bearing. Use the confirmed resolved plan directory
verbatim. Never derive, slug, or suffix a plan directory. Do not ask planning
questions, design, draft implementation, or edit product code. Never delete an
existing plan or `.bearing` state, and never remove, alter, or create a
`## Risk Profile` section in the stub: the risk profile is owner and Gather
Supplies content, not a stub concern.

Bearing normally performs this stage deterministically. Treat its supplied
stage boundary, repository root, and artifact paths as authoritative.

## Authority and prohibited actions

Act only within the supplied repository and stage boundary. Do not choose scope,
answer owner questions, or advance the journey. Repository containment and
artifact validation remain TypeScript-owned; this skill provides guidance only.

## Inputs and outputs schema

Read the repository root, work goal, run identifier, and confirmed resolved plan
directory. Return the plan specification and sibling `repository-map.md`,
distinguishing a new workspace from a resumed one.

## State read and written

Read bounded repository metadata and the confirmed plan workspace when it exists.

Write only the plan directory, `plan-spec.md` stub, bounded repository map, and
Bearing-owned local state needed for resumption.

## Closed-loop workflow

1. Use the confirmed resolved plan directory verbatim.
2. Create or resume it without replacing existing plan content.
3. Build the map, verify both artifacts, and return their relative paths.

## Entry and exit criteria

Enter for `set-bearings` with a valid repository and goal. Exit when the
workspace is ready or resumed and both artifacts are readable; otherwise return
the blocker without advancing.

## Evidence requirements

Evidence is the existing `plan-spec.md` path, the sibling `repository-map.md`
path, and an accurate created-or-resumed summary. Do not invent paths.

## Failure taxonomy

Classify invalid roots or goals as input failures, missing files as artifact
failures, cancellation as cancelled, and other errors by observed diagnostic.

## Escalation and amendment rules

Escalate when an existing workspace conflicts with the goal or safe resumption
is ambiguous. Ask for an owner decision; do not delete, rename, or replace it.

## Metrics and trace events

Bearing records stage activity and zero agent tokens for its deterministic
path. Relevant activity kinds are `stage.started`, `repository-map.started`,
and `workspace.ready` with `created` or `resumed` status.
