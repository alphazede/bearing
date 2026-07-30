import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createFocusContext } from "../src/journey/focus-mode.js";
import { validatePlan } from "../src/journey/planning-validator.js";
import { parsePlanDocuments, type PlanDocuments } from "../src/journey/plan-structure.js";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

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

const glob: PlanDocuments = { ...clean, implementation: clean.implementation.replace("src/import.ts", "skills/*/SKILL.md") };
const missingFields: PlanDocuments = {
  ...clean,
  implementation: ["Type", "Design lenses", "Implementation role", "Agent model route", "Agent reasoning level"].reduce(
    (value, name) => value.replace(new RegExp(`^\\*\\*${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.\\*\\*.*\\n`, "m"), ""),
    clean.implementation,
  ),
};
const missingSeitSections: PlanDocuments = {
  ...clean,
  seit: clean.seit
    .replace("## Required Commands", "## Removed Commands")
    .replace("## Traceability Matrix", "## Removed Matrix")
    .replace("## Cross-cutting Checks", "## Removed Checks"),
};
const goalBoundary: PlanDocuments = {
  ...clean,
  implementation: clean.implementation.replace("Import bounded data.", "x".repeat(513)),
};
const ownerDecision: PlanDocuments = {
  ...clean,
  implementation: clean.implementation.replace("Import bounded data.", "TODO decide the import contract."),
};
const noSlices: PlanDocuments = {
  ...clean,
  implementation: clean.implementation.slice(0, clean.implementation.indexOf("### Slice")),
};
const noIds: PlanDocuments = {
  ...clean,
  implementation: clean.implementation
    .replace("**Requirement IDs.** AC-1, RISK-1", "**Requirement IDs.** None.")
    .replace("**Design IDs.** DES-1, CONTRACT-1", "**Design IDs.** None.")
    .replace("**SEIT proof rows.** SEIT-1", "**SEIT proof rows.** None."),
};
const noWrites: PlanDocuments = {
  ...clean,
  implementation: clean.implementation.replace("Write only `src/import.ts`.", "No writes required."),
};
const lowercaseSlice: PlanDocuments = {
  ...clean,
  implementation: clean.implementation.replace("### Slice S1", "### slice S1"),
};
const mixedNoWrites: PlanDocuments = {
  ...clean,
  implementation: clean.implementation
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

**Write set.** No writes required.
**Command IDs.** CMD-UNIT
**Stop condition.** Stop if the focused test fails.
**Human decision.** None.
`),
};

const writeSetClauseForms = [
  ["clean", "Write only `src/a.ts`.", false],
  ["delete", "Write only `src/a.ts`. Do not delete `src/secret.ts`.", true],
  ["remove", "Write only `src/a.ts`. Do not remove `src/secret.ts`.", true],
  ["drop", "Write only `src/a.ts`. Do not drop `src/secret.ts`.", true],
  ["but-not", "Write only `src/a.ts`, but not `src/secret.ts`.", true],
  ["emphasized", "Write only `src/a.ts`. `src/secret.ts` must not be **modified**.", true],
  ["emphasized-marker", "Write only `src/a.ts`. `src/secret.ts` must **not** be **modified**.", true],
  ["unchanged", "Write only `src/a.ts` and `docs/notes.md` (public export unchanged)", true],
  ["no", "Write only `src/a.ts`. No changes to `src/secret.ts`.", true],
  ["never", "Write only `src/a.ts`. Never touch `src/secret.ts`.", true],
  ["except", "Write only `src/a.ts` except `src/secret.ts`.", true],
  ["excluding", "Write only `src/a.ts`, excluding `src/secret.ts`.", true],
  ["other-than", "Write only `src/a.ts`; other than `src/secret.ts`.", true],
  ["rather-than", "Write only `src/a.ts` rather than `src/secret.ts`.", true],
  ["read-only", "Write only `src/a.ts`; `src/secret.ts` is read-only.", true],
  ["untouched", "Write only `src/a.ts`; leave `src/secret.ts` untouched.", true],
] as const;
const writeSetClauseReason = "ambiguous write authority fails closed rather than silently granting write access; restate the prohibition in prose without backticks per planning contract rule 5";

async function checkedInFixtureDocuments(): Promise<PlanDocuments> {
  const directory = fileURLToPath(new URL("./fixtures/focus-plan-corpus/valid-bounds/", import.meta.url));
  const [plan, design, seit, implementation] = await Promise.all(
    ["plan-spec.md", "design.md", "seit.md", "implementation.md"].map((name) => readFile(join(directory, name), "utf8")),
  );
  return { plan, design, seit, implementation };
}

async function repository(fixtures: readonly (readonly [string, PlanDocuments])[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bearing-validator-conformance-"));
  roots.push(root);
  for (const [name, documents] of fixtures) {
    const directory = join(root, "docs/plans", name);
    await mkdir(directory, { recursive: true });
    await Promise.all([
      writeFile(join(directory, "plan-spec.md"), documents.plan),
      writeFile(join(directory, "design.md"), documents.design),
      writeFile(join(directory, "seit.md"), documents.seit),
      writeFile(join(directory, "implementation.md"), documents.implementation),
    ]);
  }
  await exec("git", ["init", "-q"], { cwd: root });
  await exec("git", ["config", "user.email", "bearing@example.invalid"], { cwd: root });
  await exec("git", ["config", "user.name", "Bearing Test"], { cwd: root });
  await exec("git", ["add", "."], { cwd: root });
  await exec("git", ["commit", "-qm", "baseline"], { cwd: root });
  return root;
}

async function fingerprint(root: string, directory: string): Promise<ReadonlyMap<string, string>> {
  return new Map(await Promise.all(["plan-spec.md", "design.md", "seit.md", "implementation.md"].map(async (name) => {
    const content = await readFile(join(root, directory, name));
    return [name, createHash("sha256").update(content).digest("hex")] as const;
  })));
}

describe("planning validator conformance", () => {
  it.each(writeSetClauseForms)("keeps validator and boundary aligned for the %s clause form", async (name, writeSet, rejected) => {
    const candidate = { ...clean, implementation: clean.implementation.replace("Write only `src/import.ts`.", writeSet) };
    const root = await repository([[name, candidate]]);
    const planDirectory = `docs/plans/${name}`;
    const validation = validatePlan({ documents: candidate, planDirectory });
    const finding = validation.findings.find((item) => item.code === "writeset_readonly_harvest");
    const boundary = await createFocusContext({
      root,
      planDirectory,
      role: "crewmate",
      objective: "Verify write authority conformance",
      currentSlice: "S1",
    });

    expect({
      validator: finding?.code ?? "none",
      boundary: boundary.ok ? "GRANTED" : boundary.reason,
    }).toEqual(rejected
      ? { validator: "writeset_readonly_harvest", boundary: "write_set_negation" }
      : { validator: "none", boundary: "GRANTED" });
    if (rejected) {
      expect(finding).toMatchObject({
        required: writeSetClauseReason,
        remedy: "Restate the prohibition in prose without backticks, per planning contract rule 5.",
      });
      expect(boundary).toMatchObject({
        ok: false,
        reason: "write_set_negation",
        sliceId: "S1",
        field: "Write set",
        detail: writeSetClauseReason,
      });
    }
  });

  it("proves every passing corpus fixture is accepted by the real execution boundary", async () => {
    const corpus: readonly [string, PlanDocuments][] = [
      ["clean", clean],
      ["checked-in-focus", await checkedInFixtureDocuments()],
      ["phase-1-glob", glob],
      ["phase-1-missing-fields", missingFields],
      ["phase-1-missing-seit", missingSeitSections],
      ["goal-boundary", goalBoundary],
      ["no-slices", noSlices],
      ["no-ids", noIds],
      ["no-writes", noWrites],
      ["lowercase-slice", lowercaseSlice],
      ["mixed-no-writes", mixedNoWrites],
    ];
    const root = await repository(corpus);

    for (const [name, documents] of corpus) {
      const planDirectory = `docs/plans/${name}`;
      const result = validatePlan({ documents, planDirectory });
      if (result.verdict !== "PASS") continue;
      const context = await createFocusContext({
        root,
        planDirectory,
        role: "explorer",
        objective: "Validate one bounded plan",
      });
      expect(context.ok, `${name} passed validation but the real boundary rejected it: ${context.ok ? "" : context.reason}`).toBe(true);
      if (!context.ok) throw new Error(`${name}: ${context.reason}`);
      expect(context.value.envelope.remainingSlices).toEqual([...parsePlanDocuments(documents).slices.keys()]);
      for (const sliceId of parsePlanDocuments(documents).slices.keys()) {
        const selected = await createFocusContext({
          root,
          planDirectory,
          role: "crewmate",
          objective: "Validate one bounded slice",
          currentSlice: sliceId,
        });
        expect(selected.ok, `${name}/${sliceId} passed validation but the real selected-slice boundary rejected it: ${selected.ok ? "" : selected.reason}`).toBe(true);
        if (!selected.ok) throw new Error(`${name}/${sliceId}: ${selected.reason}`);
        expect(selected.value.envelope.remainingSlices).toEqual([sliceId]);
      }
    }
  });

  it("rejects all three reproduced Phase 1 defects before dispatch", () => {
    expect(validatePlan({ documents: glob, planDirectory: "docs/plans/glob" }).findings).toContainEqual(expect.objectContaining({ code: "writeset_glob" }));
    expect(validatePlan({ documents: missingFields, planDirectory: "docs/plans/fields" }).findings.filter((item) => item.code === "slice_field_missing")).toHaveLength(5);
    expect(validatePlan({ documents: missingSeitSections, planDirectory: "docs/plans/seit" }).findings.filter((item) => item.code === "seit_section_missing")).toHaveLength(3);
  });

  it("leaves the plan directory byte-identical for every verdict", async () => {
    const fixtures = [
      ["pass", clean],
      ["amendment", glob],
      ["owner", ownerDecision],
    ] as const;
    const root = await repository(fixtures);

    for (const [name, documents] of fixtures) {
      const directory = `docs/plans/${name}`;
      const before = await fingerprint(root, directory);
      validatePlan({ documents, planDirectory: directory });
      expect(await fingerprint(root, directory)).toEqual(before);
    }
    expect(fixtures.map(([name, documents]) => validatePlan({ documents, planDirectory: `docs/plans/${name}` }).verdict))
      .toEqual(["PASS", "NEEDS_AMENDMENT", "OWNER_DECISION_REQUIRED"]);
  });
});
