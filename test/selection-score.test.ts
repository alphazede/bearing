import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SELECTION_THRESHOLD,
  HARD_TRIGGER_IDS,
  MAX_COMPLEXITY_SCORE,
  MIN_PHASE_EXPLORERS,
  RISK_RATINGS,
  SELECTION_WEIGHTS_V2,
  complexityScore,
  firedHardTriggers,
  isSelectionSignals,
  type ComplexitySignals,
  type HardTriggerSignals,
  type RiskRating,
  type SelectionSignals,
} from "../src/execution/selection-score.js";

const ZERO_TRIGGERS: HardTriggerSignals = {
  multiRepository: false,
  securityCriticalIntegration: false,
  dataMigration: false,
  irreversibleOperations: false,
  phaseExplorerCount: 0,
};

const ZERO_COMPLEXITY: ComplexitySignals = {
  phaseCount: 0,
  sliceCount: 0,
  dependencyEdgeCount: 0,
  sharedFileOverlapCount: 0,
  serviceCount: 0,
  expectedConcurrency: 0,
  integrationCheckpointCount: 0,
  riskRating: "low",
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

// design.md §3.4, cell by cell. Every row is `[signal, value, expected points]`
// scored through `complexityScore` against an otherwise-zero vector, so a moved
// band boundary fails here rather than being restated by the test.
const BAND_CELLS: readonly (readonly [keyof ComplexitySignals, number, number])[] = [
  ["phaseCount", 0, 0], ["phaseCount", 1, 0], ["phaseCount", 2, 1], ["phaseCount", 3, 2], ["phaseCount", 4, 2], ["phaseCount", 5, 3], ["phaseCount", 6, 3],
  ["sliceCount", 0, 0], ["sliceCount", 8, 0], ["sliceCount", 9, 1], ["sliceCount", 20, 1], ["sliceCount", 21, 2], ["sliceCount", 50, 2], ["sliceCount", 51, 3], ["sliceCount", 52, 3],
  ["dependencyEdgeCount", 0, 0], ["dependencyEdgeCount", 4, 0], ["dependencyEdgeCount", 5, 1], ["dependencyEdgeCount", 15, 1], ["dependencyEdgeCount", 16, 2], ["dependencyEdgeCount", 40, 2], ["dependencyEdgeCount", 41, 3], ["dependencyEdgeCount", 42, 3],
  ["sharedFileOverlapCount", 0, 0], ["sharedFileOverlapCount", 1, 2], ["sharedFileOverlapCount", 2, 2], ["sharedFileOverlapCount", 3, 2], ["sharedFileOverlapCount", 4, 3], ["sharedFileOverlapCount", 5, 3],
  ["serviceCount", 0, 0], ["serviceCount", 1, 0], ["serviceCount", 2, 1], ["serviceCount", 3, 2], ["serviceCount", 4, 2], ["serviceCount", 5, 3], ["serviceCount", 6, 3],
  ["expectedConcurrency", 0, 0], ["expectedConcurrency", 2, 0], ["expectedConcurrency", 3, 1], ["expectedConcurrency", 4, 1], ["expectedConcurrency", 5, 2], ["expectedConcurrency", 8, 2], ["expectedConcurrency", 9, 3], ["expectedConcurrency", 10, 3],
  ["integrationCheckpointCount", 0, 0], ["integrationCheckpointCount", 1, 1], ["integrationCheckpointCount", 2, 1], ["integrationCheckpointCount", 3, 2], ["integrationCheckpointCount", 5, 2], ["integrationCheckpointCount", 6, 3], ["integrationCheckpointCount", 7, 3],
];

const RISK_CELLS: readonly (readonly [RiskRating, number])[] = [["low", 0], ["medium", 1], ["high", 3], ["critical", 4]];

describe("complexity band table (design §3.4)", () => {
  it.each(BAND_CELLS)("%s = %i scores %i", (signal, value, expected) => {
    expect(complexityScore(signals({ complexity: { [signal]: value } }))).toBe(expected);
  });

  it.each(RISK_CELLS)("riskRating %s scores %i", (riskRating, expected) => {
    expect(complexityScore(signals({ complexity: { riskRating } }))).toBe(expected);
  });

  it("covers every banded signal and every risk rating in the shipped table", () => {
    const bandedCells = new Set(BAND_CELLS.map(([signal]) => signal));
    expect([...bandedCells].sort()).toEqual(Object.keys(SELECTION_WEIGHTS_V2.bands).sort());
    expect(RISK_CELLS.map(([rating]) => rating)).toEqual([...RISK_RATINGS]);
  });

  it("scores an all-zero vector at zero and a saturated vector at the table maximum", () => {
    expect(complexityScore(signals())).toBe(0);
    const saturated = Object.fromEntries(
      Object.keys(SELECTION_WEIGHTS_V2.bands).map((signal) => [signal, Number.MAX_SAFE_INTEGER]),
    ) as Partial<ComplexitySignals>;
    expect(complexityScore(signals({ complexity: { ...saturated, riskRating: "critical" } }))).toBe(MAX_COMPLEXITY_SCORE);
    expect(MAX_COMPLEXITY_SCORE).toBe(25);
  });

  it("saturates out of range in both directions rather than growing", () => {
    const top = signals({ complexity: { sliceCount: 51 } });
    const beyond = signals({ complexity: { sliceCount: Number.MAX_SAFE_INTEGER } });
    expect(complexityScore(beyond)).toBe(complexityScore(top));
    const bottom = signals({ complexity: { sliceCount: 0 } });
    const alsoBottom = signals({ complexity: { sliceCount: 8 } });
    expect(complexityScore(bottom)).toBe(0);
    expect(complexityScore(alsoBottom)).toBe(0);
    expect(() => complexityScore(signals({ complexity: { sliceCount: -1 } }))).toThrow(TypeError);
    expect(() => complexityScore(signals({ complexity: { sliceCount: 1.5 } }))).toThrow(TypeError);
  });

  it("scores the design §3.4 worked example at 17", () => {
    // UC-2: four phases (2), fifty slices (2), three services (2), high risk (3);
    // completed with the dependency, overlap, concurrency and checkpoint values a
    // plan that size carries: 45 edges (3), 6 overlapping paths (3), concurrency 4
    // (1), 2 integration checkpoints (1).
    const worked = signals({
      complexity: {
        phaseCount: 4, sliceCount: 50, dependencyEdgeCount: 45, sharedFileOverlapCount: 6,
        serviceCount: 3, expectedConcurrency: 4, integrationCheckpointCount: 2, riskRating: "high",
      },
    });
    expect(complexityScore(worked)).toBe(17);
    expect(firedHardTriggers(worked)).toEqual([]);
    expect(complexityScore(worked)).toBeGreaterThanOrEqual(worked.threshold);
  });

  it("keeps riskRating a scored signal: critical alone scores 4 and stays below the threshold (OD-3.1)", () => {
    const critical = signals({ complexity: { riskRating: "critical" } });
    expect(complexityScore(critical)).toBe(4);
    expect(firedHardTriggers(critical)).toEqual([]);
    expect(DEFAULT_SELECTION_THRESHOLD).toBe(8);
    expect(complexityScore(critical)).toBeLessThan(DEFAULT_SELECTION_THRESHOLD);
  });

  it("is deterministic and reads no clock or randomness", () => {
    const vector = signals({ complexity: { phaseCount: 3, sliceCount: 22, riskRating: "high" } });
    const now = vi.spyOn(Date, "now");
    const random = vi.spyOn(Math, "random");
    try {
      expect(complexityScore(vector)).toBe(complexityScore(vector));
      expect(now).not.toHaveBeenCalled();
      expect(random).not.toHaveBeenCalled();
    } finally {
      now.mockRestore();
      random.mockRestore();
    }
  });
});

describe("hard triggers (design §3.3)", () => {
  const ALONE: readonly (readonly [string, Partial<HardTriggerSignals>])[] = [
    ["multi_repository", { multiRepository: true }],
    ["security_critical_integration", { securityCriticalIntegration: true }],
    ["data_migration", { dataMigration: true }],
    ["irreversible_operations", { irreversibleOperations: true }],
    ["three_or_more_phase_explorers", { phaseExplorerCount: MIN_PHASE_EXPLORERS }],
  ];

  it.each(ALONE)("%s fires alone at a complexity score of zero", (id, hardTriggers) => {
    const vector = signals({ hardTriggers });
    expect(complexityScore(vector)).toBe(0);
    expect(firedHardTriggers(vector)).toEqual([id]);
  });

  it("exposes exactly the five triggers of design §3.3", () => {
    expect(HARD_TRIGGER_IDS).toEqual(ALONE.map(([id]) => id));
    expect(HARD_TRIGGER_IDS).toHaveLength(5);
  });

  it("emits fired triggers in declaration order, not sorted", () => {
    const all = signals({
      hardTriggers: {
        multiRepository: true, securityCriticalIntegration: true, dataMigration: true,
        irreversibleOperations: true, phaseExplorerCount: MIN_PHASE_EXPLORERS,
      },
    });
    expect(firedHardTriggers(all)).toEqual([...HARD_TRIGGER_IDS]);
    expect([...HARD_TRIGGER_IDS]).not.toEqual([...HARD_TRIGGER_IDS].sort());
  });

  it("fires the explorer-count trigger only at or above the minimum", () => {
    expect(MIN_PHASE_EXPLORERS).toBe(3);
    expect(firedHardTriggers(signals({ hardTriggers: { phaseExplorerCount: MIN_PHASE_EXPLORERS - 1 } }))).toEqual([]);
    expect(firedHardTriggers(signals({ hardTriggers: { phaseExplorerCount: MIN_PHASE_EXPLORERS + 40 } }))).toEqual(["three_or_more_phase_explorers"]);
  });

  it("fires no trigger for an empty signal vector", () => {
    expect(firedHardTriggers(signals())).toEqual([]);
  });
});

describe("selection signal guard", () => {
  it("accepts a well-formed vector", () => {
    expect(isSelectionSignals(signals())).toBe(true);
  });

  it.each([
    ["a non-object", 7],
    ["an array", []],
    ["a missing member", { ...signals(), subExplorerCount: undefined }],
    ["an unknown key", { ...signals(), extra: 1 }],
    ["a wrong algorithm version", { ...signals(), algorithmVersion: 1 }],
    ["a zero threshold", { ...signals(), threshold: 0 }],
    ["a negative sub-explorer count", { ...signals(), subExplorerCount: -1 }],
    ["a partial trigger group", { ...signals(), hardTriggers: { multiRepository: true } }],
    ["a non-boolean trigger", { ...signals(), hardTriggers: { ...ZERO_TRIGGERS, dataMigration: "yes" } }],
    ["a partial complexity group", { ...signals(), complexity: { riskRating: "low" } }],
    ["an unknown risk rating", { ...signals(), complexity: { ...ZERO_COMPLEXITY, riskRating: "extreme" } }],
    ["a fractional signal", { ...signals(), complexity: { ...ZERO_COMPLEXITY, phaseCount: 1.5 } }],
    ["an unsafe integer", { ...signals(), complexity: { ...ZERO_COMPLEXITY, sliceCount: Number.MAX_SAFE_INTEGER + 2 } }],
  ])("rejects %s", (_label, value) => {
    expect(isSelectionSignals(value)).toBe(false);
  });

  it("throws rather than scoring an invalid vector", () => {
    expect(() => complexityScore({ ...signals(), algorithmVersion: 1 } as unknown as SelectionSignals)).toThrow(TypeError);
    expect(() => firedHardTriggers({ ...signals(), threshold: -1 } as unknown as SelectionSignals)).toThrow(TypeError);
  });
});
