---
name: bearing
description: Launch the local Bearing CLI and begin its planning-first repository journey when the user explicitly invokes or directly requests Bearing.
---

# Bearing

Use only when the user explicitly invokes `$bearing`, `/bearing`, or directly
asks to use Bearing. From the current repository, keep PATH first and run the
installed `bearing` executable with `start --detach` when it is available.
Otherwise resolve `../../dist/cli.js` relative to this `SKILL.md` directory, run
that absolute path with Node and `start --detach`, and report its loopback URL.
Always start a listener from this installed package; never reuse a listener from
another or stale Bearing installation.
Never resolve the fallback from the current or target repository. Bearing
best-effort opens the browser automatically. Then follow Bearing's planning-first
journey.

If the sandbox blocks the Bearing CLI from binding its loopback listener, ask
the owner to approve rerunning the same launch command with host escalation.
Limit that escalation to the Bearing CLI listener; do not weaken the sandbox,
tools, authority, or isolation of any agent Bearing launches.

For a browser-free installed-user workflow, do not run `start`. Set one
absolute target-repository path and stable run ID, then run `bearing journey
create --repo <repository> --provider <provider> --model <model> --reasoning
<level> --run <id> --goal <goal>`. Save its single JSON stdout receipt before
each next command. Use `journey status` or `journey resume` with the same
repository and ID after interruption. Follow only the receipt's
`allowedActions`: record owner answers with `journey decide`, advance named
planning stages with `journey progress --stage <stage>`, run
`journey approve-route` only when route approval is offered, then run
`journey select-explorer --review-cadence <slice|phase|end>` for Explorer.
Each receipt contains `ok`, `runId`, `revision`, optional `stage` and `status`,
and `allowedActions`. A typed `ok: false` receipt leaves journey state
unchanged, though any command may still initialize the repository workspace
directory; do not retry it out of order or substitute browser-only steps.

Do not use for ordinary planning, SessionStart, software installation, runtime
reimplementation, filesystem-wide plugin discovery, target-repository changes,
remote actions, or changes to the host agent's native collaboration behavior.
