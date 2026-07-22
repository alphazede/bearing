import { describe, expect, it } from "vitest";
import { BUILTIN_ROUTES } from "../src/adapters/adapters.js";
import { EvaluationRunner, SKILLSBENCH_V1_1_TASK_IDS, type EvaluationCell, type EvaluationSuiteDefinition } from "../src/evaluation/evaluation-runner.js";

const runner = new EvaluationRunner();
const nativeSuite = {
  schemaVersion: 1,
  suiteId: "native-characterization",
  kind: "native",
  version: "1",
  caseIds: ["positive", "negative"],
  arms: { control: "without-skill", treatment: "with-skill" },
} as const satisfies EvaluationSuiteDefinition;
const panelSuite = {
  schemaVersion: 1,
  suiteId: "skillsbench-panel",
  kind: "skillsbench",
  version: "1.1",
  caseIds: SKILLSBENCH_V1_1_TASK_IDS,
  arms: { control: "curated", treatment: "bearing" },
} as const satisfies EvaluationSuiteDefinition;

function matrix(suite: EvaluationSuiteDefinition): EvaluationCell[] {
  return BUILTIN_ROUTES.flatMap((descriptor) => suite.caseIds.flatMap((caseId) => [suite.arms.control, suite.arms.treatment].flatMap((arm) => [1, 2, 3].map((trial) => ({
    suiteId: suite.suiteId,
    caseId,
    arm,
    route: descriptor.id,
    trial: trial as 1 | 2 | 3,
    workspaceId: `${suite.suiteId}:${caseId}:${arm}:${descriptor.id}:${trial}`,
    identity: { requested: descriptor.id, effective: descriptor.id },
    metadata: {
      source: "verified-provider" as const,
      provider: descriptor.provider,
      model: descriptor.model === "*" ? "gpt-5.6-sol" : descriptor.model,
      reasoning: "medium",
      harness: suite.kind === "native" ? "native" : "skillsbench-v1.1",
      isolation: "attested",
    },
    outcome: "passed" as const,
    criticalInvariantPassed: true,
    score: arm === suite.arms.treatment ? 0.7 : 0.5,
  })))));
}

