# Map the Route Artifact Grammar

Apply this closed grammar while authoring or validating planning artifacts.
Bearing rejects deviations with typed findings.

## Shared artifact rules

1. Frontmatter declares `type` as `plan-spec`, `design`, `seit`, or
   `implementation`, and `status` as `complete` or `amended`.
2. Journey-authored requirement IDs use `AC-*` or `RISK-*`; references to an
   existing requirements register keep that register's identities verbatim.
   Design IDs use `DES-*` or `CONTRACT-*`; SEIT rows use `SEIT-*`; commands
   use `CMD-*` or `PROC-*`. Suffixes contain only uppercase letters, digits,
   dots, or hyphens.
3. `<journey-topic>-spec.md` declares requirements, Entry criteria, Exit criteria,
   Rollback or repair, and Accountable controller. `design.md` declares design
   IDs. `seit.md` declares SEIT rows and commands.
4. Preserve stable IDs. Every implementation reference resolves to a declared
   requirement, design contract, SEIT row, and command.
5. Owner-confirmed lineup identities and `review_cadence: at-end` are required before
   implementation drafting; missing identities or cadence block drafting.
   Do not offer `per-slice` or `per-round`.
   Active/standby/unused role states may remain provisional until route review
   resolves the Journey type. The final implementation and `review.html` then
   record the route-determined active, standby, and unused instances.

## Requirements register

1. Before authoring a Journey specification, establish whether the target
   repository or system already has a requirements register and where. When the
   repository cannot answer, ask the owner; never infer.
2. Where no register exists, author requirements as today; this section does not
   apply.
3. Where a register exists, specification requirement rows are either references
   to registered identities (no restated text), derivations from them
   (`AC-X derives from REG-ID`), or Journey-local `AC-*`/`RISK-*` criteria about
   write sets, seams, gates, or concurrency. Do not restate registered content.
4. `seit.md` references verification allocations where the register provides
   them. Where the register provides none for a referenced requirement, author
   Journey-level proof for it or return `NEEDS_OWNER_DECISION` when register
   authority is unclear; do not silently drop coverage. Journey-level proof
   rows remain Journey-local.
5. `review.html` marks every requirement as either a register reference or
   Journey-local, so a reviewer can tell which artifact owns each statement.
6. `design.md` is unaffected: it records how the work is built, which no
   requirements register covers.

## Published standards

1. When a slice, command, or proof implements a published standard, the plan and
   its execution manifest cite the exact document and clause.
2. Verification is against the standard's text, not against neighbouring
   implementation agreement; a passing cross-boundary test does not substitute
   for clause conformance.

## SEIT rules

1. Include non-empty `Required Commands`, `Traceability Matrix`, and
   `Cross-cutting Checks` sections.
2. Declare each command as `- **<CMD/PROC-id>** — description`.
3. Use one flat traceability table with exactly these columns: SEIT row ID |
   Acceptance/risk ID | Design/contract ID | Boundary/test layer | Positive
   case | Negative/failure case | Command/procedure ID | Evidence.
4. Every row carries exactly one SEIT row ID, requirement ID, design ID, and
   command ID, and names an observable failure.
5. If procedure narratives are used, title each `### SEIT-<id> <title>` under
   a procedures section and restate Command, Positive case, Negative case, and
   Evidence exactly. Every PROC row then has exactly one matching narrative.

## Implementation rules

1. Slice headings are `### Slice <id>` and manifests are
   `### <id> execution manifest`. IDs are a letter-run plus an integer or
   dotted integer. Every slice has exactly one matching manifest.
2. Every slice declares Goal, Requirement IDs, Design IDs, SEIT proof rows,
   Type, Design lenses, named implementation role, owner-selected model route,
   reasoning level, and review path. Goals are at most 512 characters.
3. Every manifest declares Write set, Command IDs, Stop condition, and Human
   decision. Optional fields are Shared interfaces (`path#Symbol`), Integration
   boundary, Published standard (`doc#clause`) when applicable, and Parallel
   safe (`yes` or `no` plus reason).
4. Write sets use one line: `Write only `path``. Paths are bounded, normalized,
   repository-relative literals. Put prohibitions in prose, not the write set.
5. Multi-slice plans declare consecutive `Wave <n>: <ids>` lines. Every slice
   belongs to one wave. Dependencies use acyclic `S1 --> S2` arrows.
6. Optional phase graphs use Phase | Slices | Depends on phases | Integration
   checkpoints. Optional Inputs and Produces name metric denominator, ledger
   key, or contract field values in backticks.
7. Plans may contain at most 128 slices, manifests, write paths, and commands.
   Aim for at most 500 estimated tokens per slice plus manifest; split larger
   packets when practical.

## Optional binding sections

If `## System Catalog` appears, use System ID | System | Responsibility with
one `SYS-*` per row. Each `### SYS-*` specification declares Ownership, Inputs,
Outputs, APIs, Data ownership, Invariants, Trust boundary, Failure modes, and
Observability. A Requirement Trace, when present, maps Requirement ID, System
ID, Contract ID, SEIT row ID, Slice ID, and Path; every requirement and path
must resolve.

If `## Risk Profile` appears, enumerate the complete closed flag set required
by Bearing. Every `yes` maps design or system, SEIT row, and slice coverage.
Every `no` gives an evidence-backed rationale of at least four words; do not use
placeholders, bare negations, or deferral language.

## Feature diagram and visual review rules

1. Select review-oriented feature diagrams (flow diagrams, state-machine diagrams, or process/sequence diagrams) when they materially clarify architecture or lifecycle behavior for owner review.
2. Major features select a justified subset or full set of diagrams based on architectural complexity. Trivial features or minor fixes do not require unnecessary diagrams.
3. Every feature diagram must include canonical, reviewable source (such as Mermaid code blocks), render visually inside generated `review.html`, and retain nearby authoritative explanatory text.

## Completion boundary

Author specification, design, SEIT, and implementation in that dependency order
with internal prospective checks. The owner review gate requires all four
artifacts plus the complete `review.html`; do not insert a specification-only
owner gate unless the owner explicitly requests staged approvals. The HTML
becomes authoritative only after integrated owner approval.
