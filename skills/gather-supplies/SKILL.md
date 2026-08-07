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
acceptance. Open each necessary question with the explicit ask sentence, then
lead the details with **Recommendation:**, concise **Evidence:**, the
**Options:** with material tradeoffs, the **Affected section:** of the
plan-spec, and the **Safe default:** if unanswered. State safe defaults as
assumptions instead of asking for approval.

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
with stable requirements, assumptions, decisions, blockers, the owner's exact
Role routes decision, and — when the plan declares it — the complete
`## Risk Profile` declaration: every known risk flag enumerated with applies
yes or no and, per flag, either cross-artifact coverage (a design section or
SYS- system, a SEIT row, and a slice) or an evidence-backed not-applicable
rationale. A declared profile binds the whole closed flag set; an incomplete
enumeration fails validation.

## Closed-loop workflow

1. Compare the goal, plan stub, evidence, and prior answers.
2. Ask only material questions, each opening with the explicit ask and leading
   with the labeled details. Never re-ask a decision already recorded in the
   prior owner Q&A; Bearing drops the re-ask and reuses the recorded answer,
   and presents a question changed in substance as an explicit amendment of the
   prior decision.
3. Apply completed answers without another question.
4. Check testability and return the actual plan path.

## Entry and exit criteria

Enter with a valid plan workspace. Exit questions mode with zero to three
bounded questions, or apply mode with a validated specification.

## Evidence requirements

Cite repository evidence and the affected plan section for each question, and
name that section in the **Affected section:** label. Keep the explicit ask
sentence stable across runs: only the options or the safe default may change
for the same decision. In apply, use the returned plan path and recorded
answers; do not claim unrecorded approval.

## Failure taxonomy

Separate owner decision, input invalid, result malformed, artifact invalid,
adapter failure, cancellation, interruption, and token budget. Preserve the last
valid plan on failure.

## Escalation and amendment rules

Escalate only material scope, architecture, authority, security, or acceptance
decisions. During apply, record a blocker instead of reopening grilling. A
recorded owner answer always wins over any safe default from the same question;
never overwrite a recorded answer with a default or an assumption.

## Metrics and trace events

Report question and requirement counts, assumptions, and the plan artifact.
Bearing records `stage.started` and may record `estimate.dropped`.
