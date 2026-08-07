import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createFocusContext, validateFocusCompletion, type CommandEvidence } from "../src/journey/focus-mode.js";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// Issue #117 reproduction shape: slice S10 is split into two dependency-ordered
// Crewmate lanes (10.1, 10.2). The parent manifest still declares the union of
// both lanes' write sets and commands; each lane block declares its own bounded
// partition. Selecting a lane must project ONLY that lane's paths and commands
// into the Focus envelope, and an honest intermediate lane receipt must validate.
const PLAN_WITH_LANES = `# Plan
**Requirement IDs.** AC-1

### Slice S10
**Goal.** Split S10 into two serialized Crewmate lanes.
**Requirement IDs.** AC-1

### S10 execution manifest
**Write set.** \`src/lane1.ts\`, \`src/lane2.ts\` only.
**Command IDs.** CMD-UNIT-1, CMD-UNIT-2

#### Lane 10.1
**Write set.** only \`src/lane1.ts\`
**Command IDs.** CMD-UNIT-1

#### Lane 10.2
**Write set.** only \`src/lane2.ts\`
**Command IDs.** CMD-UNIT-2
`;

const SEIT_DOC = `# SEIT
- CMD-UNIT-1: lane 1 unit test
- CMD-UNIT-2: lane 2 unit test
`;

const reviewArtifact = "docs/plans/lane-plan/review.html";

async function repositoryWithPlan(implementation: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bearing-lane-projection-"));
  roots.push(root);
  await mkdir(join(root, "docs/plans/lane-plan"), { recursive: true });
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "docs/plans/lane-plan/plan-spec.md"), "# Spec\n");
  await writeFile(join(root, "docs/plans/lane-plan/design.md"), "# Design\n");
  await writeFile(join(root, "docs/plans/lane-plan/seit.md"), SEIT_DOC);
  await writeFile(join(root, "docs/plans/lane-plan/implementation.md"), implementation);
  await writeFile(join(root, "docs/plans/lane-plan/review.html"), "<html>review</html>\n");
  await writeFile(join(root, "src/lane1.ts"), "export const lane1 = false;\n");
  await writeFile(join(root, "src/lane2.ts"), "export const lane2 = false;\n");
  await exec("git", ["init", "-q"], { cwd: root });
  await exec("git", ["config", "user.email", "bearing@example.invalid"], { cwd: root });
  await exec("git", ["config", "user.name", "Bearing Test"], { cwd: root });
  await exec("git", ["add", "."], { cwd: root });
  await exec("git", ["commit", "-qm", "baseline"], { cwd: root });
  return root;
}

function context(root: string, currentSlice?: string) {
  return createFocusContext({
    root,
    planDirectory: "docs/plans/lane-plan",
    role: "crewmate",
    objective: "Execute one approved Crewmate lane",
    ...(currentSlice ? { currentSlice } : {}),
  });
}

