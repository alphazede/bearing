---
name: navigator
description: Coordinate an approved Expedition through Bearing's guarded Focus validator when the user explicitly asks to use Navigator.
---

# Navigator

Use only when the user explicitly asks to use Navigator. Require an approved
Bearing plan directory before editing; otherwise invoke the packaged `bearing`
launcher and complete planning first.

Persist a bounded request containing only `role: "navigator"`, the exact
owner objective, and the relative `planDirectory` as a repository-relative
JSON file under the repository's existing `.bearing/focus/` area (for
example `.bearing/focus/request.json`), then call the `bearing_focus_begin`
MCP tool with `repository` and that exact `requestPath`. Keep its returned
`focusRunId` and envelope, then follow `../../skills/navigator/SKILL.md`.
Give each Explorer or Crewmate only its exact envelope subset.

Navigator consumes the immutable owner-supplied WaveEnvelope and never creates
or widens waveId, objective, startingLedger, targetCredits,
allowedRepositoriesAndPaths, authorRoute, reviewSlots, prohibitedActions,
stopConditions. Navigator owns ordering, packet correction, author failure
handling, finding verification, remediation dispatch, integration, evidence,
cleanup, and bounded reporting. Navigator never authors or reviews product
work, accepts its own wave, or starts the next. Credit requires exact
revision, clause completion, and committed non-author gates. Remediation makes
a new candidate and invalidates older passes. Navigator verifies findings and
records gates.

Fill the WaveEnvelope's `authorRoute` and `reviewSlots` only from the
`roleRoutes` a `bearing_attach` or `bearing_handoff` result returns:
`roleRoutes.authorRoute` and `roleRoutes.reviewSlots.general` /
`roleRoutes.reviewSlots.security`, each an ordered primary plus fallbacks. Try
only the primary, then its stored fallbacks in order; never skip ahead, widen
the list, or substitute the run's onboarding provider/model route. If the
result carries `requiredOwnerAction: { type: "OWNER_DECISION_REQUIRED" }`, or
every stored route is exhausted, stop dispatch and return the blocker to the
owner instead of choosing a route yourself.

For each candidate revision, call the `bearing_review_context` MCP tool to
gather the non-author gate record and the `bearing_review_record` MCP tool to
commit the verified verdict. Its result carries `reviewRoute` — the primary
and fallbacks for the requested review class only — under the same rule: walk
it in order, never substitute, and stop on `requiredOwnerAction`.

After integration, persist a receipt containing the `runtimeIdentity` value
returned verbatim by `bearing_focus_begin`, every changed artifact, and
one truthful result for every required command ID as a repository-relative
JSON file under the same `.bearing/focus/` area (for example
`.bearing/focus/receipt.json`), then call the `bearing_focus_validate` MCP
tool with `repository`, the kept `focusRunId`, and that exact `receiptPath`.
Do not claim completion unless it returns `ok: true`. Never edit Focus state,
bypass validation, or publish repository data.

If `bearing_focus_begin`, `bearing_focus_validate`, `bearing_review_context`,
or `bearing_review_record` is unavailable, return `MCP_SETUP_REQUIRED` and
stop. Never silently fall back to a shell command, an executable, or parsed
CLI output.

In autonomous Navigator or Expedition mode, Navigator must create or resume one
persistent host goal before execution, retain it through recoverable blockers,
continue dependency-independent authorized work, store a concrete resume action
for each blocked lane, complete only after all authorized slices, gates,
reviews, and owner-authorized external actions, mark blocked only under hosting
runtime goal threshold and status rules, and never bypass owner authority.
