import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validatePlan, type Finding } from "../src/journey/planning-validator.js";
import type { PlanDocuments } from "../src/journey/plan-structure.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const systemCatalogFixture = "test/fixtures/focus-plan-corpus/system-catalog-incomplete";

async function fixtureDocuments(fixture: string): Promise<PlanDocuments> {
  const [plan, design, seit, implementation] = await Promise.all(
    ["plan-spec.md", "design.md", "seit.md", "implementation.md"].map((name) => readFile(join(repositoryRoot, fixture, name), "utf8")),
  );
  return { plan, design, seit, implementation };
}

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

/** The incomplete fixture completed: SYS-2 gains a full per-system specification. */
async function completeDocuments(): Promise<PlanDocuments> {
  const documents = await fixtureDocuments(systemCatalogFixture);
  return {
    ...documents,
    design: documents.design.replace("## Requirement Trace", `${SYS_2_SPEC}\n\n## Requirement Trace`),
  };
}

const TRACE_ROW = "| AC-1, RISK-1 | SYS-1, SYS-2 | CONTRACT-1 | SEIT-1 | S1 | `src/notifier.ts` |";

const CONTRADICTION_CODES = ["system_owner_conflict", "system_scope_conflict", "system_path_conflict"] as const;

function contradictionFindings(findings: readonly Finding[]): readonly Finding[] {
  return findings.filter((finding) => (CONTRADICTION_CODES as readonly string[]).includes(finding.code));
}

// The first slice in implementation.md is S1, so a plain replace hits S1's
// field before the identical S2 field.
const S1_ONLY = (documents: PlanDocuments, from: string, to: string): PlanDocuments => ({
  ...documents,
  implementation: documents.implementation.replace(from, to),
});

