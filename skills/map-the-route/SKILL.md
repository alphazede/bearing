---
name: map-the-route
description: Build Bearing's complete validated route from an approved plan specification, including design, SEIT, and implementation slices, when the journey enters Map the Route.
user-invocable: false
disable-model-invocation: true
---

# Map the Route

## Mission and non-goals

Follow the substep and artifact boundary supplied by Bearing; do not advance
into execution or invoke another planning skill.

For the design substep, resolve an owner decision only when it blocks honest
design, then write complete `design.md` and `seit.md`. Stop at Bearing's
design-and-SEIT validation checkpoint without drafting `implementation.md`.

For the implementation-drafting substep, reuse the validated design and SEIT.
Write `implementation.md` with traceable, bounded slices and execution manifests
that satisfy Bearing's supplied schema. Do not execute a slice or invoke another
planning skill.

Bearing owns deterministic `review.html` generation. Never hand-edit, summarize,
or replace it. The final review must embed the complete current `plan-spec.md`,
`design.md`, `seit.md`, and `implementation.md` sources with working artifact
links before the owner is asked to approve execution.

## Authority and prohibited actions

Use approved `plan-spec.md`, lens decision, route catalog, and substep. Do not
invent approval, IDs, routes, contracts, or results. Bearing validates artifacts
and generates the review.

Return structured planning state, findings, and artifacts to Navigator.
Do not invoke the next pass or record a planning transition. Bearing's TypeScript capability boundary remains the enforcement.

## Inputs and outputs schema

Read the plan directory, prior Q&A, goal, and substep. Design returns `design.md`
and `seit.md`; drafting returns `implementation.md`; Bearing adds `review.html`.

## State read and written

Read `plan-spec.md` and approved artifacts. Write only `design.md` and `seit.md`
during design, or `implementation.md` during drafting. Preserve stable IDs.

## Closed-loop workflow

1. Resolve the owner lens decision before design.
2. Trace requirements through contracts and prospective SEIT proof.
3. Stop at the design-and-SEIT checkpoint.
4. Draft reference-only slices with matching manifests.
5. Return current artifacts for review generation.

## Entry and exit criteria

Enter with a validated plan specification. Design exits with complete design and
SEIT; drafting then exits with a validated implementation plan. Never execute.

## Evidence requirements

Each slice references existing requirement, design, and SEIT rows. Its manifest
declares exact writes, mapped commands, stop condition, and human decision.

## Failure taxonomy

Distinguish owner question, invalid input or artifact, malformed receipt,
unsupported route, missing trace link, cancellation, interruption, adapter
failure, and token budget.

## Escalation and amendment rules

Ask one question only when design is blocked. Stop for amendment when drafting
exposes a plan or design conflict.

## Metrics and trace events

Report phases, slices, assignments, trace coverage, and paths. Bearing records
`stage.started`, `design.ready`, and `implementation-draft.started`.
