# Bearing

![Bearing working in its local planning office](assets/bearing-office.png)

Bearing is a local browser control room for evidence-backed agent work. It helps founders and small teams turn a complex repository request into an approved plan, bounded execution, owner decisions, and reviewable evidence without surrendering approval or review authority.

Bearing is packaged for Codex and Claude Code and was created by William Rumph at AlphaZede.

This is the public `0.1.0` source candidate. The npm package `@alphazede/bearing` has not yet been published. Build and run from source for now.

## Repository layout

- `src/` — application source.
- `test/` — automated tests.
- `skills/` — the packaged Bearing skill.
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

Once the npm package is published, the following commands will also be available:

```sh
npm install --global @alphazede/bearing
bearing start
```

```sh
npx --yes @alphazede/bearing start
```

`start` binds an ephemeral port on `127.0.0.1`, prints the local URL, and opens the default browser. Print the URL without opening a browser:

```sh
node dist/cli.js start --no-open
```

Keep the terminal running when using either foreground command above. For an
agent-launched session that must survive the launching turn, use the
portable detached mode:

```sh
node dist/cli.js start --detach
```

The URL contains a one-time capability in its fragment; do not share it.

## Codex plugin

The packaged repo-local plugin provides the `bearing` skill. In a Codex session
where this package is installed, invoke `$bearing` or ask Codex to use the
Bearing skill. Codex starts the existing local Bearing CLI in persistent mode
from the current repository, keeps it running, reports its loopback URL, and
begins the planning-first journey. It does not launch on SessionStart, install
software, publish a marketplace entry, or change Codex native collaboration
behavior. After an explicit invocation, the CLI's default `start` command
best-effort opens the browser automatically.

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

## First launch

1. Choose one absolute path to a writable local repository. Bearing initializes or resumes `.bearing/` inside that repository; credentials remain outside it.
2. Choose one detected provider route, model, and reasoning level. The model and reasoning selection is shared across all four role profiles for the run; there are no per-role model choices.
3. Complete the readiness check. Detection alone is not verification, and an unavailable selection is blocked rather than silently substituted.
4. Enter a work request and select **Embark**. Bearing records the request, invokes the verified route, and begins the real staged journey. Agent questions and owner answers are also recorded in the durable run ledger.

## Real browser journey

The main browser flow uses the selected, readiness-verified harness; it is not a canned workflow projection:

1. **Set Bearings** starts the plan and returns validated plan artifacts.
2. **Gather Supplies** asks the selected agent to inspect the repository once and return only questions that materially affect the plan. Bearing presents them one at a time without another model call, then sends the complete answer set back in one writing call. Choose **End questions** at any point to write from the answers already collected and explicitly recorded assumptions.
3. **Map the Route** produces the design, SEIT, and self-contained review baseline, then Bearing drafts `implementation.md`.
4. **Review your route** verifies each slice's role, selected model route, and reasoning level. The regenerated review HTML embeds the complete planning package; every source artifact also opens through a contained authenticated link. The owner can request changes or approve the route, and implementation cannot start before approval.
5. The owner chooses **Explorer** or **Expedition**, Surveyor review cadence, and whether clean merged temporary worktrees should be removed automatically. By default, cleanup removes only clean, proven-merged temporary worktrees and their corresponding proven-merged temporary branches; dirty, blocked, failed, or unmerged lanes are retained for recovery. Bearing has no arbitrary repository delete controls.
6. The selected harness executes the approved route. Bearing then invokes native review where supported, with a read-only Surveyor fallback, and presents cumulative validated artifacts.

While a real agent call is pending, Bearing shows the stable public phase name, an indeterminate moving trail, honest helper text, elapsed time, and only artifacts already validated by completed results. It does not invent percentages, activity details, or an ETA. Failures remain retryable and do not become success claims.

Execution can pause when the selected agent reaches a blocker or needs owner authorization. Bearing preserves the journey and reports what stopped, why, a recommended next step, and the decision it needs.

## Explorer and Expedition

- **Explorer** uses one Explorer to coordinate bounded Crewmates. It is the lower-agent, lower-token choice for a small set of related work items, but one Explorer carries the coordination fan-out.
- **Expedition** adds a Navigator and multiple bounded Explorer groups. It costs more coordination and tokens, but fits multi-phase work whose lanes benefit from independent management.

