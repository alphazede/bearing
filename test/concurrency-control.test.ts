import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as concurrencyControl from "../src/execution/concurrency-control.js";
import {
  admissibleConcurrency,
  provenIndependent,
  type ConcurrencySignal,
  type SliceFacts,
} from "../src/execution/concurrency-control.js";

function slice(overrides: Partial<SliceFacts> = {}): SliceFacts {
  return {
    writeSet: ["src/one.ts"],
    interfaceTags: ["interface-one"],
    environmentTags: ["environment-one"],
    integrationBoundaryTags: ["boundary-one"],
    parallelSafe: true,
    ...overrides,
  };
}

describe("dynamic concurrency control", () => {
  it("exports only concurrency decisions with production consumers", () => {
    expect(Object.keys(concurrencyControl).sort()).toEqual([
      "admissibleConcurrency",
      "provenIndependent",
    ]);
  });

  it("uses exact path membership and requires every independence declaration", () => {
    const first = slice();
    const exactDirectoryIsNotAFilePrefix = slice({
      writeSet: ["src/one.ts/child.ts"],
      interfaceTags: ["interface-two"],
      environmentTags: ["environment-two"],
      integrationBoundaryTags: ["boundary-two"],
    });

    expect(provenIndependent(first, exactDirectoryIsNotAFilePrefix)).toBe(true);
    expect(provenIndependent(first, slice({
      writeSet: ["src/one.ts"],
      interfaceTags: ["interface-two"],
      environmentTags: ["environment-two"],
      integrationBoundaryTags: ["boundary-two"],
    }))).toBe(false);

    for (const overlap of [
      { interfaceTags: ["interface-one"] },
      { environmentTags: ["environment-one"] },
      { integrationBoundaryTags: ["boundary-one"] },
    ]) {
      expect(provenIndependent(first, slice({
        writeSet: ["src/two.ts"],
        interfaceTags: ["interface-two"],
        environmentTags: ["environment-two"],
        integrationBoundaryTags: ["boundary-two"],
        ...overlap,
      }))).toBe(false);
    }

    for (const declaration of [
      "writeSet",
      "interfaceTags",
      "environmentTags",
      "integrationBoundaryTags",
    ] as const) {
      expect(provenIndependent(first, { ...exactDirectoryIsNotAFilePrefix, [declaration]: undefined })).toBe(false);
    }
    expect(provenIndependent(first, { ...exactDirectoryIsNotAFilePrefix, parallelSafe: undefined })).toBe(false);
    expect(provenIndependent(first, {
      ...exactDirectoryIsNotAFilePrefix,
      environmentTags: ["environment-two", 42],
    } as unknown as SliceFacts)).toBe(false);
    expect(provenIndependent(first, {
      ...exactDirectoryIsNotAFilePrefix,
      environmentTags: new Array<string>(1),
    })).toBe(false);
  });

  it("treats explicit empty tag declarations as known and disjoint", () => {
    expect(provenIndependent(
      slice({ interfaceTags: [], environmentTags: [], integrationBoundaryTags: [] }),
      slice({
        writeSet: ["src/two.ts"],
        interfaceTags: [],
        environmentTags: [],
        integrationBoundaryTags: [],
      }),
    )).toBe(true);
  });

  it("uses every hard cap and assigns authority by scope", () => {
    expect(admissibleConcurrency({
      ceiling: 8,
      ownerCap: 5,
      independenceCap: 3,
      signals: [],
      phaseId: "phase-a",
      scope: "cross-phase",
    })).toEqual({ cap: 3, controller: "trail-boss" });

    expect(admissibleConcurrency({
      ceiling: 8,
      ownerCap: 2,
      independenceCap: 6,
      signals: [],
      phaseId: "phase-a",
      scope: "within-phase",
    })).toEqual({ cap: 2, controller: "explorer" });

    expect(admissibleConcurrency({
      ceiling: 1,
      ownerCap: 8,
      independenceCap: 6,
      signals: [],
      phaseId: "phase-a",
      scope: "within-phase",
    })).toEqual({ cap: 1, controller: "explorer" });
  });

  it.each([
    "write_set_conflict",
    "shared_file",
    "unstable_test",
    "repeated_integration_failure",
  ] satisfies readonly ConcurrencySignal[])("reduces %s to serial execution", (signal) => {
    expect(admissibleConcurrency({
      ceiling: 8,
      ownerCap: 8,
      independenceCap: 8,
      signals: [signal],
      phaseId: "phase-a",
      scope: "within-phase",
    })).toEqual({ cap: 1, controller: "explorer", reducedBy: signal });
  });

  it("never raises a reduced cap in the same phase and resets on a clean new phase", () => {
    const prior = {
      phaseId: "phase-a",
      cap: 2,
      reducedBy: "unstable_test" as const,
    };

    expect(admissibleConcurrency({
      ceiling: 8,
      ownerCap: 8,
      independenceCap: 8,
      signals: [],
      phaseId: "phase-a",
      scope: "within-phase",
      prior,
    })).toEqual({ cap: 2, controller: "explorer", reducedBy: "unstable_test" });

    expect(admissibleConcurrency({
      ceiling: 8,
      ownerCap: 8,
      independenceCap: 8,
      signals: [],
      phaseId: "phase-b",
      scope: "cross-phase",
      prior,
    })).toEqual({ cap: 8, controller: "trail-boss" });
  });

  it("has no ambient filesystem, process, path, time, or randomness dependency", () => {
    const source = readFileSync(
      new URL("../src/execution/concurrency-control.ts", import.meta.url),
      "utf8",
    );

    expect(source).not.toMatch(/from\s+["'](?:node:)?(?:fs|child_process|path)(?:\/[^"']*)?["']/);
    expect(source).not.toContain("Date.now");
    expect(source).not.toContain("Math.random");
  });
});
