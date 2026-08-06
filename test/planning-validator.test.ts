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
