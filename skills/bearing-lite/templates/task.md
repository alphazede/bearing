# Task record template

Use one compact Markdown block per task in the project's existing plan or progress document. Omit unused conditional fields. Prefer the project's format; add only missing fields. Do not create a Bearing-owned state file or hidden ledger.

## Journey settings

Record these plan-level choices above the task blocks. Lineup identities and
`review_cadence` are recorded before Map the Route; `journey` is recorded at the
route review, where active/standby/unused role states are finalized once Map the
Route reveals the wave and dependency structure. Completing role states at the
route review is part of the initial `lineup_snapshot`, not a replacement
amendment.

```markdown
- journey: <Explorer Journey | Expedition>
- review_cadence: <per-slice | per-round | at-end>
- choice_basis: <owner-confirmed recommendation and reason>
- lineup_snapshot: <named primary/fallback instances; role-state classification completed at route review>
```

`review_cadence` selects where the Journey's single independent review runs,
not task-level tests or author self-checks. Never infer it from
`required_assurance` on an individual task. `per-slice` and `per-round` select
one declared boundary; `at-end` selects the final integrated candidate. The
Router asks the owner to confirm both the applicable lineup and boundary before
implementation.
`journey` stays unrecorded until the mapped implementation graph exists; a
resumed Journey without a recorded type does not re-ask early or block
Repository Fit, Set Bearings, or Gather Supplies.
`lineup_snapshot` is authoritative for this Journey after recording. Later
edits to `~/.agents/bearing-lite/default-role-lineup.md` have no effect.
Replace it only through an explicit owner-confirmed dated visible amendment.
Record the amendment date beside the replacement values. Dispatch identities
come from this snapshot, not from the current global defaults file.

## Checkout lease (record before any planning write)

The Router's first write is this visible lease. Inventory nonterminal Journeys
first. Do not dispatch or write other planning state until the lease is
`active` for this Journey.

```markdown
- checkout_lease:
  - journey: <Journey id>
  - controller: <Router>
  - repository: <canonical repository>
  - checkout: <worktree or checkout identity>
  - branch: <branch>
  - candidate_revision: <candidate revision>
  - acquired_at: <acquisition time>
  - generation: <positive integer>
  - state: <active | released>
```

Same checkout plus a live other Journey returns `WAITING_ON` with sanitized
competing Journey and controller identities. Distinct explicitly approved
compatible worktrees may proceed. Resume keeps the same generation and does
not duplicate dispatch. Authorized same-Journey candidate progress whose
parent is the current leased revision refreshes `candidate_revision` on the
same generation. `COMPLETE` or `CANCELLED` releases the lease exactly
once. Stale recovery is explicit, recorded, increments generation, and cannot
steal a live lease. Process discovery cannot replace this durable lease.

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
- assurance_rounds: <0-1 completed assurance rounds for this Journey>
```

`candidate_ref` must not claim stronger provenance than the client can prove.
`assurance_rounds` counts the Journey's single submission to required assurance
against Bearing Lite `max_assurance_rounds`. A repair or replacement candidate
does not reset it; only a separately scoped, materially changed new Journey starts at 0, and a new Journey is not a way around the bound. The parent
coordinator writes the count before dispatch. If the review permits correction, spend at
most one remaining `attempts` repair, run deterministic coordinator verification,
and close the gate without another review. A failed repair or scope change
returns `OWNER_DECISION_REQUIRED`.

## Waiting or correcting only

```markdown
- blocker: <WAITING_ON:<task-id> | typed reason | none on success>
- attempts: <0-3 correction attempts for this task or protected action>
```

Omit `blocker` and `attempts` when the task is not waiting or correcting. Waiting does not consume correction attempts.

`COMPLETE` ends Bearing assurance. An already authorized deployment keeps its
own operational checks and rollback evidence but does not reopen independent
review. Any source or candidate change during deployment is separately scoped.

## Single-writer reminder

Only the parent coordinator updates this block after rereading it. Crewmate, Validator, Park Ranger, and Surveyor return handoffs; the coordinator records transitions. Navigator alone changes cross-wave dependencies or global sequencing.
