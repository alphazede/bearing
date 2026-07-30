import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { planDirectoryValid, proposePlanDirectory } from "../src/journey/plan-directory.js";

describe("plan directory", () => {
  it("accepts the relaxed bounded grammar", () => {
    expect(planDirectoryValid("docs/plans/bearing-improvements")).toBe(true);
    expect(planDirectoryValid("docs/plans/bearing-improvements/phase-2a")).toBe(true);
    expect(planDirectoryValid("docs/plans/Platform/Auth/rotation_1.2")).toBe(true);
    expect(planDirectoryValid(`docs/plans/${"a".repeat(64)}`)).toBe(true);
  });

  it.each([
    "docs/plans/bearing improvements",
    "docs/plans/platform/auth/rotation/archive",
    "docs/plans",
    "docs/plans/",
    "docs/plans//phase-2a",
    "docs/plans/.hidden",
    "docs/plans/-hidden",
    "docs/plans/../escape",
    "docs/plans/phase\\two",
    "docs/plans/phase*",
    "other/plans/phase",
    "/docs/plans/phase",
    `docs/plans/${"a".repeat(65)}`,
  ])("rejects %s", (value) => {
    expect(planDirectoryValid(value)).toBe(false);
  });

  it("is a strict superset of generated values accepted by the legacy regex", () => {
    const legacy = /^docs\/plans\/\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*$/;
    for (const date of ["2025-01-01", "2026-07-24", "2099-12-31"]) {
      for (const words of [["plan"], ["bearing", "phase2a"], ["a1", "b2", "c3"]]) {
        const value = `docs/plans/${date}-${words.join("-")}`;
        expect(legacy.test(value)).toBe(true);
        expect(planDirectoryValid(value)).toBe(true);
      }
    }
  });

  it("proposes one deterministic unsuffixed path without filesystem access", async () => {
    expect(proposePlanDirectory(" Ship bounded Evidence! ", "2026-07-24"))
      .toBe("docs/plans/2026-07-24-ship-bounded-evidence");
    expect(proposePlanDirectory(" Ship bounded Evidence! ", "2026-07-24"))
      .toBe("docs/plans/2026-07-24-ship-bounded-evidence");

    const source = await readFile(new URL("../src/journey/plan-directory.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/node:fs|mkdir|readdir|writeFile|numeric|suffix/i);
  });

  it("never proposes a path its own validator rejects", () => {
    // The property, not an example: a fixed slug cap let a long goal produce an
    // 83-character segment against a 64-character grammar. Any goal length that
    // crosses the boundary would have passed a sampled test.
    for (let length = 0; length <= 120; length += 1) {
      const goal = "a".repeat(length);
      expect(planDirectoryValid(proposePlanDirectory(goal, "2026-07-25"))).toBe(true);
    }
    for (const goal of ["", "   ", "!!!", "Ship it", "a b c ".repeat(30), "-".repeat(90)]) {
      expect(planDirectoryValid(proposePlanDirectory(goal, "2026-07-25"))).toBe(true);
    }
  });
});
