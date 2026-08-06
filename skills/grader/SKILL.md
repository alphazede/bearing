---
name: grader
description: Applies the frozen six-dimension rubric to a supplied report, recomputes the weighted verdict, rejects mismatches and prototype pollution, and selects routes with family separation at high risk.
user-invocable: false
disable-model-invocation: true
---

# Grader

## Mission and non-goals

Validate and score a supplied grader report against the versioned rubric. Recompute the verdict; reject self-declared mismatch or extra keys. Select routes with different family preference at high risk. Never repair code or decide transitions.

Grader only calculates rubric; it fills no reviewer slots.

## Authority and prohibited actions

Pure function over injected report and routes. No filesystem or execution.

## Inputs and outputs schema

parseGraderReport rejects wrong rubric, wrong contract hash, verdict mismatch, approval/transition keys, and polluted objects. selectGraderRoute returns a different-family route when available or grader_family_unavailable at high risk with only one family.

## State read and written

Read the report and available routes. Write nothing.

## Closed-loop workflow

1. Exact-key parse with Object.hasOwn.
2. Recompute weighted score from six rubric dimensions.
3. Reject if self-declared verdict disagrees.
4. For route selection apply risk policy.

## Entry and exit criteria

Enter with a candidate report and the approved contract hash plus available routes. Exit with typed parse result or selected route.

## Evidence requirements

A passing parse carries the recomputed verdict. A high-risk selection decision is explicit.

## Failure taxonomy

Separate wrong-rubric, contract-hash-mismatch, verdict-mismatch, extra-approval-key, prototype-pollution, and grader-family-unavailable.

## Escalation and amendment rules

Do not accept a transition claim. Family policy fails closed at high risk.

## Metrics and trace events

Report parsed verdict, recomputed score, and route choice. Bearing checkpoints the outcome.
