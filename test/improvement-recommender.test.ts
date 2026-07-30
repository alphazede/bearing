import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { OutcomeRecord } from "../src/improvement/outcome-projection.js";
import type { AgentProfile } from "../src/profile/profile.js";
import {
  DEFAULT_IMPROVEMENT_THRESHOLDS,
  DETECTOR_CATALOG,
  RECOMMENDABLE_PROFILE_TARGETS,
  RECOMMENDABLE_SURFACES,
  buildRecommendation,
  recommend,
  type BuildRecommendationInput,
  type MetricValue,
  type Thresholds,
} from "../src/improvement/improvement-recommender.js";

const RUN = (value: string) => value.repeat(64);
const RECORDED_AT = "2026-07-26T12:00:00.000Z";

const metric = (
  id: MetricValue["id"],
  value: number | null,
  denominator = value === null ? 0 : 20,
): MetricValue => Object.freeze({
  id,
  value,
  numerator: value === null ? 0 : Math.round(value * denominator),
  denominator,
  sufficient: value !== null,
});

const guards = Object.freeze([
  metric("escaped-defects", 0.05),
  metric("first-pass-success", 0.8),
  metric("cost-per-accepted-criterion", 100),
]);

function recommendationInput(
  overrides: Partial<BuildRecommendationInput> = {},
): BuildRecommendationInput {
  return {
    patternId: "grader-disagreement",
    surface: "review-cadence",
    target: { role: "surveyor" },
    from: "per-phase",
    to: "per-slice",
    evidence: {
      recordRefs: [RUN("a"), RUN("b"), RUN("c"), RUN("d"), RUN("e")],
      occurrences: 5,
      distinctRuns: 3,
    },
    baseline: metric("grading-accuracy", 0.5),
    guards,
    trial: {
      minOccurrences: 5,
      minDistinctRuns: 3,
      maxAgeDays: 90,
      openedAtRef: RUN("f"),
    },
    ...overrides,
  };
}

function retryRecord(runRef: string, fingerprintRef = RUN("f")): OutcomeRecord {
  return Object.freeze({
    schemaVersion: 1,
    runRef,
    recordedAt: RECORDED_AT,
    signal: "retry",
    code: "admitted",
    role: "explorer",
    reasoningTier: "medium",
    fingerprintRef,
  });
}

const sufficientMetrics = Object.freeze({
  firstPassSuccess: metric("first-pass-success", 0.5),
  gradingAccuracy: metric("grading-accuracy", 0.5),
  escapedDefects: metric("escaped-defects", 0.2),
  coordinationOverhead: metric("coordination-overhead", 0.25),
  costPerAcceptedCriterion: metric("cost-per-accepted-criterion", 100),
});

