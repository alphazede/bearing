import { describe, expect, it } from "vitest";
import {
  artifactComplete,
  parsePlanDocuments,
  requiredManifestFields,
  requiredSliceFields,
  sectionPresent,
  structuralFindings,
  writeSetPathIssue,
  type PlanDocuments,
  type StructuralFindingCode,
} from "../src/journey/plan-structure.js";
import { validatePlan } from "../src/journey/planning-validator.js";

const plan = `---
type: plan-spec
status: complete
---

## Acceptance criteria

- **AC-1** — Import bounded data.

## Risks and open questions

- **RISK-1** — Invalid input must fail closed.

## Entry criteria

Requirements are approved.

## Exit criteria

All evidence commands pass.

## Rollback or repair

Repair the plan and rerun validation.

## Accountable controller

Navigator controls the phase.
`;

const design = `---
type: design
status: complete
---

## Use Cases and Communication Flows

The owner dispatches one bounded slice.

## Interface Option Check

No new interface is needed.

## OOPDSA Implementation Design

- **DES-1** — Reuse the bounded import boundary.
- **CONTRACT-1** — Invalid input fails closed.
`;

const seit = `---
type: seit
status: complete
---

## Required Commands

- **CMD-UNIT** — \`pnpm test\`

## Traceability Matrix

| SEIT row ID | Acceptance/risk ID | Design/contract ID | Boundary/test layer | Positive case | Negative/failure case | Command/procedure ID | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| SEIT-1 | AC-1, RISK-1 | DES-1, CONTRACT-1 | unit | valid input imports | invalid input fails closed | CMD-UNIT | test report |

## Cross-cutting Checks

The execution boundary remains unchanged.
`;

const implementation = `---
type: implementation
status: complete
---

## Dependency graph

Wave 1: **S1**

### Slice S1 — Import

**Goal.** Import bounded data.
**Requirement IDs.** AC-1, RISK-1
**Design IDs.** DES-1, CONTRACT-1
**SEIT proof rows.** SEIT-1
**Type.** New pure module and test
**Design lenses.** CDD
**Implementation role.** Backend Engineer
**Agent model route.** Codex agent default
**Agent reasoning level.** high
**Ponytail mode.** full
**Review path.** native review

### S1 execution manifest

**Write set.** Write only \`src/import.ts\`.
**Command IDs.** CMD-UNIT
**Stop condition.** Stop if the focused test fails.
**Human decision.** None.
`;

function secondSlice(writeSet = "Write only `src/verify.ts`."): string {
  return implementation
    .replace("Wave 1: **S1**", "Wave 1: **S1**\nWave 2: **S2**")
    .concat(`

### Slice S2 — Verify

**Goal.** Verify bounded data.
**Requirement IDs.** AC-1, RISK-1
**Design IDs.** DES-1, CONTRACT-1
**SEIT proof rows.** SEIT-1
**Type.** New pure module and test
**Design lenses.** CDD
**Implementation role.** Backend Engineer
**Agent model route.** Codex agent default
**Agent reasoning level.** high
**Ponytail mode.** full
**Review path.** native review

### S2 execution manifest

**Write set.** ${writeSet}
**Command IDs.** CMD-UNIT
**Stop condition.** Stop if the focused test fails.
**Human decision.** None.
`);
}

const documents = (overrides: Partial<PlanDocuments> = {}): PlanDocuments => ({
  plan,
  design,
  seit,
  implementation,
  ...overrides,
});

const codes = (input: PlanDocuments): StructuralFindingCode[] =>
  structuralFindings(parsePlanDocuments(input)).map((finding) => finding.code);
const writeSetClauseReason = "ambiguous write authority fails closed rather than silently granting write access; restate the prohibition in prose without backticks per planning contract rule 5";