describe("EvaluationRunner", () => {
  it("passes complete native and exact eight-task panel matrices", () => {
    const native = runner.runSuite(nativeSuite, matrix(nativeSuite));
    expect(native.verdict).toBe("passed");
    expect(native.compositeKeys).toHaveLength(2 * 2 * BUILTIN_ROUTES.length * 3);
    expect(native.routes.every(({ verdict, uplift }) => verdict === "passed" && uplift! > 0)).toBe(true);
    expect(native.macro).toEqual({ controlAverage: 0.5, treatmentAverage: 0.7000000000000001, uplift: 0.20000000000000007, passed: true });

    const panel = runner.runSuite(panelSuite, matrix(panelSuite));
    expect(panel.verdict).toBe("passed");
    expect(panel.compositeKeys).toHaveLength(8 * 2 * BUILTIN_ROUTES.length * 3);
    expect(panel.routes.map(({ route }) => route)).toEqual(BUILTIN_ROUTES.map(({ id }) => id));
  });

  it("makes missing, extra, and duplicate cells non-passing", () => {
    const missing = matrix(nativeSuite);
    missing.pop();
    expect(runner.runSuite(nativeSuite, missing).verdict).toBe("incomplete");

    const extra = matrix(nativeSuite);
    extra.push({ ...extra[0], caseId: "unrequested", workspaceId: "extra-workspace" });
    expect(runner.runSuite(nativeSuite, extra).verdict).toBe("incomplete");

    const duplicate = matrix(nativeSuite);
    duplicate.push({ ...duplicate[0], workspaceId: "duplicate-workspace" });
    expect(runner.runSuite(nativeSuite, duplicate).verdict).toBe("incomplete");
  });

  it("does not let another task or route mask a failing route", () => {
    const results = matrix(nativeSuite);
    for (const cell of results) if (cell.route === BUILTIN_ROUTES[0].id && cell.arm === nativeSuite.arms.treatment) (cell as { score: number }).score = 0.4;
    const report = runner.runSuite(nativeSuite, results);
    expect(report.verdict).toBe("failed");
    expect(report.routes[0].verdict).toBe("failed");
    expect(report.routes.slice(1).every(({ verdict }) => verdict === "passed")).toBe(true);
    expect(report.macro.uplift).toBeGreaterThan(0);
    expect(report.macro.passed).toBe(false);
  });

  it("rejects case regression even when route aggregate uplift is positive", () => {
    const results = matrix(nativeSuite);
    for (const cell of results) {
      if (cell.route !== BUILTIN_ROUTES[0].id || cell.arm !== nativeSuite.arms.treatment) continue;
      (cell as { score: number }).score = cell.caseId === "positive" ? 1 : 0.4;
    }
    const route = runner.runSuite(nativeSuite, results).routes[0];
    expect(route.uplift).toBeGreaterThan(0);
    expect(route.noCaseRegression).toBe(false);
    expect(route.verdict).toBe("failed");
  });

  it("fails closed for identity drift and reused workspaces", () => {
    const drift = matrix(nativeSuite);
    drift[0] = { ...drift[0], identity: { ...drift[0].identity, effective: BUILTIN_ROUTES[1].id } };
    expect(runner.runSuite(nativeSuite, drift).verdict).toBe("incomplete");

    const reused = matrix(nativeSuite);
    reused[1] = { ...reused[1], workspaceId: reused[0].workspaceId };
    expect(runner.runSuite(nativeSuite, reused).issues.some((issue) => issue.endsWith("workspace-reused"))).toBe(true);
  });

  it("requires homogeneous metadata across every cell in a route", () => {
    for (const metadata of [
      { model: "gpt-5.6-terra" },
      { reasoning: "high" },
      { source: "synthetic", isolation: "local" },
    ] as const) {
      const results = matrix(nativeSuite);
      results[0] = { ...results[0], metadata: { ...results[0].metadata, ...metadata } };
      const report = runner.runSuite(nativeSuite, results);
      expect(report.verdict).toBe("incomplete");
      expect(report.routes[0].issues.some((issue) => issue.endsWith("metadata-drift"))).toBe(true);
    }
  });

  it("keeps native and SkillsBench arm contracts distinct", () => {
    expect(() => runner.runSuite({ ...nativeSuite, arms: { control: "curated", treatment: "bearing" } }, [])).toThrow(TypeError);
    expect(() => runner.runSuite({ ...panelSuite, arms: { control: "without-skill", treatment: "with-skill" } }, [])).toThrow(TypeError);
    expect(() => runner.runSuite({ ...panelSuite, caseIds: panelSuite.caseIds.slice(1) }, [])).toThrow(TypeError);
    expect(() => runner.runSuite({ ...panelSuite, caseIds: ["substituted-task", ...panelSuite.caseIds.slice(1)] }, [])).toThrow(TypeError);
    const wrongCellArm = matrix(nativeSuite);
    wrongCellArm[0] = { ...wrongCellArm[0], arm: "curated" };
    expect(runner.runSuite(nativeSuite, wrongCellArm).verdict).toBe("incomplete");
  });

  it("rejects malformed scores and failure metadata while retaining valid failures", () => {
    for (const score of [-0.1, 1.1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const results = matrix(nativeSuite) as unknown as Record<string, unknown>[];
      results[0].score = score;
      expect(runner.runSuite(nativeSuite, results).verdict).toBe("incomplete");
    }
    const malformed = matrix(nativeSuite) as unknown as Record<string, unknown>[];
    malformed[0].outcome = "failed";
    malformed[0].failure = { code: "boom" };
    expect(runner.runSuite(nativeSuite, malformed).verdict).toBe("incomplete");

    const failed = matrix(nativeSuite);
    failed[0] = { ...failed[0], outcome: "failed", failure: { code: "assertion", message: "expected output was absent" } };
    const report = runner.runSuite(nativeSuite, failed);
    expect(report.verdict).toBe("failed");
    expect(report.failures).toEqual([{ key: JSON.stringify(["native-characterization", "positive", "without-skill", "codex", 1]), code: "assertion", message: "expected output was absent" }]);

    const extraKey = matrix(nativeSuite) as unknown as Record<string, unknown>[];
    extraKey[0].unexpected = true;
    expect(runner.runSuite(nativeSuite, extraKey).verdict).toBe("incomplete");
  });

  it("labels deterministic local evidence synthetic and fails critical invariants", () => {
    const synthetic = matrix(nativeSuite);
    synthetic.forEach((cell) => {
      (cell.metadata as { source: string }).source = "synthetic";
      (cell.metadata as { isolation: string }).isolation = "local";
    });
    expect(runner.runSuite(nativeSuite, synthetic).results.every(({ metadata }) => metadata.source === "synthetic")).toBe(true);
    synthetic[0] = { ...synthetic[0], criticalInvariantPassed: false };
    expect(runner.runSuite(nativeSuite, synthetic).routes[0].verdict).toBe("failed");
  });

  it("rejects mismatched evidence provenance pairs as malformed", () => {
    for (const metadata of [
      { source: "synthetic", isolation: "attested" },
      { source: "verified-provider", isolation: "local" },
    ] as const) {
      const results = matrix(nativeSuite);
      results[0] = { ...results[0], metadata: { ...results[0].metadata, ...metadata } };
      expect(runner.runSuite(nativeSuite, results).issues).toContain("cell:0:malformed");
    }
  });

  it("returns deeply immutable copied reports", () => {
    const input = matrix(nativeSuite);
    const report = runner.runSuite(nativeSuite, input);
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.suite.arms)).toBe(true);
    expect(Object.isFrozen(report.results[0].metadata)).toBe(true);
    expect(Object.isFrozen(report.routes[0].issues)).toBe(true);
    expect(() => (report.routes as RouteEvaluationVerdict[]).push(report.routes[0])).toThrow();
    (input[0] as { score: number }).score = 0;
    expect(report.results[0].score).toBe(0.5);
  });
});

type RouteEvaluationVerdict = ReturnType<EvaluationRunner["runSuite"]>["routes"][number];
