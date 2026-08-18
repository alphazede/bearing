# Bearing Lite

[![npm](https://img.shields.io/npm/v/@alphazede/bearing-lite)](https://www.npmjs.com/package/@alphazede/bearing-lite)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE-APACHE)

**Bearing Lite** (`@alphazede/bearing-lite`) is a skills-first Agent Plugin for
planning, routing, bounded execution, and independent review of repository work.
It ships portable skills, references, templates, and optional client hooks.

An agent cannot certify its own work. The stateful Router owns the planning
conversation and visible Journey state, then dispatches fresh bounded sessions.
Independent assurance runs at the owner's selected cadence: per slice, per
execution/correction round, or once at the end. Owner Authority remains human-only.

Bearing Lite was created by William Rumph.

## Quick start with Pi

Install the published skills package:

```sh
pi install npm:@alphazede/bearing-lite
```

Then give your agent a real task:

> Use Bearing Lite to add rate limiting to this API without changing its public
> responses. Require one independent review at the end.

Bearing Lite asks whether the work is an Explorer Journey or an Expedition,
fills only the missing planning stages, confirms the agent lineup and review
cadence, and dispatches bounded sessions with visible Markdown state.

If Bearing Lite helps keep a long agent task scoped and reviewable,
[star the repository](https://github.com/alphazede/bearing-lite). It helps other
coding-agent users find it.

## Install

Install as a host plugin. The portable identity is always `bearing-lite` /
`@alphazede/bearing-lite`. No postinstall script, global hook copy, or
host-config mutation is required.

```sh
# Claude Code
claude plugin marketplace add /path/to/bearing-lite
claude plugin install bearing-lite@bearing-lite

# Codex
codex plugin marketplace add /path/to/bearing-lite
codex plugin add bearing-lite@bearing-lite

# Grok Build
grok plugin marketplace add /path/to/bearing-lite
grok plugin install bearing-lite --trust

# Cursor
# Add the checkout as a Cursor marketplace/plugin (.cursor-plugin/)

# Kimi Code
# /plugins install /path/to/bearing-lite

# AGY (Antigravity) — install the .agy root, not the repo root
agy plugin install /path/to/bearing-lite/.agy

# Pi — skills package, no command hooks
pi install npm:@alphazede/bearing-lite
```

Claude Code, Codex, Grok Build, Cursor, and Kimi Code are **partial** hook
clients: session start runs the activation advisory and stop runs the closeout
advisory. AGY and Pi are **skills-only**. Transition-order and protected-action
checks stay in the skills on every host. Node.js must be on `PATH` for the
hook adapters.

**Skills-only copy** of `skills/` into a host skills directory does not
register hooks. That path remains first-class. See
[`hooks/com.anthropic.claude-code/mapping.md`](hooks/com.anthropic.claude-code/mapping.md).

## What it does

1. **Ask** whether the Journey is an Explorer Journey or an Expedition.
2. **Fill only missing planning stages:** Repository Fit → Set Bearings → Gather
   Supplies → Map the Route.
3. **Confirm** the user-owned primary/fallback lineup and review cadence.
4. **Dispatch fresh sessions** with bounded context, authority, and return types.
5. **Record state visibly** in human-readable Markdown artifacts only.

Bearing Lite never selects models, providers, credentials, or launchers. The
owner provides each role's primary/fallback agent or harness, model, and
reasoning level in `~/.agents/bearing-lite/default-role-lineup.md`, then confirms
the applicable Journey snapshot before implementation.

## Routes and scaling

| Route | When | Cost |
|---|---|---|
| **Explorer Journey** | One bounded packet or one wave | Direct Crewmate or one Explorer |
| **Expedition** | Multi-phase or concurrent independent lanes | Navigator |

An **Explorer Journey** uses a direct Crewmate for one ready packet or one
Explorer over a compact/sequential wave.
**Expedition** adds navigation so independent lanes
stay small and sharp instead of degrading in one long context. Either shape can
use substantial tokens; the product does not impose a default budget ceiling.

### Role routing (explanatory)

Current routing diagram source: [`skills/bearing-lite/references/role-routing.mmd`](skills/bearing-lite/references/role-routing.mmd).
The text below remains authoritative for clients that do not render Mermaid.

**Authoritative text (vision optional):** Owner Authority remains human-only. The
Bearing Lite Router is the stateful planning controller, not a work role. It
invokes only missing planning stages in fresh sessions, confirms the owner's
lineup and cadence, then dispatches an Explorer Journey or Expedition. Explorer
coordinates proven-independent in-wave lanes without a nested coordinator.
Validator, Park Ranger,
and Surveyor appear only when declared and when the selected per-slice,
per-round, or at-end boundary is reached. Diagrams explain orientation; they
never authorize a transition.

## Roles and authority

| Role | What it is | Executes | Notes |
|---|---|---|---|
| **Router** | Stateful planning controller | no | User-facing; planning-state writer |
| **Navigator** | Expedition orchestrator | no | Owns cross-wave sequencing and conflicts |
| **Explorer** | One-wave controller | no | Dispatches Crewmates; owns proven-independent lanes |
| **Crewmate** | Bounded implementer | yes | Most hands-on work; exact write set |
| **Validator** | Evidence sufficiency | no | Independent of the author |
| **Park Ranger** | Defect review | no | Independent of the author |
| **Surveyor** | User-facing acceptance | no | Read-only outcome judgment |
| **Owner Authority** | Human decision | n/a | Never an agent role |

**Independent review:** a candidate author never provides their own Validator,
Park Ranger, or Surveyor verdict.

Failure escalates to the nearest role whose scope can see it:

| Failure scope | Escalates to |
|---|---|
| Within one slice or packet | Explorer or nearest parent |
| Across slices in a wave | Explorer |
| Across waves or phases | Navigator |
| Contract, security, or authority change | Owner Authority |

## Task state (explanatory)

Current task-state diagram source: [`skills/bearing-lite/references/task-state.mmd`](skills/bearing-lite/references/task-state.mmd).
The text below remains authoritative for clients that do not render Mermaid.
Authoritative transition rules: [`skills/bearing-lite/references/task-state.md`](skills/bearing-lite/references/task-state.md).

**Authoritative summary:** The project's plan is the only task-state record.
Normal progress is `PROPOSED` → `READY` → `IN_PROGRESS` → `EVIDENCE_READY`, then
optional `VALIDATING` / `REVIEWING` when required, then `ACCEPTANCE` →
`COMPLETE`. `WAITING_ON` holds for missing prerequisites, checkout-lease
conflict, or assurance dispatch.
`CORRECTION_REQUIRED` allows two in-authority repairs; a third failed correction
escalates to `OWNER_DECISION_REQUIRED`. Diagrams never create state or authorize
transitions.

## Implementation process (explanatory)

Owner-approved multi-phase work follows four phases: Inventory, Foundation,
Proof and Documentation, and Final Audit. Default slice completion is author
self-check plus coordinator confirmation when `required_assurance` is `none`.
Fresh Validator then separate Park Ranger is mandatory only on exact integrated
phase candidates, not on every packet.

![Bearing Lite implementation process: four phases with default self-check slices, optional owner slice assurance, mandatory integrated phase gates, bounded correction, and final Surveyor acceptance](docs/plans/2026-08-09-bearing-skills-first-architecture/assets/implementation-process.png)

Mermaid source:
[`docs/plans/2026-08-09-bearing-skills-first-architecture/assets/implementation-process.mmd`](docs/plans/2026-08-09-bearing-skills-first-architecture/assets/implementation-process.mmd).

<details>
<summary>Diagram source (implementation process)</summary>

```mermaid
flowchart TD
    P1[Phase 1 Inventory S1-S4 complete] --> P2[Phase 2 Foundation S4A-S7]
    P2 --> SLICE[Crewmate then author self-check]
    SLICE --> CC[Coordinator scope and dependency confirmation]
    CC --> OPT{Owner slice assurance?}
    OPT -->|Yes| V[Fresh Validator then optional Park Ranger]
    OPT -->|No| MORE{More Foundation slices?}
    V -->|Fail or repair| R[Bounded Correction Attempt]
    V -->|Pass| MORE
    R -->|Attempt 1 or 2| SLICE
    R -->|3rd Failure| O[OWNER_DECISION_REQUIRED]
    MORE -->|Yes| SLICE
    MORE -->|No: integrated Foundation| FG[Fresh Validator then separate Park Ranger]
    FG --> P3[Phase 3 Proof and Documentation S8-S10]
    P3 --> SLICE3[Crewmate then author self-check]
    SLICE3 --> CC3[Coordinator confirmation]
    CC3 --> OPT3{Owner slice assurance?}
    OPT3 -->|Yes| V3[Fresh Validator then optional Park Ranger]
    OPT3 -->|No| MORE3{More Proof and Documentation slices?}
    V3 -->|Fail or repair| R
    V3 -->|Pass| MORE3
    MORE3 -->|Yes| SLICE3
    MORE3 -->|No: integrated Proof and Documentation| PG[Fresh Validator then separate Park Ranger]
    PG --> P4[Phase 4 Final Audit S11-S12]
    P4 --> S11[S11 Skill and State Alignment Audit]
    S11 --> S12[S12 Integrated Acceptance]
    S12 --> S[Fresh Surveyor Final Acceptance]
    S -->|Pass| CMP[COMPLETE]
    O -->|Owner Decision| MORE
```

</details>

## Package layout

| Path | Purpose |
|---|---|
| `plugin.json` | Agent Plugins v1.0.0 manifest |
| `skills/` | Router, planning stages, and role skills |
| `hooks/` | Four portable class adapters plus the verified Claude Code / Codex mapping |
| `README.md` and governance docs | Public product and conduct surfaces |

There is no `mcp.json`, `bin` entrypoint, postinstall, or runtime dependency on
another product's state.

## Provider neutrality

Skills declare **capabilities** (reasoning depth, repository access, mutation
tools, independence, optional vision). They never pin a model, provider API key,
default route, or launcher. Owners and clients choose how to satisfy each role.

## Contributing

Issues and carefully scoped pull requests help. See
[CONTRIBUTING.md](CONTRIBUTING.md). Everyone is covered by the
[Code of Conduct](CODE_OF_CONDUCT.md).

## Security

Report suspected vulnerabilities privately—not in a public issue. See
[SECURITY.md](SECURITY.md).

## License

Licensed under the [Apache License 2.0](LICENSE-APACHE).
