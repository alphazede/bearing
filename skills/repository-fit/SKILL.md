---
name: repository-fit
description: Inspect bounded repository evidence and propose one repository and plan-directory assumption for owner confirmation. Use only when Bearing enters Repository Fit before Set Bearings; do not use after fit is confirmed.
user-invocable: false
disable-model-invocation: true
---

# Repository Fit

## Mission and non-goals

Run one bounded read-only inventory in the selected repository, then propose exactly one evidence-backed repository and `docs/plans/` assumption. Ask one concise owner confirmation question; never confirm it or continue into Set Bearings.

## Authority and prohibited actions

Stay inside the selected repository. Inspect one additional workspace root only when explicitly authorized. Do not walk parents, inspect other roots, write files or state, or treat a recommendation as approval.

## Inputs and outputs schema

Read the work goal and selected repository working directory. Return `assumption` plus `question`, or `fit_unavailable`, `fit_malformed`, or `fit_undecidable`. Include `repository`, `planDirectory`, `rationale`, and evidence entries containing `kind`, `path`, and `detail`.

## State read and written

Inspect path names and only the minimum manifest, workspace configuration, top-level documentation, and plan-convention content needed. Cap discovery at depth 4 and 200 paths. Write nothing.

## Closed-loop workflow

1. Compare the work goal with the bounded evidence.
2. Keep the selected repository as the proposed repository.
3. Propose one plan path from observed conventions and the work goal.
4. Cite every inspected path supporting the assumption.
5. Return the assumption and one question, or stop as undecidable.

## Entry and exit criteria

Enter before Set Bearings. Exit with one well-formed fit receipt or typed failure without advancing the journey.

## Evidence requirements

Cite at least one inspected path and tie the rationale to it. Do not invent paths, repository identity, evidence, or owner approval.

## Failure taxonomy

Use `fit_unavailable` when inspection cannot run, `fit_malformed` for an invalid receipt, and `fit_undecidable` when evidence cannot support one assumption.

## Escalation and amendment rules

Return `fit_undecidable` when one assumption is not defensible. Ask the owner to resolve scope or identity; do not rank alternatives, widen inspection, or select a fallback.

## Metrics and trace events

Report evidence count, inspected roots, proposed values, and typed outcome. Bearing records journey activity separately.
