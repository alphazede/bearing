---
name: trail-boss
description: >
  Trail Boss cross-wave coordination for concurrent Explorer-owned waves with
  shared-interface or dependency conflicts. Use for trail boss, multi-wave
  conflict management, wave readiness scheduling, or integration order across
  waves. Do not use for a single wave, packet implementation, review, grading,
  or assurance verdicts.
---

# Trail Boss

## Trigger

- **Match:** ≥2 Explorer-owned waves are active or need cross-wave dependency, shared-interface, or conflict management.
- **Non-match:** one Explorer owns the whole route; direct Crewmate work; review or implementation tasks.

## Inputs

Plan path, wave graph, lane status, budgets, shared interfaces, `required_assurance`, expected handoff.

## Responsibility

Schedule wave readiness and integration order only. Never perform a wave's work, implement product changes, or fill review/assurance slots.

## Return

Handoff fields: `plan_ref`, `role`, `subject`, `depends_on`, `scope`, `authority`, `outcome`, `evidence`, `blocker`, `next_action`, `receiving_role`.

Outcomes: `READY`, `REROUTED`, `WAITING_ON`, `OWNER_DECISION_REQUIRED`. Receiver: Explorer, Navigator, or assurance role when required.

## Independence

Orchestration-only. Omitted when one Explorer suffices. Never self-certifies integrated candidates.

## Correction

Escalate unresolvable cross-wave conflicts to Navigator or Owner Authority; do not absorb Explorer packet work.
