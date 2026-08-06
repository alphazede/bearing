---
name: gather-supplies
description: Resolve only material owner decisions and produce Bearing's validated plan specification when the journey enters Gather Supplies.
user-invocable: false
disable-model-invocation: true
---

# Gather Supplies

## Mission and non-goals

Inspect the repository once, reuse supplied owner answers, and ask only when an
answer materially changes scope, architecture, security, authority, or
acceptance. Lead each necessary question with a recommendation and concise
evidence. State safe defaults as assumptions instead of asking for approval.

Ask the owner's exact primary agent and ordered fallback agents for each
required execution and review role once, never for credentials; a durable
prior answer suppresses the question on a later run.

During question discovery, do not write files. During apply, update only the
validated plan specification and do not ask another question. Keep requirements
testable and give them stable IDs. Do not design, draft implementation, or edit
product code.

## Authority and prohibited actions

Treat the stage boundary, plan directory, prior owner Q&A, and question allowance
as authoritative. Recommendations are not approval. Do not expand scope or
create design artifacts. Bearing rejects invalid result shapes.

## Inputs and outputs schema

Read the goal, repository, plan directory, prior Q&A, and `gatherMode`. Return a
questions receipt with at most the allowed unique questions, or an apply action
whose artifacts include validated `plan-spec.md`.

## State read and written

Read the plan stub and enough repository evidence to expose material decisions.
Write nothing in questions mode. In apply mode write only the plan specification
with stable requirements, assumptions, decisions, blockers, and the owner's
exact Role routes decision.

## Closed-loop workflow

1. Compare the goal, plan stub, evidence, and prior answers.
2. Ask only material questions with options and a safe default.
3. Apply completed answers without another question.
4. Check testability and return the actual plan path.

## Entry and exit criteria

Enter with a valid plan workspace. Exit questions mode with zero to three
bounded questions, or apply mode with a validated specification.

## Evidence requirements

Cite repository evidence and the affected plan section for each question. In
apply, use the returned plan path and recorded answers; do not claim unrecorded
approval.

## Failure taxonomy

Separate owner decision, input invalid, result malformed, artifact invalid,
adapter failure, cancellation, interruption, and token budget. Preserve the last
valid plan on failure.

## Escalation and amendment rules

Escalate only material scope, architecture, authority, security, or acceptance
decisions. During apply, record a blocker instead of reopening grilling.

## Metrics and trace events

Report question and requirement counts, assumptions, and the plan artifact.
Bearing records `stage.started` and may record `estimate.dropped`.
