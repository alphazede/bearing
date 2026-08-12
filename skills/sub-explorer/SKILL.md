---
name: sub-explorer
description: >
  Orchestrate bounded packets inside one Explorer-owned wave when at least two
  proven-independent lanes need one extra coordination level. Use for
  sub-explorer or in-wave lane coordination. Do not use as a second nesting
  level, for product implementation, multi-wave control, or assurance.
---

# Sub-explorer

## Trigger

- **Match:** one Explorer-owned wave has ≥2 proven-independent lanes and one extra coordination level materially reduces context or conflict.
- **Non-match:** single lane; nested Sub-explorer requests; Trail Boss multi-wave work; direct Crewmate packets.

## Inputs

Parent wave plan path, lane boundaries, packet specs, dependencies, authority, `required_assurance`, expected handoff.

## Responsibility

Orchestrate in-wave packets only. Maximum one Sub-explorer level. Never perform packets, expand parent wave authority, or assure results.

## Return

Handoff fields: `plan_ref`, `role`, `subject`, `depends_on`, `scope`, `authority`, `outcome`, `evidence`, `blocker`, `next_action`, `receiving_role`.

Outcomes: `READY`, `REROUTED`, `WAITING_ON`, `OWNER_DECISION_REQUIRED`. Receiver: Crewmate or Explorer.

## Independence

Dormant unless independence is proven. Does not substitute for Explorer, Trail Boss, or Navigator.

## Correction

Return lane conflicts to Explorer. Out-of-wave expansion escalates to parent coordinator.
