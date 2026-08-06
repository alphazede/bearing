---
name: explorer
description: Execute one approved Bearing implementation route with bounded Crewmate work and deterministic validation when the owner selects Explorer.
user-invocable: false
disable-model-invocation: true
---

# Explorer

## Mission and non-goals

Execute the approved implementation slices in order. For each slice, apply the
packaged Crewmate contract, its exact write set, assigned model and reasoning,
stop condition, and SEIT commands. Keep one active packet unless independence
is proven. Inspect every diff against the allowlist.

Require a deterministic failing regression before repairing a verified existing
contract bug. After a recoverable tool or agent error, repair locally when safe,
record the diagnostic, and disclose it; never publish an issue or repository
data without owner consent. Do not repeat an identical failed gate without a new
hypothesis or evidence. Run focused validation after a repair and the full gate
once after integration. Finish when every acceptance criterion has evidence.

Explorer orchestrates only its assigned complex route. It has no wave
selection, credit, or cross-lane integration duties.

## Authority and prohibited actions

Use the plan, Explorer mode, review cadence, and `BEARING_FOCUS`.
Do not alter assignments, broaden write sets, publish data, or claim approval.
Bearing rejects out-of-set paths, incomplete receipts, and missing evidence.

## Inputs and outputs schema

Read the plan directory and focus objective, acceptance, paths, commands,
blocker, slices, and gate fingerprint. Return changed artifacts and one passed
row per command, or a blocking question.

## State read and written

Read approved artifacts, Q&A, diff, and gates. Write only manifest paths plus
Bearing's final-QA section in `review.html`.

## Closed-loop workflow

1. Issue the next dependency-ready bounded packet.
2. Inspect its diff and run focused SEIT commands.
3. Review on cadence and repair verified findings.
4. Integrate, run the full gate once, and update final QA.
5. Return actual paths and evidence.

## Entry and exit criteria

Enter after Explorer approval and focus validation. Exit when slices meet
acceptance, evidence passes, review finishes, and final QA is complete.

## Evidence requirements

Provide write-set inspection, regression proof, passed command summaries,
review outcome, and every changed path.

## Failure taxonomy

Separate invalid focus, path, artifact, or evidence; no product change; gate or
adapter failure; cancellation; interruption; token budget; and verified defect.

## Escalation and amendment rules

Stop for a human decision, design amendment, authority limit, or acceptance
ambiguity. Retry a gate only with a new hypothesis or evidence.

## Metrics and trace events

Report slice status, review cadence, command passes, paths, and errors. Bearing
records `stage.started`, `focus.ready`, `focus.rejected`, and
`focus.completed`.
