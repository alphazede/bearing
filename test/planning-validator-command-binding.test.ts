import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validatePlan } from "../src/journey/planning-validator.js";
import type { PlanDocuments } from "../src/journey/plan-structure.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const clean: PlanDocuments = {
  plan: `---
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
`,
  design: `---
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
`,
  seit: `---
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
`,
  implementation: `---
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
`,
};

function validate(documents: PlanDocuments) {
  return validatePlan({ documents, planDirectory: "docs/plans/candidate" });
}

function withSeitEntry(entry: string): PlanDocuments {
  return { ...clean, seit: clean.seit.replace("- **CMD-UNIT** — `pnpm test`", entry) };
}

function withGoal(goal: string): PlanDocuments {
  return { ...clean, implementation: clean.implementation.replace("Import bounded data.", goal) };
}

function withWriteSet(writeSet: string): PlanDocuments {
  return { ...clean, implementation: clean.implementation.replace("Write only `src/import.ts`.", writeSet) };
}

describe("issue-113 command ID binding", () => {
  it("passes a plan whose command resolves to an exact backticked repository command", () => {
    expect(validate(clean).verdict).toBe("PASS");
  });

  it("rejects a whitespace-only backticked literal as not an exact repository command", () => {
    const result = validate(withSeitEntry("- **CMD-UNIT** — `   `"));
    expect(result.verdict).toBe("NEEDS_AMENDMENT");
    expect(result.findings).toContainEqual(expect.objectContaining({
      code: "command_unbound",
      artifact: "seit.md",
      observed: "CMD-UNIT: `   `",
    }));
  });

  it("applies the declared-but-unbound check to lowercase manifest command ids", () => {
    const documents = {
      ...clean,
      implementation: clean.implementation.replace("**Command IDs.** CMD-UNIT", "**Command IDs.** cmd-unit"),
    };
    const result = validate(documents);
    expect(result.verdict).toBe("PASS");
  });

  it("rejects a required command with no repository command binding", () => {
    const result = validate(withSeitEntry("- **CMD-UNIT**"));
    expect(result.verdict).toBe("NEEDS_AMENDMENT");
    expect(result.findings).toContainEqual(expect.objectContaining({
      code: "command_unbound",
      artifact: "seit.md",
      observed: "CMD-UNIT: (no binding)",
    }));
  });

  it("rejects a placeholder binding as not an exact repository command", () => {
    for (const placeholder of ["tbd", "todo", "n/a", "none", "pending", "..."]) {
      const result = validate(withSeitEntry(`- **CMD-UNIT** — ${placeholder}`));
      expect(result.verdict, placeholder).toBe("NEEDS_AMENDMENT");
      expect(result.findings, placeholder).toContainEqual(expect.objectContaining({
        code: "command_unbound",
        observed: `CMD-UNIT: ${placeholder}`,
      }));
    }
  });

  it("rejects prose as a CMD- binding: CMD- ids must name an exact repository command", () => {
    const result = validate(withSeitEntry("- **CMD-UNIT** — Run the unit test suite."));
    expect(result.verdict).toBe("NEEDS_AMENDMENT");
    expect(result.findings).toContainEqual(expect.objectContaining({ code: "command_unbound" }));
  });

  it("rejects template syntax inside a backticked command literal", () => {
    const result = validate(withSeitEntry("- **CMD-UNIT** — `pnpm install <pkg>`"));
    expect(result.verdict).toBe("NEEDS_AMENDMENT");
    expect(result.findings).toContainEqual(expect.objectContaining({ code: "command_unbound" }));
  });

  it("accepts a command with multiple exact backticked repository commands", () => {
    const result = validate(withSeitEntry("- **CMD-UNIT** — `pnpm test` and `pnpm typecheck`"));
    expect(result.verdict).toBe("PASS");
  });

  it("accepts a PROC- id bound to an explicitly typed external procedure in prose", () => {
    const result = validate(withSeitEntry(
      "- **CMD-UNIT** — `pnpm test`\n- **PROC-IMPORT** — Run the migration import procedure.",
    ));
    expect(result.verdict).toBe("PASS");
  });

  it("accepts a PROC- id bound to an exact backticked repository command", () => {
    const result = validate(withSeitEntry(
      "- **CMD-UNIT** — `pnpm test`\n- **PROC-IMPORT** — `pnpm proc:import`",
    ));
    expect(result.verdict).toBe("PASS");
  });

  it("rejects a PROC- id whose procedure description is a placeholder", () => {
    for (const placeholder of ["pending", "tbd"]) {
      const result = validate(withSeitEntry(
        "- **CMD-UNIT** — `pnpm test`\n- **PROC-IMPORT** — " + placeholder,
      ));
      expect(result.verdict, placeholder).toBe("NEEDS_AMENDMENT");
      expect(result.findings, placeholder).toContainEqual(expect.objectContaining({
        code: "command_unbound",
        observed: `PROC-IMPORT: ${placeholder}`,
      }));
    }
  });

  it("flags the manifest slice that resolves to an unbound command", () => {
    const seitWithDrift = withSeitEntry("- **CMD-UNIT** — `pnpm test`\n- **CMD-DRIFT**");
    const documents = {
      ...seitWithDrift,
      implementation: seitWithDrift.implementation.replace("**Command IDs.** CMD-UNIT", "**Command IDs.** CMD-DRIFT"),
    };
    const result = validate(documents);
    expect(result.verdict).toBe("NEEDS_AMENDMENT");
    expect(result.findings).toContainEqual(expect.objectContaining({
      code: "command_unbound",
      artifact: "seit.md",
      observed: "CMD-DRIFT: (no binding)",
    }));
    expect(result.findings).toContainEqual(expect.objectContaining({
      code: "command_unbound",
      artifact: "implementation.md",
      sliceId: "S1",
      observed: "CMD-DRIFT",
    }));
  });

  it("does not double-flag a manifest command that is not declared at all", () => {
    const documents = { ...clean, implementation: clean.implementation.replace("CMD-UNIT", "CMD-GHOST") };
    const result = validate(documents);
    expect(result.findings.filter((item) => item.code === "command_undeclared").length).toBeGreaterThan(0);
    expect(result.findings.filter((item) => item.code === "command_unbound")).toEqual([]);
  });
});

