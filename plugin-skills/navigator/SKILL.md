---
name: navigator
description: Coordinate an approved Expedition through Bearing's guarded Focus validator when the user explicitly asks to use Navigator.
---

# Navigator

Use only when the user explicitly asks to use Navigator. Require an approved
Bearing plan directory before editing; otherwise invoke the packaged `bearing`
launcher and complete planning first.

Resolve the installed `bearing` executable from PATH, or use
`../../dist/cli.js` relative to this file. Write a bounded JSON request under
`.bearing/focus/` containing only `role: "navigator"`, the exact owner objective, and
the relative `planDirectory`. Run `bearing focus begin --request <path>`, keep
its run ID and envelope, then follow `../../skills/navigator/SKILL.md`. Give each
Explorer or Crewmate only its exact envelope subset.

After integration, write a JSON receipt under `.bearing/focus/` containing every
changed artifact and one truthful result for every required command ID. Run
`bearing focus validate --run <run-id> --receipt <path>`. Do not claim completion
unless it returns `ok: true`. Never edit Focus state, bypass validation, or
publish repository data.
