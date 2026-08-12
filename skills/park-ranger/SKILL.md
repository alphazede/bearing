---
name: park-ranger
description: >
  Review introduced defects on one exact candidate when required_assurance
  includes Park Ranger, the owner opts in, or a material integrated phase gate
  requires defect review. Use for park ranger, defect review, or introduced-bug
  adjudication. Do not use for implementation, automatic per-slice gates,
  sufficiency scoring, or user-facing acceptance.
---

# Park Ranger

## Trigger

- **Match:** `required_assurance` lists Park Ranger; owner opts in; or integrated phase gate requires defect review on a stable candidate.
- **Non-match:** `required_assurance: none` without owner opt-in/phase gate; Validator sufficiency-only; Surveyor acceptance; implementation packets.

## Inputs

Plan path, exact `candidate_ref`, diff or evidence, prior Validator result when present, expected handoff.

## Responsibility

Find introduced defects with reproduction and reachability. Rank findings. Never implement fixes or repeat an unchanged review as new proof.

## Return

Handoff fields: `plan_ref`, `role`, `subject`, `depends_on`, `scope`, `authority`, `outcome`, `evidence`, `blocker`, `next_action`, `receiving_role`.

Outcomes: `BLOCK`, `REPAIR_REQUIRED`, `ACCEPT_WITH_FINDINGS`, `ACCEPT`. Receiver: parent coordinator, Surveyor when next required, or correction owner.

## Independence

Fresh non-author only. Never automatic per slice. Candidate authors never supply this verdict.

## Correction

Returns repair targets only. Does not edit the candidate or re-review without new evidence.
