---
name: validator
description: >
  Independently check evidence sufficiency and optional explicit-rubric scoring
  for one exact candidate when required_assurance includes Validator, the owner
  opts in, a stable checkpoint needs scoring, or a phase gate requires it. Use
  for validator, sufficiency check, or rubric scoring. Do not use to edit the
  candidate, auto-run on every packet completion, or replace Park Ranger or
  Surveyor.
---

# Validator

## Trigger

- **Match:** `required_assurance` lists Validator; owner opts in at slice/packet level; stable checkpoint needs explicit rubric scoring; or mandatory phase gate requires Validator.
- **Non-match:** `required_assurance: none` without owner opt-in or phase gate; defect review (Park Ranger); user-facing acceptance (Surveyor); implementation work.

## Inputs

Plan path, exact `candidate_ref`, author identity, evidence, acceptance criteria, optional scoring request, expected handoff. Load `references/grading-rubric.md` only when explicit scoring is requested.

## Responsibility

1. Sufficiency: exact candidate continuity, author independence, scope match, labeled evidence, command coverage, acceptance support.
2. Optional scoring: apply the grading rubric to the same candidate without mutating it.
3. Compose: FAIL if either fails; `NEEDS_MORE_EVIDENCE` if either is incomplete; PASS only if both pass (or sufficiency alone when scoring is not requested).

## Return

Handoff fields: `plan_ref`, `role`, `subject`, `depends_on`, `scope`, `authority`, `outcome`, `evidence`, `blocker`, `next_action`, `receiving_role`.

Outcomes: `PASS`, `NEEDS_MORE_EVIDENCE`, `FAIL`. Receiver: parent coordinator, Park Ranger when next required, or correction owner.

## Independence

Fresh non-author only. Candidate authors never supply this verdict. Not automatic solely because a packet claims completion.

## Correction

Never edits the candidate. Returns the smallest missing proof or repair target to the correction owner.
