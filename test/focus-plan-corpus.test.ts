import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createFocusContext } from "../src/journey/focus-mode.js";
import { parsePlanDocuments, type PlanDocuments } from "../src/journey/plan-structure.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const corpusRoot = "test/fixtures/focus-plan-corpus";
const validFixture = `${corpusRoot}/valid-bounds`;
const overlongGoalFixture = `${corpusRoot}/goal-too-long`;

async function documents(planDirectory: string): Promise<PlanDocuments> {
  const [plan, design, seit, implementation] = await Promise.all(
    ["plan-spec.md", "design.md", "seit.md", "implementation.md"].map((name) => readFile(join(repositoryRoot, planDirectory, name), "utf8")),
  );
  return { plan, design, seit, implementation };
}

async function accepted(currentSlice?: string, role: "explorer" | "crewmate" = "explorer") {
  const result = await createFocusContext({
    root: repositoryRoot,
    planDirectory: validFixture,
    role,
    objective: "Validate the checked-in plan corpus",
    ...(currentSlice ? { currentSlice } : {}),
  });
  expect(result.ok, result.ok ? undefined : `${result.reason} ${result.sliceId ?? ""} ${result.detail ?? ""}`).toBe(true);
  if (!result.ok) throw new Error(result.reason);
  return result.value;
}

describe("Focus plan corpus", () => {
  it("parses the whole plan and every slice through the real boundary", async () => {
    const planDirectory = validFixture;
    const sliceIds = [...parsePlanDocuments(await documents(planDirectory)).slices.keys()];
    expect(sliceIds.length).toBeGreaterThan(0);

    const whole = await createFocusContext({
      root: repositoryRoot,
      planDirectory,
      role: "explorer",
      objective: "Validate the existing plan corpus",
    });
    expect(whole.ok, whole.ok ? undefined : `${whole.reason} ${whole.sliceId ?? ""} ${whole.detail ?? ""}`).toBe(true);
    if (!whole.ok) throw new Error(whole.reason);
    expect(whole.value.envelope.remainingSlices).toEqual(sliceIds);

    for (const sliceId of sliceIds) {
      const selected = await createFocusContext({
        root: repositoryRoot,
        planDirectory,
        role: "crewmate",
        objective: "Validate the existing plan corpus",
        currentSlice: sliceId,
      });
      expect(selected.ok, selected.ok ? undefined : `${sliceId}: ${selected.reason} ${selected.detail ?? ""}`).toBe(true);
      if (!selected.ok) throw new Error(`${sliceId}: ${selected.reason}`);
      expect(selected.value.envelope.remainingSlices).toEqual([sliceId]);
    }
  });

  it("keeps both checked-in slices discoverable", async () => {
    expect([...parsePlanDocuments(await documents(validFixture)).slices.keys()]).toEqual(["S1", "S2"]);
  });

  it("aggregates each writable path for a whole-plan context", async () => {
    expect((await accepted()).envelope.allowedPaths).toEqual([
      "src/notifier.ts",
      "test/fixtures/focus-plan-corpus/valid-bounds/review.html",
      "test/focus-mode.test.ts",
    ]);
  });

  it("limits the S1 context to the benign path containing not", async () => {
    expect((await accepted("S1", "crewmate")).envelope.allowedPaths).toEqual([
      "src/notifier.ts",
      "test/fixtures/focus-plan-corpus/valid-bounds/review.html",
    ]);
  });

  it("limits the S2 context to its selected write target", async () => {
    expect((await accepted("S2", "crewmate")).envelope.allowedPaths).toEqual([
      "test/fixtures/focus-plan-corpus/valid-bounds/review.html",
      "test/focus-mode.test.ts",
    ]);
  });

  it("deduplicates the checked-in command contract", async () => {
    expect((await accepted()).envelope.seitCommandIds).toEqual(["CMD-UNIT"]);
  });

  it("carries the checked-in acceptance criterion", async () => {
    expect((await accepted()).envelope.currentAcceptanceCriterion).toBe("AC-1 — Keep Focus bounded.");
  });

  it("carries the immutable objective", async () => {
    expect((await accepted()).envelope.immutableObjective).toBe("Validate the checked-in plan corpus");
  });

  it("carries the whole-plan explorer role", async () => {
    expect((await accepted()).envelope.role).toBe("explorer");
  });

  it("carries the selected-slice crewmate role", async () => {
    expect((await accepted("S1", "crewmate")).envelope.role).toBe("crewmate");
  });
});

describe("Focus authoring boundaries", () => {
  it("accepts a path containing not and a 512-character Goal", async () => {
    const result = await createFocusContext({
      root: repositoryRoot,
      planDirectory: validFixture,
      role: "crewmate",
      objective: "Validate authoring boundaries",
      currentSlice: "S1",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.value.envelope.allowedPaths).toEqual([
      "src/notifier.ts",
      "test/fixtures/focus-plan-corpus/valid-bounds/review.html",
    ]);
  });

  it("reports the measured length and limit for a 513-character Goal", async () => {
    expect(await createFocusContext({
      root: repositoryRoot,
      planDirectory: overlongGoalFixture,
      role: "crewmate",
      objective: "Validate authoring boundaries",
    })).toEqual({
      ok: false,
      reason: "goal_too_long",
      sliceId: "S1",
      field: "Goal",
      detail: "length=513 limit=512",
    });
  });
});
