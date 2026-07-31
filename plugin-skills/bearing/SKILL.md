---
name: bearing
description: Trigger only on `$bearing`, `/bearing`, or direct Bearing requests. If mode is omitted, ask guided workflow, browser UI, or headless CLI, then follow the answer.
---

# Bearing

If mode is named, do not ask again; otherwise ask and wait:

`How would you like to use Bearing: guided workflow here, browser UI, or headless CLI?`

- **Guided workflow here:** operate here; show decisions and results.
- **Browser UI:** start Bearing; report the loopback URL.
- **Headless CLI:** show commands and JSON receipts.

Resolve once: keep PATH first; use installed `bearing` when available.
Otherwise resolve `../../dist/cli.js` relative to this `SKILL.md` and run that
absolute path with Node. Never search the current or target repository.

## Browser UI

Run `bearing start --detach`. Never reuse another or stale installation's
listener. Bearing best-effort opens the browser automatically. If sandboxing
blocks it, ask before rerunning only that launch with host escalation; do not
weaken agent tools, authority, or isolation.

## Guided workflow or headless CLI

Stay in the current conversation. Use one absolute repository and stable run
ID. Run `bearing journey create --repo <repository> --provider <provider>
--model <model> --reasoning <level> --run <id> --goal <goal>`, then parse exactly
one JSON receipt before acting.

For each later action, run `bearing journey <action>` with the same `--repo`,
`--provider`, `--model`, `--reasoning`, and `--run` flags plus action flags.

Follow only `allowedActions`. Use `journey progress --stage`, `journey decide`
for owner answers, and `journey approve-route` only for explicit route approval.
Use `journey select-execution --mode <explorer|expedition> --review-cadence
<slice|phase|end>` for Explorer or Expedition; accept `journey select-explorer`
only as legacy compatibility.

Receipts include `ok`, `runId`, `revision`, `allowedActions`, and optional
`requiredOwnerAction`, `outcome`, summary, or artifacts. An `ok: false` receipt
proves no progress. Show any owner action and wait; never infer authorization.

A failed or stopped same-stage Focus amendment sets
`requiredOwnerAction.type: confirm-amendment` and `requiredOwnerAction.prompt`.
Run `journey confirm-amendment` only after explicit approval; it takes no
action-specific flags. Never infer or auto-issue it.
After interruption use `journey status` or `journey resume`. If `readiness:
unavailable`, allow only `status` and `resume`, with no mutating
`requiredOwnerAction`, until repaired. Continue through review. Stop only at
`status: complete` with final summary or artifacts, owner cancellation, or a
typed blocked `outcome` lacking recovery. Report failed and stopped honestly;
attempt only an advertised recovery action.
Do not use for ordinary planning, SessionStart, installation, remote actions,
filesystem-wide plugin discovery, runtime reimplementation, or changes to the
host agent's native collaboration behavior.
