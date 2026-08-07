import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createFocusContext, validateFocusCompletion, type CommandEvidence } from "../src/journey/focus-mode.js";
import { renderPlanningReview } from "../src/journey/planning-journey.js";
import { validatePlan, type PlanDocuments } from "../src/journey/planning-validator.js";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const plan = "---\ntype: plan-spec\nstatus: complete\n---\n\n## Acceptance criteria\n\n- **AC-1** — Bind approved shared dependencies.\n- **AC-2** — Import bounded data.\n- **AC-3** — Export bounded data.\n\n## Risks and open questions\n\n- **RISK-1** — Invalid input must fail closed.\n\n## Entry criteria\n\nRequirements are approved.\n\n## Exit criteria\n\nAll evidence commands pass.\n\n## Rollback or repair\n\nRepair the plan and rerun validation.\n\n## Accountable controller\n\nNavigator controls the phase.\n";
const design = "---\ntype: design\nstatus: complete\n---\n\n## Use Cases and Communication Flows\n\nThe owner dispatches one bounded lane.\n\n## Interface Option Check\n\nNo new interface is needed.\n\n## OOPDSA Implementation Design\n\n- **DES-1** — Keep the route bounded.\n";
const seit = "---\ntype: seit\nstatus: complete\n---\n\n## Required Commands\n\n- **CMD-UNIT** — `pnpm test`\n\n## Traceability Matrix\n\n| SEIT row ID | Acceptance/risk ID | Design/contract ID | Boundary/test layer | Positive case | Negative/failure case | Command/procedure ID | Evidence |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n| SEIT-1 | AC-1, RISK-1 | DES-1 | unit | binds | rejects | CMD-UNIT | report |\n| SEIT-2 | AC-2 | DES-1 | unit | imports | rejects | CMD-UNIT | report |\n| SEIT-3 | AC-3 | DES-1 | unit | exports | rejects | CMD-UNIT | report |\n\n## Cross-cutting Checks\n\nBounded write sets only.\n";
// Wave 5 owns a shared dependency/command-binding prelude (Slice 5.0) sequenced
// before two disjoint product lanes (Slice 5.1 and Slice 5.2), exactly the
// approved route shape issue 124 dispatches a Crewmate into.
const preludeSlice = `### Slice 5.0 — Shared dependency prelude

**Goal.** Bind approved shared dependencies and guard configuration.

**Requirement IDs.** AC-1

**Design IDs.** DES-1

**SEIT proof rows.** SEIT-1

**Type.** module

**Design lenses.** boundary

**Implementation role.** Add the approved dependency and its lockfile.

**Agent model route.** grok

**Agent reasoning level.** medium

**Review path.** native review.

### 5.0 execution manifest

**Write set.** \`package.json\`, \`pnpm-lock.yaml\`, \`config/guard.yml\` only.

**Command IDs.** CMD-UNIT

**Stop condition.** Stop if the focused test fails.

**Human decision.** None.
`;
const importSlice = `### Slice 5.1 — Import

**Goal.** Import bounded data through src/import.ts.

**Requirement IDs.** AC-2

**Design IDs.** DES-1

**SEIT proof rows.** SEIT-2

**Type.** module

**Design lenses.** correctness

**Implementation role.** Implement the import module.

**Agent model route.** grok

**Agent reasoning level.** medium

**Review path.** native review.

### 5.1 execution manifest

**Write set.** \`src/import.ts\` only.

**Command IDs.** CMD-UNIT

**Stop condition.** Stop if the focused test fails.

**Human decision.** None.
`;
const exportSlice = `### Slice 5.2 — Export

**Goal.** Export bounded data through src/export.ts.

**Requirement IDs.** AC-3

**Design IDs.** DES-1

**SEIT proof rows.** SEIT-3

**Type.** module

**Design lenses.** correctness

**Implementation role.** Implement the export module.

**Agent model route.** grok

**Agent reasoning level.** medium

**Review path.** native review.

### 5.2 execution manifest

**Write set.** \`src/export.ts\` only.

**Command IDs.** CMD-UNIT

**Stop condition.** Stop if the focused test fails.

**Human decision.** None.
`;
const implementation = `---
type: implementation
status: complete
---

## Dependency graph

5.0 --> 5.1

5.0 --> 5.2

## Execution waves

Wave 1:

Wave 2:

Wave 3:

Wave 4:

Wave 5: 5.0, 5.1, 5.2

${preludeSlice}
${importSlice}
${exportSlice}`;
// The lane that never declares the prelude as a prerequisite must not inherit
// the shared paths: the envelope admits only the declared prerequisite prelude.
const implementationWithoutPreludePrerequisite = implementation.replace("5.0 --> 5.2\n", "");

