import { describe, expect, it } from "vitest";
import { createFocusContext } from "../src/journey/focus-mode.js";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

const PLAN_WITH_LANES = `
# Plan
**Requirement IDs.** AC-1

### Slice S10
**Goal.** Implement component in bounded lanes.
**Requirement IDs.** AC-1

### S10 execution manifest
#### Lane 10.1
**Write set.** only \`src/lane1.ts\`
**Command IDs.** CMD-UNIT-1

#### Lane 10.2
**Write set.** only \`src/lane2.ts\`
**Command IDs.** CMD-UNIT-2
`;

const SEIT_DOC = `
# SEIT
- CMD-UNIT-1: unit test 1
- CMD-UNIT-2: unit test 2
`;

describe("bounded Crewmate lane selection (Issue #117)", () => {
  it("projects only selected lane write set and command IDs (lane 10.1)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bearing-lane-test-"));
    try {
      await exec("git", ["init"], { cwd: dir });
      await exec("git", ["config", "user.name", "Test"], { cwd: dir });
      await exec("git", ["config", "user.email", "test@example.com"], { cwd: dir });

      const planDir = join(dir, "docs/plans/lane-plan");
      await mkdir(planDir, { recursive: true });
      await writeFile(join(planDir, "plan-spec.md"), "# Spec\n");
      await writeFile(join(planDir, "design.md"), "# Design\n");
      await writeFile(join(planDir, "seit.md"), SEIT_DOC);
      await writeFile(join(planDir, "implementation.md"), PLAN_WITH_LANES);

      await exec("git", ["add", "."], { cwd: dir });
      await exec("git", ["commit", "-m", "init"], { cwd: dir });

      const res1 = await createFocusContext({
        root: dir,
        role: "crewmate",
        planDirectory: "docs/plans/lane-plan",
        objective: "Test objective",
        currentSlice: "10.1",
      });
      expect(res1.ok).toBe(true);
      if (res1.ok) {
        expect(res1.value.envelope.allowedPaths).toEqual(["docs/plans/lane-plan/review.html", "src/lane1.ts"]);
        expect(res1.value.envelope.seitCommandIds).toEqual(["CMD-UNIT-1"]);
      }

      const res2 = await createFocusContext({
        root: dir,
        role: "crewmate",
        planDirectory: "docs/plans/lane-plan",
        objective: "Test objective",
        currentSlice: "10.2",
      });
      expect(res2.ok).toBe(true);
      if (res2.ok) {
        expect(res2.value.envelope.allowedPaths).toEqual(["docs/plans/lane-plan/review.html", "src/lane2.ts"]);
        expect(res2.value.envelope.seitCommandIds).toEqual(["CMD-UNIT-2"]);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects duplicate lane IDs across slice manifests", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bearing-lane-dup-"));
    try {
      await exec("git", ["init"], { cwd: dir });
      await exec("git", ["config", "user.name", "Test"], { cwd: dir });
      await exec("git", ["config", "user.email", "test@example.com"], { cwd: dir });

      const planDir = join(dir, "docs/plans/dup-plan");
      await mkdir(planDir, { recursive: true });
      await writeFile(join(planDir, "plan-spec.md"), "# Spec\n");
      await writeFile(join(planDir, "design.md"), "# Design\n");
      await writeFile(join(planDir, "seit.md"), SEIT_DOC);
      await writeFile(join(planDir, "implementation.md"), `
# Plan
**Requirement IDs.** AC-1

### Slice S10
**Goal.** S10
**Requirement IDs.** AC-1

### S10 execution manifest
#### Lane 10.1
**Write set.** only \`src/lane1.ts\`
**Command IDs.** CMD-UNIT-1

#### Lane 10.1
**Write set.** only \`src/lane2.ts\`
**Command IDs.** CMD-UNIT-2
`);

      await exec("git", ["add", "."], { cwd: dir });
      await exec("git", ["commit", "-m", "init"], { cwd: dir });

      const res = await createFocusContext({
        root: dir,
        role: "crewmate",
        planDirectory: "docs/plans/dup-plan",
        objective: "Test objective",
      });
      expect(res).toMatchObject({ ok: false, reason: "duplicate_lane_id" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns slice_not_found for unknown lane ID", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bearing-lane-missing-"));
    try {
      await exec("git", ["init"], { cwd: dir });
      await exec("git", ["config", "user.name", "Test"], { cwd: dir });
      await exec("git", ["config", "user.email", "test@example.com"], { cwd: dir });

      const planDir = join(dir, "docs/plans/lane-plan");
      await mkdir(planDir, { recursive: true });
      await writeFile(join(planDir, "plan-spec.md"), "# Spec\n");
      await writeFile(join(planDir, "design.md"), "# Design\n");
      await writeFile(join(planDir, "seit.md"), SEIT_DOC);
      await writeFile(join(planDir, "implementation.md"), PLAN_WITH_LANES);

      await exec("git", ["add", "."], { cwd: dir });
      await exec("git", ["commit", "-m", "init"], { cwd: dir });

      const res = await createFocusContext({
        root: dir,
        role: "crewmate",
        planDirectory: "docs/plans/lane-plan",
        objective: "Test objective",
        currentSlice: "99.9",
      });
      expect(res).toMatchObject({ ok: false, reason: "slice_not_found" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects lane block missing write set or command IDs without falling back to manifest", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bearing-lane-field-missing-"));
    try {
      await exec("git", ["init"], { cwd: dir });
      await exec("git", ["config", "user.name", "Test"], { cwd: dir });
      await exec("git", ["config", "user.email", "test@example.com"], { cwd: dir });

      const planDir = join(dir, "docs/plans/incomplete-lane");
      await mkdir(planDir, { recursive: true });
      await writeFile(join(planDir, "plan-spec.md"), "# Spec\n");
      await writeFile(join(planDir, "design.md"), "# Design\n");
      await writeFile(join(planDir, "seit.md"), SEIT_DOC);
      await writeFile(join(planDir, "implementation.md"), `
# Plan
**Requirement IDs.** AC-1

### Slice S10
**Goal.** S10
**Requirement IDs.** AC-1

### S10 execution manifest
**Write set.** only \`src/parent.ts\`
**Command IDs.** CMD-UNIT-1

#### Lane 10.1
**Write set.** only \`src/lane1.ts\`
`);

      await exec("git", ["add", "."], { cwd: dir });
      await exec("git", ["commit", "-m", "init"], { cwd: dir });

      const res = await createFocusContext({
        root: dir,
        role: "crewmate",
        planDirectory: "docs/plans/incomplete-lane",
        objective: "Test objective",
        currentSlice: "10.1",
      });
      expect(res).toMatchObject({ ok: false, reason: "field_missing", field: "Command IDs" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
