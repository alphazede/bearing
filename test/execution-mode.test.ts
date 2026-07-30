import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  EXECUTION_MODES,
  EXECUTION_ORCHESTRATIONS,
  recommendExecutionMode,
  recommendExecutionModeV1,
  recommendExecutionModeV2,
  type ExecutionMode,
  type ModeRecommendationInput,
} from "../src/execution/execution-mode.js";
import {
  DEFAULT_SELECTION_THRESHOLD,
  HARD_TRIGGER_IDS,
  complexityScore,
  type ComplexitySignals,
  type HardTriggerSignals,
  type SelectionSignals,
} from "../src/execution/selection-score.js";

// --- Frozen version-1 fixture ------------------------------------------------
// Captured from the PRE-PHASE-3 code path (the tracked build output, which
// dist-guard proves matched the unmodified src) and committed as data before
// execution-mode.ts was touched. Asserting against a recomputation instead
// would agree with any change by construction and prove nothing.

const WORK_ITEMS = [1, 2, 3, 4, 5, 8, 9, 16, 17, 32, 63, 64];
const CREWMATES = [1, 2, 3, 4, 5, 8, 16];
const TOKENS = [1, 10, 1000, 100_000];
const OVERRIDES: readonly (ExecutionMode | undefined)[] = [undefined, "explorer", "expedition"];

/** sha256 over JSON.stringify([[input, output], ...]) for the 1008-row grid below. */
const V1_GRID_DIGEST = "bbbe7bce2b027c6469628678b6d94385d53c93500c47a3aa5d130413e71df5db";
const V1_GRID_ROWS = 1008;

const V1_SAMPLE: readonly (readonly [ModeRecommendationInput, Readonly<Record<string, unknown>>])[] = [
  [{ workItems: 2, maxCrewmatesPerExplorer: 3, perAgentTokenEstimate: 10 },
    { recommendedMode: "explorer", selectedMode: "explorer", overridden: false, estimatedAgents: 3, estimatedTokens: 30, tradeoffs: { tokens: "lower manager token overhead", coordination: "one Explorer coordinates all Crewmates" }, launchAuthorized: false }],
  [{ workItems: 3, maxCrewmatesPerExplorer: 3, perAgentTokenEstimate: 1000 },
    { recommendedMode: "explorer", selectedMode: "explorer", overridden: false, estimatedAgents: 4, estimatedTokens: 4000, tradeoffs: { tokens: "lower manager token overhead", coordination: "one Explorer coordinates all Crewmates" }, launchAuthorized: false }],
  [{ workItems: 5, maxCrewmatesPerExplorer: 2, perAgentTokenEstimate: 10 },
    { recommendedMode: "expedition", selectedMode: "expedition", overridden: false, estimatedAgents: 9, estimatedTokens: 90, tradeoffs: { tokens: "higher Navigator and Explorer token overhead", coordination: "bounded Explorer groups reduce coordination fan-out" }, launchAuthorized: false }],
  [{ workItems: 64, maxCrewmatesPerExplorer: 16, perAgentTokenEstimate: 100_000 },
    { recommendedMode: "expedition", selectedMode: "expedition", overridden: false, estimatedAgents: 69, estimatedTokens: 6_900_000, tradeoffs: { tokens: "higher Navigator and Explorer token overhead", coordination: "bounded Explorer groups reduce coordination fan-out" }, launchAuthorized: false }],
  [{ workItems: 1, maxCrewmatesPerExplorer: 1, perAgentTokenEstimate: 1 },
    { recommendedMode: "explorer", selectedMode: "explorer", overridden: false, estimatedAgents: 2, estimatedTokens: 2, tradeoffs: { tokens: "lower manager token overhead", coordination: "one Explorer coordinates all Crewmates" }, launchAuthorized: false }],
  [{ workItems: 5, maxCrewmatesPerExplorer: 2, perAgentTokenEstimate: 10, overrideMode: "explorer" },
    { recommendedMode: "expedition", selectedMode: "explorer", overridden: true, estimatedAgents: 6, estimatedTokens: 60, tradeoffs: { tokens: "lower manager token overhead", coordination: "one Explorer coordinates all Crewmates" }, launchAuthorized: false }],
  [{ workItems: 2, maxCrewmatesPerExplorer: 3, perAgentTokenEstimate: 10, overrideMode: "expedition" },
    { recommendedMode: "explorer", selectedMode: "expedition", overridden: true, estimatedAgents: 4, estimatedTokens: 40, tradeoffs: { tokens: "higher Navigator and Explorer token overhead", coordination: "bounded Explorer groups reduce coordination fan-out" }, launchAuthorized: false }],
  [{ workItems: 17, maxCrewmatesPerExplorer: 4, perAgentTokenEstimate: 1000 },
    { recommendedMode: "expedition", selectedMode: "expedition", overridden: false, estimatedAgents: 23, estimatedTokens: 23_000, tradeoffs: { tokens: "higher Navigator and Explorer token overhead", coordination: "bounded Explorer groups reduce coordination fan-out" }, launchAuthorized: false }],
];

