import { describe, expect, it } from "vitest";
import {
  buildProposal,
  evaluateBoundedTrial,
  evaluateTrial,
  type BoundedTrialOwnerEvidence,
  type MetricSnapshot,
  type OwnerAppliedRecommendation,
  type ProposalRecommendation,
} from "../src/improvement/improvement-proposal.js";

const metric = (
  id: MetricSnapshot["id"],
  value: number | null,
  sufficient = value !== null,
): MetricSnapshot => ({
  id,
  value,
  numerator: value === null ? 0 : Math.round(value * 100),
  denominator: sufficient ? 100 : 0,
  sufficient,
});

function recommendation(overrides: Partial<ProposalRecommendation> = {}): ProposalRecommendation {
  const base: ProposalRecommendation = {
    patternId: "grader-disagreement",
    surface: "review-cadence",
    target: { role: "surveyor" },
    from: "per-phase",
    to: "per-slice",
    evidence: {
      recordRefs: ["record-a", "record-b", "record-c", "record-d", "record-e"],
      occurrences: 5,
      distinctRuns: 3,
    },
    baseline: metric("grading-accuracy", 0.5),
    guards: [
      metric("escaped-defects", 0.1),
      metric("first-pass-success", 0.8),
      metric("cost-per-accepted-criterion", 100),
    ],
    trial: {
      minOccurrences: 5,
      minDistinctRuns: 3,
      maxAgeDays: 90,
      openedAtRef: "checkpoint-a",
    },
    revert: {
      surface: "review-cadence",
      target: { role: "surveyor" },
      value: "per-phase",
    },
  };
  return { ...base, ...overrides };
}

function proposal(overrides: Partial<ProposalRecommendation> = {}) {
  const result = buildProposal(recommendation(overrides));
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.reason);
  return result.value;
}

function cleanCurrentGuards(): readonly MetricSnapshot[] {
  return [
    metric("escaped-defects", 0.09),
    metric("first-pass-success", 0.82),
    metric("cost-per-accepted-criterion", 95),
  ];
}