Real skill-driven planning and execution can use substantial tokens, especially with Explorer or Expedition. Bearing displays a persistent warning rather than imposing a default hard token ceiling. If you use a subscription plan, consider a higher tier and choose reasoning deliberately. An explicit `--budget` flag is available when an owner wants a hard per-call boundary.

## Roles and authority

- **Navigator** coordinates an Expedition and does not perform independent research.
- **Explorer** manages a bounded group of Crewmates and can inspect context without execution authority beyond its profile.
- **Crewmate** performs a bounded implementation task within the allowed tools, workspace, and limits.
- **Surveyor** independently reviews evidence, has no execution ancestry, and cannot certify its own execution.

The local Node server—not the browser—owns durable workflow state, batched owner answers, command validation, approval checks, adapter invocation, and evidence projection. The browser never receives provider credentials. Recommendations never authorize execution; material actions require durable owner evidence. Fallback is disabled by default, unsupported authority combinations fail closed, and isolation is reported as attested, local, off, or blocked rather than assumed.

## Safe start flags

The CLI accepts only the following bounded overrides:

| Flag | Accepted value or effect |
|---|---|
| `--detach` | Keep the local server alive after the launching process exits. |
| `--no-open` | Do not open a browser. |
| `--agent` | Shared agent reference. |
| `--provider`, `--model` | Shared route selection; never per-role. |
| `--reasoning` | One provider-supported value: `default`, `off`, `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`, or `thinking`. The chosen model is validated before launch. |
| `--decision-depth` | `focused`, `standard`, or `deep`. |
| `--tools`, `--exclude-tools` | Bounded comma-separated tool names. |
| `--no-session` | Disable provider session persistence for the run. |
| `--offline` | Remove network authority for the run. |
| `--timeout` | Positive milliseconds, at most `2100000` (35 minutes). |
| `--max-turns` | Positive count, at most `20`. |
| `--budget` | Optional positive safe-integer per-call token ceiling. No ceiling is imposed by default. |

Pass values as `--flag value` or `--flag=value`. Duplicate, unknown, credential-shaped, per-role, conflicting tool, and out-of-range values are rejected. Never put keys, tokens, passwords, or other credentials in a flag.

## Examples and showcase fixtures

The token-free examples and included fictional B2B showcases are separate from the real browser journey above. They are deterministic, provider-disabled fixtures for orientation and QA. Their authenticated JSON and offline HTML report endpoints never execute external work and are not evidence that a selected harness completed a real request.

1. **Engineering Import** models a feature/import flow with an owner role gate, input validation, dry run, duplicate handling, atomic customer/audit publication, and independent Surveyor review.
2. **Launch Readiness** turns repository facts into a marketing brief and infographic-input evidence. A Surveyor review blocks an unsupported promise; an owner-approved correction removes it, then an independent follow-up Surveyor review passes the corrected brief.
3. **Due Diligence** answers supported product questions from repository evidence while leaving security certification and retention answers blocked with named owners.

Each example exposes decision stops, expected artifacts, outcome classes, Surveyor review history, and an offline evidence report that can be opened or saved from the browser.

## State, recovery, export, and deletion

Bearing stores a workspace manifest plus per-run hash-linked JSONL ledgers and snapshots beneath the selected repository's `.bearing/` directory. Choosing the same repository on a later launch resumes it. The ledger is authoritative; a missing or stale snapshot can be rebuilt from valid events. Corrupt, truncated, future-schema, sequence-invalid, or hash-invalid state blocks writable resume instead of being silently reset.

The real journey presents contained authenticated links for validated planning Markdown and generated HTML artifacts; showcase reports remain self-contained HTML fixtures. Journey History can delete one saved journey or clear all saved journeys for the selected repository; generated artifacts and source files remain untouched, and running journeys are protected. There is not yet an in-app full-state export. To preserve all local state, stop Bearing and copy the repository's `.bearing/` directory to an owner-controlled backup. To retire it recoverably, stop Bearing, make that backup, and rename `.bearing/` to a repository-specific quarantine name; permanent deletion remains an explicit repository-owner action. Provider credentials are never part of `.bearing/`.

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
