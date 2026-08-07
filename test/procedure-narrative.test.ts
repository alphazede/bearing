import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parsePlanDocuments, type PlanDocuments } from "../src/journey/plan-structure.js";
import { validatePlan, type Finding } from "../src/journey/planning-validator.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const driftFixture = "test/fixtures/focus-plan-corpus/procedure-drift";

async function documents(planDirectory: string): Promise<PlanDocuments> {
  const [plan, design, seit, implementation] = await Promise.all(
    ["plan-spec.md", "design.md", "seit.md", "implementation.md"].map((name) => readFile(join(repositoryRoot, planDirectory, name), "utf8")),
  );
  return { plan, design, seit, implementation };
}

function procedureFindings(findings: readonly Finding[]): readonly Finding[] {
  return findings.filter((finding) => finding.code === "procedure_mismatch");
}

/** The drift fixture with every procedure narrative realigned to its row. */
async function consistentDocuments(): Promise<PlanDocuments> {
  const base = await documents(driftFixture);
  return {
    ...base,
    seit: base.seit
      .replace("**Command.** PROC-LEGACY", "**Command.** PROC-IMPORT")
      .replace("**Positive case.** legacy import semantics are retained", "**Positive case.** schema-preserving migration keeps row semantics")
      .replace("**Negative case.** legacy rejection is retained", "**Negative case.** migration that rebinds row meaning fails validation")
      .replace("**Evidence.** test report", "**Evidence.** focused drift report")
      .replace(
        "## Cross-cutting Checks",
        `### SEIT-3 — Procedure review

**Command.** PROC-REVIEW
**Positive case.** every executable row resolves to one matching procedure narrative
**Negative case.** an executable row without a matching narrative blocks the plan
**Evidence.** procedure review report

## Cross-cutting Checks`,
      ),
  };
}

describe("procedure narrative resolution", () => {
  it("parses procedure narratives from the seit procedure section", async () => {
    const model = parsePlanDocuments(await documents(driftFixture));
    expect([...model.procedureNarratives.keys()]).toEqual(["SEIT-2"]);
    const narrative = model.procedureNarratives.get("SEIT-2")?.[0];
    expect(narrative?.heading).toBe("SEIT-2 — Legacy import procedure");
    expect([...narrative?.commandIds ?? []]).toEqual(["PROC-LEGACY"]);
  });

  it("returns NEEDS_AMENDMENT when a procedure narrative drifts from its row", async () => {
    const result = validatePlan({ documents: await documents(driftFixture), planDirectory: driftFixture });
    expect(procedureFindings(result.findings)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "procedure_mismatch",
        severity: "amendment",
        artifact: "seit.md",
        observed: "SEIT-2: SEIT-2 — Legacy import procedure declares command PROC-LEGACY, the row requires PROC-IMPORT",
        required: "every executable-procedure traceability row must resolve to exactly one procedure narrative whose command, positive case, negative case, and evidence target match the row",
      }),
      expect.objectContaining({ observed: "SEIT-2: SEIT-2 — Legacy import procedure positive case does not match the row" }),
      expect.objectContaining({ observed: "SEIT-2: SEIT-2 — Legacy import procedure negative case does not match the row" }),
      expect.objectContaining({ observed: "SEIT-2: SEIT-2 — Legacy import procedure evidence target does not match the row" }),
      expect.objectContaining({ observed: "SEIT-3 has no procedure narrative" }),
    ]));
    expect(procedureFindings(result.findings)).toHaveLength(5);
    expect(result.verdict).toBe("NEEDS_AMENDMENT");
  });

  it("stays quiet when every executable row resolves to a matching narrative", async () => {
    const result = validatePlan({ documents: await consistentDocuments(), planDirectory: driftFixture });
    expect(procedureFindings(result.findings)).toEqual([]);
    expect(result.verdict).toBe("PASS");
  });

  // Every seit.md in this workspace titles its procedures as unkeyed prose
  // (`## Integration Test Procedures` then `### 1. <title>`). Such a plan
  // cannot resolve a row to a narrative, so the check must not fire at all --
  // otherwise it rejects every existing plan instead of proving anything.
  it("does not fire on a plan whose procedures are unkeyed prose", async () => {
    const base = await documents(driftFixture);
    const legacy = { ...base, seit: base.seit.replace("### SEIT-2 — Legacy import procedure", "### 1. Legacy import procedure") };
    const model = parsePlanDocuments(legacy);
    expect(model.procedureNarratives.size).toBe(0);
    expect(procedureFindings(validatePlan({ documents: legacy, planDirectory: driftFixture }).findings)).toEqual([]);
  });

  it("reports a procedure narrative whose row ID is not declared in the matrix", async () => {
    const base = await consistentDocuments();
    const phantom = {
      ...base,
      seit: base.seit.replace("## Cross-cutting Checks", "### SEIT-99 — Phantom procedure\n\n**Command.** PROC-PHANTOM\n\n## Cross-cutting Checks"),
    };
    expect(procedureFindings(validatePlan({ documents: phantom, planDirectory: driftFixture }).findings)).toEqual([
      expect.objectContaining({
        code: "procedure_mismatch",
        artifact: "seit.md",
        observed: "SEIT-99: SEIT-99 — Phantom procedure names no declared traceability row",
      }),
    ]);
  });
});
