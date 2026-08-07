import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  foldVerdict,
  validatePlan,
  type Finding,
  type FindingCode,
} from "../src/journey/planning-validator.js";
import type { PlanDocuments } from "../src/journey/plan-structure.js";

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

const documents = (overrides: Partial<PlanDocuments> = {}): PlanDocuments => ({
  plan,
  design,
  seit,
  implementation,
  ...overrides,
});

function validate(overrides: Partial<PlanDocuments> = {}) {
  return validatePlan({ documents: documents(overrides), planDirectory: "docs/plans/import" });
}

function finding(severity: Finding["severity"]): Finding {
  return {
    code: severity === "amendment" ? "validation_missing" : severity === "owner_decision" ? "contract_ambiguous" : "phase_control_missing",
    severity,
    artifact: "implementation.md",
    observed: "seed",
    required: "rule",
    remedy: "repair",
  };
}

function secondSlice(waves: string): string {
  return implementation
    .replace("Wave 1: **S1**", waves)
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

**Write set.** Write only \`src/import.ts\`.
**Command IDs.** CMD-UNIT
**Stop condition.** Stop if the focused test fails.
**Human decision.** None.
`);
}

function sharedIntegration(reviewPath: string): string {
  return secondSlice("Wave 1: **S1, S2**")
    .replace("### S1 execution manifest", "### S1 execution manifest\n\n**Integration owner.** S1")
    .replaceAll("**Review path.** native review", `**Review path.** ${reviewPath}`);
}

const findingCodes = (overrides: Partial<PlanDocuments>): FindingCode[] => validate(overrides).findings.map((item) => item.code);

