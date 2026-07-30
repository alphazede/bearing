import { describe, expect, it } from "vitest";
import {
  METRIC_IDS,
  computeMetrics,
  type MetricInputs,
} from "../src/improvement/improvement-metrics.js";

function inputs(overrides: Partial<MetricInputs> = {}): MetricInputs {
  return {
    coordination: [],
    sliceAttempts: [],
    completedSlices: [],
    tokenReports: [],
    ...overrides,
  };
}

describe("improvement metrics", () => {
  it("computes all five normative numerator and denominator pairs", () => {
    const metrics = computeMetrics(inputs({
      coordination: [
        { estimatedAgents: 8, workItems: 4 },
        { estimatedAgents: 3, workItems: 2 },
      ],
      sliceAttempts: [
        { sliceRef: "slice-a", attempt: 1, status: "complete" },
        { sliceRef: "slice-b", attempt: 1, status: "failed" },
        { sliceRef: "slice-b", attempt: 2, status: "complete" },
        { sliceRef: "slice-c", attempt: 1, status: "failed" },
      ],
      grading: [
        { sliceRef: "slice-a", verdict: "fail", groundTruth: "fail" },
        { sliceRef: "slice-b", verdict: "pass", groundTruth: "pass" },
        { sliceRef: "slice-c", verdict: "pass", groundTruth: "fail" },
        { sliceRef: "slice-d", verdict: "fail", groundTruth: "pass" },
        { sliceRef: "slice-unresolved", verdict: "fail" },
      ],
      completedSlices: [
        { sliceRef: "slice-a", sequence: 10, requirementRefs: ["AC-1", "AC-2"] },
        { sliceRef: "slice-b", sequence: 20, requirementRefs: ["AC-3"] },
      ],
      confirmedFindings: [
        { sliceRef: "slice-a", sequence: 11 },
        { sliceRef: "slice-a", sequence: 9 },
        { sliceRef: "slice-c", sequence: 30 },
      ],
      tokenReports: [{ tokens: 120 }, { tokens: 30 }],
    }));

    expect(metrics.coordinationOverhead).toEqual({
      id: "coordination-overhead",
      numerator: 5,
      denominator: 11,
      sufficient: true,
      value: 5 / 11,
    });
    expect(metrics.firstPassSuccess).toEqual({
      id: "first-pass-success",
      numerator: 1,
      denominator: 3,
      sufficient: true,
      value: 1 / 3,
    });
    expect(metrics.gradingAccuracy).toEqual({
      id: "grading-accuracy",
      numerator: 2,
      denominator: 4,
      sufficient: true,
      value: 0.5,
      confusion: {
        truePositive: 1,
        trueNegative: 1,
        falsePositive: 1,
        falseNegative: 1,
      },
    });
    expect(metrics.escapedDefects).toEqual({
      id: "escaped-defects",
      numerator: 1,
      denominator: 3,
      sufficient: true,
      value: 1 / 3,
    });
    expect(metrics.costPerAcceptedCriterion).toEqual({
      id: "cost-per-accepted-criterion",
      numerator: 150,
      denominator: 3,
      sufficient: true,
      value: 50,
    });
    expect(Object.isFrozen(metrics)).toBe(true);
    expect(Object.values(metrics).every(Object.isFrozen)).toBe(true);
    expect(Object.isFrozen(metrics.gradingAccuracy.confusion)).toBe(true);
  });

  it("reports absent signal families as insufficient and never divides by zero", () => {
    const metrics = computeMetrics(inputs({
      completedSlices: [
        { sliceRef: "slice-a", sequence: 1, requirementRefs: ["AC-1"] },
      ],
      tokenReports: [{ tokens: 10 }],
    }));

    expect(METRIC_IDS).toEqual([
      "coordination-overhead",
      "first-pass-success",
      "grading-accuracy",
      "escaped-defects",
      "cost-per-accepted-criterion",
    ]);
    for (const metric of [
      metrics.coordinationOverhead,
      metrics.firstPassSuccess,
      metrics.gradingAccuracy,
      metrics.escapedDefects,
    ]) {
      expect(metric).toMatchObject({
        value: null,
        numerator: 0,
        sufficient: false,
      });
      expect(Number.isNaN(metric.value)).toBe(false);
    }
    expect(metrics.gradingAccuracy.confusion).toEqual({
      truePositive: 0,
      trueNegative: 0,
      falsePositive: 0,
      falseNegative: 0,
    });
    expect(metrics.escapedDefects.denominator).toBe(1);
    expect(metrics.costPerAcceptedCriterion).toMatchObject({
      value: 10,
      numerator: 10,
      denominator: 1,
      sufficient: true,
    });
  });

  it("counts accepted criteria once per completed slice and only later confirmed findings as escaped", () => {
    const metrics = computeMetrics(inputs({
      completedSlices: [
        { sliceRef: "slice-a", sequence: 10, requirementRefs: ["AC-1", "AC-1", "AC-2"] },
        { sliceRef: "slice-a", sequence: 12, requirementRefs: ["AC-1", "AC-2"] },
      ],
      confirmedFindings: [
        { sliceRef: "slice-a", sequence: 9 },
        { sliceRef: "slice-a", sequence: 11 },
      ],
      tokenReports: [{ tokens: 20 }],
    }));

    expect(metrics.escapedDefects).toMatchObject({ numerator: 1, denominator: 2, value: 0.5 });
    expect(metrics.costPerAcceptedCriterion).toMatchObject({ numerator: 20, denominator: 2, value: 10 });
  });

  it("requires an own resolved ground-truth signal instead of accepting a prototype-carried value", () => {
    const inherited = Object.assign(
      Object.create({ groundTruth: "fail" }) as Record<string, unknown>,
      { sliceRef: "slice-a", verdict: "fail" },
    ) as unknown as NonNullable<MetricInputs["grading"]>[number];

    const metric = computeMetrics(inputs({ grading: [inherited] })).gradingAccuracy;

    expect(metric).toMatchObject({
      value: null,
      numerator: 0,
      denominator: 0,
      sufficient: false,
    });
  });
});