describe("improvement proposal", () => {
  it("hashes the canonical proposal body and freezes every nested value object", () => {
    const first = proposal();
    const reordered = proposal({
      target: { role: "surveyor" },
      revert: {
        value: "per-phase",
        target: { role: "surveyor" },
        surface: "review-cadence",
      },
      trial: {
        openedAtRef: "checkpoint-a",
        maxAgeDays: 90,
        minDistinctRuns: 3,
        minOccurrences: 5,
      },
    });

    expect(first.proposalHash).toMatch(/^[a-f0-9]{64}$/);
    expect(reordered.proposalHash).toBe(first.proposalHash);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.recommendation)).toBe(true);
    expect(Object.isFrozen(first.recommendation.trial)).toBe(true);
    expect(Object.isFrozen(first.recommendation.revert)).toBe(true);
    expect(Object.isFrozen(first.recommendation.evidence.recordRefs)).toBe(true);
  });

  it.each([
    ["surface", { surface: "test-depth", revert: { surface: "test-depth", target: { role: "surveyor" }, value: "per-phase" } }],
    ["target", { target: { role: "explorer" }, revert: { surface: "review-cadence", target: { role: "explorer" }, value: "per-phase" } }],
    ["prior value", { from: "completion-only", revert: { surface: "review-cadence", target: { role: "surveyor" }, value: "completion-only" } }],
    ["proposed value", { to: "completion-only" }],
  ] as const)("changes the hash when the %s changes", (_name, overrides) => {
    expect(proposal(overrides).proposalHash).not.toBe(proposal().proposalHash);
  });

  it("rejects a revert descriptor that is not the exact prior typed value", () => {
    const result = buildProposal(recommendation({
      revert: {
        surface: "review-cadence",
        target: { role: "surveyor" },
        value: "completion-only",
      },
    }));

    expect(result).toEqual({ ok: false, reason: "revert_mismatch" });
  });

  it("retains an improvement past the effect floor when all guards are clean", () => {
    const result = evaluateTrial({
      proposal: proposal(),
      currentTarget: metric("grading-accuracy", 0.65),
      currentGuards: cleanCurrentGuards(),
      occurrences: 5,
      distinctRuns: 3,
      ageDays: 10,
      minEffect: 0.15,
      noiseFloor: 0.05,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.value).toMatchObject({
      status: "retain",
      prescribedAction: "retain",
      guardRegressions: [],
    });
    expect(result.value.targetImprovement).toBeCloseTo(0.15);
  });

  it.each([
    ["escaped-defects", 0.16],
    ["first-pass-success", 0.74],
    ["cost-per-accepted-criterion", 106],
  ] as const)("forces revert when the %s guard regresses", (guardId, regressedValue) => {
    const currentGuards = cleanCurrentGuards().map((guard) => (
      guard.id === guardId ? metric(guard.id, regressedValue) : guard
    ));
    const result = evaluateTrial({
      proposal: proposal(),
      currentTarget: metric("grading-accuracy", 0.8),
      currentGuards,
      occurrences: 5,
      distinctRuns: 3,
      ageDays: 10,
      minEffect: 0.15,
      noiseFloor: 0.05,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.value.status).toBe("revert");
    expect(result.value.prescribedAction).toBe("revert");
    expect(result.value.guardRegressions).toEqual([guardId]);
  });

  it("returns a truthy typed rejection while an underfilled trial is still open", () => {
    const result = evaluateTrial({
      proposal: proposal(),
      currentTarget: metric("grading-accuracy", 0.8),
      currentGuards: cleanCurrentGuards(),
      occurrences: 4,
      distinctRuns: 2,
      ageDays: 89,
      minEffect: 0.15,
      noiseFloor: 0.05,
    });

    expect(result).toEqual({ ok: false, reason: "window_open" });
    expect(result).toBeTruthy();
  });

  it("marks a closed underfilled window inconclusive and prescribes revert", () => {
    const result = evaluateTrial({
      proposal: proposal(),
      currentTarget: metric("grading-accuracy", 0.8),
      currentGuards: cleanCurrentGuards(),
      occurrences: 4,
      distinctRuns: 2,
      ageDays: 90,
      minEffect: 0.15,
      noiseFloor: 0.05,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.value).toMatchObject({
      status: "inconclusive",
      prescribedAction: "revert",
      occurrences: 4,
      distinctRuns: 2,
      requiredOccurrences: 5,
      requiredDistinctRuns: 3,
    });
  });

  it("fails closed unless every guard metric is present exactly once", () => {
    const result = evaluateTrial({
      proposal: proposal(),
      currentTarget: metric("grading-accuracy", 0.8),
      currentGuards: cleanCurrentGuards().slice(0, 2),
      occurrences: 5,
      distinctRuns: 3,
      ageDays: 10,
      minEffect: 0.15,
      noiseFloor: 0.05,
    });

    expect(result).toEqual({ ok: false, reason: "guard_set_invalid" });
  });

  it("evaluates exactly one owner-bound external application without applying it", () => {
    const existing = proposal();
    const application: OwnerAppliedRecommendation = {
      schemaVersion: 1 as const,
      applicationId: "external-review-cadence-change",
      externalEvidenceHash: "ab".repeat(32),
      proposalHash: existing.proposalHash,
      surface: existing.recommendation.surface,
      target: existing.recommendation.target,
      value: existing.recommendation.to,
    };
    const ownerEvidence: BoundedTrialOwnerEvidence = {
      proposalHash: existing.proposalHash,
      applicationHash: "ab".repeat(32),
    };
    const result = evaluateBoundedTrial({
      proposal: existing,
      applications: [application],
      ownerEvidence,
      currentTarget: metric("grading-accuracy", 0.65),
      currentGuards: cleanCurrentGuards(),
      occurrences: 5,
      distinctRuns: 3,
      ageDays: 10,
      minEffect: 0.15,
      noiseFloor: 0.05,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.value.status).toBe("retain");
  });

  it("rejects mismatched proposal hash or surface-target-value binding in bounded trial", () => {
    const existing = proposal();
    const badEvidence = { proposalHash: "ee".repeat(32), applicationHash: "ff".repeat(32) };
    const res = evaluateBoundedTrial({
      proposal: existing,
      applications: [{ schemaVersion: 1, applicationId: "x", externalEvidenceHash: "ff".repeat(32), proposalHash: existing.proposalHash, surface: existing.recommendation.surface, target: existing.recommendation.target, value: existing.recommendation.to }],
      ownerEvidence: badEvidence,
      currentTarget: metric("grading-accuracy", 0.65),
      currentGuards: cleanCurrentGuards(),
      occurrences: 5,
      distinctRuns: 3,
      ageDays: 10,
      minEffect: 0.15,
      noiseFloor: 0.05,
    });
    expect(res.ok).toBe(false);
  });
});