const documents = (implementationContent: string): PlanDocuments => ({ plan, design, seit, implementation: implementationContent });
const reviewArtifact = "docs/plans/import/review.html";
const preludePaths = ["config/guard.yml", "package.json", "pnpm-lock.yaml"];
const passed: CommandEvidence[] = [{ commandId: "CMD-UNIT", status: "passed", summary: "1 test passed" }];

async function repositoryWithWavePlan(implementationContent: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bearing-focus-prelude-"));
  roots.push(root);
  await mkdir(join(root, "docs/plans/import"), { recursive: true });
  await mkdir(join(root, "config"), { recursive: true });
  await mkdir(join(root, "src"), { recursive: true });
  const planSources: readonly [string, string][] = [
    ["plan-spec.md", plan],
    ["design.md", design],
    ["seit.md", seit],
    ["implementation.md", implementationContent],
  ];
  await Promise.all([
    writeFile(join(root, "docs/plans/import/plan-spec.md"), plan),
    writeFile(join(root, "docs/plans/import/design.md"), design),
    writeFile(join(root, "docs/plans/import/seit.md"), seit),
    writeFile(join(root, "docs/plans/import/implementation.md"), implementationContent),
    writeFile(join(root, "docs/plans/import/review.html"), renderPlanningReview(planSources)),
    writeFile(join(root, "package.json"), "{}\n"),
    writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: 1\n"),
    writeFile(join(root, "config/guard.yml"), "allow: []\n"),
    writeFile(join(root, "src/import.ts"), "export const imported = false;\n"),
    writeFile(join(root, "src/export.ts"), "export const exported = false;\n"),
  ]);
  await exec("git", ["init", "-q"], { cwd: root });
  await exec("git", ["config", "user.email", "bearing@example.invalid"], { cwd: root });
  await exec("git", ["config", "user.name", "Bearing Test"], { cwd: root });
  await exec("git", ["add", "."], { cwd: root });
  await exec("git", ["commit", "-qm", "baseline"], { cwd: root });
  return root;
}

async function context(root: string, currentSlice?: string) {
  return createFocusContext({
    root,
    planDirectory: "docs/plans/import",
    role: "crewmate",
    objective: "Execute one approved lane with its shared prelude",
    ...(currentSlice ? { currentSlice } : {}),
  });
}

describe("Focus wave shared prelude", () => {
  it("issue 124: a wave whose prelude owns shared dependency paths is an approved plan", () => {
    expect(validatePlan({ documents: documents(implementation), planDirectory: "docs/plans/import" }).verdict).toBe("PASS");
  });

  it("issue 124: a whole-plan context aggregates the prelude and lane paths", async () => {
    const root = await repositoryWithWavePlan(implementation);
    const result = await context(root);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.value.envelope.allowedPaths).toEqual([...preludePaths, reviewArtifact, "src/export.ts", "src/import.ts"].sort());
    expect(result.value.envelope.remainingSlices).toEqual(["5.0", "5.1", "5.2"]);
  });

  it("issue 124: selecting a lane under the wave includes the shared prelude paths in the envelope", async () => {
    const root = await repositoryWithWavePlan(implementation);
    const result = await context(root, "5.1");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.value.envelope.allowedPaths).toEqual([...preludePaths, reviewArtifact, "src/import.ts"].sort());
    expect(result.value.envelope.remainingSlices).toEqual(["5.1"]);
  });

  it("issue 124: selecting the other lane includes the same shared prelude paths", async () => {
    const root = await repositoryWithWavePlan(implementation);
    const result = await context(root, "5.2");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.value.envelope.allowedPaths).toEqual([...preludePaths, reviewArtifact, "src/export.ts"].sort());
  });

  it("issue 124: selecting the prelude slice itself keeps the envelope bounded to its own write set", async () => {
    const root = await repositoryWithWavePlan(implementation);
    const result = await context(root, "5.0");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.value.envelope.allowedPaths).toEqual([...preludePaths, reviewArtifact].sort());
  });

  it("issue 124: a lane that does not declare the prelude as a prerequisite stays bounded to its own write set", async () => {
    const root = await repositoryWithWavePlan(implementationWithoutPreludePrerequisite);
    const result = await context(root, "5.2");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.value.envelope.allowedPaths).toEqual([reviewArtifact, "src/export.ts"].sort());
  });

  it("issue 124: the guarded workflow admits editing an approved shared prelude path beside the lane", async () => {
    const root = await repositoryWithWavePlan(implementation);
    const focus = await context(root, "5.1");
    if (!focus.ok) throw new Error(focus.reason);
    await Promise.all([
      writeFile(join(root, "package.json"), "{ \"dependencies\": { \"bounded\": \"1.0.0\" } }\n"),
      writeFile(join(root, "src/import.ts"), "export const imported = true;\n"),
    ]);
    const artifacts = ["package.json", "src/import.ts"];
    expect(await validateFocusCompletion(focus.value, root, artifacts, passed)).toEqual({
      ok: true,
      changedPaths: artifacts,
    });
  });
});