describe("issue-113 dependency change ownership", () => {
  it("passes a plan that declares no dependency change", () => {
    expect(validate(clean).verdict).toBe("PASS");
  });

  it("rejects a slice that adds a runtime dependency without owning the package manifest or lockfile", () => {
    const result = validate(withGoal("Add a new runtime dependency."));
    expect(result.verdict).toBe("NEEDS_AMENDMENT");
    expect(result.findings).toContainEqual(expect.objectContaining({
      code: "dependency_unowned",
      artifact: "implementation.md",
      sliceId: "S1",
      observed: "Add a new runtime dependency",
    }));
  });

  it("accepts the same dependency addition when the write set owns the manifest and lockfile", () => {
    const documents = withWriteSet("Write only `package.json`, `pnpm-lock.yaml` and `src/import.ts`.");
    const result = validate(withGoalAndWriteSet("Add a new runtime dependency.", documents));
    expect(result.findings.filter((item) => item.code === "dependency_unowned")).toEqual([]);
    expect(result.verdict).toBe("PASS");
  });

  it("accepts ownership through a lockfile alone", () => {
    const documents = { ...withGoal("Add a new runtime dependency."), implementation: withWriteSet("Write only `pnpm-lock.yaml`.").implementation };
    expect(validate(documents).findings.filter((item) => item.code === "dependency_unowned")).toEqual([]);
  });

  it("accepts ownership through the package manifest alone", () => {
    const documents = { ...withGoal("Add a new runtime dependency."), implementation: withWriteSet("Write only `package.json`.").implementation };
    expect(validate(documents).findings.filter((item) => item.code === "dependency_unowned")).toEqual([]);
  });

  it("ignores negated dependency declarations", () => {
    for (const goal of [
      "Import bounded data without adding dependencies.",
      "Import bounded data and requires no new dependencies.",
      "Import bounded data, skipping any package installation.",
    ]) {
      const result = validate(withGoal(goal));
      expect(result.findings.filter((item) => item.code === "dependency_unowned"), goal).toEqual([]);
      expect(result.verdict, goal).toBe("PASS");
    }
  });

  it("detects a generic manifest change only when it names a specific manifest noun", () => {
    expect(validate(withGoal("Update package.json.")).findings.filter((item) => item.code === "dependency_unowned")).toHaveLength(1);
    expect(validate(withGoal("Update the package documentation.")).findings.filter((item) => item.code === "dependency_unowned")).toEqual([]);
  });

  it("treats a bare package mention paired with an add-tier verb as a dependency change", () => {
    expect(validate(withGoal("Add the package.")).findings.filter((item) => item.code === "dependency_unowned")).toHaveLength(1);
  });

  it("does not read a package-manifest write target as dependency intent", () => {
    const documents = withWriteSet("Write only `package.json`.");
    expect(validate(documents).findings.filter((item) => item.code === "dependency_unowned")).toEqual([]);
  });

  it("ignores dependency language inside backticked literals", () => {
    const result = validate(withGoal("Document the `add the package` step for operators."));
    expect(result.findings.filter((item) => item.code === "dependency_unowned")).toEqual([]);
    expect(result.verdict).toBe("PASS");
  });
});

describe("issue-113 fixture regression control", () => {
  it("adds no command_unbound or dependency_unowned findings to the checked-in plan fixtures", async () => {
    for (const planDirectory of [
      "test/fixtures/focus-plan-corpus/valid-bounds",
      "test/fixtures/focus-plan-corpus/procedure-drift",
      "test/fixtures/map-the-route-contract",
    ]) {
      const [plan, design, seit, implementation] = await Promise.all(
        ["plan-spec.md", "design.md", "seit.md", "implementation.md"].map((name) => readFile(join(repositoryRoot, planDirectory, name), "utf8")),
      );
      const result = validatePlan({ documents: { plan, design, seit, implementation }, planDirectory });
      const codes = result.findings.filter((item) => item.code === "command_unbound" || item.code === "dependency_unowned");
      expect(codes, `${planDirectory}: ${codes.map((item) => `${item.code} ${item.observed}`).join("; ")}`).toEqual([]);
    }
  });
});

function withGoalAndWriteSet(goal: string, documents: PlanDocuments): PlanDocuments {
  return { ...documents, implementation: documents.implementation.replace("Import bounded data.", goal) };
}