describe("plan structure", () => {
  it("builds the immutable model once from the four injected strings", () => {
    const model = parsePlanDocuments(documents());

    expect([...model.slices]).toHaveLength(1);
    expect(model.slices.get("S1")?.requirementIds).toEqual(new Set(["AC-1", "RISK-1"]));
    expect(model.manifests.get("S1")?.writeSetPaths).toEqual(["src/import.ts"]);
    expect(model.traceRows.get("SEIT-1")?.commands).toEqual(new Set(["CMD-UNIT"]));
    expect(codes(documents())).toEqual([]);
  });

  it("blocks an explicitly declared input when no plan producer or recorded ledger key exists", () => {
    const unresolved = documents({
      implementation: implementation.replace(
        "**Goal.** Import bounded data.",
        "**Goal.** Import bounded data.\n**Inputs.** Metric denominator `acceptedCriterionCount`.",
      ),
    });
    const inputFinding = structuralFindings(parsePlanDocuments(unresolved))
      .find((finding) => finding.code === "input_unproduced");

    expect(inputFinding).toMatchObject({
      code: "input_unproduced",
      severity: "amendment",
      artifact: "implementation.md",
      sliceId: "S1",
      observed: "metric denominator: acceptedCriterionCount",
    });
    expect(validatePlan({ documents: unresolved, planDirectory: "/tmp/plan" }).verdict).toBe("NEEDS_AMENDMENT");
  });

  it("resolves all three explicit input shapes to producers declared anywhere in the plan", () => {
    const resolved = documents({
      implementation: secondSlice()
        .replace(
          "**Goal.** Import bounded data.",
          "**Goal.** Import bounded data.\n**Produces.** Metric denominator `acceptedCriterionCount`; ledger key `customSignal`; contract field `trialPolicy`.",
        )
        .replace(
          "**Goal.** Verify bounded data.",
          "**Goal.** Verify bounded data.\n**Inputs.** Metric denominator `acceptedCriterionCount`; ledger key `customSignal`; contract field `trialPolicy`.",
        ),
    });

    expect(codes(resolved)).not.toContain("input_unproduced");
  });

  it("refuses a producer whose kind differs from the declared input", () => {
    // A contract field named foo must not satisfy an input declared as a metric denominator foo:
    // they are distinct input domains that happen to share a name.
    const mismatched = documents({
      implementation: secondSlice()
        .replace(
          "**Goal.** Import bounded data.",
          "**Goal.** Import bounded data.\n**Produces.** Contract field `sharedName`.",
        )
        .replace(
          "**Goal.** Verify bounded data.",
          "**Goal.** Verify bounded data.\n**Inputs.** Metric denominator `sharedName`.",
        ),
    });

    expect(codes(mismatched)).toContain("input_unproduced");
  });

  it("accepts explicitly declared ledger inputs that the existing ledger already records", () => {
    const recorded = documents({
      implementation: implementation.replace(
        "**Goal.** Import bounded data.",
        "**Goal.** Import bounded data.\n**Inputs.** Ledger key `stage`; ledger key `requirementRefs`.",
      ),
    });

    expect(codes(recorded)).not.toContain("input_unproduced");
  });

  it("skips ambiguous provenance text instead of guessing and emitting false positives", () => {
    const ambiguous = documents({
      implementation: implementation.replace(
        "**Goal.** Import bounded data.",
        "**Goal.** Read contract field `mysteryValue` when available.\n**Inputs.** Structured outcome records from the ledger.",
      ),
    });

    expect(codes(ambiguous)).not.toContain("input_unproduced");
  });

  it("makes Ponytail mode optional without relaxing the other required slice fields", () => {
    const noPonytail = documents({ implementation: implementation.replace("**Ponytail mode.** full\n", "") });
    const noReviewPath = documents({ implementation: implementation.replace("**Review path.** native review\n", "") });

    expect(requiredSliceFields).not.toContain("Ponytail mode");
    expect(codes(noPonytail)).not.toContain("slice_field_missing");
    expect(codes(noReviewPath)).toContain("slice_field_missing");
  });

  it("keeps the ten slice and four manifest requirements unchanged by content", () => {
    expect(requiredSliceFields).toEqual([
      "Goal",
      "Requirement IDs",
      "Design IDs",
      "SEIT proof rows",
      "Type",
      "Design lenses",
      "Implementation role",
      "Agent model route",
      "Agent reasoning level",
      "Review path",
    ]);
    expect(requiredManifestFields).toEqual(["Write set", "Command IDs", "Stop condition", "Human decision"]);
  });

  it("recognizes valid optional manifest metadata without changing omission behavior", () => {
    const enriched = documents({
      implementation: implementation
        .replace("**Command IDs.** CMD-UNIT", [
          "**Shared interfaces.** `src/import.ts#run`",
          "**Integration boundary.** import API",
          "**Parallel safe.** yes — the write set is disjoint.",
          "**Command IDs.** CMD-UNIT",
        ].join("\n")),
    });
    const model = parsePlanDocuments(enriched);

    expect(codes(documents())).toEqual([]);
    expect(codes(enriched)).toEqual([]);
    expect(model.manifests.get("S1")).toMatchObject({
      sharedInterfaces: ["src/import.ts#run"],
      integrationBoundary: "import API",
      parallelSafe: true,
    });
  });

  it("rejects malformed optional metadata and reports parallel-safe overlap as an amendment", () => {
    const malformedInterface = documents({
      implementation: implementation.replace(
        "**Command IDs.** CMD-UNIT",
        "**Shared interfaces.** `src/*.ts`\n**Command IDs.** CMD-UNIT",
      ),
    });
    const malformedBoundary = documents({
      implementation: implementation.replace(
        "**Command IDs.** CMD-UNIT",
        "**Integration boundary.** api/*\n**Command IDs.** CMD-UNIT",
      ),
    });
    const malformedParallel = documents({
      implementation: implementation.replace(
        "**Command IDs.** CMD-UNIT",
        "**Parallel safe.** yes\n**Command IDs.** CMD-UNIT",
      ),
    });
    const oneDeclaredParallel = documents({
      implementation: secondSlice("Write only `src/import.ts`.").replace(
        "**Command IDs.** CMD-UNIT",
        "**Parallel safe.** yes — the write set is disjoint.\n**Command IDs.** CMD-UNIT",
      ),
    });
    const overlap = documents({
      implementation: secondSlice("Write only `src/import.ts`.").replaceAll(
        "**Command IDs.** CMD-UNIT",
        "**Parallel safe.** yes — the write set is disjoint.\n**Command IDs.** CMD-UNIT",
      ),
    });
    const disjoint = documents({
      implementation: secondSlice().replaceAll(
        "**Command IDs.** CMD-UNIT",
        "**Parallel safe.** yes — the write set is disjoint.\n**Command IDs.** CMD-UNIT",
      ),
    });
    const overlapFinding = structuralFindings(parsePlanDocuments(overlap))
      .find((finding) => finding.code === "parallel_safety_conflict");

    expect(codes(malformedInterface)).toContain("optional_manifest_malformed");
    expect(codes(malformedBoundary)).toContain("optional_manifest_malformed");
    expect(codes(malformedParallel)).toContain("optional_manifest_malformed");
    expect(codes(oneDeclaredParallel)).toContain("parallel_safety_conflict");
    expect(codes(disjoint)).not.toContain("parallel_safety_conflict");
    expect(overlapFinding).toMatchObject({
      severity: "amendment",
      observed: "S1, S2: src/import.ts",
    });
    expect(validatePlan({ documents: oneDeclaredParallel, planDirectory: "/tmp/plan" }).verdict).toBe("NEEDS_AMENDMENT");
    expect(validatePlan({ documents: overlap, planDirectory: "/tmp/plan" }).verdict).toBe("NEEDS_AMENDMENT");
  });

  it("reports parallel-safe conflicts across shared interfaces and integration boundaries", () => {
    const sharedInterface = documents({
      implementation: secondSlice().replaceAll(
        "**Command IDs.** CMD-UNIT",
        [
          "**Shared interfaces.** `src/shared.ts#Client`",
          "**Parallel safe.** yes — the write set is disjoint.",
          "**Command IDs.** CMD-UNIT",
        ].join("\n"),
      ),
    });
    const sharedIntegrationBoundary = documents({
      implementation: secondSlice().replaceAll(
        "**Command IDs.** CMD-UNIT",
        [
          "**Integration boundary.** shared API",
          "**Parallel safe.** yes — the write set is disjoint.",
          "**Command IDs.** CMD-UNIT",
        ].join("\n"),
      ),
    });

    expect(codes(sharedInterface)).toContain("parallel_safety_conflict");
    expect(codes(sharedIntegrationBoundary)).toContain("parallel_safety_conflict");
  });

  it("recognizes and validates the optional phase-graph table", () => {
    const phaseGraph = `
## Phase graph

| Phase | Slices | Depends on phases | Integration checkpoints |
|---|---|---|---|
| \`build\` | S1 | — | 0 |
`;
    const accepted = documents({
      implementation: implementation.replace("## Dependency graph", `${phaseGraph}\n## Dependency graph`),
    });
    const unknownSlice = documents({
      implementation: accepted.implementation.replace("| S1 | — | 0 |", "| S2 | — | 0 |"),
    });
    const malformedCount = documents({
      implementation: accepted.implementation.replace("| S1 | — | 0 |", "| S1 | — | many |"),
    });
    const explanatoryCount = documents({
      implementation: accepted.implementation.replace("| S1 | — | 0 |", "| S1 | — | 1 (owner checkpoint) |"),
    });

    expect(parsePlanDocuments(accepted).phaseGraph).toEqual([{
      phaseId: "build",
      sliceIds: ["S1"],
      dependsOnPhases: [],
      integrationCheckpointCount: 0,
    }]);
    expect(parsePlanDocuments(explanatoryCount).phaseGraph[0]?.integrationCheckpointCount).toBe(1);
    expect(codes(accepted)).toEqual([]);
    expect(codes(unknownSlice)).toContain("phase_graph_malformed");
    expect(codes(malformedCount)).toContain("phase_graph_malformed");
    for (const malformed of ["1.5", "1/2", "1 garbage"]) {
      const value = documents({
        implementation: accepted.implementation.replace("| S1 | — | 0 |", `| S1 | — | ${malformed} |`),
      });
      expect(codes(value), malformed).toContain("phase_graph_malformed");
    }
  });

  it.each<{
    code: StructuralFindingCode;
    mutate: (value: PlanDocuments) => PlanDocuments;
  }>([
    {
      code: "slice_field_missing",
      mutate: (value) => ({ ...value, implementation: value.implementation.replace("**Review path.** native review\n", "") }),
    },
    {
      code: "manifest_field_missing",
      mutate: (value) => ({ ...value, implementation: value.implementation.replace("**Human decision.** None.\n", "") }),
    },
    {
      code: "writeset_glob",
      mutate: (value) => ({ ...value, implementation: value.implementation.replace("src/import.ts", "src/*.ts") }),
    },
    {
      code: "writeset_unsafe_path",
      mutate: (value) => ({ ...value, implementation: value.implementation.replace("src/import.ts", "../src/import.ts") }),
    },
    {
      code: "writeset_duplicate",
      mutate: (value) => ({ ...value, implementation: value.implementation.replace("`src/import.ts`.", "`src/import.ts` and `src/import.ts`.") }),
    },
    {
      code: "writeset_readonly_harvest",
      mutate: (value) => ({ ...value, implementation: value.implementation.replace("Write only `src/import.ts`.", "Do not modify `src/import.ts`; it is read-only.") }),
    },
    {
      code: "writeset_multiline",
      mutate: (value) => ({ ...value, implementation: value.implementation.replace("Write only `src/import.ts`.", "Write only `src/import.ts`.\nAlso `test/import.test.ts`.") }),
    },
    {
      code: "writeset_missing_only",
      mutate: (value) => ({ ...value, implementation: value.implementation.replace("Write only `src/import.ts`.", "Write `src/import.ts`.") }),
    },
    {
      code: "goal_unbounded",
      mutate: (value) => ({ ...value, implementation: value.implementation.replace("Import bounded data.", "x".repeat(513)) }),
    },
    {
      code: "writeset_empty",
      mutate: (value) => ({ ...value, implementation: value.implementation.replace("Write only `src/import.ts`.", "Write only.") }),
    },
    {
      code: "seit_section_missing",
      mutate: (value) => ({ ...value, seit: value.seit.replace("## Cross-cutting Checks", "## Removed Checks") }),
    },
    {
      code: "design_section_missing",
      mutate: (value) => ({ ...value, design: value.design.replace("## Interface Option Check", "## Removed Interface Check") }),
    },
    {
      code: "artifact_frontmatter_invalid",
      mutate: (value) => ({ ...value, plan: value.plan.replace("status: complete\n", "") }),
    },
    {
      code: "id_format_invalid",
      mutate: (value) => ({
        ...value,
        implementation: value.implementation.replace("AC-1, RISK-1", "AC_bad, RISK-1"),
      }),
    },
    {
      code: "id_unknown",
      mutate: (value) => ({ ...value, implementation: value.implementation.replace("AC-1, RISK-1", "AC-1, AC-2, RISK-1") }),
    },
    {
      code: "trace_header_invalid",
      mutate: (value) => ({ ...value, seit: value.seit.replace(" | Evidence |", " |") }),
    },
    {
      code: "trace_cell_placeholder",
      mutate: (value) => ({ ...value, seit: value.seit.replace("| test report |", "| TBD |") }),
    },
    {
      code: "slice_manifest_mismatch",
      mutate: (value) => ({ ...value, implementation: `${value.implementation}\n### S2 execution manifest\n\n**Write set.** No writes required.\n**Command IDs.** CMD-UNIT\n**Stop condition.** Stop on failure.\n**Human decision.** None.\n` }),
    },
    {
      code: "slice_reference_dangling",
      mutate: (value) => ({ ...value, implementation: value.implementation.replace("Import bounded data.", "Import bounded data for Slice S2.") }),
    },
    {
      code: "wave_noncontiguous",
      mutate: (value) => ({ ...value, implementation: value.implementation.replace("Wave 1", "Wave 2") }),
    },
    {
      code: "command_undeclared",
      mutate: (value) => ({ ...value, implementation: value.implementation.replace("**Command IDs.** CMD-UNIT", "**Command IDs.** CMD-MISSING") }),
    },
    {
      code: "build_command_in_manifest",
      mutate: (value) => ({ ...value, implementation: value.implementation.replace("**Command IDs.** CMD-UNIT", "**Command IDs.** CMD-BUILD") }),
    },
  ])("$code has a clean positive case and a seeded negative case", ({ code, mutate }) => {
    const clean = documents();

    expect(codes(clean)).not.toContain(code);
    expect(codes(mutate(clean))).toContain(code);
  });

  it("matches or exceeds both existing path predicates", () => {
    const rejected = [
      "",
      " src/import.ts",
      "src/import.ts ",
      "/src/import.ts",
      "C:/src/import.ts",
      "src//import.ts",
      "src/./import.ts",
      "src/../import.ts",
      "src/.../import.ts",
      "src/*.ts",
      "src/<name>.ts",
      "src/>name.ts",
      String.raw`src\import.ts`,
      `src/\u0000import.ts`,
      "x".repeat(4097),
    ];

    expect(rejected.map(writeSetPathIssue).every(Boolean)).toBe(true);
    expect(writeSetPathIssue("src/import.ts")).toBeUndefined();
  });

  it("keeps aggregate no-write recognition in parity with the legacy shim", () => {
    const acceptedPhrase = codes(documents({ implementation: implementation.replace("Write only `src/import.ts`.", "No writes required.") }));
    const journeyOnlyPhrase = codes(documents({ implementation: implementation.replace("Write only `src/import.ts`.", "No new files.") }));
    const conflictingPhrase = codes(documents({ implementation: implementation.replace("Write only `src/import.ts`.", "No writes required, including `src/import.ts`.") }));

    expect(acceptedPhrase.filter((code) => code === "writeset_empty")).toHaveLength(1);
    expect(journeyOnlyPhrase.filter((code) => code === "writeset_empty")).toHaveLength(1);
    expect(conflictingPhrase).toContain("writeset_empty");
  });

  it("reproduces all three Phase 1 defects with their named findings", () => {
    const glob = documents({ implementation: implementation.replace("src/import.ts", "skills/*/SKILL.md") });
    const fiveMissing = documents({
      implementation: ["Type", "Design lenses", "Implementation role", "Agent model route", "Agent reasoning level"]
        .reduce((value, field) => value.replace(new RegExp(`^\\*\\*${field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.\\*\\*.*\\n`, "m"), ""), implementation),
    });
    const sectionsMissing = documents({
      seit: seit
        .replace("## Required Commands", "## Removed Commands")
        .replace("## Traceability Matrix", "## Removed Matrix")
        .replace("## Cross-cutting Checks", "## Removed Checks"),
    });

    expect(codes(glob)).toContain("writeset_glob");
    expect(codes(fiveMissing).filter((code) => code === "slice_field_missing")).toHaveLength(5);
    expect(codes(sectionsMissing).filter((code) => code === "seit_section_missing")).toHaveLength(3);
  });

  it("exposes the shared section and frontmatter predicates", () => {
    expect(sectionPresent(design, "Interface Option Check")).toBe(true);
    expect(sectionPresent(design.replace("No new interface is needed.", ""), "Interface Option Check")).toBe(false);
    expect(artifactComplete(design, "design", ["Interface Option Check"])).toBe(true);
    expect(artifactComplete(design.replace("status: complete", "status: draft"), "design", ["Interface Option Check"])).toBe(false);
  });

  it("rejects empty, identifier-free, and all-no-write plans before dispatch", () => {
    const empty = documents({ implementation: implementation.slice(0, implementation.indexOf("### Slice")) });
    const identifierFree = documents({
      implementation: implementation
        .replace("**Requirement IDs.** AC-1, RISK-1", "**Requirement IDs.** None.")
        .replace("**Design IDs.** DES-1, CONTRACT-1", "**Design IDs.** None.")
        .replace("**SEIT proof rows.** SEIT-1", "**SEIT proof rows.** None."),
    });
    const noWrites = documents({ implementation: implementation.replace("Write only `src/import.ts`.", "No writes required.") });

    expect(codes(empty)).toContain("slice_manifest_mismatch");
    expect(codes(identifierFree)).toContain("id_unknown");
    expect(codes(noWrites)).toContain("writeset_empty");
  });

  it("preserves every membership across compact and repeated wave declarations", () => {
    const compact = parsePlanDocuments(documents({
      implementation: implementation.replace("Wave 1: **S1**", "Wave 1: **S1** · Wave 2: **S2**"),
    }));
    const repeated = parsePlanDocuments(documents({
      implementation: implementation.replace("Wave 1: **S1**", "Wave 1: **S1**\nWave 1: **S2**"),
    }));

    expect(compact.waves).toEqual(new Map([[1, new Set(["S1"])], [2, new Set(["S2"])]]));
    expect(repeated.waves).toEqual(new Map([[1, new Set(["S1", "S2"])]]));
  });

  it("parses only declared wave members before dependency annotations", () => {
    const estimated = parsePlanDocuments(documents({
      implementation: implementation.replace("Wave 1: **S1**", "Wave 1 completes in about 2.5 hours and covers S1."),
    }));
    const dependent = parsePlanDocuments(documents({
      implementation: implementation.replace("Wave 1: **S1**", "Wave 2: S2 (after S1)"),
    }));

    expect(estimated.waves).toEqual(new Map([[1, new Set(["S1"])]]));
    expect(dependent.waves).toEqual(new Map([[2, new Set(["S2"])]]));
  });

  it("rejects duplicate trace ids and surplus trace cells", () => {
    const row = "| SEIT-1 | AC-1, RISK-1 | DES-1, CONTRACT-1 | unit | valid input imports | invalid input fails closed | CMD-UNIT | test report |";
    const duplicate = documents({ seit: seit.replace(row, `${row}\n${row}`) });
    const surplus = documents({ seit: seit.replace(row, `${row.slice(0, -1)}| extra |`) });

    expect(codes(duplicate)).toContain("trace_header_invalid");
    expect(codes(surplus)).toContain("trace_header_invalid");
  });

  it("requires exactly the eight traceability headers with no extras or duplicates", () => {
    const extra = documents({
      seit: seit
        .replace("| Evidence |", "| Evidence | Extra |")
        .replace("| --- | --- | --- | --- | --- | --- | --- | --- |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- |")
        .replace("| CMD-UNIT | test report |", "| CMD-UNIT | test report | extra evidence |"),
    });
    const duplicate = documents({
      seit: seit
        .replace("| Evidence |", "| Evidence | Evidence |")
        .replace("| --- | --- | --- | --- | --- | --- | --- | --- |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- |")
        .replace("| CMD-UNIT | test report |", "| CMD-UNIT | test report | duplicate evidence |"),
    });

    expect(codes(extra)).toContain("trace_header_invalid");
    expect(codes(duplicate)).toContain("trace_header_invalid");
  });

  it("matches the execution boundary's case-sensitive slice heading", () => {
    const lowercase = documents({ implementation: implementation.replace("### Slice S1", "### slice S1") });

    expect(codes(lowercase)).toContain("slice_manifest_mismatch");
  });

  it("applies the execution boundary's bounded-text rule to slice goals", () => {
    const controlCharacter = documents({
      implementation: implementation.replace("Import bounded data.", "Import\u0007bounded data."),
    });

    expect(codes(controlCharacter)).toContain("goal_unbounded");
  });

  it("rejects trace rows without typed requirement and design ids", () => {
    const row = "| SEIT-1 | AC-1, RISK-1 | DES-1, CONTRACT-1 | unit | valid input imports | invalid input fails closed | CMD-UNIT | test report |";
    const malformed = documents({
      seit: seit.replace(row, `${row}\n| SEIT-2 | prose | prose | unit | valid input imports | invalid input fails closed | CMD-UNIT | test report |`),
    });

    expect(codes(malformed)).toContain("trace_header_invalid");
  });

  it("rejects trace rows without exactly one typed SEIT row id", () => {
    const row = "| SEIT-1 | AC-1, RISK-1 | DES-1, CONTRACT-1 | unit | valid input imports | invalid input fails closed | CMD-UNIT | test report |";
    const invalid = documents({
      seit: seit.replace(row, `${row}\n| proof-row | AC-1 | DES-1 | unit | valid input imports | invalid input fails closed | CMD-UNIT | test report |`),
    });
    const multiple = documents({
      seit: seit.replace(row, `${row}\n| SEIT-2 and SEIT-3 | AC-1 | DES-1 | unit | valid input imports | invalid input fails closed | CMD-UNIT | test report |`),
    });

    expect(codes(invalid)).toContain("trace_header_invalid");
    expect(codes(multiple)).toContain("trace_header_invalid");
  });

  it("requires every slice to belong to exactly one declared wave", () => {
    const unassigned = documents({ implementation: secondSlice().replace("Wave 2: **S2**\n", "") });
    const repeated = documents({ implementation: secondSlice().replace("Wave 2: **S2**", "Wave 2: **S1, S2**") });
    const unknown = documents({ implementation: secondSlice().replace("Wave 2: **S2**", "Wave 2: **S2, S3**") });

    expect(codes(unassigned)).toContain("wave_noncontiguous");
    expect(codes(repeated)).toContain("wave_noncontiguous");
    expect(codes(unknown)).toContain("wave_noncontiguous");
  });

  it("rejects a no-write slice even when another slice supplies an aggregate path", () => {
    expect(codes(documents({ implementation: secondSlice("No writes required.") }))).toContain("writeset_empty");
  });

  it("keeps write-set prohibitions scoped to clauses without splitting code paths", () => {
    const prohibited = documents({
      implementation: implementation.replace("Write only `src/import.ts`.", "Only inspect; do not write `src/import.ts`."),
    });
    const unrelated = documents({
      implementation: implementation.replace("Write only `src/import.ts`.", "Write only `src/import.ts`; do not edit tests."),
    });

    expect(codes(prohibited)).toContain("writeset_readonly_harvest");
    expect(codes(unrelated)).not.toContain("writeset_readonly_harvest");
  });

  it.each([
    "Write only `src/a.ts` and do not modify `src/b.ts`",
    "Write only `src/a.ts`. `src/b.ts` is read-only.",
    "Write only `src/a.ts`. `src/b.ts` must not be changed.",
    "Write only `src/a.ts`. Leave `src/b.ts` untouched.",
    "Write only `src/a.ts`. Don't modify `src/b.ts`.",
  ])("rejects every path in an ambiguous write set: %s", (writeSet) => {
    const input = documents({
      implementation: implementation.replace("Write only `src/import.ts`.", writeSet),
    });
    const model = parsePlanDocuments(input);
    const readonlyFindings = structuralFindings(model).filter((finding) => finding.code === "writeset_readonly_harvest");

    expect(model.manifests.get("S1")?.writeSetPaths).toEqual([]);
    expect(readonlyFindings).toEqual([
      expect.objectContaining({
        required: writeSetClauseReason,
        remedy: "Restate the prohibition in prose without backticks, per planning contract rule 5.",
      }),
    ]);
  });

  it("enforces the execution boundary collection limits", () => {
    const paths = [...Array(129)].map((_, index) => `src/${index}.ts`);
    const pathHeavy = documents({
      implementation: implementation.replace("`src/import.ts`", paths.map((path) => `\`${path}\``).join(", ")),
    });
    const commandIds = [...Array(129)].map((_, index) => `CMD-${index + 1}`);
    const commandHeavy = documents({
      seit: seit
        .replace("- **CMD-UNIT** — `pnpm test`", commandIds.map((id) => `- **${id}** — test`).join("\n"))
        .replace("CMD-UNIT | test report", `${commandIds.join(", ")} | test report`),
      implementation: implementation.replace("**Command IDs.** CMD-UNIT", `**Command IDs.** ${commandIds.join(", ")}`),
    });
    const prefix = implementation.slice(0, implementation.indexOf("### Slice"));
    const sliceHeavy = documents({
      implementation: `${prefix}${[...Array(129)].map((_, index) => {
        const id = `S${index + 1}`;
        return implementation.slice(implementation.indexOf("### Slice"))
          .replaceAll("S1", id)
          .replace("src/import.ts", `src/${index}.ts`);
      }).join("\n")}`,
    });

    expect(codes(pathHeavy)).toContain("writeset_unsafe_path");
    expect(codes(commandHeavy)).toContain("command_undeclared");
    expect(codes(sliceHeavy)).toContain("slice_manifest_mismatch");
  });

  it("does not promote code symbols or prose phrases into plan identifiers", () => {
    const symbols = documents({
      design: design.replace("No new interface is needed.", "No new interface; `contract_ambiguous`, `SEIT_ID`, and `seit_section_missing` are code symbols."),
      plan: plan.replace("Import bounded data.", "Import bounded data; Recon is risk-recommended."),
    });

    expect(codes(symbols)).not.toContain("id_format_invalid");
    expect(parsePlanDocuments(symbols).planIds).toEqual(new Set(["AC-1", "RISK-1"]));
  });

  it("carries the source across branched dependency continuation lines", () => {
    const model = parsePlanDocuments(documents({
      implementation: implementation.replace(
        "Wave 1: **S1**",
        "Wave 1: **S1**\nS1 ──┬──> S2\n   └──> S3\nS3 --> S1",
      ),
    }));

    expect(model.dependencies.get("S1")).toEqual(new Set(["S2", "S3"]));
    expect(model.dependencies.get("S3")).toEqual(new Set(["S1"]));
  });

  it("binds a nested branch continuation to the last node before the fork", () => {
    const model = parsePlanDocuments(documents({
      implementation: implementation.replace(
        "Wave 1: **S1**",
        "Wave 1: **S1**\nS1 --> S2 ──┬──> S3\n          └──> S4",
      ),
    }));

    expect(model.dependencies.get("S1")).toEqual(new Set(["S2"]));
    expect(model.dependencies.get("S2")).toEqual(new Set(["S3", "S4"]));
  });
});