describe("planning validator", () => {
  it("returns a stable PASS and content hash for a complete plan", () => {
    const first = validate();
    const second = validate();

    expect(first).toEqual(second);
    expect(first.verdict).toBe("PASS");
    expect(first.findings).toEqual([]);
    expect(first.checkedContentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(validate({ plan: `${plan}\n` }).checkedContentHash).not.toBe(first.checkedContentHash);
  });

  it("folds verdict policy independently of all checks", () => {
    expect(foldVerdict([])).toBe("PASS");
    expect(foldVerdict([finding("owner_decision")])).toBe("OWNER_DECISION_REQUIRED");
    expect(foldVerdict([finding("amendment")])).toBe("NEEDS_AMENDMENT");
    expect(foldVerdict([finding("owner_decision"), finding("amendment")])).toBe("NEEDS_AMENDMENT");
    expect(foldVerdict([finding("advisory")])).toBe("PASS");
  });

  it("reports untaught phase controls without gating approval", () => {
    const withoutControls = plan
      .replace("## Entry criteria", "## Removed entry")
      .replace("## Exit criteria", "## Removed exit")
      .replace("## Rollback or repair", "## Removed rollback")
      .replace("## Accountable controller", "## Removed controller");
    const result = validate({ plan: withoutControls });

    expect(result.verdict).toBe("PASS");
    expect(result.findings.filter((item) => item.code === "phase_control_missing")).toEqual([
      expect.objectContaining({ severity: "advisory" }),
      expect.objectContaining({ severity: "advisory" }),
      expect.objectContaining({ severity: "advisory" }),
      expect.objectContaining({ severity: "advisory" }),
    ]);
  });

  it("does not add untaught phase-control diagnostics to a legacy unstructured plan", () => {
    const legacy = plan
      .replace(/^---[\s\S]*?---\n/, "# Legacy plan\n")
      .replace("## Entry criteria", "## Removed entry")
      .replace("## Exit criteria", "## Removed exit")
      .replace("## Rollback or repair", "## Removed rollback")
      .replace("## Accountable controller", "## Removed controller");
    const result = validate({ plan: legacy });

    expect(result.findings).toContainEqual(expect.objectContaining({ code: "artifact_frontmatter_invalid" }));
    expect(result.findings).not.toContainEqual(expect.objectContaining({ code: "phase_control_missing" }));
  });

  it("reports both severity classes while amendments dominate", () => {
    const result = validate({
      implementation: implementation
        .replace("Import bounded data.", "TODO decide the import contract.")
        .replace("src/import.ts", "src/*.ts"),
    });

    expect(result.verdict).toBe("NEEDS_AMENDMENT");
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "writeset_glob", severity: "amendment" }),
      expect.objectContaining({ code: "contract_ambiguous", severity: "owner_decision" }),
    ]));
  });

  it.each<{
    code: FindingCode;
    severity: Finding["severity"];
    mutate: () => Partial<PlanDocuments>;
  }>([
    {
      code: "traceability_broken",
      severity: "amendment",
      mutate: () => ({ plan: plan.replace("- **AC-1**", "- **AC-2** — Untraced acceptance.\n- **AC-1**") }),
    },
    {
      code: "traceability_broken",
      severity: "amendment",
      mutate: () => ({
        plan: plan.replace("- **AC-1**", "- **AC-2** — Second acceptance.\n- **AC-1**"),
        implementation: implementation.replace("AC-1, RISK-1", "AC-2, RISK-1"),
      }),
    },
    {
      code: "dependency_cycle",
      severity: "amendment",
      mutate: () => ({ implementation: implementation.replace("Wave 1: **S1**", "Wave 1: **S1**\nS1 --> S1") }),
    },
    {
      code: "validation_missing",
      severity: "amendment",
      mutate: () => ({ seit: seit.replace("invalid input fails closed", "input behavior is described") }),
    },
    {
      code: "parallelism_unsafe",
      severity: "amendment",
      mutate: () => ({ implementation: secondSlice("Wave 1: **S1, S2**") }),
    },
    {
      code: "integration_unowned",
      severity: "owner_decision",
      mutate: () => ({ implementation: secondSlice("Wave 1: **S1, S2**") }),
    },
    {
      code: "contract_ambiguous",
      severity: "owner_decision",
      mutate: () => ({ implementation: implementation.replace("Import bounded data.", "TODO decide later.") }),
    },
    {
      code: "phase_control_missing",
      severity: "advisory",
      mutate: () => ({ plan: plan.replace("## Entry criteria", "## Removed entry control") }),
    },
    {
      code: "recon_recommended",
      severity: "owner_decision",
      mutate: () => ({ design: design.replace("No new interface is needed.", "The cost assumption requires Recon.") }),
    },
  ])("$code stays silent on the clean plan and fires with $severity severity", ({ code, severity, mutate }) => {
    expect(findingCodes({})).not.toContain(code);
    expect(validate(mutate()).findings).toContainEqual(expect.objectContaining({ code, severity }));
  });

  it("rejects an unresolved alternative in a binding design contract", () => {
    const result = validate({
      design: design.replace("Invalid input fails closed.", "Either SQLite or Postgres stores the record."),
    });

    expect(result.verdict).toBe("OWNER_DECISION_REQUIRED");
    expect(result.findings).toContainEqual(expect.objectContaining({
      code: "contract_ambiguous",
      severity: "owner_decision",
      artifact: "design.md",
      observed: "- **CONTRACT-1** — Either SQLite or Postgres stores the record.",
    }));
  });

  it("returns findings in identical sorted order on repeated calls", () => {
    const changed = {
      plan: plan.replace("## Entry criteria", "## Removed entry control"),
      implementation: implementation
        .replace("Import bounded data.", "TODO decide later.")
        .replace("src/import.ts", "src/*.ts"),
    };
    const first = validate(changed).findings;
    const second = validate(changed).findings;
    const keys = first.map((item) => [item.artifact, item.sliceId ?? "", item.code].join("|"));

    expect(first).toEqual(second);
    expect(keys).toEqual([...keys].sort());
  });

  it("does not mutate the injected document values", () => {
    const input = documents({ implementation: implementation.replace("Import bounded data.", "TODO decide later.") });
    const before = JSON.stringify(input);

    validatePlan({ documents: input, planDirectory: "docs/plans/import" });

    expect(JSON.stringify(input)).toBe(before);
  });

  it("accepts explicit negative outcomes without a narrow failure keyword", () => {
    const result = validate({ seit: seit.replace("invalid input fails closed", "an owner-decision finding never yields PASS") });

    expect(result.findings).not.toContainEqual(expect.objectContaining({ code: "validation_missing" }));
  });

  it.each([
    "missing input is rejected",
    "v1 ledger without keys replays unchanged",
    "Without credentials request is rejected",
    "a run with no terminal message does not fabricate one",
    "a session id never reaches argv",
    "Invalid, expired, exhausted, replayed, revoked, or rate-limited code returns a generic denial and creates no entitlement; no code grants spend authority",
    "an invalid code returns a generic denial",
    "a replayed code creates no entitlement",
    "the request is denied",
  ])("accepts an observable negative outcome: %s", (negativeCase) => {
    const result = validate({ seit: seit.replace("invalid input fails closed", negativeCase) });

    expect(result.findings).not.toContainEqual(expect.objectContaining({ code: "validation_missing" }));
  });

  it.each([
    "No failure occurs for the seeded defect",
    "invalid input does not fail closed",
    "denial is not returned for rate-limited codes",
    "the run produces no error",
  ])("rejects a negative case that does not describe observable failure: %s", (negativeCase) => {
    const result = validate({ seit: seit.replace("invalid input fails closed", negativeCase) });

    expect(result.findings).toContainEqual(expect.objectContaining({ code: "validation_missing" }));
  });

  it("rejects verb-negated failure evidence while accepting affirmative failure evidence", () => {
    const negated = validate({ seit: seit.replace("invalid input fails closed", "invalid input does not fail closed") });
    const affirmative = validate({ seit: seit.replace("invalid input fails closed", "invalid input fails closed with a non-zero exit") });

    expect(negated.findings).toContainEqual(expect.objectContaining({ code: "validation_missing" }));
    expect(affirmative.findings).not.toContainEqual(expect.objectContaining({ code: "validation_missing" }));
  });

  it("does not treat an unavailable native review as an independent review path", () => {
    const unavailable = validate({ implementation: sharedIntegration("Native review unavailable") });
    const affirmative = validate({ implementation: sharedIntegration("native review") });

    expect(unavailable.findings).toContainEqual(expect.objectContaining({ code: "integration_unowned" }));
    expect(affirmative.findings).not.toContainEqual(expect.objectContaining({ code: "integration_unowned" }));
  });

  it("does not require an integration owner for sequential shared paths", () => {
    const sequential = secondSlice("Wave 1: **S1**\nWave 2: **S2**");

    expect(validate({ implementation: sequential }).findings).not.toContainEqual(expect.objectContaining({
      code: "integration_unowned",
    }));
  });

  it.each([
    "Native review cannot be performed",
    "Native review is currently unavailable",
    "Native review is not scheduled",
    "Native review does not occur",
    "Native review without independence",
  ])("does not treat an absent review as independent: %s", (reviewPath) => {
    const result = validate({ implementation: sharedIntegration(reviewPath) });

    expect(result.findings).toContainEqual(expect.objectContaining({ code: "integration_unowned" }));
  });

  it("accepts a future-tense independent review assignment", () => {
    const result = validate({ implementation: sharedIntegration("Native review will validate the integration") });

    expect(result.findings).not.toContainEqual(expect.objectContaining({ code: "integration_unowned" }));
  });

  it("does not treat a never-used Surveyor as an independent review path", () => {
    const neverUsed = validate({ implementation: sharedIntegration("never use Surveyor") });
    const affirmative = validate({ implementation: sharedIntegration("Surveyor review") });

    expect(neverUsed.findings).toContainEqual(expect.objectContaining({ code: "integration_unowned" }));
    expect(affirmative.findings).not.toContainEqual(expect.objectContaining({ code: "integration_unowned" }));
  });

  it("does not treat an explicitly absent controller as a phase control", () => {
    const absent = validate({ plan: plan.replace("Navigator controls the phase.", "No accountable controller is assigned.") });
    const affirmative = validate({ plan: plan.replace("Navigator controls the phase.", "Will Rumph owns this phase.") });

    expect(absent.findings).toContainEqual(expect.objectContaining({ code: "phase_control_missing" }));
    expect(affirmative.findings).not.toContainEqual(expect.objectContaining({ code: "phase_control_missing" }));
  });

  it.each(["Unassigned.", "Assignment remains pending."])("rejects an absent controller declaration: %s", (controller) => {
    const result = validate({ plan: plan.replace("Navigator controls the phase.", controller) });

    expect(result.findings).toContainEqual(expect.objectContaining({ code: "phase_control_missing" }));
  });

  it("accepts future-tense phase controls", () => {
    const future = plan
      .replace("Requirements are approved.", "Entry criteria will require approved requirements.")
      .replace("Repair the plan and rerun validation.", "Repair will restore the prior plan.");

    expect(validate({ plan: future }).findings).not.toContainEqual(expect.objectContaining({ code: "phase_control_missing" }));
  });

  it("accepts valid line-leading identifiers without bold formatting", () => {
    const result = validate({
      plan: plan.replaceAll("**AC-1**", "AC-1").replaceAll("**RISK-1**", "RISK-1"),
      design: design.replaceAll("**DES-1**", "DES-1").replaceAll("**CONTRACT-1**", "CONTRACT-1"),
    });

    expect(result.verdict).toBe("PASS");
    expect(result.findings).toEqual([]);
  });

  it("requires concrete phase-control sections instead of prose mentions", () => {
    const controlsOnlyMentioned = plan
      .replace("Import bounded data.", "Define entry criteria, exit criteria, rollback behavior, and an accountable controller.")
      .replace("## Entry criteria", "## Removed entry")
      .replace("## Exit criteria", "## Removed exit")
      .replace("## Rollback or repair", "## Removed rollback")
      .replace("## Accountable controller", "## Removed controller");

    expect(validate({ plan: controlsOnlyMentioned }).findings.filter((item) => item.code === "phase_control_missing")).toHaveLength(4);
  });

  it("rejects placeholder phase-control sections", () => {
    const placeholders = plan
      .replace("Requirements are approved.", "TBD")
      .replace("All evidence commands pass.", "None.")
      .replace("Repair the plan and rerun validation.", "TODO")
      .replace("Navigator controls the phase.", "None.");

    expect(validate({ plan: placeholders }).findings.filter((item) => item.code === "phase_control_missing")).toHaveLength(4);
  });

  it("does not let one declared phase supply another phase's controls", () => {
    const phased = plan.replace(/## Entry criteria[\s\S]*$/, `## Phase 1 — Import

Phase one is bounded.

## Entry criteria

Requirements are approved.

## Exit criteria

All evidence commands pass.

## Rollback or repair

Repair the plan and rerun validation.

## Accountable controller

Navigator controls the phase.

## Phase 2 — Verify

Phase two is bounded but has no declared controls.
`);
    const result = validate({ plan: phased });
    const controls = result.findings.filter((item) => item.code === "phase_control_missing");

    expect(result.verdict).toBe("PASS");
    expect(controls).toHaveLength(4);
    expect(controls.map((item) => item.observed)).toEqual([
      "Phase 2 — Verify: Accountable controller",
      "Phase 2 — Verify: Entry criteria",
      "Phase 2 — Verify: Exit criteria",
      "Phase 2 — Verify: Rollback or repair",
    ]);
  });

  it("still escalates shared integration work when the declared owner has no independent review", () => {
    const shared = secondSlice("Wave 1: **S1, S2**")
      .replace("### S1 execution manifest", "### S1 execution manifest\n\n**Integration owner.** S1")
      .replaceAll("**Review path.** native review", "**Review path.** deterministic self-review");

    expect(validate({ implementation: shared }).findings).toContainEqual(expect.objectContaining({
      code: "integration_unowned",
      severity: "owner_decision",
    }));
  });

  it("does not treat a negated independent review as an affirmative review path", () => {
    const shared = secondSlice("Wave 1: **S1, S2**")
      .replace("### S1 execution manifest", "### S1 execution manifest\n\n**Integration owner.** S1")
      .replaceAll("**Review path.** native review", "**Review path.** No independent review; deterministic self-review only.");

    expect(validate({ implementation: shared }).findings).toContainEqual(expect.objectContaining({
      code: "integration_unowned",
      severity: "owner_decision",
    }));
  });

  it("does not treat an explicitly unowned shared path as an integration owner", () => {
    const shared = secondSlice("Wave 1: **S1, S2**")
      .replace("### S1 execution manifest", "### S1 execution manifest\n\n**Integration owner.** None; `src/import.ts` remains unowned.");

    expect(validate({ implementation: shared }).findings).toContainEqual(expect.objectContaining({
      code: "integration_unowned",
      severity: "owner_decision",
    }));
  });

  it("detects cycles that use a branched dependency continuation", () => {
    const result = validate({
      implementation: implementation.replace(
        "Wave 1: **S1**",
        "Wave 1: **S1**\nS1 ──┬──> S2\n   └──> S3\nS3 --> S1",
      ),
    });

    expect(result.findings).toContainEqual(expect.objectContaining({ code: "dependency_cycle" }));
  });

  it("detects cycles that close through a nested branch continuation", () => {
    const result = validate({
      implementation: implementation.replace(
        "Wave 1: **S1**",
        "Wave 1: **S1**\nS1 --> S2 ──┬──> S3\n          └──> S4\nS4 --> S2",
      ),
    });

    expect(result.findings).toContainEqual(expect.objectContaining({ code: "dependency_cycle" }));
  });

  it("rejects dependency endpoints that do not name declared slices", () => {
    for (const edge of ["S1 --> S999", "S999 --> S1"]) {
      const result = validate({ implementation: implementation.replace("Wave 1: **S1**", `Wave 1: **S1**\n${edge}`) });

      expect(result.findings).toContainEqual(expect.objectContaining({
        code: "slice_reference_dangling",
        observed: "S999",
      }));
    }
  });

  it("rejects dangling requirement, design, and command ids in trace rows", () => {
    const row = "| SEIT-1 | AC-1, RISK-1 | DES-1, CONTRACT-1 | unit | valid input imports | invalid input fails closed | CMD-UNIT | test report |";
    const changed = seit.replace(row, `${row}\n| SEIT-2 | AC-999 | DES-999 | unit | valid input imports | invalid input fails closed | CMD-MISSING | test report |`);
    const result = validate({ seit: changed });

    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "traceability_broken", observed: "AC-999" }),
      expect.objectContaining({ code: "traceability_broken", observed: "DES-999" }),
      expect.objectContaining({ code: "traceability_broken", observed: "CMD-MISSING" }),
    ]));
  });

  it("requires exactly one owner for a shared integration path", () => {
    const shared = secondSlice("Wave 1: **S1, S2**")
      .replace("### S1 execution manifest", "### S1 execution manifest\n\n**Integration owner.** S1")
      .replace("### S2 execution manifest", "### S2 execution manifest\n\n**Integration owner.** S2");

    expect(validate({ implementation: shared }).findings).toContainEqual(expect.objectContaining({
      code: "integration_unowned",
      severity: "owner_decision",
    }));
  });

  it("suppresses Recon escalation only for an affirmative report binding", () => {
    const required = design.replace("No new interface is needed.", "The cost assumption requires Recon.");
    const negated = validate({ design: required, plan: `${plan}\nNo Recon report is bound for this assumption.\n` });
    const future = validate({ design: required, plan: `${plan}\nThe reconReport will be bound after validation.\n` });
    const futureBinding = validate({ design: required, plan: `${plan}\nWe will bind the reconReport after validation.\n` });
    const expected = validate({ design: required, plan: `${plan}\nA future reconReport is expected.\n` });
    const notReady = validate({ design: required, plan: `${plan}\nThe reconReport is not ready.\n` });
    const affirmative = validate({ design: required, plan: `${plan}\nThe recon report is bound for this assumption.\n` });

    expect(negated.findings).toContainEqual(expect.objectContaining({ code: "recon_recommended" }));
    expect(future.findings).toContainEqual(expect.objectContaining({ code: "recon_recommended" }));
    expect(futureBinding.findings).toContainEqual(expect.objectContaining({ code: "recon_recommended" }));
    expect(expected.findings).toContainEqual(expect.objectContaining({ code: "recon_recommended" }));
    expect(notReady.findings).toContainEqual(expect.objectContaining({ code: "recon_recommended" }));
    expect(affirmative.findings).not.toContainEqual(expect.objectContaining({ code: "recon_recommended" }));
  });
});

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sharedContractFixture = "test/fixtures/focus-plan-corpus/shared-contract-omitted";

async function sharedContractDocuments(): Promise<PlanDocuments> {
  const [plan, design, seit, implementation] = await Promise.all(
    ["plan-spec.md", "design.md", "seit.md", "implementation.md"].map((name) => readFile(join(repositoryRoot, sharedContractFixture, name), "utf8")),
  );
  return { plan, design, seit, implementation };
}

describe("shared contract producers", () => {
  it("rejects a slice whose declared shared interface names a producer path no slice write set covers", async () => {
    const result = validatePlan({ documents: await sharedContractDocuments(), planDirectory: sharedContractFixture });

    expect(result.verdict).toBe("NEEDS_AMENDMENT");
    expect(result.findings).toContainEqual(expect.objectContaining({
      code: "shared_contract_unproduced",
      severity: "amendment",
      artifact: "implementation.md",
      sliceId: "S1",
      observed: "src/verification/validator.ts",
    }));
  });

  it("stays silent when the declaring slice's own write set covers the producer path", async () => {
    const documents = await sharedContractDocuments();
    const covered = {
      ...documents,
      implementation: documents.implementation.replace(
        "Write only `src/import.ts`.",
        "Write only `src/import.ts` and `src/verification/validator.ts`.",
      ),
    };

    expect(validatePlan({ documents: covered, planDirectory: sharedContractFixture }).verdict).toBe("PASS");
  });

  it("stays silent when a peer slice's write set covers the producer path", async () => {
    const documents = await sharedContractDocuments();
    const withPeer = documents.implementation
      .replace("Wave 1: **S1**", "Wave 1: **S1**\nWave 2: **S2**")
      .concat(`
### Slice S2 — Produce

**Goal.** Produce the shared validator report contract.
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

**Write set.** Write only \`src/verification/validator.ts\`.
**Command IDs.** CMD-UNIT
**Stop condition.** Stop if the focused test fails.
**Human decision.** None.
`);
    const result = validatePlan({ documents: { ...documents, implementation: withPeer }, planDirectory: sharedContractFixture });

    expect(result.verdict).toBe("PASS");
  });

  // Reviewer P2: the field also carries documented non-path forms ("backticked
  // identifiers, or the word `none`"). A bare interface tag or an anchor-only
  // identifier names no producer module and must never demand one.
  it("stays silent on a bare interface tag with no path separator", async () => {
    const documents = await sharedContractDocuments();
    const bareTag = {
      ...documents,
      implementation: documents.implementation.replace(
        "**Shared interfaces.** `src/verification/validator.ts#ValidatorReport`.",
        "**Shared interfaces.** `ValidatorReport`.",
      ),
    };

    expect(validatePlan({ documents: bareTag, planDirectory: sharedContractFixture }).verdict).toBe("PASS");
  });

  it("stays silent on an anchor-only identifier", async () => {
    const documents = await sharedContractDocuments();
    const anchorOnly = {
      ...documents,
      implementation: documents.implementation.replace(
        "**Shared interfaces.** `src/verification/validator.ts#ValidatorReport`.",
        "**Shared interfaces.** `#ValidatorReport`.",
      ),
    };

    expect(validatePlan({ documents: anchorOnly, planDirectory: sharedContractFixture }).verdict).toBe("PASS");
  });

  it("stays silent on a plan that declares no shared interfaces", async () => {
    const documents = await sharedContractDocuments();
    const undeclared = {
      ...documents,
      implementation: documents.implementation.replace("**Shared interfaces.** `src/verification/validator.ts#ValidatorReport`.\n", ""),
    };

    expect(validatePlan({ documents: undeclared, planDirectory: sharedContractFixture }).verdict).toBe("PASS");
  });
});

