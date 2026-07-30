import { describe, expect, it } from "vitest";
import {
  hashExecutionContractBody,
  parseApprovedExecutionContract,
  type ApprovedExecutionContract,
  type ExecutionContractBody,
  type ExecutionContractPhase,
  type ExecutionContractSlice,
  type ParallelSafetyAdvisory,
} from "../src/contracts/execution-contract.js";
import { MAX_ORCHESTRATION_DEPTH } from "../src/execution/execution-scheduler.js";
import { adviseSubExplorers, buildPhaseGraph } from "../src/execution/phase-graph.js";

function slice(
  sliceId: string,
  phaseId: string,
  dependsOn: readonly string[] = [],
  writeSet: readonly string[] = [`src/${sliceId}.ts`],
  overrides: Partial<ExecutionContractSlice> = {},
): ExecutionContractSlice {
  return {
    sliceId,
    phaseId,
    requirementIds: ["AC-1"],
    writeSet,
    acceptance: `Complete ${sliceId}.`,
    evidenceCommandIds: ["CMD-UNIT"],
    dependsOn,
    parallelSafe: true,
    role: "crewmate",
    reasoningTier: "high",
    ...overrides,
  };
}

function approved(
  slices: readonly ExecutionContractSlice[],
  phases: readonly ExecutionContractPhase[] = [{
    phaseId: "phase-1",
    title: "Build",
    entryCriteria: "Approved.",
    exitCriteria: "Validated.",
    dependsOnPhases: [],
    integrationCheckpointCount: 0,
  }],
  dependencyEdges: ExecutionContractBody["dependencyEdges"] = [],
): ApprovedExecutionContract {
  const body: ExecutionContractBody = {
    schemaVersion: 1,
    contractId: "phase-graph-contract",
    runId: "phase-graph-run",
    planDirectory: "docs/plans/phase-graph",
    objective: "Derive the approved phase graph.",
    mode: "expedition",
    reviewCadence: "per-phase",
    phases,
    slices,
    dependencyEdges,
  };
  const contentHash = hashExecutionContractBody(body);
  return {
    ...body,
    contentHash,
    ownerApproval: {
      kind: "owner-approval",
      recordedBy: "owner",
      durable: true,
      recordId: "phase-graph-approval",
      contentHash,
    },
  };
}

function naiveAdvisories(contract: ApprovedExecutionContract): ParallelSafetyAdvisory[] {
  const advisories: ParallelSafetyAdvisory[] = [];
  for (let left = 0; left < contract.slices.length; left += 1) {
    for (let right = left + 1; right < contract.slices.length; right += 1) {
      const first = contract.slices[left];
      const second = contract.slices[right];
      const paths = [...new Set(first.writeSet.filter((path) => second.writeSet.includes(path)))].sort();
      if (paths.length && (first.parallelSafe || second.parallelSafe)) {
        advisories.push({
          code: "overlapping_parallel_write_set",
          sliceIds: [first.sliceId, second.sliceId],
          paths,
        });
      }
    }
  }
  return advisories;
}

function naiveParallelSafety(contract: ApprovedExecutionContract) {
  const conflicts = contract.slices.map(() => new Set<string>());
  const sharedPaths = contract.slices.map(() => new Set<string>());
  for (let left = 0; left < contract.slices.length; left += 1) {
    for (let right = left + 1; right < contract.slices.length; right += 1) {
      const first = contract.slices[left];
      const second = contract.slices[right];
      const paths = first.writeSet.filter((path) => second.writeSet.includes(path));
      const interfaces = (first.sharedInterfaces ?? []).filter((value) =>
        (second.sharedInterfaces ?? []).includes(value));
      if (!paths.length && !interfaces.length) continue;
      conflicts[left].add(second.sliceId);
      conflicts[right].add(first.sliceId);
      paths.forEach((path) => {
        sharedPaths[left].add(path);
        sharedPaths[right].add(path);
      });
    }
  }
  return contract.slices.map((entry, index) => ({
    sliceId: entry.sliceId,
    parallelSafe: entry.parallelSafe && conflicts[index].size === 0,
    conflictsWith: [...conflicts[index]],
    sharedPaths: [...sharedPaths[index]].sort(),
  }));
}

