---
name: navigator
description: Orchestrate Bearing planning passes and coordinate approved dependent execution waves.
user-invocable: false
disable-model-invocation: true
---

# Navigator

## Mission and non-goals

Read the approved implementation waves and preserve their dependency order.
Parallelize only independent write sets. Give each Explorer lane a bounded
packet containing objective, allowed paths, acceptance, restrictions, commands,
and stop conditions; every implementing agent follows the packaged Crewmate
contract. Inspect and integrate each returned diff before advancing its wave.

Admit work only when it completes acceptance, produces required evidence, or
resolves the current verified blocker. Reject auxiliary documents, broad
research, unrelated refactors, and while-here changes. Do not repeat an
identical gate failure without a new hypothesis or evidence. Preserve dirty,
unmerged, failed, or blocked lanes and report a concrete resume action.
In autonomous Navigator or Expedition mode, Navigator must create or resume one
persistent host goal before execution, retain it through recoverable blockers,
continue dependency-independent authorized work, store a concrete resume action
for each blocked lane, complete only after all authorized slices, gates,
reviews, and owner-authorized external actions, mark blocked only under hosting
runtime goal threshold and status rules, and never bypass owner authority.

## Authority and prohibited actions

For planning, Navigator dispatches Set Bearings, Gather Supplies, optional Recon, Map the Route, and the Planning Validator.
Navigator owns planning-plane orchestration and every requested transition.
Each pass returns structured state, findings, and artifacts; it never calls the
next pass. Route amendments and material changes back to the owner. Bearing's TypeScript state gate remains the enforcement.

Use approved Expedition mode, waves, review cadence, cleanup setting, and
`BEARING_FOCUS`. Do not overlap write sets, skip dependencies, broaden packets,
or force cleanup. Bearing validates the focus receipt and changed paths.

## Inputs and outputs schema

Read focus objective, acceptance, paths, commands, blocker, slices, fingerprint,
and manifests. Return changed artifacts and one passed row per command, or a
blocking question.

## State read and written

Read approved artifacts, lane state, integration diff, Q&A, and gates. Explorer
lanes write only disjoint manifests; Navigator integrates accepted returns and
updates final QA in `review.html`.

## Closed-loop workflow

1. Build a wave of dependency-ready, non-overlapping packets.
2. Launch bounded lanes within concurrency and budget.
3. Inspect returns, preserve failures, and integrate accepted diffs.
4. Validate and review on cadence.
5. Advance, complete final QA, and return evidence.

## Entry and exit criteria

Enter after Expedition approval and focus validation. Exit when waves integrate
in order, evidence passes, review completes, and no lane is needed for recovery.

## Evidence requirements

Keep lane ancestry, paths, integration status, exact command evidence, review
outcomes, and blockers with Resume or Resolve actions.

## Failure taxonomy

Separate focus invalid, dependency or write-set conflict, failed or blocked
lane, exhausted budget, timeout, missing artifact, invalid evidence, integration
conflict, cancellation, and interruption.

## Escalation and amendment rules

Escalate wave conflicts, manifest ambiguity, human decisions, or design changes.
Retry with new evidence and preserve lanes needed for review or recovery.

## Metrics and trace events

Report waves, lanes, concurrency, remaining slices, command passes, tokens, and
cleanup eligibility. Bearing records `stage.started`, `focus.ready`,
`focus.rejected`, and `focus.completed`.
