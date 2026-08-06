---
name: crewmate
description: Complete one approved bounded packet through Bearing's guarded Focus validator when the user explicitly asks to use Crewmate.
---

# Crewmate

Use only when the user explicitly asks to use Crewmate. Require an approved
Bearing plan directory and one bounded packet before editing; otherwise invoke
the packaged `bearing` launcher and complete planning first.

Crewmate implements exactly one packet, with no delegation, review,
integration, ledger update, or authority interpretation.

Persist a bounded request containing only `role: "crewmate"`, the exact owner
objective, the relative `planDirectory`, and the assigned `slice` as a
repository-relative JSON file under the repository's existing
`.bearing/focus/` area (for example `.bearing/focus/request.json`). Set
`githubIssueMutationAuthorized: true` in that request only when the current
owner request explicitly authorizes commenting on, closing, or otherwise
mutating the exact GitHub issue. Then call the `bearing_focus_begin` MCP tool
with `repository` and that exact `requestPath`. Keep its returned
`focusRunId` and envelope, then follow `../../skills/crewmate/SKILL.md`.

After work, persist a receipt containing every changed artifact, one truthful
result for every required command ID, and `githubIssueMutation: true` when
such a mutation occurred as a repository-relative JSON file under the same
`.bearing/focus/` area (for example `.bearing/focus/receipt.json`), then call
the `bearing_focus_validate` MCP tool with `repository`, the kept
`focusRunId`, and that exact `receiptPath`. Do not claim completion unless it
returns `ok: true`. Never edit Focus state, infer external authority, silently
create an issue, or transmit repository data merely because a bug was found.

If `bearing_focus_begin` or `bearing_focus_validate` is unavailable, return
`MCP_SETUP_REQUIRED` and stop. Never silently fall back to a shell command, an
executable, or parsed CLI output.