describe("bounded Crewmate lane projection (Issue #117)", () => {
  it("issue 117: selecting a lane projects ONLY that lane's paths and commands, and an honest intermediate lane receipt validates", async () => {
    const root = await repositoryWithPlan(PLAN_WITH_LANES);
    const result = await context(root, "10.1");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.value.envelope.allowedPaths).toEqual([reviewArtifact, "src/lane1.ts"]);
    expect(result.value.envelope.seitCommandIds).toEqual(["CMD-UNIT-1"]);
    expect(result.value.envelope.remainingSlices).toEqual(["10.1"]);
    // An honest first lane touches only its own file and provides evidence for
    // its own command; the second lane's paths and commands are not in the
    // envelope, so the receipt validates instead of failing evidence_invalid.
    await writeFile(join(root, "src/lane1.ts"), "export const lane1 = true;\n");
    const completion = await validateFocusCompletion(result.value, root, ["src/lane1.ts"], [
      { commandId: "CMD-UNIT-1", status: "passed", summary: "1 test passed" } satisfies CommandEvidence,
    ]);
    expect(completion).toEqual({ ok: true, changedPaths: ["src/lane1.ts"] });
  });

  it("issue 117: a lane cannot escape its parent slice's write set", async () => {
    const escaping = PLAN_WITH_LANES.replace("**Write set.** only `src/lane1.ts`", "**Write set.** only `src/escaped.ts`");
    const root = await repositoryWithPlan(escaping);
    const result = await context(root, "10.1");
    expect(result).toMatchObject({ ok: false, reason: "lane_write_set_escape", field: "Write set", detail: "src/escaped.ts" });
  });

  it("issue 117: a lane cannot declare commands its parent slice never authorized", async () => {
    const plan = `# Plan
**Requirement IDs.** AC-1

### Slice S10
**Goal.** Split S10 into two serialized Crewmate lanes.
**Requirement IDs.** AC-1

### S10 execution manifest
**Write set.** \`src/lane1.ts\`, \`src/lane2.ts\` only.
**Command IDs.** CMD-UNIT-1

#### Lane 10.1
**Write set.** only \`src/lane1.ts\`
**Command IDs.** CMD-UNIT-2

#### Lane 10.2
**Write set.** only \`src/lane2.ts\`
**Command IDs.** CMD-UNIT-2
`;
    const root = await repositoryWithPlan(plan);
    const result = await context(root, "10.1");
    expect(result).toMatchObject({ ok: false, reason: "lane_command_escape", field: "Command IDs", detail: "CMD-UNIT-2" });
  });

  it("issue 117: a lane may write inside a directory entry of its parent slice's write set", async () => {
    const plan = PLAN_WITH_LANES.replace("**Write set.** `src/lane1.ts`, `src/lane2.ts` only.", "**Write set.** `src/` only.");
    const root = await repositoryWithPlan(plan);
    const result = await context(root, "10.1");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.value.envelope.allowedPaths).toEqual([reviewArtifact, "src/lane1.ts"]);
  });

  it("issue 117: a lane inherits its PARENT slice's wave position and shared-prelude closure", async () => {
    const plan = `# Plan
**Requirement IDs.** AC-1

## Dependency graph

S9 --> S10

## Execution waves

Wave 1: S9, S10

### Slice S9
**Goal.** Shared dependency prelude for the S10 lanes.
**Requirement IDs.** AC-1

### S9 execution manifest
**Write set.** \`config/guard.yml\` only.
**Command IDs.** CMD-UNIT-1

### Slice S10
**Goal.** Split S10 into two serialized Crewmate lanes.
**Requirement IDs.** AC-1

### S10 execution manifest
**Write set.** \`src/lane1.ts\`, \`src/lane2.ts\` only.
**Command IDs.** CMD-UNIT-1, CMD-UNIT-2

#### Lane 10.1
**Write set.** only \`src/lane1.ts\`
**Command IDs.** CMD-UNIT-1

#### Lane 10.2
**Write set.** only \`src/lane2.ts\`
**Command IDs.** CMD-UNIT-2
`;
    const root = await repositoryWithPlan(plan);
    await mkdir(join(root, "config"), { recursive: true });
    await writeFile(join(root, "config/guard.yml"), "allow: []\n");
    await exec("git", ["add", "."], { cwd: root });
    await exec("git", ["commit", "-qm", "prelude"], { cwd: root });
    const result = await context(root, "10.1");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.value.envelope.allowedPaths).toEqual(["config/guard.yml", reviewArtifact, "src/lane1.ts"]);
    expect(result.value.envelope.remainingSlices).toEqual(["10.1"]);
  });

  it("issue 117: a lane whose parent slice is missing from the plan fails typed instead of crashing", async () => {
    const plan = `# Plan
**Requirement IDs.** AC-1

### Slice S10
**Goal.** A slice whose manifest id does not match.
**Requirement IDs.** AC-1

### M10 execution manifest
**Write set.** \`src/lane1.ts\` only.
**Command IDs.** CMD-UNIT-1

#### Lane 10.1
**Write set.** only \`src/lane1.ts\`
**Command IDs.** CMD-UNIT-1
`;
    const root = await repositoryWithPlan(plan);
    const result = await context(root, "10.1");
    expect(result).toMatchObject({ ok: false, reason: "slice_not_found", field: "currentSlice" });
  });

  it("issue 117: a slice with no lanes behaves exactly as it does without the lane grammar", async () => {
    const plain = `# Plan
**Requirement IDs.** AC-1

### Slice S20
**Goal.** A slice that never declares lanes.
**Requirement IDs.** AC-1

### S20 execution manifest
**Write set.** \`src/plain.ts\` only.
**Command IDs.** CMD-UNIT-1
`;
    const root = await repositoryWithPlan(plain);
    await writeFile(join(root, "src/plain.ts"), "export const plain = false;\n");
    await exec("git", ["add", "."], { cwd: root });
    await exec("git", ["commit", "-qm", "plain"], { cwd: root });
    const result = await context(root, "S20");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.value.envelope.allowedPaths).toEqual([reviewArtifact, "src/plain.ts"]);
    expect(result.value.envelope.seitCommandIds).toEqual(["CMD-UNIT-1"]);
    expect(result.value.envelope.remainingSlices).toEqual(["S20"]);
  });

  it("issue 117: a whole-plan run over a lane-split slice keeps the parent manifest's union envelope", async () => {
    const root = await repositoryWithPlan(PLAN_WITH_LANES);
    const result = await context(root);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.value.envelope.allowedPaths).toEqual([reviewArtifact, "src/lane1.ts", "src/lane2.ts"]);
    expect(result.value.envelope.seitCommandIds).toEqual(["CMD-UNIT-1", "CMD-UNIT-2"]);
    expect(result.value.envelope.remainingSlices).toEqual(["S10"]);
  });
});