describe("cross-artifact plan contradictions", () => {
  it("passes a consistent catalog plan with no contradiction findings", async () => {
    const result = validatePlan({ documents: await completeDocuments(), planDirectory: systemCatalogFixture });

    expect(contradictionFindings(result.findings)).toEqual([]);
    expect(result.verdict).toBe("PASS");
  });

  it("rejects a requirement the trace binds to a slice that does not declare it", async () => {
    const documents = S1_ONLY(await completeDocuments(), "**Requirement IDs.** AC-1, RISK-1", "**Requirement IDs.** RISK-1");
    const result = validatePlan({ documents, planDirectory: systemCatalogFixture });

    expect(result.findings).toEqual([expect.objectContaining({
      code: "system_owner_conflict",
      severity: "amendment",
      artifact: "design.md",
      observed: "AC-1: Requirement Trace row names slice(s) S1, none declaring the requirement",
    })]);
    expect(result.verdict).toBe("NEEDS_AMENDMENT");
  });

  it("rejects a contract the trace binds to a slice that does not declare it", async () => {
    const documents = S1_ONLY(await completeDocuments(), "**Design IDs.** DES-1, CONTRACT-1", "**Design IDs.** DES-1");
    const result = validatePlan({ documents, planDirectory: systemCatalogFixture });

    expect(result.findings).toEqual([expect.objectContaining({
      code: "system_scope_conflict",
      severity: "amendment",
      artifact: "design.md",
      observed: "CONTRACT-1: Requirement Trace row names slice(s) S1, none declaring the contract",
    })]);
    expect(result.verdict).toBe("NEEDS_AMENDMENT");
  });

  it("rejects a SEIT row the trace binds to a slice that does not list it as a proof row", async () => {
    const documents = await completeDocuments();
    const contradicted = {
      ...documents,
      design: documents.design.replace(TRACE_ROW, TRACE_ROW.replace("SEIT-1", "SEIT-9")),
      seit: documents.seit.replace(
        "| SEIT-1 | AC-1, RISK-1 | DES-1, CONTRACT-1 | unit | bounded plans parse | invalid plans fail closed | CMD-UNIT | test report |",
        "| SEIT-1 | AC-1, RISK-1 | DES-1, CONTRACT-1 | unit | bounded plans parse | invalid plans fail closed | CMD-UNIT | test report |\n| SEIT-9 | AC-1, RISK-1 | DES-1, CONTRACT-1 | unit | bounded plans parse | invalid plans fail closed | CMD-UNIT | test report |",
      ),
    };
    const result = validatePlan({ documents: contradicted, planDirectory: systemCatalogFixture });

    expect(result.findings).toEqual([expect.objectContaining({
      code: "system_scope_conflict",
      severity: "amendment",
      artifact: "design.md",
      observed: "SEIT-9: Requirement Trace row names slice(s) S1, none listing the row in SEIT proof rows",
    })]);
    expect(result.verdict).toBe("NEEDS_AMENDMENT");
  });

  it("rejects a traced path the named slice does not write when another slice covers it", async () => {
    const documents = await completeDocuments();
    const contradicted = {
      ...documents,
      // S1 stops covering the traced path; S2's write set covers it instead, so
      // the union coverage check alone cannot see that the row's binding to S1 broke.
      implementation: documents.implementation
        .replace("**Write set.** Write only `src/notifier.ts`.", "**Write set.** Write only `src/import.ts`.")
        .replace("**Write set.** Write only `test/focus-mode.test.ts`.", "**Write set.** Write only `src/notifier.ts`."),
    };
    const result = validatePlan({ documents: contradicted, planDirectory: systemCatalogFixture });

    expect(result.findings).toEqual([expect.objectContaining({
      code: "system_path_conflict",
      severity: "amendment",
      artifact: "design.md",
      observed: "src/notifier.ts: Requirement Trace row names slice(s) S1, none covering the path in a write set",
    })]);
    expect(result.verdict).toBe("NEEDS_AMENDMENT");
  });

  it("accepts a traced path covered by any slice the row names", async () => {
    const documents = await completeDocuments();
    const covered = {
      ...documents,
      design: documents.design.replace(TRACE_ROW, TRACE_ROW.replace("| S1 |", "| S1, S2 |")),
      implementation: documents.implementation
        .replace("**Write set.** Write only `src/notifier.ts`.", "**Write set.** Write only `src/import.ts`.")
        .replace("**Write set.** Write only `test/focus-mode.test.ts`.", "**Write set.** Write only `src/notifier.ts`."),
    };
    const result = validatePlan({ documents: covered, planDirectory: systemCatalogFixture });

    expect(contradictionFindings(result.findings)).toEqual([]);
    expect(result.verdict).toBe("PASS");
  });

  it("does not add contradiction findings when the row names an undeclared slice", async () => {
    const documents = await completeDocuments();
    const dangling = {
      ...documents,
      design: documents.design.replace("| S1 | `src/notifier.ts` |", "| S9 | `src/notifier.ts` |"),
    };
    const result = validatePlan({ documents: dangling, planDirectory: systemCatalogFixture });

    expect(contradictionFindings(result.findings)).toEqual([]);
    expect(result.findings).toContainEqual(expect.objectContaining({
      code: "system_trace_broken",
      observed: "S9",
      severity: "amendment",
    }));
  });

  it("does not double-report a traced path that no slice anywhere covers", async () => {
    const documents = S1_ONLY(await completeDocuments(), "**Write set.** Write only `src/notifier.ts`.", "**Write set.** Write only `src/import.ts`.");
    const result = validatePlan({ documents, planDirectory: systemCatalogFixture });

    expect(contradictionFindings(result.findings)).toEqual([]);
    expect(result.findings).toContainEqual(expect.objectContaining({
      code: "system_trace_broken",
      observed: "src/notifier.ts",
      required: "every traced path must be covered by a slice write set",
    }));
  });

  it("does not fire on a catalog-free plan", async () => {
    const result = validatePlan({ documents: await fixtureDocuments("test/fixtures/focus-plan-corpus/valid-bounds"), planDirectory: "test/fixtures/focus-plan-corpus/valid-bounds" });

    expect(contradictionFindings(result.findings)).toEqual([]);
    expect(result.verdict).toBe("PASS");
  });
});
