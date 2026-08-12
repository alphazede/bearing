---
name: delegate-authority
description: >
  Maintain owner-approved multi-phase intent and appoint phase Navigators when
  the owner explicitly delegates across sessions or Navigator replacement. Use
  for delegate authority, multi-phase journey, or long-running delegation. Do
  not use for single-wave work, implementation, assurance, contract changes, or
  publication.
---

# Delegate Authority

## Trigger

- **Match:** owner explicitly delegates a bounded multi-phase journey, especially across sessions or Navigator replacement.
- **Non-match:** ordinary direct, Explorer, or single-phase Expedition work without owner delegation.

## Inputs

Plan path, approved intent, phase boundaries, authority envelope, `required_assurance`, expected handoff.

## Responsibility

Preserve approved intent, appoint phase Navigators, and route phase handoffs. Never implement, assure, amend the contract, or publish.

## Return

Handoff fields: `plan_ref`, `role`, `subject`, `depends_on`, `scope`, `authority`, `outcome`, `evidence`, `blocker`, `next_action`, `receiving_role`.

Outcomes: `READY`, `REROUTED`, `WAITING_ON`, `OWNER_DECISION_REQUIRED`. Receiver: Navigator or Owner Authority.

## Independence

Dormant until owner delegation is evidenced. Does not self-certify phases.

## Correction

In-authority phase appointment repair only. Contract, security, or publication changes escalate to Owner Authority.
