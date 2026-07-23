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

Do not use for ordinary planning, SessionStart, software installation, runtime
reimplementation, filesystem-wide plugin discovery, target-repository changes,
remote actions, or changes to the host agent's native collaboration behavior.
