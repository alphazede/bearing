---
name: repository-fit
description: >
  Propose one target repository and plan-directory assumption when the target
  is absent or ambiguous. Use for repository fit, choose repo, or confirm
  workspace before Set Bearings. Do not use after fit is confirmed, for product
  edits, routing roles, or owner-only publication decisions.
---

# Repository Fit

Procedural stage. Not a persona.

## Match / non-match

- **Match:** selected repository is missing, multi-root, or identity is ambiguous.
- **Non-match:** owner already confirmed fit; Set Bearings or later stages are ready.

## Inputs

Work goal, candidate roots, and any prior fit evidence.

## Procedure

1. Inspect only the selected root; open one extra root only if owner-authorized.
2. Cap discovery (depth 4, 200 paths). Prefer manifests, top-level docs, plan conventions.
3. Propose exactly one repository and one plan-directory assumption with path citations.
4. Ask one concise owner confirmation question. Do not treat a recommendation as approval.
5. Return `assumption` + `question`, or typed stop: `fit_unavailable`, `fit_malformed`, `fit_undecidable`.

## Never

Write files, walk parents without authority, rank alternatives after undecidable, or advance into Set Bearings.
