# Bearing

![Bearing working in its local planning office](assets/bearing-office.png)

Bearing is a local browser control room for evidence-backed agent work. It helps founders and small teams move a complex repository request through approved planning, bounded execution, owner decisions, and reviewable evidence while keeping approval and review authority.

Bearing is packaged for Codex and Claude Code and was created by William Rumph at AlphaZede.

The public npm package is `@alphazede/bearing`.

## Repository layout

- `src/` — application source.
- `test/` — automated tests.
- `plugin-skills/` — guarded, host-discoverable entrypoints for Bearing, Explorer, Navigator, and Crewmate.
- `skills/` — Bearing's editable internal workflow skills; the plugin does not expose them directly.
- `hooks/` — optional Codex and Claude reminders that activate only inside a Bearing Focus process.
- `examples/fictional-b2b/` — deterministic public-safe examples, showcase, and QA data.
- `assets/` — interface artwork.

Bearing writes generated planning artifacts into the repository selected by the user at runtime. Generated customer plans are not maintained in Bearing's public source tree.

## Install and start

Bearing requires Node.js 22 or newer. To run from a source checkout:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm build
node dist/cli.js start
```

Install the published package globally:

```sh
npm install --global @alphazede/bearing
bearing start
```

Or run it without installing:

```sh
npx --yes @alphazede/bearing start
```

`start` binds an ephemeral port on `127.0.0.1`, prints the local URL, and opens the default browser. Print the URL without opening a browser:

```sh
node dist/cli.js start --no-open
```

Keep the terminal open while a foreground `start` command is running. To keep an
agent-launched session alive after the launching turn ends, use detached mode:

```sh
node dist/cli.js start --detach
```

The URL contains a one-time capability in its fragment; do not share it.

## Codex plugin

Add the Bearing marketplace and install its plugin:

```sh
codex plugin marketplace add alphazede/bearing
codex plugin add bearing@bearing
```

Start a new Codex session, then invoke `$bearing` or ask Codex to use the
Bearing skill. Codex starts the existing local Bearing CLI in persistent mode
from the current repository, keeps it running, reports its loopback URL, and
begins the planning-first journey. It does not launch on SessionStart, install
software, or change Codex native collaboration behavior. After an explicit
invocation, the CLI's default `start` command best-effort opens the browser
automatically.

If the active Codex sandbox blocks the loopback listener, Codex asks for owner
approval to rerun only the Bearing CLI launch with host escalation. That launch
exception does not weaken the sandbox, tools, authority, or isolation of agents
Bearing starts for repository work.

## Claude Code plugin

In Claude Code, add this repository as a marketplace and install Bearing:

```text
/plugin marketplace add alphazede/bearing
/plugin install bearing@bearing
```

Invoke `/bearing` or ask Claude to use Bearing. The shared skill starts the same
local planning-first journey described above.

## Workflow skills

Bearing ships its complete internal workflow vocabulary in `skills/`: **Repository Fit**,
**Set Bearings**, **Gather Supplies**, **Map the Route**, **Navigator**, **Explorer**,
**Crewmate**, **Validator**, **Grader**, **Park Ranger**, and **Surveyor**. At runtime
Bearing reads the relevant packaged `SKILL.md` files and embeds them in the
selected harness request. Customers do not need AlphaZede's private skill
installation. The internal skills disable user and model invocation, so a harness cannot use
one as an unguarded command. `plugin-skills/` exposes the launcher plus guarded
Explorer, Navigator, and Crewmate wrappers. Each wrapper requires an approved
plan, starts a Focus snapshot, loads its corresponding internal skill, and
validates the final receipt. The internal role files are never exposed as
commands.

To customize a source build, edit the corresponding `skills/<name>/SKILL.md`
file, keep its `name` and `description` frontmatter valid, then rebuild and run
the tests. TypeScript remains responsible for security boundaries, artifact
validation, approval checks, and deterministic `review.html` generation; skill
text cannot weaken those guarantees. Reinstalling or upgrading the npm package
replaces edits made directly inside an installed package, so durable changes
belong in a fork or source checkout.

### Focus mode and direct roles

During Explorer or Expedition execution, Bearing derives one compact Focus
envelope from `plan-spec.md`, `seit.md`, and each `implementation.md` execution
manifest. The envelope fixes the objective, current acceptance criterion,
allowed paths, SEIT command IDs, blocker, remaining slices, and gate-failure
fingerprint. Bearing snapshots Git before execution and rejects completion when
the agent changes an undeclared path, omits a changed artifact, omits or
duplicates command evidence, reports a failed command as completion, makes no
product change, or leaves `review.html` stale.

The same validator backs the guarded `$explorer`, `$navigator`, and `$crewmate`
plugin skills. Their temporary request and receipt stay under the selected
repository's ignored `.bearing/focus/` state, while the immutable snapshot stays
inside a one-use loopback guard process and cannot be rewritten as a workspace
file. Direct GitHub issue comments or closure require explicit GitHub-mutation
authority on the Focus request; Bearing checks that authorization flag but does
not itself bind it to a specific repository or issue number, so scoping to an
exact issue is the host wrapper's responsibility. Finding a bug does not
authorize publishing repository data.

Codex and Claude plugins also ship a short Focus reminder hook. Bearing enables
it only for the provider process it starts, including resumes and subagents.
The hook is optional: disabling or removing it does not remove TypeScript Focus
validation, which remains the completion boundary.

## First launch

1. Choose one absolute path to a writable local directory. A directory that is not a Git repository requires explicit one-time owner confirmation and supports planning only; Focus execution validation requires Git. Bearing rejects any directory containing agent executables, such as a home directory, because the process-runner guard would block them. On first initialization it discloses that durable state is written to `<repo>/.bearing/`. For a Git repository whose `.gitignore` does not already ignore `.bearing/`, it offers once to add the rule and does so only with explicit consent; it never creates or edits `.gitignore` otherwise.
2. Choose one detected provider route, model, and reasoning selection. The provider and model are shared across all four role profiles for the run; there are no per-role model choices. Reasoning is normalized into the provider-independent policy and resolved separately for each role.
3. Complete the readiness check. Detection alone is not verification, and an unavailable selection is blocked rather than silently substituted.
4. Enter a work request and select **Embark**. Bearing records the request, invokes the verified route, and begins the real staged journey. Agent questions and owner answers are also recorded in the durable run ledger.

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

## Real browser journey

The main browser flow uses the selected, readiness-verified harness; it is not a canned workflow projection:

1. **Repository fit** runs first, before any plan or product artifact is written. Bearing inspects the selected repository read-only and proposes one repository and one plan directory, with the evidence behind the proposal. No plan directory, plan stub, or repository map is created yet. The proposal is a recommendation; your recorded confirmation is what authorizes the first product write. Decline it, or name a different directory, and no plan content is written — Bearing still records the run itself, including the work request and any pending question, under `<repo>/.bearing/`, because that ledger is how a declined or interrupted journey stays recoverable. If the agent is unavailable, returns a malformed answer, or cannot form a defensible proposal, Bearing stops and asks rather than guessing.
2. **Set Bearings** starts the plan at the confirmed directory and returns validated plan artifacts. Without a recorded confirmation it refuses, and creates no directory, no plan stub, and no repository map.
3. **Gather Supplies** asks the selected agent to inspect the repository once and return only questions that materially affect the plan. Bearing presents them one at a time without another model call, then sends the complete answer set back in one writing call. Choose **End questions** at any point to write from the answers already collected and explicitly recorded assumptions.
4. **Map the Route** produces the design, SEIT, and self-contained review baseline. The browser then routes through an optional **Recon** stage before Bearing drafts `implementation.md`.
5. **Review your route** displays each slice's role and validates that each slice declares a role, a model route, a reasoning level, and a review path, rejecting a model or reasoning value it cannot resolve. It does not restrict the role name to a supported set. The regenerated review HTML embeds the complete planning package; every source artifact also opens through a contained authenticated link. The owner can request changes or approve the route, and implementation cannot start before approval.
6. The owner chooses **Explorer** or **Expedition**, Surveyor review cadence, and whether clean merged temporary worktrees should be removed automatically. Choosing automatic cleanup instructs the selected harness to remove only clean, proven-merged temporary worktrees and their corresponding proven-merged temporary branches, and to retain dirty, blocked, failed, or unmerged lanes for recovery. That instruction is carried in the harness prompt: Bearing records your choice and states the rule, but it does not independently verify afterwards that the harness honored it. Bearing itself has no arbitrary repository delete controls.
7. The selected harness executes the approved route. Bearing then invokes native review where supported, with a read-only Surveyor fallback, and presents cumulative validated artifacts.

### Checking a plan before you run it

```sh
bearing plan validate docs/plans/account-export/phase-1
```

The command reads the four plan documents and prints a verdict plus every finding
with its code, artifact, slice, the text it objected to, the rule, and what to do
about it. It creates no run, writes no journey state, and changes nothing on
disk. Exit codes are 0 for a pass, 1 when the plan needs amending, 2 when a
finding needs an owner decision, and 3 when the input itself is unusable.

Two kinds of checks sit behind that verdict, and they are not equally strong.

**Structural checks are deterministic.** Required fields and sections, slice
heading formats, ID formats, write-set path safety, dependency cycles,
traceability closure, and same-wave write-set overlap are decided by parsing, so
they give the same answer every time. Coverage runs one way: a conformance test
feeds passing corpus fixtures through the real execution boundary and asserts the
boundary accepts them. The two are not identical — the execution predicate
deliberately exempts several findings that the validator still reports — so treat
a structural pass as "the parser found nothing wrong", not as a guarantee that
every accepted plan is executable.

**Prose checks are heuristic, and some of them still block.** Whether a phase
names an accountable controller, whether a slice has a genuine independent review
path, and whether SEIT evidence actually asserts failing closed are judgments
about sentences, and a heuristic has a miss rate: it catches "no accountable
controller is assigned" but not every way English can say the same thing. Treat a
pass as "nothing obviously missing", not as proof. A failure is not always
advisory: `validation_missing` yields NEEDS_AMENDMENT, and `integration_unowned`,
`contract_ambiguous`, and `recon_recommended` yield OWNER_DECISION_REQUIRED.

A passing verdict never authorizes execution on its own. Owner approval is still
required, and approval is what the run is gated on.

### Plan directories

Plans live under `docs/plans/` in the selected repository. A plan directory may
be up to three segments deep, so a multi-phase program can keep its phases
together — `docs/plans/account-export/phase-1/` is valid. Each segment starts
with a letter or digit and may otherwise contain letters, digits, `.`, `_`, and
`-`, up to 64 characters. No spaces. A date prefix is optional rather than
required.

Name a directory that already exists and Bearing resumes it, creating no sibling.
If the name matches more than one directory, Bearing lists the matches and asks;
it never picks one for you, and no plan content is written while it waits, though
the pending question and run checkpoint are recorded under `.bearing/`.

Consolidating duplicate plan directories is reachable from the browser. When
Repository Fit finds a duplicate matching the confirmed plan name, Bearing asks
before doing anything, and the copy runs only after you approve it.

While a real agent call is pending, Bearing shows the stable public phase name, an indeterminate moving trail, contextual guidance, elapsed time, and only artifacts already validated by completed results. It does not invent percentages, activity details, or an ETA. A failure never becomes a success claim, and eligible failures remain retryable — though retry policy can refuse one for a missing warrant, a reasoning-only repetition, lost continuity, or too many equivalent failures.

Execution can pause when the selected agent reaches a blocker or needs owner authorization. Bearing preserves the journey and reports what stopped, why, a recommended next step, and the decision it needs.

## Explorer and Expedition

- **Explorer** uses one Explorer to coordinate bounded Crewmates. It is the lower-agent, lower-token choice for a small set of related work items, but one Explorer carries the coordination fan-out.
- **Expedition** adds a Navigator and multiple bounded Explorer groups. It costs more coordination and tokens, but fits multi-phase work whose lanes benefit from independent management.

### The mode-recommendation policy

The scoring rules below are a policy and command contract, not current browser
behavior. The browser presents both cards and you choose directly; it does not
derive signals from your plan or call the scoring command for you. A caller that
does supply the signals gets the following, and a recommendation never starts
anything.

Any of five conditions selects the larger shape on its own: work spanning
multiple repositories, a security-critical integration, a data migration,
irreversible operations, or a plan that already declares three or more Explorers.

Otherwise eight signals are scored — phases, slices, dependency edges,
overlapping write sets, services, risk rating, expected concurrency, and
integration checkpoints — for a total between 0 and 25. Reaching the threshold
selects the larger shape. The default threshold is 8.

Risk adds 3 points at high and 4 at critical, so a critical-risk plan with
nothing else notable scores 4 and stays below the default threshold. Risk raises
the score; it does not by itself force Expedition.

**Trail Boss** is the role that coordinates Explorer lanes inside Expedition. It
schedules phases and manages dependencies, budgets, conflicts, and integration;
it does not implement, and it cannot certify anyone's work — only Surveyor
certifies. It may only parent Explorers, and when one exists every Explorer
reports to it, so the graph rules never permit a half-coordinated topology. Trail
Boss is a role inside Expedition, never a mode of its own.

This graph, and the scheduler that would enact it, are implemented and tested but
not yet wired into the browser journey. A live run makes one adapter call;
choosing Expedition permits subagents where the selected adapter supports that
option, and delegates the actual fan-out to that harness rather than scheduling
lanes itself.

Each decision records the threshold it used rather than reading configuration at
replay time, so replaying an old decision reproduces it even if the default later
changes. Two plans with identical inputs but different recorded thresholds
therefore replay to different recommendations.

Real skill-driven planning and execution can use substantial tokens, especially with Explorer or Expedition. Bearing displays a persistent warning rather than imposing a default hard token ceiling. If you use a subscription plan, consider a higher tier and choose reasoning deliberately. An explicit `--budget` flag sets a per-call acceptance ceiling: Bearing compares the usage a provider reports after the call returns and fails the call as `token_budget` if it exceeded the limit. It does not interrupt a call in flight, and it only works for adapters that report usage — Agy rejects any finite token budget with `agy_token_budget_unsupported`.

## Roles and authority

- **Navigator** coordinates an Expedition and does not perform independent research. Its default reasoning tier is `high`.
- **Explorer** manages a bounded group of Crewmates and can inspect context without execution authority beyond its profile. Its default reasoning tier is `medium`.
- **Crewmate** performs a bounded implementation task within the allowed tools, workspace, and limits. Its default reasoning tier is `medium`.
- **Surveyor** independently reviews evidence, has no execution ancestry, and cannot certify its own execution. Its default reasoning tier is `medium`.

Reasoning policy uses provider-independent abstract tiers: `minimal`, `low`,
`medium`, `high`, `very-high`, and `max`. Bearing maps each role's tier onto
the selected provider's real reasoning ladder and clamps it down to that
provider's ceiling. The resolved provider level and whether clamping occurred
are recorded. The policy accepts an escalation input that raises a tier, but
never above the provider ceiling; no browser journey supplies it today, so
escalation is an available policy input rather than current browser behavior. An
unmapped provider or unrecognized tier blocks with `reasoning_unmappable`
instead of silently choosing a default.

The tier you select is a ceiling, not an assignment. Each role runs at the
lower of its own default and your selection, so choosing `medium` holds every
role at `medium` or below, while choosing `max` leaves Explorer, Crewmate, and
Surveyor at their `medium` default and lets the roles that default to `high` —
Navigator, Validator, Grader, and Park Ranger — reach it.
If the selected model's ladder omits a role's level, that role clamps to the
nearest lower level the model does support; a model with nothing available at
or below a role's tier is blocked rather than quietly raised.

For example, abstract `max` resolves to `xhigh` on Grok and Pi and to
`thinking` on Agy; abstract `very-high` also resolves to `thinking` on Agy.
`--reasoning very-high` is accepted directly by the CLI.
`--reasoning ultra --provider codex` is accepted as a legacy alias and normalizes to abstract `max`;
Codex `ultra` remains a provider level rather than a policy default.
Agent profiles use schema version 2. Valid version 1 profiles migrate to
version 2, while malformed or future-schema profiles block rather than reset.

The local Node server—not the browser—owns durable workflow state, batched owner answers, command validation, approval checks, adapter invocation, and evidence projection. The browser never receives provider credentials. Recommendations never authorize execution: planning approval and consequential run decisions require durable owner evidence in the ledger. Not every action is ledgered that way — deleting saved journey history and consenting to the `.gitignore` rule take effect without being recorded as durable owner-evidence events. Fallback is disabled by default, unsupported authority combinations fail closed, and isolation is reported as attested, local, off, or blocked rather than assumed.

## Verification layers

Bearing defines four verification questions and their result vocabularies:

- **Validator** asks whether the approved contract was proven with sufficient
  evidence. Its verdict is `PASS`, `NEEDS_MORE_EVIDENCE`, or `FAIL`; escalation is
  `none`, `re_execute_slice`, `park_ranger_gate`, or
  `owner_decision_required`.
- **Grader** asks how strong the completed result is across the quality rubric.
  Its verdict is `strong`, `acceptable`, or `weak`; rubric version 1 is frozen
  and scores each dimension from 0 through 4.
- **Park Ranger** asks whether the code introduced a concrete defect. Findings
  are ranked `P0` through `P3`, and synthesis returns `block`,
  `repair-required`, `accept-with-findings`, or `accept`.
- **Surveyor** asks whether the integrated product behaves correctly for the
  user. It is the independent, read-only reviewer described above.

The shipped surface consists of packaged skill contracts, pure decision
functions for Validator, Grader, and Park Ranger policy, and read-only HTTP
projections for recorded checkpoint summaries and cadence. Invocation differs by
layer. Validator runs automatically: after a Focus execution completes and passes
completion validation, the journey scopes the result and records a Validator
report. Grader, Park Ranger, and the cadence gate sequence are not invoked
automatically at slice, phase, or completion transitions. No layer refuses a
transition because a function returned a particular verdict.

### Review cadence policy

`resolveReviewCadence` recognizes `high-risk`, `unclear-requirements`,
`new-architecture`, `security-sensitive`, `substantial-work`, and
`low-risk-mature-system`. The first four select `per-slice`, while
`substantial-work` selects `per-phase`. When triggers are supplied, a declared
`completion-only` cadence survives only when the sole trigger is
`low-risk-mature-system`.

Resolution is tighten-only: it can raise the declared cadence and never lower
it. `requiredGates` specifies these gate sets:

| Boundary | Resolved cadence | Specified gates |
|---|---|---|
| Slice | `per-slice` | `validator` + `park-ranger` |
| Slice | `per-phase` or `completion-only` | `validator` |
| Phase | `completion-only` | `validator` + `park-ranger` |
| Phase | `per-slice` or `per-phase` | `validator` + `park-ranger` + `grader` |
| Completion | any cadence | `validator` + `park-ranger` + `grader` + `surveyor` |

The table describes policy output; it is not an automatically executed or
server-enforced gate sequence.

### Independent verification preconditions

Independence is checked when a caller invokes the verification functions, not
as an ambient server guarantee. `assertIndependentVerification` returns
`self_certification` when the verifier session id is among the implementer
session ids, and `shared_ancestry` when execution ancestry is non-empty.
`assertIsolatedVerification` rejects a verifier with a provider session id, a
verifier in Focus mode, or a verifier with write or external-action authority.
`assertParkRangerCleanRoom` composes the isolation and independence checks for
Park Ranger lens reports.

### Read-only projections

The local server exposes four authenticated, loopback-only GET projections:

- `GET /api/v1/runs/{runId}/verification/{validator|grader|park-ranger}` returns
  `{ runId, layer, entries }`. Each entry carries `eventId`, `sequence`, `stage`,
  `status`, and `verdict`, with optional `rubricVersion` and `findingCount`.
- `GET /api/v1/runs/{runId}/review-cadence` returns `{ runId, declaredCadence,
  resolvedCadence, requiredGates }`. `resolvedCadence` nests `cadence`,
  `tightened`, and `reasons`; `requiredGates` nests the gate sets for the
  `slice`, `phase`, and `completion` boundaries.

Verification entries are reconstructed from the optional summary on recorded
journey checkpoints. The ledger persists only the layer, verdict, and optional
rubric version and finding count, so full verification reports are neither
persisted nor invented by this endpoint.

The cadence handler reads the declared cadence from the approved execution
contract only after matching its owner approval to a ledger event. It currently
calls the policy with an empty trigger list because no trigger source is
persisted, so this endpoint always reports `tightened: false` and `reasons: []`.

The route patterns bound each run id to 128 characters. Unsupported methods fall
through to `404`, and these projections grant no write or transition authority.

Report ingestion enforces `self_certification` from recorded ledger fact: a verifier whose session
id matches an implementer session on that run is refused. It does **not** enforce
`shared_ancestry`, because no trusted provenance for a verifier's execution ancestry is persisted
yet, and accepting a caller-supplied ancestry would be a control in name only. That check remains
available to callers that can supply trustworthy ancestry; the local endpoint does not claim it.

The control room reads these projections directly: a verification panel shows
each layer's recorded verdict, and the resolved cadence is displayed with its
required gates for the slice, phase, and completion boundaries. The panel issues
only GET requests and grants no transition, approval, or execution authority.
Separately, the review-cadence control in the journey UI selects the cadence
*before* execution; that is an input, not the resolved value shown here.

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

Pass values as `--flag value` or `--flag=value`. Duplicate, unknown, per-role, conflicting tool, and out-of-range flags are rejected, as are credential-shaped flag *names* — anything matching key, secret, token, credential, or password. Flag values are not secret-scanned, so a credential passed as the value of an accepted flag will not be caught. Never put keys, tokens, passwords, or other credentials in a flag.

## Examples and showcase fixtures

The included token-free and fictional B2B examples are separate from the real browser journey above. They are deterministic, provider-disabled fixtures for orientation and QA. Their authenticated JSON and offline HTML report endpoints do not execute external work and are not evidence that a selected harness completed a request.

1. **Engineering Import** models a feature/import flow with an owner role gate, input validation, dry run, duplicate handling, atomic customer/audit publication, and independent Surveyor review.
2. **Launch Readiness** turns repository facts into a marketing brief and infographic-input evidence. A Surveyor review blocks an unsupported promise; an owner-approved correction removes it, then an independent follow-up Surveyor review passes the corrected brief.
3. **Due Diligence** answers supported product questions from repository evidence while leaving security certification and retention answers blocked with named owners.

Each example exposes decision stops, expected artifacts, outcome classes, Surveyor review history, and an offline evidence report that can be opened or saved from the browser.

## State, recovery, export, and deletion

Bearing stores a workspace manifest plus per-run hash-linked JSONL ledgers and snapshots beneath the selected repository's `.bearing/` directory. Choosing the same repository on a later launch resumes it. The ledger is authoritative; a missing or stale snapshot can be rebuilt from valid events. Corrupt, truncated, future-schema, sequence-invalid, or hash-invalid state blocks writable resume instead of being silently reset.

A single optional journey-checkpoint key, `runtimeStateJson`, carries the bounded activity trace, retry ledger, current concurrency decision, and provider-session continuity status. The local server validates and restores that record when it rebuilds browser journey state, so those fields survive a Bearing restart; checkpoints without the optional key still validate.

Retrying a known failure fingerprint requires one of five recorded warrants: `new_hypothesis`, `new_evidence`, `changed_strategy`, `changed_environment`, or `approved_amendment`. A higher reasoning tier alone is refused, and after the equivalent-failure limit the attempt is not run again; retry control returns the scope-selected escalation target (`explorer`, `trail-boss`, `navigator`, or `owner`).

`provenIndependent` is a fail-closed policy function that requires both units to declare parallel safety and disjoint write sets by exact path membership plus disjoint interface, environment, and integration-boundary tags, returning `false` when any required declaration is absent or malformed. Within one phase, `admissibleConcurrency` can retain or lower a prior cap but cannot raise it. The browser journey persists only that cap decision into checkpoint state; its runtime scheduler does not use `provenIndependent` to launch work.

For Codex, Claude, and Pi, a persistent journey checkpoint also records a
bounded provider conversation UUID. Browser reconnection returns to active
work, and a later Bearing process resumes that same conversation for the exact
repository, journey, and saved model/reasoning selection. Separate journeys
cannot inherit one another's conversation. Surveyor review remains a new,
read-only session so the implementing conversation cannot certify itself.

An unavailable continuation is classified only when a provider session id was actually supplied, the process exits nonzero with no usable structured events, and the route-specific resume-failure signature matches. Resume-failure signatures are currently defined for Codex only, so this detection and the fallback below apply to Codex sessions; a dead Claude or Pi continuation surfaces as an ordinary nonzero exit. The journey clears the dead session from its cache and, only when the failed attempt reports itself side-effect-free, retries once without the id; the result carries a continuity-lost disclosure.

Focus contract drift returns `focus_amendment_required` with a bounded owner-readable summary of changed plan sources and contract fields. Bearing keeps the existing Focus context until explicit owner confirmation; only then does it adopt the candidate context and the Git baseline captured with it.

The real journey routes `map-route` through optional `recon` before `draft-implementation`. A Recon receipt with no brief and no report is accepted as `SKIPPED`, so omitting an experiment does not invalidate the plan. Recon validates its receipt against a Git baseline captured before the stage, and refuses the receipt when that baseline is unavailable. In a planning-only repository without Git there is nothing to observe a bounded experiment against, so Bearing records its own skip, says why, and does not call the agent for that stage.

`bearing workspace status [--repo <abs>]` reports the absolute `.bearing/` path, its on-disk size, the total run count with settled, unsettled, and compacted breakdowns, whether it is gitignored, and whether its location is safe. A run Bearing cannot read is counted separately as `unreadable` and named with the integrity error that stopped it, rather than being folded into the healthy totals. That covers every store integrity failure, not only a truncated ledger: a hash or sequence mismatch, a wrong run id, an unparsable snapshot, and a run written by a newer schema version all qualify. Such a run never reads as settled, is never pruned or compacted, and no longer prevents the remaining runs from being listed, reported, compacted, or pruned. `bearing workspace doctor [--scan <abs>...]` detects misplaced `.bearing/` workspaces within the top level of `$HOME` and any `--scan` paths. `--relocate <abs>` quarantines one by renaming it to `.bearing.quarantine-<timestamp>`. It never deletes, and it refuses while a live busy lease or an in-progress initialization marker exists for that repository.

`bearing workspace compact --compact-settled [--repo <abs>]` and `bearing workspace prune (--max-age-days <n> | --max-completed-runs <n>) [--repo <abs>]` operate only with an explicit policy, print their retention plan, and obtain a fresh live cleanliness proof again immediately before applying it. That caller-owned proof supplies exactly the two settle conditions that are not persisted: every Git worktree is clean and merged, and no run is busy; the store itself proves only that the final review checkpoint is complete and no owner decision is pending. Missing or incomplete proof refuses both compaction and pruning. Compaction writes and verifies a compacted snapshot before truncating the ledger, seals the run, and refuses every later command with `run_compacted`; pruning deletes only runs selected by the same settle proof and explicit age/count policy.

The real journey presents contained authenticated links for validated planning Markdown and generated HTML artifacts; showcase reports remain self-contained HTML fixtures. Journey History can delete one saved journey or clear all saved journeys for the selected repository; generated artifacts and source files remain untouched, and running journeys are protected. There is not yet an in-app full-state export. To preserve all local state, stop Bearing and copy the repository's `.bearing/` directory to an owner-controlled backup. To retire it recoverably, stop Bearing, make that backup, and rename `.bearing/` to a repository-specific quarantine name; permanent deletion remains an explicit repository-owner action. Provider credentials are never part of `.bearing/`.

## Improvement loop

Bearing observes how its own runs went and reports what it noticed. It never acts on what it finds. Everything below reads run ledgers that already exist under the selected repository's `.bearing/` directory: the loop writes no journal, cache, or index, opens no socket, and sends nothing anywhere. There is no account, no telemetry, and no central data program to opt out of.

It defines eight kinds of already-recorded outcome, each with a closed vocabulary: `validation_failure` (why a slice failed validation), `retry` (admissions, refusals, and escalations), `grader_score` (strong, acceptable, or weak), `park_ranger_finding` (P0 through P3), `surveyor_failure` (failed, blocked, or deviated), `reasoning_effectiveness`, `concurrency_conflict`, and `coordination` (which execution mode a run used). **Five of those eight are produced today** — `validation_failure`, `retry`, `concurrency_conflict`, `coordination`, and `grader_score`. Two are not, and the reasons are recorded rather than approximated: the run ledger stores a Park Ranger verdict and finding count but no severity level, so there is no honest source for `P0` through `P3`, and surveyor outcomes live in a separate evidence ledger the loop does not read. `reasoning_effectiveness` is likewise not yet derived from recorded fields. It reads no plan prose, no artifact contents, and no questions or answers. Paths, run identifiers, and failure fingerprints appear only as digests. Only settled runs count toward evidence; a run Bearing cannot read is counted unreadable and skipped rather than treated as a failure.

A recommendation may name exactly six surfaces — reasoning defaults, review cadence, test depth, concurrency cap, planning template, and skill guidance — and exactly one profile path, `reasoningPolicy.defaults`. Nothing else is recommendable. Skill guidance is **pointer-only**: a recommendation may say which skill correlates with which pattern, it may never propose wording, and Bearing never writes to a skill file. Skills are the instructions agents follow, so a system that rewrote them from its own outcome statistics would be editing the rules it is measured by. There is no apply button either; acting on a recommendation is an ordinary plan you author and run through the normal workflow.

The loop refuses to speak from thin data. A pattern is reported only with at least 20 settled runs in the window, at least 5 occurrences spanning at least 3 distinct runs, and, for a rate, a denominator of at least 20 and an absolute effect of at least 0.15. Below any of those it reports `insufficient_evidence` and zero recommendations rather than a suggestive number.

Most metrics report `insufficient` today, and the loop does not yet emit recommendations. The fields the metrics denominate on — a coordination pair, a slice sequence, accepted-criteria references, and token counts — are deliberately not carried across the outcome projection, which exists to keep run data minimal. Because a recommendation requires every one of its guard metrics to be sufficient, an insufficient guard means no recommendation is emitted at all. That is the fail-closed behavior working as intended, not a silent zero: Bearing reports insufficient rather than substituting a proxy. For the same reason it does not detect token-budget exhaustion; of the five degradation signals it detects repeated equivalent failures, retry refusals, and lost session continuity.

Proposals and trial verdicts are built but not yet reachable, because applying a recommendation is out of scope for this release. `bearing improve report` therefore always reports no trial verdicts, and the export bundle is correspondingly empty until an apply path exists.

Four commands read this evidence. `bearing improve status` prints the evidence position and thresholds; `bearing improve report` prints metrics, recommendations, and trial verdicts; `bearing improve handoff` prints a copy-paste handoff prompt when a run shows degradation; and `bearing improve export --out <relative-path>` is the only one that writes. The export carries only the typed from/to of retained recommendations, benchmark cases, test-case descriptors, and notes you authored, and an allowlist assertion refuses digests, run identifiers, timestamps, provider session identifiers, plan directories, and repository paths before a single byte is written. There is nowhere to post it: you contribute by opening a pull request yourself, like any other contributor.

The handoff renders what Bearing can prove about a degraded run — the run, the plan directory, the stages verified complete, the stages an agent only *reported* complete and that you should re-derive before trusting, what is in flight, and the single next action. A stage counts as verified only when the ledger records a passing verification verdict for it. The control room shows the same text through one authenticated read-only route. It is text; it starts nothing.

## Platform assumptions and limitations

- Node.js 22+ and a writable local filesystem are required. `package.json` pins pnpm 10.33.0.
- Browser opening uses `open` on macOS, `cmd /c start` on Windows, and `xdg-open` on other platforms; use `--no-open` when that integration is unavailable. Publishing the npm package does not require Windows or macOS code signing. Native Windows, macOS, Linux, and WSL smoke tests remain release certification work.
- The server is single-user and loopback-only. Bearing provides no hosted account or service, remote telemetry, production deployment, support SLA, or multi-user authorization boundary. Selected agent CLI and provider account requirements remain external to Bearing.
- The native UI is intentionally small. The real staged journey launches the selected harness, but it does not provide a general-purpose terminal, arbitrary workflow editor, full-state export, or delete controls.
- Example and showcase providers are intentionally disabled; they remain deterministic fixtures. Real journey readiness and effective isolation depend on the selected local harness and its attestation, and may be unavailable.
- Optional RAG-assisted context, external config discovery, OAuth/setup flows, alias migrations, and skill lifecycle changes are not enabled by this package's browser flow.

## Security

Report suspected vulnerabilities through GitHub's [private vulnerability
reporting form](https://github.com/alphazede/bearing/security/advisories/new),
not a public issue. See [SECURITY.md](SECURITY.md) for supported versions,
report contents, response targets, disclosure, and safe-harbor terms. Use
[public issues](https://github.com/alphazede/bearing/issues) for ordinary bugs.

## License

Licensed, at your option, under either the [Apache License 2.0](LICENSE-APACHE)
or the [MIT license](LICENSE-MIT).
