# Verification layers

The four verification questions, the cadence policy that selects gates, and the read-only projections that report them.

Bearing defines four verification questions and their result vocabularies:

- **Validator** asks whether the approved contract was proven with sufficient
  evidence. Its verdict is `PASS`, `NEEDS_MORE_EVIDENCE`, or `FAIL`; escalation is
  `none`, `re_execute_slice`, `park_ranger_gate`, or
  `owner_decision_required`.
- **Grader** asks how strong the completed result is across the quality rubric.
  Its verdict is `strong`, `acceptable`, or `weak`; rubric version 1 is frozen
  and scores each dimension from 0 through 4.
- **Park Ranger** asks whether the code introduced a concrete defect. Findings
  are ranked `P0` through `P3`, and synthesis returns `block`,
  `repair-required`, `accept-with-findings`, or `accept`.
- **Surveyor** asks whether the integrated product behaves correctly for the
  user. It is the independent, read-only reviewer described above.

The shipped surface consists of packaged skill contracts, pure decision
functions for Validator, Grader, and Park Ranger policy, and read-only HTTP
projections for recorded checkpoint summaries and cadence. Invocation differs by
layer. Validator runs automatically: after a Focus execution completes and passes
completion validation, the journey scopes the result and records a Validator
report. Grader, Park Ranger, and the cadence gate sequence are not invoked
automatically at slice, phase, or completion transitions. No layer refuses a
transition because a function returned a particular verdict.

## Review cadence policy

`resolveReviewCadence` recognizes `high-risk`, `unclear-requirements`,
`new-architecture`, `security-sensitive`, `substantial-work`, and
`low-risk-mature-system`. The first four select `per-slice`, while
`substantial-work` selects `per-phase`. When triggers are supplied, a declared
`completion-only` cadence survives only when the sole trigger is
`low-risk-mature-system`.

Resolution is tighten-only: it can raise the declared cadence and never lower
it. `requiredGates` specifies these gate sets:

| Boundary | Resolved cadence | Specified gates |
|---|---|---|
| Slice | `per-slice` | `validator` + `park-ranger` |
| Slice | `per-phase` or `completion-only` | `validator` |
| Phase | `completion-only` | `validator` + `park-ranger` |
| Phase | `per-slice` or `per-phase` | `validator` + `park-ranger` + `grader` |
| Completion | any cadence | `validator` + `park-ranger` + `grader` + `surveyor` |

The table describes policy output; it is not an automatically executed or
server-enforced gate sequence.

## Independent verification preconditions

Independence is checked when a caller invokes the verification functions, not
as an ambient server guarantee. `assertIndependentVerification` returns
`self_certification` when the verifier session id is among the implementer
session ids, and `shared_ancestry` when execution ancestry is non-empty.
`assertIsolatedVerification` rejects a verifier with a provider session id, a
verifier in Focus mode, or a verifier with write or external-action authority.
`assertParkRangerCleanRoom` composes the isolation and independence checks for
Park Ranger lens reports.

## Read-only projections

The local server exposes four authenticated, loopback-only GET projections:

- `GET /api/v1/runs/{runId}/verification/{validator|grader|park-ranger}` returns
  `{ runId, layer, entries }`. Each entry carries `eventId`, `sequence`, `stage`,
  `status`, and `verdict`, with optional `rubricVersion` and `findingCount`.
- `GET /api/v1/runs/{runId}/review-cadence` returns `{ runId, declaredCadence,
  resolvedCadence, requiredGates }`. `resolvedCadence` nests `cadence`,
  `tightened`, and `reasons`; `requiredGates` nests the gate sets for the
  `slice`, `phase`, and `completion` boundaries.

Verification entries are reconstructed from the optional summary on recorded
journey checkpoints. The ledger persists only the layer, verdict, and optional
rubric version and finding count, so full verification reports are neither
persisted nor invented by this endpoint.

The cadence handler reads the declared cadence from the approved execution
contract only after matching its owner approval to a ledger event. It currently
calls the policy with an empty trigger list because no trigger source is
persisted, so this endpoint always reports `tightened: false` and `reasons: []`.

The route patterns bound each run id to 128 characters. Unsupported methods fall
through to `404`, and these projections grant no write or transition authority.

Report ingestion enforces `self_certification` from recorded ledger fact: a verifier whose session
id matches an implementer session on that run is refused. It does **not** enforce
`shared_ancestry`, because no trusted provenance for a verifier's execution ancestry is persisted
yet, and accepting a caller-supplied ancestry would be a control in name only. That check remains
available to callers that can supply trustworthy ancestry; the local endpoint does not claim it.

The control room reads these projections directly: a verification panel shows
each layer's recorded verdict, and the resolved cadence is displayed with its
required gates for the slice, phase, and completion boundaries. The panel issues
only GET requests and grants no transition, approval, or execution authority.
Separately, the review-cadence control in the journey UI selects the cadence
*before* execution; that is an input, not the resolved value shown here.

[Back to the README](../README.md)
