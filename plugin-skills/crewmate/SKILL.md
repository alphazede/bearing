---
name: crewmate
description: Complete one approved bounded packet through Bearing's guarded Focus validator when the user explicitly asks to use Crewmate.
---

# Crewmate

Use only when the user explicitly asks to use Crewmate. Require an approved
Bearing plan directory and one bounded packet before editing; otherwise invoke
the packaged `bearing` launcher and complete planning first.

Resolve the installed `bearing` executable from PATH, or use
`../../dist/cli.js` relative to this file. Write a bounded JSON request under
`.bearing/focus/` containing only `role: "crewmate"`, the exact owner objective,
the relative `planDirectory`, and the assigned `slice`. Set
`githubIssueMutationAuthorized: true` only
when the current owner request explicitly authorizes commenting on, closing,
or otherwise mutating the exact GitHub issue. Run
`bearing focus begin --request <path>`, keep its run ID and envelope, then
follow `../../skills/crewmate/SKILL.md`.

After work, write a JSON receipt under `.bearing/focus/` containing every changed
artifact, one truthful result for every required command ID, and
`githubIssueMutation: true` when such a mutation occurred. Run
`bearing focus validate --run <run-id> --receipt <path>`. Do not claim completion
unless it returns `ok: true`. Never edit Focus state, infer external authority,
silently create an issue, or transmit repository data merely because a bug was
found.
