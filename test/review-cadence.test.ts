import { describe, expect, it } from "vitest";
import type { ReviewCadence } from "../src/contracts/execution-contract.js";
import {
  resolveReviewCadence,
  requiredGates,
  CADENCE_TRIGGERS,
  type CadenceTrigger,
  type VerificationGate,
} from "../src/verification/review-cadence.js";

const ALL_CADENCES: ReviewCadence[] = ["per-slice", "per-phase", "completion-only"];
const FORCE_PER_SLICE: CadenceTrigger[] = ["high-risk", "unclear-requirements", "new-architecture", "security-sensitive"];

function strength(c: ReviewCadence): number {
  return c === "per-slice" ? 3 : c === "per-phase" ? 2 : 1;
}

describe("resolveReviewCadence", () => {
  it("respects declared cadence with no triggers", () => {
    expect(resolveReviewCadence({ declared: "per-phase", triggers: [] })).toEqual({
      cadence: "per-phase",
      tightened: false,
      reasons: [],
    });
    expect(resolveReviewCadence({ declared: "completion-only", triggers: [] })).toEqual({
      cadence: "completion-only",
      tightened: false,
      reasons: [],
    });
  });

  it("completion-only survives only when the sole trigger is low-risk-mature-system", () => {
    expect(resolveReviewCadence({ declared: "completion-only", triggers: ["low-risk-mature-system"] })).toEqual({
      cadence: "completion-only",
      tightened: false,
      reasons: [],
    });
    expect(resolveReviewCadence({ declared: "completion-only", triggers: ["substantial-work"] })).toMatchObject({
      cadence: "per-phase",
      tightened: true,
    });
    expect(resolveReviewCadence({ declared: "completion-only", triggers: ["low-risk-mature-system", "substantial-work"] })).toMatchObject({
      cadence: "per-phase",
      tightened: true,
    });
  });

  it("high-risk and similar force per-slice even from weaker declared", () => {
    for (const t of FORCE_PER_SLICE) {
      const r = resolveReviewCadence({ declared: "completion-only", triggers: [t] });
      expect(r.cadence).toBe("per-slice");
      expect(r.tightened).toBe(true);
      expect(r.reasons).toContain(t);
    }
  });

  it("substantial-work forces at least per-phase", () => {
    const r = resolveReviewCadence({ declared: "completion-only", triggers: ["substantial-work"] });
    expect(r.cadence).toBe("per-phase");
    expect(r.tightened).toBe(true);
  });

  it("never loosens a declared per-slice", () => {
    const subsets: CadenceTrigger[][] = [ [], ...CADENCE_TRIGGERS.map(t => [t]), ["high-risk", "substantial-work"] ];
    for (const trigs of subsets) {
      const r = resolveReviewCadence({ declared: "per-slice", triggers: trigs });
      expect(r.cadence).toBe("per-slice");
      expect(r.tightened).toBe(false);
    }
  });

  it("property: monotonic over every declared cadence and every trigger subset", () => {
    const n = CADENCE_TRIGGERS.length;
    for (const declared of ALL_CADENCES) {
      for (let mask = 0; mask < (1 << n); mask++) {
        const triggers: CadenceTrigger[] = [];
        for (let i = 0; i < n; i++) if (mask & (1 << i)) triggers.push(CADENCE_TRIGGERS[i]);
        const r = resolveReviewCadence({ declared, triggers });
        expect(strength(r.cadence)).toBeGreaterThanOrEqual(strength(declared));
        if (strength(r.cadence) > strength(declared)) {
          expect(r.tightened).toBe(true);
          expect(r.reasons.length).toBeGreaterThan(0);
        } else {
          expect(r.tightened).toBe(false);
        }
      }
    }
  });
});

describe("requiredGates", () => {
  it("slice boundary: validator always; park-ranger only under per-slice", () => {
    expect(requiredGates("per-slice", "slice")).toEqual(["validator", "park-ranger"] as const);
    expect(requiredGates("per-phase", "slice")).toEqual(["validator"] as const);
    expect(requiredGates("completion-only", "slice")).toEqual(["validator"] as const);
  });

  it("phase boundary: validator+park-ranger; grader for non-completion", () => {
    expect(requiredGates("per-slice", "phase")).toEqual(["validator", "park-ranger", "grader"] as const);
    expect(requiredGates("per-phase", "phase")).toEqual(["validator", "park-ranger", "grader"] as const);
    expect(requiredGates("completion-only", "phase")).toEqual(["validator", "park-ranger"] as const);
  });

  it("completion: all four regardless of cadence", () => {
    for (const c of ALL_CADENCES) {
      expect(requiredGates(c, "completion")).toEqual(["validator", "park-ranger", "grader", "surveyor"] as const);
    }
  });
});
