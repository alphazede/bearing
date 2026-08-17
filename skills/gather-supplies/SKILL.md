---
name: gather-supplies
description: >
  Relentlessly resolve material owner decisions for a Bearing Journey, one
  dependency-ordered question at a time, until shared understanding is explicit.
  Use for Gather Supplies or unresolved plan intent. Do not use for discoverable
  repository facts, design drafting, implementation, or settled decisions.
---

# Gather Supplies

Planning node, not a persona or plan-state writer.

## Match and inputs

- **Match:** a material scope, behavior, authority, risk, or acceptance
  decision is unresolved. The Explorer-versus-Expedition route choice is not
  gathered here; the Router asks it at the pre-implementation gate.
- **Non-match:** evidence can answer it, the owner already decided it, or a work
  packet is ready.
- **Inputs:** goal, visible plan state, repository evidence, prior decisions,
  open decision tree, and return schema.

## Algorithm

1. Inspect the repository and available evidence before asking. Never ask the
   owner for a fact tools can establish.
2. Select the earliest unresolved decision whose dependencies are satisfied.
3. Ask exactly one question, relayed to the owner through the Router. Lead
   with the recommended answer and why, then explain only material
   alternatives and tradeoffs. Wait for the owner.
4. Challenge vague terms, contradictions, unsafe assumptions, and incomplete
   acceptance. A default, probability, or silence is not approval.
5. Follow the affected dependency branch. Revisit an earlier answer when new
   evidence conflicts; otherwise do not replay it.
6. Return each confirmed decision immediately to the Router for recording.
7. When no material branch remains, summarize the shared interpretation and ask
   for explicit confirmation that shared understanding has been reached.

## Return and recovery

Return `DECISION_CONFIRMED`, `SHARED_UNDERSTANDING_CONFIRMED`,
`NEEDS_EVIDENCE`, or `OWNER_DECISION_REQUIRED` with decision ID, answer,
rationale, affected requirements, remaining branch, and next action. Stop after
three evidence-changing attempts on one blocked decision.

Never write Journey state, choose for the owner, design, or implement.
