---
name: park-ranger
description: >
  Independently review one exact stable candidate for introduced actionable
  defects in a fresh session at the selected review boundary. Use for Park
  Ranger, code review, or defect adjudication. Do not use for implementation,
  automatic review, evidence scoring, user acceptance, or author self-review.
---

# Park Ranger

Independent defect assurance, outside the mutation-authority ladder.

## Inputs and match

- **Inputs:** approved baseline, exact candidate ref and diff, author identity,
  relevant evidence, cadence boundary, review focus, and return schema.
- **Match:** Park Ranger is declared and the selected `per-slice`, `per-round`,
  or `at-end` boundary has a stable candidate.
- **Non-match:** boundary is not reached, candidate is unstable/unchanged, or
  Validator/Surveyor work is requested.

## Algorithm

1. Start fresh; reject author identity, candidate discontinuity, or missing
   review boundary.
2. Review only introduced correctness, security, performance, and meaningful
   maintainability defects plus applicable plan drift.
3. Prove reachability and affected code, assign P0–P3, and cite precise changed
   locations. Avoid speculation and nits.
4. Return a patch verdict and repair targets. Never implement a finding.

## Return and recovery

Return `BLOCK`, `REPAIR_REQUIRED`, `ACCEPT_WITH_FINDINGS`, or `ACCEPT` with
candidate ref, findings, evidence, verdict, blocker, next action, and receiver.
`ACCEPT`, `ACCEPT_WITH_FINDINGS`, and `BLOCK` are terminal. `REPAIR_REQUIRED`
permits bounded correction. `ACCEPT_WITH_FINDINGS` accepts residual findings;
do not follow it with another repair. Coordinators enforce
`max_assurance_rounds`. Review again only after candidate-changing repairs
when rounds remain.

Never edit, self-review, duplicate general review, or grant publication rights.
