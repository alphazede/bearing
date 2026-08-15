# Task record template

Use one compact Markdown block per task in the project's existing plan or progress document. Omit unused conditional fields. Prefer the project's format; add only missing fields. Do not create a Bearing-owned state file or hidden ledger.

## Journey settings (record before task mapping)

Record these plan-level choices once, above the task blocks:

```markdown
- journey: <Explorer Journey | Expedition>
- review_cadence: <per-slice | per-round | at-end>
- choice_basis: <owner-confirmed recommendation and reason>
- lineup_snapshot: <named active, standby, and unused role instances>
```

`review_cadence` controls independent review frequency, not task-level tests or
author self-checks. Never infer it from `required_assurance` on an individual
task. `per-round` means after each integrated execution or correction round;
`at-end` means one review of the final integrated candidate. The Router asks the
owner to confirm both the applicable lineup and cadence before implementation.

## Always present

```markdown
### task_id: T1
- outcome: <approved user-visible outcome for this task>
- status: PROPOSED
- assigned_role: <role or unassigned>
- depends_on: []
- next_action: <smallest concrete next step>
```

Field rules:

- `task_id` — stable identifier unique within the plan.
- `outcome` — approved intent for this task only.
- `status` — one of `PROPOSED`, `READY`, `WAITING_ON`, `IN_PROGRESS`, `EVIDENCE_READY`, `VALIDATING`, `REVIEWING`, `ACCEPTANCE`, `CORRECTION_REQUIRED`, `OWNER_DECISION_REQUIRED`, `COMPLETE`, `CANCELLED`.
- `assigned_role` — current role contract for the active step, or unassigned while proposing.
- `depends_on` — list of other `task_id` values only, never prose.
- `next_action` — the immediate allowed step.

## Before execution (add when leaving PROPOSED)

```markdown
- scope: <allowed paths, systems, and boundaries>
- authority: <approved envelope; protected actions remain owner-only>
- required_assurance: [Validator]
```

`required_assurance` lists only roles that must accept the same candidate (for example `Validator`, and `Park Ranger` or `Surveyor` when their triggers apply).

## After candidate work (add when evidence exists)

```markdown
- candidate_ref: <strongest native revision or changed-path reference available>
- evidence: <commands run, results observed, and inferences labeled separately>
```

`candidate_ref` must not claim stronger provenance than the client can prove.

## Waiting or correcting only

```markdown
- blocker: <WAITING_ON:<task-id> | typed reason | none on success>
- attempts: <0-3 correction attempts for this task or protected action>
```

Omit `blocker` and `attempts` when the task is not waiting or correcting. Waiting does not consume correction attempts.

## Single-writer reminder

Only the parent coordinator updates this block after rereading it. Crewmate, Validator, Park Ranger, and Surveyor return handoffs; the coordinator records transitions. Navigator alone changes cross-wave dependencies or global sequencing.
