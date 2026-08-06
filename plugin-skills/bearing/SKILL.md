---
name: bearing
description: Trigger only on `$bearing`, `/bearing`, or direct Bearing requests. If mode is omitted, ask guided workflow, browser UI, or headless CLI, then follow the answer.
---

# Bearing

If mode is named, do not ask again; otherwise ask and wait:
`How would you like to use Bearing: guided workflow here, browser UI, or headless CLI?`
Resolve once: run `node <bundled dist/cli.js> resolve-cli`, where `<bundled dist/cli.js>` is `../../dist/cli.js` relative to this `SKILL.md`, and parse its one JSON receipt. Use exactly the `path` it reports for the rest of this session. A PATH-installed `bearing` is used only when the receipt's `reason` is `path_preferred` (proven compatible provenance and version); any other reason (`path_unavailable`, `path_provenance_unverified`, `runtime_version_mismatch`) means the bundled CLI is effective — never silently fall back to an older or unverified PATH binary, and surface the reason if asked. Never search the current or target repository.

## Guided workflow
Use only the `bearing_attach`, `bearing_transition`, and `bearing_handoff` MCP tools. Never silently fall back to the CLI. If absent, report typed setup blocker naming the missing `bearing` MCP server and stop.

Attach first, act only on the `allowedActions` it returns, and pass its `revision` back as `expectedRevision` on every transition. Stale: attach again. Handoff for continuation.

## Browser UI
Run `bearing start --detach`. Never reuse another or stale installation's listener. Bearing best-effort opens the browser automatically. If sandboxing blocks it, ask before rerunning only that launch with host escalation; do not weaken agent tools, authority, or isolation.

## Headless CLI
Stay in current conversation. Run `bearing journey create --repo <repository> --provider <provider> --model <model> --reasoning <level> --run <id> --goal <goal>`, parse one JSON receipt.

For each later action, run `bearing journey <action>` with the same `--repo`, `--provider`, `--model`, `--reasoning`, and `--run` flags plus action flags.

Follow only `allowedActions`. Use `journey progress --stage`, `journey decide` for owner answers, and `journey approve-route` only for explicit route approval. Use `journey select-execution --mode <explorer|expedition> --review-cadence <slice|phase|end>`; accept `journey select-explorer` only as legacy compatibility.

Receipts include `ok`, `runId`, `revision`, `allowedActions`, and optional `requiredOwnerAction`, `outcome`, summary, or artifacts. An `ok: false` receipt proves no progress. Show any owner action and wait; never infer authorization.

A failed or stopped same-stage Focus amendment sets `requiredOwnerAction.type: confirm-amendment` and `requiredOwnerAction.prompt`. Run `journey confirm-amendment` only after explicit approval; it takes no action-specific flags. Never infer or auto-issue it.

After interruption use `journey status` or `journey resume`. If `readiness: unavailable`, allow only `status` and `resume`, with no mutating `requiredOwnerAction`, until repaired. Continue through review. Stop only at `status: complete` with final summary or artifacts, owner cancellation, or a typed blocked `outcome` lacking recovery. Report failed and stopped honestly; attempt only an advertised recovery action.

Do not use for ordinary planning, SessionStart, installation, remote actions, filesystem-wide plugin discovery, runtime reimplementation, or changes to the host agent's native collaboration behavior.
