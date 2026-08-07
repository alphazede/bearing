---
name: map-the-route
description: Build Bearing's complete validated route from an approved plan specification, including design, SEIT, and implementation slices, when the journey enters Map the Route.
user-invocable: false
disable-model-invocation: true
---

# Map the Route

## Mission and non-goals

Follow the substep and artifact boundary supplied by Bearing; do not advance
into execution or invoke another planning skill.

For the design substep, resolve an owner decision only when it blocks honest
design, then write complete `design.md` and `seit.md`. Stop at Bearing's
design-and-SEIT validation checkpoint without drafting `implementation.md`.

For the implementation-drafting substep, reuse the validated design and SEIT.
Write `implementation.md` with traceable, bounded slices and execution manifests
that satisfy Bearing's supplied schema. Do not execute a slice or invoke another
planning skill.

Read the plan's recorded Role routes decision and honor those exact primary and
ordered fallback agents for delegation. When the decision is missing or
incomplete, stop before drafting `implementation.md` and report the owner-decision
blocker instead of substituting the onboarding provider or model selection.

Bearing owns deterministic `review.html` generation. Never hand-edit, summarize,
or replace it. The final review must embed the complete current `plan-spec.md`,
`design.md`, `seit.md`, and `implementation.md` sources with working artifact
links before the owner is asked to approve execution.

## Authority and prohibited actions

Use approved `plan-spec.md`, lens decision, route catalog, and substep. Do not
invent approval, IDs, routes, contracts, or results. Bearing validates artifacts
and generates the review.

The immutable WaveEnvelope's `authorRoute` and `reviewSlots` come only from the
approved plan's Role routes decision; never invent, widen, or substitute an
onboarding default for either.

Return structured planning state, findings, and artifacts to Navigator.
Do not invoke the next pass or record a planning transition. Bearing's TypeScript capability boundary remains the enforcement.

## Inputs and outputs schema

Read the plan directory, prior Q&A, goal, and substep. Design returns `design.md`
and `seit.md`; drafting returns `implementation.md`; Bearing adds `review.html`.

## Artifact grammar

Bearing's validator enforces a closed grammar over `plan-spec.md`, `design.md`,
`seit.md`, and `implementation.md`. Draft every artifact inside this grammar;
`bearing plan validate` rejects any deviation with a typed finding.

1. **Frontmatter.** Every artifact begins with `---` frontmatter declaring
   `type` (`plan-spec`, `design`, `seit`, or `implementation`) and
   `status: complete` or `status: amended`. Never emit draft, blocked, or
   pending lifecycle values.
2. **Identifiers.** Requirement ids are `AC-*` and `RISK-*`; design ids are
   `DES-*` and `CONTRACT-*`; SEIT row ids are `SEIT-*`; evidence commands are
   `CMD-*` and `PROC-*`. Every prefix is followed by uppercase letters, digits,
   dots, or hyphens — never underscores. Requirement ids are declared in
   plan-spec.md's Acceptance criteria and Risks and open questions sections,
   design ids in design.md, and SEIT row ids in seit.md's Traceability Matrix.
3. **Slices and manifests.** Slice headings are `### Slice <id>`; execution
   manifests are `### <id> execution manifest`. A slice id is a letter-run
   followed by a number (`S1`) or a dotted number (`1.2`).
   Ids never contain hyphens. Every slice has exactly one manifest with the
   same id, and every manifest has exactly one slice.
4. **SEIT sections.** seit.md contains the non-empty sections Required
   Commands, Traceability Matrix, and Cross-cutting Checks. Required Commands
   declares one `- **<CMD/PROC-id>** — description` bullet per command.
5. **Write sets.** A manifest's Write set is a single line of the form
   `Write only `path`` — bounded, normalized, repository-relative literal
   paths only. Prohibitions inside a write set (`do not`, `never`, `except`,
   `read-only`, `leave`, `without`, ...) are ambiguous and fail closed;
   restate any negation in prose without backticks.
6. **Traceability Matrix.** The matrix is exactly one flat Markdown table with
   the eight columns SEIT row ID | Acceptance/risk ID | Design/contract ID |
   Boundary/test layer | Positive case | Negative/failure case |
   Command/procedure ID | Evidence.
   Every row carries exactly one typed SEIT row id, one typed requirement id,
   one typed design id, and one typed command id, all declared elsewhere, and
   states an observable failure in the negative/failure case. No nested or
   additional table belongs inside the matrix section; the OOPDSA table
   belongs in design.md's OOPDSA Implementation Design section.
7. **Procedures.** Procedure narratives are an opt-in convention: title a
   procedure `### SEIT-<id> <title>` under a `## ... Procedures` section and
   restate the row's Command, Positive case, Negative case, and Evidence (or
   Evidence target) fields exactly. Adopting the convention binds every
   PROC-command row to exactly one matching narrative.
8. **Slice fields.** Every slice declares Goal, Requirement IDs, Design IDs,
   SEIT proof rows, Type, Design lenses, Implementation role, Agent model
   route, Agent reasoning level, and Review path. Goals are bounded prose of
   at most 512 characters with no control characters.