const repositoryRootForSystemCatalog = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const systemCatalogFixture = "test/fixtures/focus-plan-corpus/system-catalog-incomplete";

async function systemCatalogDocuments(): Promise<PlanDocuments> {
  const [plan, design, seit, implementation] = await Promise.all(
    ["plan-spec.md", "design.md", "seit.md", "implementation.md"].map((name) => readFile(join(repositoryRootForSystemCatalog, systemCatalogFixture, name), "utf8")),
  );
  return { plan, design, seit, implementation };
}

function systemFindings(findings: readonly Finding[]): readonly Finding[] {
  return findings.filter((finding) => finding.code.startsWith("system_"));
}

const SYSTEM_SPEC_FIELDS = [
  "Ownership",
  "Inputs",
  "Outputs",
  "APIs",
  "Data ownership",
  "Invariants",
  "Trust boundary",
  "Failure modes",
  "Observability",
] as const;

const SYS_2_SPEC = `### SYS-2 — Import boundary

**Ownership.** Backend Engineering.
**Inputs.** Bounded import requests.
**Outputs.** Imported ledger rows.
**APIs.** importLedger.
**Data ownership.** Imported ledger rows.
**Invariants.** Imports never widen the ledger schema.
**Trust boundary.** None beyond the import boundary.
**Failure modes.** Invalid imports fail closed.
**Observability.** Import events.`;

