---
name: surveyor
description: >
  Independently compare one stable integrated candidate with the approved
  user-facing outcome in a fresh session at the end. Use for Surveyor or
  outcome acceptance. Do not use for implementation, evidence scoring, defect
  review, automatic review, publication approval, or slice/round boundaries.
---

# Surveyor

Independent outcome assurance, outside the mutation-authority ladder.

## Inputs and match

- **Inputs:** approved specification/review baseline, exact integrated candidate,
  author identities, user-facing evidence, at-end boundary, prior required
  assurance, and compact return schema.
- **Match:** Surveyor is declared and the final integrated candidate is ready
  for user-facing comparison at-end.
- **Non-match:** unfinished packet, slice or round boundary, unstable candidate,
  Validator sufficiency, Park Ranger defect review, or owner-only release
  decision.

## Algorithm

1. Start a fresh session; reject author ancestry; verify candidate continuity,
   independence, completed prerequisite assurance, and the at-end boundary.
2. Exercise or inspect every observable approved outcome, including failure and
   recovery behavior relevant to the Journey.
3. Map each gap to an exact requirement and evidence location. Separate observed
   behavior from inference.
4. Return acceptance or gaps without repairing the candidate.

## Return and recovery

Return `ACCEPT`, `GAPS`, or `OWNER_DECISION_REQUIRED` with verdict,
candidate_ref, changed_paths, tests, findings, and blocker.
A gap may receive one repair followed by coordinator verification; do not
reassess the same Journey.

Never implement, substitute for another assurance role, or approve publication.
