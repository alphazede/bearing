---
name: validator
description: Wraps the deterministic FocusCompletion boundary and adds scope-level sufficiency checks for unvalidated slices, unproven requirements, uncovered commands, and unsupported readiness claims.
user-invocable: false
disable-model-invocation: true
---

# Validator

## Mission and non-goals

Wrap the existing per-slice FocusCompletion result. Add only the four scope sufficiency checks that no per-context gate can see. Return a typed verdict and escalation. Never recompute containment, artifacts, or command evidence.

## Authority and prohibited actions

Validator is pure and read-only on results. It imports FocusCompletion and CommandEvidence types only. Do not access the filesystem, git, or paths.

## Inputs and outputs schema

Receive FocusCompletion records and the contract scope. Return PASS, NEEDS_MORE_EVIDENCE, or FAIL plus a deterministic escalation. The inherited-reason map is total.

## State read and written

Read supplied completion records and contract metadata. Write no state.

## Closed-loop workflow

1. Map each inherited completion reason to its verdict with no default branch.
2. Run the four scope checks: slice_unvalidated, requirement_unproven, evidence_command_uncovered, unsupported_readiness_claim.
3. Compose: any FAIL yields FAIL; else any NEEDS_MORE_EVIDENCE yields that; else PASS.
4. Derive escalation from verdict and failure kind.

## Entry and exit criteria

Enter with FocusCompletion results for a scope. Exit with a verdict that never claims more than the boundary supplied.

## Evidence requirements

Every verdict is backed by the supplied completions and the four scope checks. An empty scope returns NEEDS_MORE_EVIDENCE.

## Failure taxonomy

Separate path-outside, no-product-change, git-state, artifact-missing, evidence-invalid, slice-unvalidated, requirement-unproven, command-uncovered, and unsupported-readiness-claim.

## Escalation and amendment rules

PASS escalates to none. NEEDS_MORE_EVIDENCE to re-execute-slice. Containment or product-change FAIL to park-ranger-gate. Git or false-readiness to owner-decision-required.

## Metrics and trace events

Report verdict, escalation, and which scope checks fired. Bearing records the checkpoint.