function v1Grid(recommend: (input: ModeRecommendationInput) => unknown): readonly (readonly [ModeRecommendationInput, unknown])[] {
  const rows: (readonly [ModeRecommendationInput, unknown])[] = [];
  for (const workItems of WORK_ITEMS) {
    for (const maxCrewmatesPerExplorer of CREWMATES) {
      for (const perAgentTokenEstimate of TOKENS) {
        for (const overrideMode of OVERRIDES) {
          const input: ModeRecommendationInput = overrideMode === undefined
            ? { workItems, maxCrewmatesPerExplorer, perAgentTokenEstimate }
            : { workItems, maxCrewmatesPerExplorer, perAgentTokenEstimate, overrideMode };
          rows.push([input, recommend(input)]);
        }
      }
    }
  }
  return rows;
}

function gridDigest(recommend: (input: ModeRecommendationInput) => unknown): string {
  return createHash("sha256").update(JSON.stringify(v1Grid(recommend))).digest("hex");
}

describe("execution mode vocabulary", () => {
  it("stays exactly the two-member tuple", () => {
    expect([...EXECUTION_MODES]).toEqual(["explorer", "expedition"]);
    expect(EXECUTION_MODES).toHaveLength(2);
    expect([...EXECUTION_MODES]).not.toContain("trail-boss");
  });
});

describe("version 1 is frozen", () => {
  it("reproduces the pre-change fixture digest for every payload in the grid", () => {
    expect(v1Grid(recommendExecutionMode)).toHaveLength(V1_GRID_ROWS);
    expect(gridDigest(recommendExecutionMode)).toBe(V1_GRID_DIGEST);
  });

  it.each(V1_SAMPLE)("reproduces the recorded output for %o", (input, expected) => {
    expect(recommendExecutionMode(input)).toEqual(expected);
  });

  it("rejects invalid inputs exactly as before", () => {
    expect(() => recommendExecutionMode({ workItems: 0, maxCrewmatesPerExplorer: 3, perAgentTokenEstimate: 10 })).toThrow(TypeError);
    expect(() => recommendExecutionMode({ workItems: 2, maxCrewmatesPerExplorer: 0, perAgentTokenEstimate: 10 })).toThrow(TypeError);
    expect(() => recommendExecutionMode({ workItems: 2, maxCrewmatesPerExplorer: 3, perAgentTokenEstimate: 1.5 })).toThrow(TypeError);
    expect(() => recommendExecutionMode({ workItems: 2, maxCrewmatesPerExplorer: 3, perAgentTokenEstimate: 10, overrideMode: "trail-boss" as ExecutionMode })).toThrow(TypeError);
  });

  it("never authorizes a launch", () => {
    for (const [, output] of v1Grid(recommendExecutionMode)) {
      expect((output as { launchAuthorized: unknown }).launchAuthorized).toBe(false);
    }
  });

  it("is the same function the facade delegates to, over the whole grid", () => {
    expect(gridDigest(recommendExecutionModeV1)).toBe(V1_GRID_DIGEST);
    expect(v1Grid(recommendExecutionModeV1)).toEqual(v1Grid(recommendExecutionMode));
  });
});

// --- Version 2 ---------------------------------------------------------------

const ZERO_TRIGGERS: HardTriggerSignals = {
  multiRepository: false,
  securityCriticalIntegration: false,
  dataMigration: false,
  irreversibleOperations: false,
  phaseExplorerCount: 0,
};

const ZERO_COMPLEXITY: ComplexitySignals = {
  phaseCount: 0, sliceCount: 0, dependencyEdgeCount: 0, sharedFileOverlapCount: 0,
  serviceCount: 0, expectedConcurrency: 0, integrationCheckpointCount: 0, riskRating: "low",
};