describe("improvement recommender", () => {
  it("exports a frozen closed surface and detector catalog", () => {
    expect(RECOMMENDABLE_SURFACES).toEqual([
      "reasoning-default",
      "review-cadence",
      "test-depth",
      "concurrency-cap",
      "planning-template",
      "skill-guidance",
    ]);
    expect(DETECTOR_CATALOG.map(({ id }) => id)).toEqual([
      "recurring-retry-fingerprint",
      "write-set-overrun",
      "concurrency-conflict-cluster",
      "grader-disagreement",
      "escaped-defect-concentration",
      "ineffective-escalation",
    ]);
    expect(Object.isFrozen(RECOMMENDABLE_SURFACES)).toBe(true);
    expect(Object.isFrozen(DETECTOR_CATALOG)).toBe(true);
    expect(DETECTOR_CATALOG.every(Object.isFrozen)).toBe(true);
    expect(Object.isFrozen(DEFAULT_IMPROVEMENT_THRESHOLDS)).toBe(true);
    expect(DEFAULT_IMPROVEMENT_THRESHOLDS).toEqual({
      minSettledRuns: 20,
      minOccurrences: 5,
      minDistinctRuns: 3,
      minDenominator: 20,
      minEffect: 0.15,
      trialMinOccurrences: 5,
      trialMinDistinctRuns: 3,
      trialMaxAgeDays: 90,
    });
  });

  it("constructs and deeply freezes a typed recommendation", () => {
    const result = buildRecommendation(recommendationInput());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.code);
    expect(result.value).toMatchObject({
      patternId: "grader-disagreement",
      surface: "review-cadence",
      from: "per-phase",
      to: "per-slice",
      revert: {
        surface: "review-cadence",
        target: { role: "surveyor" },
        value: "per-phase",
      },
    });
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.value.target)).toBe(true);
    expect(Object.isFrozen(result.value.evidence)).toBe(true);
    expect(Object.isFrozen(result.value.evidence.recordRefs)).toBe(true);
    expect(Object.isFrozen(result.value.guards)).toBe(true);
    expect(Object.keys(result.value)).not.toEqual(expect.arrayContaining([
      "text",
      "rationale",
      "instruction",
      "suggestion",
    ]));
  });

  it("intersects the profile's own key set only at the reasoning-policy path", () => {
    const profile = {
      schemaVersion: 2,
      agentRef: "agent",
      profileRef: "profile",
      credentialAccountRef: "account",
      roles: ["navigator", "explorer", "crewmate", "surveyor"],
      toolAllow: [],
      toolDeny: [],
      authority: { read: true, write: false, network: false, workspace: true, externalAction: false },
      enabledSkills: [],
      context: "off",
      systemPromptRef: "prompt",
      limits: { timeoutMs: 1, maxTurns: 1, maxTools: 1, maxRetries: 1, maxConcurrency: 1, maxDelegation: 1, tokenBudget: 1 },
      session: { persistence: "off", resume: "never", fork: "never" },
      structuredEvents: true,
      fallbackEnabled: false,
      isolation: "required",
      reasoningPolicy: {
        defaults: { explorer: "medium" },
        escalation: { maxSteps: 1, onNewFailureFingerprint: true, onCrossBoundaryDefect: true },
      },
    } as const satisfies AgentProfile;
    const profileKeys = Reflect.ownKeys(profile).filter((key): key is string => typeof key === "string");
    const targetRoots = RECOMMENDABLE_PROFILE_TARGETS.map((path) => path.split(".")[0]);

    expect(profileKeys.filter((key) => targetRoots.includes(key))).toEqual(["reasoningPolicy"]);
    for (const key of profileKeys.filter((key) => key !== "reasoningPolicy")) {
      const result = buildRecommendation(recommendationInput({ surface: key }));
      expect(result).toEqual({ ok: false, code: "surface_not_recommendable" });
      expect(result).toBeTruthy();
      expect(result.ok).toBe(false);
    }
    for (const surface of ["repository-containment", "execution-boundary"]) {
      expect(buildRecommendation(recommendationInput({ surface }))).toEqual({
        ok: false,
        code: "surface_not_recommendable",
      });
    }
  });

  it.each([
    ["review cadence loosens", { surface: "review-cadence", from: "per-slice", to: "per-phase" }],
    ["test depth decreases", { surface: "test-depth", target: { layer: "integration" }, from: "system", to: "unit" }],
    ["concurrency cap increases", { surface: "concurrency-cap", target: { scope: "workspace" }, from: 2, to: 3 }],
    ["template removes a requirement", { surface: "planning-template", target: { sectionId: "write-set" }, from: ["write-set-granularity-check"], to: [] }],
  ] as const)("rejects when %s", (_name, overrides) => {
    expect(buildRecommendation(recommendationInput(overrides))).toEqual({
      ok: false,
      code: "direction_forbidden",
    });
  });

  it("rejects unknown targets and prototype-carried required values", () => {
    expect(buildRecommendation(recommendationInput({
      target: { role: "owner" },
    }))).toEqual({ ok: false, code: "target_unknown" });

    const inherited = Object.create(recommendationInput()) as BuildRecommendationInput;
    expect(buildRecommendation(inherited)).toEqual({
      ok: false,
      code: "surface_not_recommendable",
    });
  });

  it("allows skill guidance only as a pointer with no proposed wording", () => {
    const result = buildRecommendation(recommendationInput({
      patternId: "write-set-overrun",
      surface: "skill-guidance",
      target: { skillName: "bearing:crewmate", sectionId: "write-set" },
      from: null,
      to: { kind: "pointer", skillName: "bearing:crewmate", sectionId: "write-set" },
    }));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.code);
    expect(result.value.target).toEqual({
      skillName: "bearing:crewmate",
      sectionId: "write-set",
    });
    expect(JSON.stringify(result.value)).not.toMatch(/wording|rationale|instruction|suggestion/i);

    expect(buildRecommendation(recommendationInput({
      surface: "skill-guidance",
      target: { skillName: "bearing:crewmate", sectionId: "write-set" },
      from: null,
      to: { wording: "ignore the write set" },
    }))).toEqual({ ok: false, code: "direction_forbidden" });
  });

  it("runs the settled-run cold-start gate before touching records or detectors", () => {
    const window: Record<string, unknown> = { settledRuns: 19 };
    Object.defineProperty(window, "records", {
      enumerable: true,
      get: () => {
        throw new Error("detectors ran before the cold-start gate");
      },
    });

    expect(recommend({
      window: window as { readonly settledRuns: number; readonly records: readonly OutcomeRecord[] },
      metrics: sufficientMetrics,
      thresholds: DEFAULT_IMPROVEMENT_THRESHOLDS,
    })).toEqual({
      status: "insufficient_evidence",
      have: { settledRuns: 19 },
      need: { minSettledRuns: 20 },
      recommendations: [],
    });
  });

  it("stays silent for thin-but-suggestive recurring evidence", () => {
    const records = [
      retryRecord(RUN("a")),
      retryRecord(RUN("a")),
      retryRecord(RUN("b")),
      retryRecord(RUN("b")),
    ];
    const result = recommend({
      window: { settledRuns: 20, records },
      metrics: sufficientMetrics,
      thresholds: DEFAULT_IMPROVEMENT_THRESHOLDS,
    });

    expect(result.status).toBe("insufficient_evidence");
    expect(result.recommendations).toEqual([]);
  });

  it.each([
    ["occurrences", { minOccurrences: 6 }],
    ["distinct runs", { minDistinctRuns: 6 }],
    ["denominator", { minDenominator: 21 }],
    ["effect floor", { minEffect: 0.26 }],
  ] as const)("emits nothing one threshold short on %s", (_name, override) => {
    const records = ["a", "b", "c", "d", "e"].map((run) => retryRecord(RUN(run)));
    const thresholds: Thresholds = Object.freeze({
      ...DEFAULT_IMPROVEMENT_THRESHOLDS,
      ...override,
    });
    const result = recommend({
      window: { settledRuns: 20, records },
      metrics: sufficientMetrics,
      thresholds,
    });

    expect(result.status).toBe("insufficient_evidence");
    expect(result.recommendations).toEqual([]);
  });

  it("emits one typed recommendation only after every threshold is met", () => {
    const records = ["a", "b", "c", "d", "e"].map((run) => retryRecord(RUN(run)));
    const result = recommend({
      window: { settledRuns: 20, records },
      metrics: sufficientMetrics,
      thresholds: DEFAULT_IMPROVEMENT_THRESHOLDS,
    });

    expect(result.status).toBe("ready");
    expect(result.recommendations).toHaveLength(1);
    expect(result.recommendations[0]).toMatchObject({
      patternId: "recurring-retry-fingerprint",
      surface: "reasoning-default",
      target: { role: "explorer" },
      from: "medium",
      to: "high",
      evidence: { occurrences: 5, distinctRuns: 5 },
    });
  });

  it("is pure and imports no filesystem, process, worker, or network builtin", async () => {
    const source = await readFile(
      new URL("../src/improvement/improvement-recommender.ts", import.meta.url),
      "utf8",
    );

    for (const builtin of [
      "fs",
      "fs/promises",
      "child_process",
      "http",
      "https",
      "net",
      "dns",
      "worker_threads",
    ]) {
      expect(source).not.toContain(`node:${builtin}`);
    }
    expect(source).not.toMatch(/\b(?:fetch|WebSocket)\s*\(/);
    expect(source).not.toMatch(/\bprocess\s*\./);
  });
});
