# Grading rubric (Validator scoring)

Use only when the task, owner, or phase gate requests **explicit rubric scoring**.
Sufficiency checks always run when Validator is active. Scoring is optional and
never makes independent assurance automatic.

## Dimensions (equal weight unless the plan overrides)

| ID | Dimension | Complete (2) | Partial (1) | Missing (0) |
| --- | --- | --- | --- | --- |
| D1 | Contract coverage | Acceptance criteria and requirement IDs are evidenced | Some criteria evidenced | Major criteria unaddressed |
| D2 | Scope discipline | Diff stays inside declared authority and allowed paths | Minor unexplained adjacency | Out-of-set or authority expansion |
| D3 | Evidence quality | Commands, observed results, and inferences labeled separately | Mixed labels | Fabricated, missing, or unlabeled claims |
| D4 | Command completeness | Declared command IDs have results | Partial command set | Required commands absent |
| D5 | Residual risk | Remaining risks and non-goals disclosed | Vague residual notes | Silent risk omission on material change |
| D6 | Handoff integrity | Return fields match the task block; `candidate_ref` is exact | Incomplete fields | Stale subject or candidate mismatch |

## Score

Sum dimension scores (0–12).

- **10–12** and no required dimension is 0: scoring supports `PASS` only if sufficiency also passes.
- **8–9** or any required dimension is 0: `NEEDS_MORE_EVIDENCE` unless severity is fatal.
- **Below 8**, fabricated evidence, or author self-certification: `FAIL`.

## Composition with sufficiency

1. Run sufficiency on the exact candidate first.
2. If scoring is requested, score the same candidate with this rubric.
3. Final Validator outcome:
   - `FAIL` if either check fails
   - `NEEDS_MORE_EVIDENCE` if either needs more proof
   - `PASS` only when sufficiency passes and (scoring was not requested, or scoring supports PASS)
4. Never edit the candidate. Never score a candidate you authored or materially repaired.

## Non-goals

This rubric does not replace Park Ranger defect review or Surveyor acceptance.
It does not install tools, widen diffs, or select models.
