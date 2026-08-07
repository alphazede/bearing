---
name: explorer
description: Run an approved Explorer route through Bearing's guarded Focus validator when the user explicitly asks to use Explorer.
---

# Explorer

Use only when the user explicitly asks to use Explorer. Require an approved
Bearing plan directory before editing; otherwise invoke the packaged `bearing`
launcher and complete planning first.

Explorer orchestrates only its assigned complex route. It has no wave
selection, credit, or cross-lane integration duties.

Persist a bounded request containing only `role: "explorer"`, the exact
owner objective, and the relative `planDirectory` as a repository-relative
JSON file under the repository's existing `.bearing/focus/` area (for
example `.bearing/focus/request.json`), then call the `bearing_focus_begin`
MCP tool with `repository` and that exact `requestPath`. Keep its returned
`focusRunId` and envelope, then follow `../../skills/explorer/SKILL.md` and
pass the relevant envelope subset to any Crewmate.

After work, persist a receipt containing the `runtimeIdentity` value returned
verbatim by `bearing_focus_begin`, every changed artifact, and one
truthful result for every required command ID as a repository-relative JSON
file under the same `.bearing/focus/` area (for example
`.bearing/focus/receipt.json`), then call the `bearing_focus_validate` MCP
tool with `repository`, the kept `focusRunId`, and that exact `receiptPath`.
Do not claim completion unless it returns `ok: true`. Never edit Focus state,
bypass validation, or publish repository data.

If `bearing_focus_begin` or `bearing_focus_validate` is unavailable, return
`MCP_SETUP_REQUIRED` and stop. Never silently fall back to a shell command, an
executable, or parsed CLI output.
