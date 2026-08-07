# Headless CLI

The browser-free journey, its receipt grammar, and every accepted start flag.

## Headless journey

When a user explicitly asks to run Bearing `via CLI` or headless, the host model
uses the browser-free journey in the same user conversation; it does not run
`start --detach`. Set `REPOSITORY` to the absolute path of the target Git
repository and choose one stable `RUN_ID`. Keep both for the whole journey and
parse stdout from each command as exactly one JSON receipt before acting again.

```sh
bearing journey create --repo "$REPOSITORY" --provider codex --model <model> --reasoning medium --run "$RUN_ID" --goal "<goal>" > 01-create.json
bearing journey status --repo "$REPOSITORY" --provider codex --model <model> --reasoning medium --run "$RUN_ID" > 02-status.json
# When the receipt allows it, record the owner's answer; decide submits that waiting stage.
bearing journey decide --repo "$REPOSITORY" --provider codex --model <model> --reasoning medium --run "$RUN_ID" --answer "<recorded answer>" > 03-decision.json
bearing journey progress --repo "$REPOSITORY" --provider codex --model <model> --reasoning medium --run "$RUN_ID" --stage set-bearings > 04-set-bearings.json
```

Continue only with an action listed in the preceding receipt:
`set-bearings`, `gather-supplies`, `map-route`, `recon`, and
`draft-implementation` advance with `journey progress --stage <stage>`.
Only when `requiredOwnerAction` is present, show its bounded question, prompt,
modes, or artifacts and wait for the owner. Record an answer with `journey
decide`; use `journey approve-route` only for route approval. Do not infer an
answer or treat `allowedActions` as owner authorization.

For a failed or stopped same-stage Focus amendment, the receipt advertises
`journey confirm-amendment`, sets `requiredOwnerAction.type: confirm-amendment`,
and supplies `requiredOwnerAction.prompt`. Show that prompt and wait. Only after
the owner explicitly approves it may the host run `bearing journey
confirm-amendment --repo "$REPOSITORY" --provider codex --model <model>
--reasoning medium --run "$RUN_ID"`. It takes no action-specific flags and
retries the same Explorer or Expedition execution stage. Never infer or
auto-issue this owner action.

After approval, prefer `journey select-execution --mode
<explorer|expedition> --review-cadence <slice|phase|end>` for Explorer or
Expedition. `journey select-explorer --review-cadence <slice|phase|end>` remains
the legacy Explorer compatibility form. Continue through execution and the
advertised `journey progress --stage review` transition. Use `journey resume`
or `journey status` with the same repository and run ID after interruption.
When a read receipt reports `readiness: unavailable`, it advertises only
`status` and `resume`, with no mutating `requiredOwnerAction`; repair or select
an available provider route before attempting another transition.

Each receipt contains `ok`, `runId`, `revision`, and `allowedActions`, plus
applicable bounded `stage`, `status`, `question`, `summary`, `artifacts`,
`requiredOwnerAction`, and typed `outcome` fields. A rejected or out-of-order
command writes one typed receipt with `ok: false` and a deterministic `code`;
it does not prove progress. Report failed and stopped outcomes honestly and
attempt only an advertised recovery action. End the loop only at `status:
complete` with a complete outcome and final summary or artifacts, at owner
cancellation, or at a reported blocker.

## Safe start flags

The CLI accepts only the following bounded overrides:

| Flag | Accepted value or effect |
|---|---|
| `--detach` | Keep the local server alive after the launching process exits. |
| `--no-open` | Do not open a browser. |
| `--agent` | Shared agent reference. |
| `--provider`, `--model` | Shared route selection; never per-role. |
| `--reasoning` | The six abstract tiers `minimal`, `low`, `medium`, `high`, `very-high`, and `max`, plus the legacy provider levels `default`, `off`, `none`, `xhigh`, `ultra`, and `thinking`. A legacy level is normalized to the lowest tier that maps to it, and only for a provider that defines it: `--reasoning ultra --provider codex` becomes `max`, while `ultra` on any other provider is rejected. Without `--provider`, a legacy level is accepted if any provider defines it. |
| `--decision-depth` | `focused`, `standard`, or `deep`. |
| `--tools`, `--exclude-tools` | Bounded comma-separated tool names. |
| `--no-session` | Disable provider session persistence for the run. |
| `--offline` | Remove network authority for the run. |
| `--timeout` | Positive milliseconds, at most `2100000` (35 minutes). |
| `--max-turns` | Positive count, at most `20`. |
| `--budget` | Optional positive safe-integer per-call token ceiling. No ceiling is imposed by default. |

Pass values as `--flag value` or `--flag=value`. Duplicate, unknown, per-role, conflicting tool, and out-of-range flags are rejected, as are credential-shaped flag *names*, meaning anything matching key, secret, token, credential, or password. Flag values are not secret-scanned, so a credential passed as the value of an accepted flag will not be caught. Never put keys, tokens, passwords, or other credentials in a flag.

[Back to the README](../README.md)