9. **Manifest fields.** Every manifest declares Write set, Command IDs, Stop
   condition, and Human decision. Optional metadata — Shared interfaces
   (`path#Symbol`), Integration boundary, Parallel safe (`yes` or `no`
   followed by a reason) — may be added but must stay in the closed forms.
10. **Waves and dependencies.** Multi-slice plans declare `Wave <n>: <ids>`
    lines and every slice belongs to exactly one wave; waves are exactly 1
    through N. Dependencies are `S1 --> S2` arrows and must stay acyclic. An
    optional `## Phase graph` table names Phase, Slices, Depends on phases,
    and Integration checkpoints.
11. **Bounds.** A plan may declare at most 128 slices, manifests, write-set
    paths, and evidence commands. Explicit slice Inputs and Produces fields
    name `metric denominator`, `ledger key`, or `contract field` values in
    backticks.
12. **Plan controls.** plan-spec.md declares requirements in Acceptance
    criteria and Risks and open questions and names Entry criteria, Exit
    criteria, Rollback or repair, and Accountable controller.
13. **System catalog and trace.** The system map is an opt-in maturity
    convention: title a `## System Catalog` section in design.md to adopt it,
    and every catalog entry then binds. The catalog is a Markdown table with
    the System ID, System, and Responsibility columns and exactly one stable
    `SYS-<id>` per row; every entry resolves to a `### SYS-<id>` per-system
    specification inside the same section carrying non-empty Ownership,
    Inputs, Outputs, APIs, Data ownership, Invariants, Trust boundary,
    Failure modes, and Observability fields. An optional `## Requirement
    Trace` table maps Requirement ID, System ID, Contract ID, SEIT row ID,
    Slice ID, and Path columns; when the table is present, every declared
    requirement must reach a row in it and
    every SYS- reference in design.md must name a catalog entry, and
    every traced path must be covered by a slice write set.
14. **Risk profile.** The risk profile is an opt-in risk declaration: title
    a `## Risk Profile` section in plan-spec.md to adopt it, and the profile
    then binds every known risk flag. The section is a Markdown table with
    the Flag, Applies, and Coverage or rationale columns that must enumerate
    the complete closed flag set: moves_money, live_financial_action,
    agentic_tools, untrusted_external_content, personal_or_behavioral_data,
    multi_user, multi_tenant, company_customers, public_api_or_sdk,
    external_webhooks_and_providers, regulated_or_sanctions_exposure,
    production_service, availability_required, and
    automatic_external_issue_creation. A `yes` flag maps cross-artifact
    coverage in `;`-separated clauses — `design:` (a `##` heading in
    design.md) or `system:` (a catalog `SYS-` id), plus `seit:` (declared
    traceability rows) and `slice:` (declared slice ids) — and every yes
    flag must name at least one design or system, one SEIT row, and one
    slice. A `no` flag carries an evidence-backed not-applicable rationale
    of at least four words stating why the flag does not apply; placeholders
    (`none`, `tbd`, `no`), bare negations (`not applicable`, `does not
    apply`), and deferral language (`pending`, `deferred`, `to be
    determined`, `future`, `planned`) are rejected. Plans that never declare
    the section carry no profile and no risk findings.
15. **Slice workload aim.** A slice aims to declare at most 500 estimated
    tokens across its slice section and its execution manifest, estimated as
    bytes divided by four and rounded up. This is an aim, not a rule: passing
    it raises the advisory `slice_scope_advisory` and never changes the
    verdict, and a plan may keep a larger slice deliberately. The aim is
    ergonomic — it keeps the work handed to one agent bounded and reviewable.
    It is not a prediction: declared plan metadata has no measured
    relationship to the effort a slice actually consumes, so a long
    declaration means the plan is asking for a lot in one go, not that the
    slice will cost a lot. When the advisory fires, prefer splitting the
    slice. At run time the outcome projection reports each measured token
    total beside the same aim, so a retrospective can see which work ran hot;
    that record is measured usage only and forecasts nothing.

## State read and written

Read `plan-spec.md` and approved artifacts. Write only `design.md` and `seit.md`
during design, or `implementation.md` during drafting. Preserve stable IDs.

## Closed-loop workflow

1. Resolve the owner lens decision before design.
2. Trace requirements through contracts and prospective SEIT proof.
3. Stop at the design-and-SEIT checkpoint.
4. Draft reference-only slices with matching manifests.
5. Return current artifacts for review generation.

## Entry and exit criteria

Enter with a validated plan specification. Design exits with complete design and
SEIT; drafting then exits with a validated implementation plan. Never execute.

## Evidence requirements

Each slice references existing requirement, design, and SEIT rows. Its manifest
declares exact writes, mapped commands, stop condition, and human decision.

## Failure taxonomy

Distinguish owner question, invalid input or artifact, malformed receipt,
unsupported route, missing trace link, cancellation, interruption, adapter
failure, and token budget.

## Escalation and amendment rules

Ask one question only when design is blocked. Stop for amendment when drafting
exposes a plan or design conflict.

## Metrics and trace events

Report phases, slices, assignments, trace coverage, and paths. Bearing records
`stage.started`, `design.ready`, and `implementation-draft.started`.
