---
name: explorer
description: Run an approved Explorer route through Bearing's guarded Focus validator when the user explicitly asks to use Explorer.
---

# Explorer

Use only when the user explicitly asks to use Explorer. Require an approved
Bearing plan directory before editing; otherwise invoke the packaged `bearing`
launcher and complete planning first.

Resolve the installed `bearing` executable from PATH, or use
`../../dist/cli.js` relative to this file. Write a bounded JSON request under
`.bearing/focus/` containing only `role: "explorer"`, the exact owner objective, and
the relative `planDirectory`. Run `bearing focus begin --request <path>`, keep
its run ID and envelope, then follow `../../skills/explorer/SKILL.md` and pass
the relevant envelope subset to any Crewmate.

After work, write a JSON receipt under `.bearing/focus/` containing every changed
artifact and one truthful result for every required command ID. Run
`bearing focus validate --run <run-id> --receipt <path>`. Do not claim completion
unless it returns `ok: true`. Never edit Focus state, bypass validation, or
publish repository data.