/** The incomplete fixture with a complete per-system specification added for SYS-2. */
async function completeSystemDocuments(): Promise<PlanDocuments> {
  const base = await systemCatalogDocuments();
  return {
    ...base,
    design: base.design.replace("## Requirement Trace", `${SYS_2_SPEC}\n\n## Requirement Trace`),
  };
}

describe("system catalog maturity", () => {
  it("rejects a catalog-declaring plan whose catalog entry has no per-system specification", async () => {
    const result = validatePlan({ documents: await systemCatalogDocuments(), planDirectory: systemCatalogFixture });

    expect(result.verdict).toBe("NEEDS_AMENDMENT");
    expect(systemFindings(result.findings)).toContainEqual(expect.objectContaining({
      code: "system_spec_missing",
      severity: "amendment",
      artifact: "design.md",
      observed: "SYS-2 has no per-system specification",
    }));
    expect(systemFindings(result.findings)).not.toContainEqual(expect.objectContaining({ observed: "SYS-1 has no per-system specification" }));
  });

  it("passes a catalog-declaring plan whose every catalog entry resolves to a complete specification", async () => {
    const result = validatePlan({ documents: await completeSystemDocuments(), planDirectory: systemCatalogFixture });

    expect(systemFindings(result.findings)).toEqual([]);
    expect(result.verdict).toBe("PASS");
  });

  it("rejects a specification that names no catalog entry", async () => {
    const documents = await completeSystemDocuments();
    const phantom = {
      ...documents,
      design: documents.design.replace("## Requirement Trace", "### SYS-99 — Phantom system\n\n**Ownership.** Nobody.\n\n## Requirement Trace"),
    };

    expect(systemFindings(validatePlan({ documents: phantom, planDirectory: systemCatalogFixture }).findings)).toContainEqual(
      expect.objectContaining({ code: "system_spec_missing", observed: "SYS-99: SYS-99 — Phantom system names no catalog entry" }),
    );
  });

  it("rejects a specification missing a required field, naming the system and the field", async () => {
    const documents = await completeSystemDocuments();
    const incomplete = {
      ...documents,
      design: documents.design.replace("**Trust boundary.** None beyond the import boundary.\n", ""),
    };

    expect(systemFindings(validatePlan({ documents: incomplete, planDirectory: systemCatalogFixture }).findings)).toContainEqual(
      expect.objectContaining({ code: "system_spec_missing", observed: "SYS-2: trust boundary" }),
    );
  });

  it("rejects a SYS- reference in design.md that no catalog entry declares", async () => {
    const documents = await completeSystemDocuments();
    const dangling = {
      ...documents,
      design: documents.design.replace("## Requirement Trace", "**Depends on.** SYS-77.\n\n## Requirement Trace"),
    };

    expect(systemFindings(validatePlan({ documents: dangling, planDirectory: systemCatalogFixture }).findings)).toContainEqual(
      expect.objectContaining({ code: "system_trace_broken", observed: "SYS-77", required: "every SYS- reference in design.md must name a catalog entry" }),
    );
  });

  it("reports a SYS- reference inside a per-system specification that no catalog row declares", async () => {
    const documents = await completeSystemDocuments();
    const dangling = {
      ...documents,
      design: documents.design.replace(
        "**Invariants.** Focus boundaries never widen.",
        "**Invariants.** SYS-9 always stays closed.\n\n| SYS-9 | Foo | Bar |",
      ),
    };

    expect(systemFindings(validatePlan({ documents: dangling, planDirectory: systemCatalogFixture }).findings)).toContainEqual(
      expect.objectContaining({ code: "system_trace_broken", observed: "SYS-9", required: "every SYS- reference in design.md must name a catalog entry" }),
    );
  });

  it("rejects a trace row whose requirement, contract, SEIT row, or slice does not resolve", async () => {
    const documents = await completeSystemDocuments();
    const danglingRow = {
      ...documents,
      design: documents.design.replace(
        "| AC-1, RISK-1 | SYS-1, SYS-2 | CONTRACT-1 | SEIT-1 | S1 | `src/notifier.ts` |",
        "| AC-9 | SYS-1 | CONTRACT-9 | SEIT-9 | S9 | `src/notifier.ts` |",
      ),
    };
    const findings = systemFindings(validatePlan({ documents: danglingRow, planDirectory: systemCatalogFixture }).findings);

    for (const observed of ["AC-9", "CONTRACT-9", "SEIT-9", "S9"]) {
      expect(findings).toContainEqual(expect.objectContaining({ code: "system_trace_broken", observed }));
    }
  });

  it("rejects a declared requirement that no Requirement Trace row reaches", async () => {
    const documents = await completeSystemDocuments();
    const untraced = {
      ...documents,
      plan: documents.plan.replace("- **AC-1** — Keep Focus bounded.", "- **AC-1** — Keep Focus bounded.\n- **AC-2** — Import bounded data."),
    };

    expect(systemFindings(validatePlan({ documents: untraced, planDirectory: systemCatalogFixture }).findings)).toContainEqual(
      expect.objectContaining({ code: "system_trace_broken", observed: "AC-2", required: "every declared requirement must reach a Requirement Trace row" }),
    );
  });

  it("passes an adopted catalog with complete specifications and no Requirement Trace table", async () => {
    const documents = await completeSystemDocuments();
    const noTrace = {
      ...documents,
      design: documents.design.replace(/^## Requirement Trace[\s\S]*$/m, ""),
    };

    const result = validatePlan({ documents: noTrace, planDirectory: systemCatalogFixture });
    expect(systemFindings(result.findings)).toEqual([]);
    expect(result.verdict).toBe("PASS");
  });

  it("rejects a traced path no slice write set covers", async () => {
    const documents = await completeSystemDocuments();
    const uncovered = {
      ...documents,
      design: documents.design.replace("`src/notifier.ts`", "`src/verification/validator.ts`"),
    };

    expect(systemFindings(validatePlan({ documents: uncovered, planDirectory: systemCatalogFixture }).findings)).toContainEqual(
      expect.objectContaining({ code: "system_trace_broken", observed: "src/verification/validator.ts", required: "every traced path must be covered by a slice write set" }),
    );
  });

  // A plan that never declares the System Catalog section never adopts the
  // maturity convention, so every system_* check must stay silent -- otherwise
  // the checks would reject every existing plan instead of proving anything.
  it("does not fire on a plan that declares no system catalog", async () => {
    for (const planDirectory of ["test/fixtures/focus-plan-corpus/valid-bounds", "test/fixtures/focus-plan-corpus/procedure-drift"]) {
      const [plan, design, seit, implementation] = await Promise.all(
        ["plan-spec.md", "design.md", "seit.md", "implementation.md"].map((name) => readFile(join(repositoryRootForSystemCatalog, planDirectory, name), "utf8")),
      );
      const result = validatePlan({ documents: { plan, design, seit, implementation }, planDirectory });
      expect(systemFindings(result.findings)).toEqual([]);
    }
  });

  it("does not fire on a catalog-free plan that mentions SYS- ids in prose", async () => {
    const documents = await systemCatalogDocuments();
    const catalogFree = {
      ...documents,
      design: documents.design
        .replace("## System Catalog", "## Background")
        .replace(/^\| SYS-\d \|.*\|.*\|$/gm, "")
        .replace(/^### SYS-1 — Focus boundary$[\s\S]*?(?=^## )/m, "")
        .replace("## Requirement Trace", "## Notes")
        .replace(/^\| (?:AC|RISK|SYS|CONTRACT|SEIT|S\d) .*\|$/gm, "")
        .replace("The owner dispatches one bounded slice.", "The SYS-1 Focus boundary and SYS-2 Import boundary systems stay ambient."),
    };

    const result = validatePlan({ documents: catalogFree, planDirectory: systemCatalogFixture });
    expect(systemFindings(result.findings)).toEqual([]);
    expect(result.verdict).toBe("PASS");
  });
});

const repositoryRootForRiskProfile = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const riskProfileFixture = "test/fixtures/focus-plan-corpus/risk-profile-uncovered";

async function riskProfileDocuments(): Promise<PlanDocuments> {
  const [plan, design, seit, implementation] = await Promise.all(
    ["plan-spec.md", "design.md", "seit.md", "implementation.md"].map((name) => readFile(join(repositoryRootForRiskProfile, riskProfileFixture, name), "utf8")),
  );
  return { plan, design, seit, implementation };
}

function riskFindings(findings: readonly Finding[]): readonly Finding[] {
  return findings.filter((finding) => finding.code.startsWith("risk_"));
}

const MOVES_MONEY_COVERED = "design: Threat Model; seit: SEIT-1; slice: S1";

describe("risk profile coverage", () => {
  // The fixture declares a risk profile with moves_money: yes mapped to
  // design coverage only; SEIT and slice coverage are missing, so the flag
  // must not be satisfiable by design coverage alone.
  it("rejects a yes flag whose profile maps design coverage but no SEIT row or slice", async () => {
    const result = validatePlan({ documents: await riskProfileDocuments(), planDirectory: riskProfileFixture });

    expect(result.verdict).toBe("NEEDS_AMENDMENT");
    // The fixture is otherwise clean: the two coverage gaps are the plan's
    // only findings, proving the profile itself introduces no noise.
    expect(result.findings).toHaveLength(2);
    expect(riskFindings(result.findings)).toContainEqual(expect.objectContaining({
      code: "risk_coverage_missing",
      severity: "amendment",
      artifact: "plan-spec.md",
      observed: "moves_money: SEIT coverage missing",
    }));
    expect(riskFindings(result.findings)).toContainEqual(expect.objectContaining({
      code: "risk_coverage_missing",
      observed: "moves_money: slice coverage missing",
    }));
  });

  it("passes a profile-declaring plan whose every yes flag maps design, SEIT, and slice coverage", async () => {
    const documents = await riskProfileDocuments();
    const covered = { ...documents, plan: documents.plan.replace("design: Threat Model", MOVES_MONEY_COVERED) };
    const result = validatePlan({ documents: covered, planDirectory: riskProfileFixture });

    expect(result.verdict).toBe("PASS");
    expect(riskFindings(result.findings)).toEqual([]);
  });

  it("passes a profile whose every flag is declared not applicable with an evidence-backed rationale", async () => {
    const documents = await riskProfileDocuments();
    const allNotApplicable = {
      ...documents,
      plan: documents.plan.replace(
        "| moves_money | yes | design: Threat Model |",
        "| moves_money | no | The plan never moves money; all state stays on the local machine. |",
      ),
    };
    const result = validatePlan({ documents: allNotApplicable, planDirectory: riskProfileFixture });

    expect(result.verdict).toBe("PASS");
    expect(riskFindings(result.findings)).toEqual([]);
  });

  it("rejects a vacuous not-applicable rationale that would silently dispose of a triggered flag", async () => {
    const documents = await riskProfileDocuments();
    const vacuous = {
      ...documents,
      plan: documents.plan.replace(
        "| moves_money | yes | design: Threat Model |",
        "| moves_money | no | none |",
      ),
    };
    const result = validatePlan({ documents: vacuous, planDirectory: riskProfileFixture });

    expect(result.verdict).toBe("NEEDS_AMENDMENT");
    expect(riskFindings(result.findings)).toContainEqual(expect.objectContaining({
      code: "risk_coverage_missing",
      observed: "moves_money: not-applicable rationale is not evidence-backed",
    }));
  });

  // The rationale gate justifies an absence, not a presence: natural
  // not-applicable rationales that assert why the flag does not apply
  // (no data present, nothing scheduled, nothing owned) are evidence and
  // must satisfy a triggered no flag.
  it("accepts natural not-applicable rationales that assert an absence", async () => {
    const documents = await riskProfileDocuments();
    const naturalRationales = [
      "No customer data is present in this plan.",
      "No personal data is collected by this plan.",
      "No external service is available to this plan.",
      "No operator is assigned to run this plan.",
      "No state is owned by the plan.",
      "No review is performed by this plan.",
      "Nothing is scheduled outside the bounded route.",
    ];
    for (const rationale of naturalRationales) {
      const result = validatePlan({
        documents: {
          ...documents,
          plan: documents.plan.replace(
            "| moves_money | yes | design: Threat Model |",
            `| moves_money | no | ${rationale} |`,
          ),
        },
        planDirectory: riskProfileFixture,
      });
      expect(riskFindings(result.findings), rationale).toEqual([]);
    }
  });

  // A bare negation padded to four words is still vacuous: "not applicable
  // to this plan" disposes of the flag without stating why.
  it("rejects a bare-negation rationale padded past the word minimum", async () => {
    const documents = await riskProfileDocuments();
    for (const rationale of ["not applicable to this plan", "The flag does not apply here."]) {
      const result = validatePlan({
        documents: {
          ...documents,
          plan: documents.plan.replace(
            "| moves_money | yes | design: Threat Model |",
            `| moves_money | no | ${rationale} |`,
          ),
        },
        planDirectory: riskProfileFixture,
      });

      expect(result.verdict).toBe("NEEDS_AMENDMENT");
      expect(riskFindings(result.findings)).toContainEqual(expect.objectContaining({
        code: "risk_coverage_missing",
        observed: "moves_money: not-applicable rationale is not evidence-backed",
      }));
    }
  });

  // Design coverage must name a section with a body: a heading title alone
  // cannot satisfy a yes flag.
  it("does not count a bodiless design heading as design coverage", async () => {
    const documents = await riskProfileDocuments();
    const bodiless = {
      ...documents,
      design: `${documents.design}\n## Vacuous\n`,
      plan: documents.plan.replace(
        "| moves_money | yes | design: Threat Model |",
        "| moves_money | yes | design: Vacuous; seit: SEIT-1; slice: S1 |",
      ),
    };
    const result = validatePlan({ documents: bodiless, planDirectory: riskProfileFixture });

    expect(result.verdict).toBe("NEEDS_AMENDMENT");
    expect(riskFindings(result.findings)).toContainEqual(expect.objectContaining({
      code: "risk_coverage_missing",
      observed: "moves_money: design section Vacuous is not a non-empty design section",
    }));
  });

  it("rejects a profile that omits a known flag from the enumeration", async () => {
    const documents = await riskProfileDocuments();
    const omitted = {
      ...documents,
      plan: documents.plan.replace("| production_service | no | Nothing is deployed; the plan runs only in the development checkout. |\n", ""),
    };
    const result = validatePlan({ documents: omitted, planDirectory: riskProfileFixture });

    expect(result.verdict).toBe("NEEDS_AMENDMENT");
    expect(riskFindings(result.findings)).toContainEqual(expect.objectContaining({
      code: "risk_profile_malformed",
      observed: "Risk Profile is missing the production_service flag",
    }));
  });

  it("rejects an unknown flag name and a malformed coverage clause", async () => {
    const documents = await riskProfileDocuments();
    const unknownFlag = {
      ...documents,
      plan: documents.plan.replace(
        "| moves_money | yes | design: Threat Model |",
        "| moves_funds | yes | design: Threat Model; seit: SEIT-1; slice: S1 |",
      ),
    };
    const result = validatePlan({ documents: unknownFlag, planDirectory: riskProfileFixture });
    expect(riskFindings(result.findings)).toContainEqual(expect.objectContaining({
      code: "risk_profile_malformed",
      observed: "unknown risk flag: moves_funds",
    }));

    const badClause = {
      ...documents,
      plan: documents.plan.replace(
        "| moves_money | yes | design: Threat Model |",
        "| moves_money | yes | threat: Threat Model |",
      ),
    };
    const resultClause = validatePlan({ documents: badClause, planDirectory: riskProfileFixture });
    expect(riskFindings(resultClause.findings)).toContainEqual(expect.objectContaining({
      code: "risk_profile_malformed",
      observed: "moves_money: coverage clause must name design, system, seit, or slice: threat: Threat Model",
    }));
  });

  it("rejects coverage that names undeclared design sections, SEIT rows, or slices", async () => {
    const documents = await riskProfileDocuments();
    const dangling = {
      ...documents,
      plan: documents.plan.replace(
        "| moves_money | yes | design: Threat Model |",
        "| moves_money | yes | design: No Such Section; seit: SEIT-9; slice: S9 |",
      ),
    };
    const result = validatePlan({ documents: dangling, planDirectory: riskProfileFixture });

    expect(result.verdict).toBe("NEEDS_AMENDMENT");
    expect(riskFindings(result.findings)).toContainEqual(expect.objectContaining({
      code: "risk_coverage_missing",
      observed: "moves_money: design section No Such Section is not a non-empty design section",
    }));
    expect(riskFindings(result.findings)).toContainEqual(expect.objectContaining({
      code: "risk_coverage_missing",
      observed: "moves_money: SEIT row SEIT-9 is not a declared traceability row",
    }));
    expect(riskFindings(result.findings)).toContainEqual(expect.objectContaining({
      code: "risk_coverage_missing",
      observed: "moves_money: slice S9 is not a declared slice",
    }));
  });

  // Negative control: the risk profile is opt-in; plans that never declare
  // the section must validate exactly as before, with zero risk findings.
  it("does not fire on plans that declare no risk profile", async () => {
    for (const planDirectory of [
      "test/fixtures/focus-plan-corpus/valid-bounds",
      "test/fixtures/focus-plan-corpus/procedure-drift",
      "test/fixtures/map-the-route-contract",
    ]) {
      const [plan, design, seit, implementation] = await Promise.all(
        ["plan-spec.md", "design.md", "seit.md", "implementation.md"].map((name) => readFile(join(repositoryRootForRiskProfile, planDirectory, name), "utf8")),
      );
      const result = validatePlan({ documents: { plan, design, seit, implementation }, planDirectory });
      expect(riskFindings(result.findings)).toEqual([]);
    }
  });
});

describe("slice workload aim", () => {
  const scopeFindings = (findings: readonly Finding[]) => findings.filter((item) => item.code === "slice_scope_advisory");
  const oversized = implementation.replace(
    "**Goal.** Import bounded data.",
    `**Goal.** Import bounded data.\n**Notes.** ${"Import one bounded record from the upstream feed and record the result. ".repeat(30)}`,
  );

  it("leaves a slice inside the aim free of the advisory", () => {
    expect(scopeFindings(validate().findings)).toEqual([]);
  });

  it("advises on a slice whose declared text exceeds the aim without changing the verdict", () => {
    const result = validate({ implementation: oversized });
    expect(scopeFindings(result.findings)).toEqual([expect.objectContaining({
      code: "slice_scope_advisory",
      severity: "advisory",
      artifact: "implementation.md",
      sliceId: "S1",
    })]);
    expect(result.verdict).toBe("PASS");
  });

  it("states the aim is ergonomic policy and never a workload prediction", () => {
    const [advisory] = scopeFindings(validate({ implementation: oversized }).findings);
    expect(advisory.required).toContain("not a prediction");
    expect(advisory.remedy).toContain("split");
  });

  it("folds an advisory-only plan to PASS", () => {
    expect(foldVerdict(scopeFindings(validate({ implementation: oversized }).findings))).toBe("PASS");
  });
});