function signals(overrides: {
  readonly complexity?: Partial<ComplexitySignals>;
  readonly hardTriggers?: Partial<HardTriggerSignals>;
  readonly threshold?: number;
  readonly subExplorerCount?: number;
} = {}): SelectionSignals {
  return {
    algorithmVersion: 2,
    threshold: overrides.threshold ?? DEFAULT_SELECTION_THRESHOLD,
    hardTriggers: { ...ZERO_TRIGGERS, ...overrides.hardTriggers },
    complexity: { ...ZERO_COMPLEXITY, ...overrides.complexity },
    subExplorerCount: overrides.subExplorerCount ?? 0,
  };
}

const BOUNDED: ModeRecommendationInput = { workItems: 2, maxCrewmatesPerExplorer: 3, perAgentTokenEstimate: 10 };
const WIDE: ModeRecommendationInput = { workItems: 5, maxCrewmatesPerExplorer: 2, perAgentTokenEstimate: 10 };

describe("version 2 orchestration selection", () => {
  it("exposes the closed orchestration pair, which is not a mode vocabulary", () => {
    expect([...EXECUTION_ORCHESTRATIONS]).toEqual(["explorer", "trail-boss"]);
    expect([...EXECUTION_MODES]).not.toContain("trail-boss");
  });

  it("keeps the version-1 fan-out rule when nothing recommends a Trail Boss", () => {
    const bounded = recommendExecutionModeV2(BOUNDED, signals());
    expect(bounded).toMatchObject({ recommendedMode: "explorer", recommendedOrchestration: "explorer", complexityScore: 0, firedHardTriggers: [], algorithmVersion: 2 });
    expect(bounded.estimatedAgents).toBe(recommendExecutionModeV1(BOUNDED).estimatedAgents);
    expect(bounded.estimatedTokens).toBe(recommendExecutionModeV1(BOUNDED).estimatedTokens);

    const wide = recommendExecutionModeV2(WIDE, signals());
    expect(wide).toMatchObject({ recommendedMode: "expedition", recommendedOrchestration: "explorer" });
    expect(wide.estimatedAgents).toBe(recommendExecutionModeV1(WIDE).estimatedAgents);
    expect(wide.tradeoffs).toEqual(recommendExecutionModeV1(WIDE).tradeoffs);
  });

  it.each(HARD_TRIGGER_IDS.map((id, index) => [id, [
    { multiRepository: true }, { securityCriticalIntegration: true }, { dataMigration: true },
    { irreversibleOperations: true }, { phaseExplorerCount: 3 },
  ][index] as Partial<HardTriggerSignals>] as const))(
    "recommends Trail Boss on %s alone, at complexity score zero",
    (id, hardTriggers) => {
      const result = recommendExecutionModeV2(BOUNDED, signals({ hardTriggers }));
      expect(result.complexityScore).toBe(0);
      expect(result.firedHardTriggers).toEqual([id]);
      expect(result.recommendedOrchestration).toBe("trail-boss");
      expect(result.recommendedMode).toBe("expedition");
      expect(result.launchAuthorized).toBe(false);
    },
  );

  it("flips at the recorded threshold, not one point below it", () => {
    const below = signals({ complexity: { phaseCount: 5, sliceCount: 21, dependencyEdgeCount: 16 } });
    const at = signals({ complexity: { phaseCount: 5, sliceCount: 21, dependencyEdgeCount: 16, serviceCount: 2 } });
    expect(complexityScore(below)).toBe(DEFAULT_SELECTION_THRESHOLD - 1);
    expect(complexityScore(at)).toBe(DEFAULT_SELECTION_THRESHOLD);
    expect(recommendExecutionModeV2(BOUNDED, below).recommendedOrchestration).toBe("explorer");
    expect(recommendExecutionModeV2(BOUNDED, at).recommendedOrchestration).toBe("trail-boss");
  });

  it("reads the threshold from the recorded signals, never a module default", () => {
    const vector = signals({ complexity: { riskRating: "critical" }, threshold: 4 });
    expect(recommendExecutionModeV2(BOUNDED, vector).recommendedOrchestration).toBe("trail-boss");
    expect(recommendExecutionModeV2(BOUNDED, { ...vector, threshold: 5 }).recommendedOrchestration).toBe("explorer");
  });

  it("keeps a critical risk rating a scored signal, not a sixth hard trigger (OD-3.1)", () => {
    const critical = recommendExecutionModeV2(BOUNDED, signals({ complexity: { riskRating: "critical" } }));
    expect(critical.complexityScore).toBe(4);
    expect(critical.firedHardTriggers).toEqual([]);
    expect(critical.recommendedOrchestration).toBe("explorer");
    expect(critical.recommendedMode).toBe("explorer");
  });

  it("makes the extra layer visible in the agent estimate", () => {
    const result = recommendExecutionModeV2(
      { workItems: 4, maxCrewmatesPerExplorer: 3, perAgentTokenEstimate: 10 },
      signals({ hardTriggers: { dataMigration: true }, subExplorerCount: 2 }),
    );
    // 4 crewmates + ceil(4/3) explorers + 2 sub-explorers + navigator + trail boss.
    expect(result.estimatedAgents).toBe(10);
    expect(result.estimatedTokens).toBe(100);
  });

  it("folds an advisory sub-explorer count in without changing the recommendation", () => {
    const withSubs = recommendExecutionModeV2(WIDE, signals({ subExplorerCount: 3 }));
    const withoutSubs = recommendExecutionModeV2(WIDE, signals());
    expect(withSubs.recommendedMode).toBe(withoutSubs.recommendedMode);
    expect(withSubs.recommendedOrchestration).toBe(withoutSubs.recommendedOrchestration);
    expect(withSubs.estimatedAgents).toBe(withoutSubs.estimatedAgents + 3);
  });

  it("never pairs a Trail Boss with explorer mode and never authorizes a launch", () => {
    for (const workItems of [1, 2, 5, 17, 64]) {
      for (const riskRating of ["low", "medium", "high", "critical"] as const) {
        for (const dataMigration of [false, true]) {
          for (const sliceCount of [0, 9, 21, 51]) {
            const result = recommendExecutionModeV2(
              { workItems, maxCrewmatesPerExplorer: 3, perAgentTokenEstimate: 10 },
              signals({ complexity: { riskRating, sliceCount }, hardTriggers: { dataMigration } }),
            );
            expect(result.launchAuthorized).toBe(false);
            expect(result.algorithmVersion).toBe(2);
            if (result.recommendedOrchestration === "trail-boss") expect(result.recommendedMode).toBe("expedition");
            expect(EXECUTION_MODES).toContain(result.recommendedMode);
          }
        }
      }
    }
  });

  it("still honours an owner override of the recommended mode", () => {
    const overridden = recommendExecutionModeV2({ ...BOUNDED, overrideMode: "expedition" }, signals());
    expect(overridden).toMatchObject({ recommendedMode: "explorer", selectedMode: "expedition", overridden: true, launchAuthorized: false });
  });

  it("F5 regression: V2 sizes explorers/agents and tradeoff text from the same authority (selectedMode, matching V1 override semantics)", () => {
    // 10 items, max=3 -> rec expedition; override explorer -> sel=explorer
    // V1 sizes to 11 agents using sel; V2 must agree (not use rec for size while sel for text)
    const input: ModeRecommendationInput = { workItems: 10, maxCrewmatesPerExplorer: 3, perAgentTokenEstimate: 100, overrideMode: "explorer" };
    const v2 = recommendExecutionModeV2(input, signals({ subExplorerCount: 0 }));
    expect(v2.selectedMode).toBe("explorer");
    expect(v2.recommendedMode).toBe("expedition");
    expect(v2.tradeoffs).toEqual({ tokens: "lower manager token overhead", coordination: "one Explorer coordinates all Crewmates" });
    expect(v2.estimatedAgents).toBe(11);
    expect(v2.estimatedTokens).toBe(1100);
  });

  it("rejects an invalid input or an invalid signal vector", () => {
    expect(() => recommendExecutionModeV2({ workItems: 0, maxCrewmatesPerExplorer: 3, perAgentTokenEstimate: 10 }, signals())).toThrow(TypeError);
    expect(() => recommendExecutionModeV2(BOUNDED, { ...signals(), algorithmVersion: 1 } as unknown as SelectionSignals)).toThrow(TypeError);
    expect(() => recommendExecutionModeV2(BOUNDED, { ...signals(), threshold: 0 } as unknown as SelectionSignals)).toThrow(TypeError);
  });
});
