---
name: bearing
description: Launch the local Bearing CLI and begin its planning-first repository journey when the user explicitly invokes or directly requests Bearing.
---

# Bearing

Use only when the user explicitly invokes `$bearing`, `/bearing`, or directly
asks to use Bearing.

## Browser request

For a browser request, keep PATH first and run the installed `bearing`
executable with `start --detach` when it is available. Otherwise resolve
`../../dist/cli.js` relative to this `SKILL.md` directory, run that absolute
path with Node and `start --detach`, and report its loopback URL. Always start a
listener from this installed package; never reuse a listener from another or
stale Bearing installation. Never resolve the fallback from the current or
target repository. Bearing best-effort opens the browser automatically. Then
follow Bearing's planning-first journey.

If the sandbox blocks the Bearing CLI from binding its loopback listener, ask
the owner to approve rerunning the same launch command with host escalation.
Limit that escalation to the Bearing CLI listener; do not weaken the sandbox,
tools, authority, or isolation of any agent Bearing launches.

## Explicit CLI or headless request

When the user explicitly asks to run Bearing `via CLI` or headless, use the
browser-free `bearing journey` commands. Stay in the current conversation. Set
one absolute target repository and one stable run ID, and use them for the
whole loop. Run `bearing journey create --repo <repository> --provider
<provider> --model <model> --reasoning <level> --run <id> --goal <goal>`, then
parse exactly one JSON stdout receipt before acting again. After interruption,
use `bearing journey status` or `bearing journey resume` with that same
repository and run ID.

Follow only safe transitions named by `allowedActions`. When there is no
`requiredOwnerAction`, advance an advertised planning stage with `bearing
journey progress --stage <stage>`. When `requiredOwnerAction` is present, show
its bounded question, prompt, modes, or artifacts to the owner and wait. Record
an answer with `bearing journey decide`; use `bearing journey approve-route`
only for route approval. For execution selection, prefer `bearing journey
select-execution --mode <explorer|expedition> --review-cadence
<slice|phase|end>` for Explorer or Expedition. Accept `bearing journey
select-explorer --review-cadence <slice|phase|end>` only as the legacy Explorer
compatibility form. Never infer an owner answer or treat an allowed action as
owner authorization.

For a failed or stopped same-stage Focus amendment, the receipt advertises
`bearing journey confirm-amendment`, sets `requiredOwnerAction.type:
confirm-amendment`, and supplies `requiredOwnerAction.prompt`. Present the
prompt and wait. Only after explicit owner approval may you run `bearing
journey confirm-amendment --repo <repository> --provider <provider> --model
<model> --reasoning <level> --run <id>`. It takes no action-specific flags and
retries that Explorer or Expedition stage. Never infer or auto-issue this owner
action.

Continue through execution and the advertised `bearing journey progress
--stage review` transition. Receipts carry `ok`, `runId`, `revision`,
`allowedActions`, and, when applicable, `stage`, `status`, `question`,
`summary`, `artifacts`, `requiredOwnerAction`, and typed `outcome`. A typed
`ok: false` receipt does not prove progress. Report failed and stopped outcomes
honestly and attempt only an advertised recovery action. End the loop only for
`status: complete` with a complete outcome and final summary or artifacts, for
owner cancellation, or for a reported blocker.

If a read receipt reports `readiness: unavailable`, it advertises only `status`
and `resume`, with no mutating `requiredOwnerAction`. Repair or select an
available provider route before attempting another transition.

Do not use for ordinary planning, SessionStart, software installation, runtime
reimplementation, filesystem-wide plugin discovery, target-repository changes,
remote actions, or changes to the host agent's native collaboration behavior.