function componentContract(
  componentSizes: readonly number[],
  options: { readonly boundaryPerComponent?: boolean; readonly crossOwners?: number } = {},
): ApprovedExecutionContract {
  const slices: ExecutionContractSlice[] = [];
  let ordinal = 1;
  componentSizes.forEach((size, component) => {
    let previous: string | undefined;
    for (let index = 0; index < size; index += 1) {
      const sliceId = `1.${ordinal++}`;
      const writeSet = [`src/component-${component}-${index}.ts`];
      if (index < (options.crossOwners ?? 0)) writeSet.push("src/cross-component.ts");
      slices.push(slice(sliceId, "phase-1", previous ? [previous] : [], writeSet, {
        sharedInterfaces: index < 2 ? [`component-${component}`] : [],
        integrationBoundary: options.boundaryPerComponent ? `boundary-${component}` : "one-boundary",
      }));
      previous = sliceId;
    }
  });
  return approved(slices);
}

describe("phase graph", () => {
  it("derives phase edges, boundaries, overlap safety, advisories, and measurable selection signals", () => {
    const contract = approved(
      [
        slice("1.1", "build", [], ["src/shared.ts"], {
          sharedInterfaces: ["api"],
          integrationBoundary: "storage",
        }),
        slice("2.1", "integrate", ["1.1"], ["src/shared.ts"], {
          sharedInterfaces: ["api"],
          integrationBoundary: "api",
        }),
      ],
      [
        {
          phaseId: "build",
          title: "Build",
          entryCriteria: "Approved.",
          exitCriteria: "Built.",
          dependsOnPhases: [],
          integrationCheckpointCount: 0,
        },
        {
          phaseId: "integrate",
          title: "Integrate",
          entryCriteria: "Built.",
          exitCriteria: "Integrated.",
          dependsOnPhases: ["build"],
          integrationCheckpointCount: 2,
        },
      ],
      [{ from: "1.1", to: "2.1" }],
    );
    const before = structuredClone(contract);
    const graph = buildPhaseGraph(contract);

    expect(contract).toEqual(before);
    expect(Object.isFrozen(graph)).toBe(true);
    expect(graph.phases).toEqual([
      {
        phaseId: "build",
        sliceIds: ["1.1"],
        dependsOnPhases: [],
        integrationBoundaries: ["storage"],
        integrationCheckpointCount: 0,
      },
      {
        phaseId: "integrate",
        sliceIds: ["2.1"],
        dependsOnPhases: ["build"],
        integrationBoundaries: ["api"],
        integrationCheckpointCount: 2,
      },
    ]);
    expect(graph.sliceParallelSafety).toEqual([
      { sliceId: "1.1", parallelSafe: false, conflictsWith: ["2.1"], sharedPaths: ["src/shared.ts"] },
      { sliceId: "2.1", parallelSafe: false, conflictsWith: ["1.1"], sharedPaths: ["src/shared.ts"] },
    ]);
    expect(graph.advisories).toEqual([{
      code: "overlapping_parallel_write_set",
      sliceIds: ["1.1", "2.1"],
      paths: ["src/shared.ts"],
    }]);
    expect(graph.signals).toEqual({
      phaseCount: 2,
      sliceCount: 2,
      dependencyEdgeCount: 1,
      sharedFileOverlapCount: 1,
      integrationCheckpointCount: 2,
    });
  });

  it("proves the inverted path index equals a naive pairwise computation on the same seeded fixture", () => {
    let seed = 0x5eed;
    const random = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed;
    };
    const slices = Array.from({ length: 32 }, (_, index) => {
      const paths = new Set<string>();
      while (paths.size < 3) paths.add(`src/pool-${random() % 13}.ts`);
      return slice(`1.${index + 1}`, "phase-1", index ? [`1.${index}`] : [], [...paths], {
        parallelSafe: index % 3 !== 0,
      });
    });
    const contract = approved(slices);
    const graph = buildPhaseGraph(contract);
    const naive = naiveAdvisories(contract);
    const expectedSharedPathCount = [...new Set(contract.slices.flatMap((entry) => entry.writeSet))]
      .filter((path) => contract.slices.filter((entry) => entry.writeSet.includes(path)).length > 1)
      .length;

    expect(graph.advisories).toEqual(naive);
    expect(graph.sliceParallelSafety).toEqual(naiveParallelSafety(contract));
    expect(graph.signals.sharedFileOverlapCount).toBe(expectedSharedPathCount);
  });

  it("never reports both intersecting slices parallel-safe and leaves contract overlap advisory", () => {
    const contract = approved([
      slice("1.1", "phase-1", [], ["src/shared.ts"]),
      slice("1.2", "phase-1", [], ["src/shared.ts"]),
    ]);
    const parsed = parseApprovedExecutionContract(contract);
    const graph = buildPhaseGraph(contract);

    expect(parsed).toMatchObject({ ok: true, advisories: [{ code: "overlapping_parallel_write_set" }] });
    expect(graph.sliceParallelSafety.filter(({ parallelSafe }) => parallelSafe)).toEqual([]);
  });

  it("does not treat parallel-safe slices sharing an integration boundary as independent", () => {
    const contract = approved([
      slice("1.1", "phase-1", [], ["src/first.ts"], {
        integrationBoundary: "execution handoff",
      }),
      slice("1.2", "phase-1", [], ["src/second.ts"], {
        integrationBoundary: "execution handoff",
      }),
    ]);
    const parsed = parseApprovedExecutionContract(contract);
    const graph = buildPhaseGraph(contract);

    expect(graph.sliceParallelSafety).toEqual([
      { sliceId: "1.1", parallelSafe: false, conflictsWith: ["1.2"], sharedPaths: [] },
      { sliceId: "1.2", parallelSafe: false, conflictsWith: ["1.1"], sharedPaths: [] },
    ]);
    expect(parsed).toMatchObject({
      ok: true,
      advisories: [{
        code: "parallel_safety_conflict",
        sliceIds: ["1.1", "1.2"],
        paths: [],
        integrationBoundaries: ["execution handoff"],
      }],
    });
  });

  it("advises one Sub-Explorer per qualifying component with provisional defaults", () => {
    const advice = adviseSubExplorers(buildPhaseGraph(componentContract(
      [11, 11],
      { boundaryPerComponent: true },
    )));

    expect(advice).toMatchObject({
      advised: true,
      count: 2,
      launchAuthorized: false,
      phases: [{
        phaseId: "phase-1",
        advised: true,
        count: 2,
      }],
    });
  });

  it("does not advise splitting dependency components that share an integration boundary", () => {
    const advice = adviseSubExplorers(buildPhaseGraph(componentContract([11, 11])));

    expect(advice).toMatchObject({
      advised: false,
      count: 0,
      launchAuthorized: false,
      reason: "coupling_not_reduced",
      phases: [{
        phaseId: "phase-1",
        advised: false,
        count: 0,
        reason: "coupling_not_reduced",
        conflictingPaths: [],
      }],
    });
  });

  it("measures coupling independently of parallel-safety claims while preserving disjoint splits", () => {
    for (const parallelSafe of [true, false]) {
      const sharedBoundary = componentContract([11, 11]);
      const contract = approved(sharedBoundary.slices.map((entry) => ({
        ...entry,
        parallelSafe,
      })));

      expect(adviseSubExplorers(buildPhaseGraph(contract))).toMatchObject({
        advised: false,
        count: 0,
        reason: "coupling_not_reduced",
      });
    }

    const disjoint = componentContract([11, 11], { boundaryPerComponent: true });
    const disjointContract = approved(disjoint.slices.map((entry) => ({
      ...entry,
      parallelSafe: false,
    })));

    expect(adviseSubExplorers(buildPhaseGraph(disjointContract))).toMatchObject({
      advised: true,
      count: 2,
    });
  });

  it("F4 regression: fully disjoint components with zero shared interfaces (cross=0,intra=0) are advised as ideal split, not coupling_not_reduced", () => {
    // Use [11,11] for span>max to reach coupling gate; clear shared to force measured {cross:0, intra:0}
    const base = componentContract([11, 11]);
    const contract = approved(base.slices.map((s) => ({
      ...s,
      sharedInterfaces: [] as string[],
      integrationBoundary: `boundary-${s.sliceId}`,
    })));
    const advice = adviseSubExplorers(buildPhaseGraph(contract));
    expect(advice).toMatchObject({ advised: true, count: 2 });
  });

  it("includes small components retained by the parent Explorer in the coupling gate", () => {
    const base = componentContract([11, 11, 1]);
    const retainedSlice = base.slices.length - 1;
    const contract = approved(base.slices.map((entry, index) => index === retainedSlice
      ? {
          ...entry,
          writeSet: Array.from({ length: 11 }, (_, path) => `src/component-0-${path}.ts`),
        }
      : entry));

    expect(adviseSubExplorers(buildPhaseGraph(contract))).toMatchObject({
      advised: false,
      count: 0,
      reason: "coupling_not_reduced",
      phases: [{
        reason: "coupling_not_reduced",
        conflictingPaths: Array.from({ length: 11 }, (_, path) => `src/component-0-${path}.ts`).sort(),
      }],
    });
  });

  it("refuses a fifty-slice single component regardless of span", () => {
    expect(adviseSubExplorers(buildPhaseGraph(componentContract([50])))).toMatchObject({
      advised: false,
      count: 0,
      reason: "single_component",
      launchAuthorized: false,
    });
  });

  it("applies span, coupling, and depth gates in order with typed reasons", () => {
    expect(adviseSubExplorers(buildPhaseGraph(componentContract([5, 5])))).toMatchObject({
      advised: false,
      reason: "below_span_threshold",
    });
    const crossCoupled = componentContract([11, 11], { crossOwners: 4 });
    const isolatedBoundaries = approved(crossCoupled.slices.map((entry) => ({
      ...entry,
      integrationBoundary: `boundary-${entry.sliceId}`,
    })));
    expect(adviseSubExplorers(buildPhaseGraph(isolatedBoundaries))).toMatchObject({
      advised: false,
      reason: "coupling_not_reduced",
      phases: [{ conflictingPaths: ["src/cross-component.ts"] }],
    });
    expect(adviseSubExplorers(
      buildPhaseGraph(componentContract([11, 11], { boundaryPerComponent: true })),
      { currentDepth: MAX_ORCHESTRATION_DEPTH },
    )).toMatchObject({
      advised: false,
      reason: "depth_cap",
    });
  });

  it("F3 regression: depth cap fires at reachable currentDepth (accounting for crew under Sub-Explorer) and boundary permits when safe", () => {
    // With explorer at depth 3 (e.g. under trail-boss), sub+crew reach depth 5 which is <= MAX
    const contract = componentContract([11, 11], { boundaryPerComponent: true });
    const atSafeDepth = adviseSubExplorers(buildPhaseGraph(contract), { currentDepth: 3 });
    expect(atSafeDepth).toMatchObject({ advised: true, count: 2 });
    // At depth 4, crew would reach 6 > MAX; must refuse (previously +1 never fired even at 4 or 5)
    const atDeep = adviseSubExplorers(buildPhaseGraph(contract), { currentDepth: 4 });
    expect(atDeep).toMatchObject({ advised: false, reason: "depth_cap" });
  });
});
