import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { RouteDescriptor } from "../src/adapters/adapters.js";
import {
  graderVerdict,
  parseGraderReport,
  selectGraderRoute,
  type GraderReport,
} from "../src/verification/grader.js";
import { GRADER_RUBRIC, GRADER_RUBRIC_VERSION } from "../src/verification/grader-rubric.js";

const CONTRACT_HASH = "approved-contract-hash";
const APPROVED_SCOPE_IDS = {
  sliceIds: ["4.3"],
  phaseIds: ["phase-4"],
};

function report(level: 0 | 1 | 2 | 3 | 4 = 4): GraderReport {
  const scores = GRADER_RUBRIC.map(({ id }) => ({
    dimensionId: id,
    level,
    evidence: `evidence for ${id}`,
    confidence: "high" as const,
  }));
  const candidate: GraderReport = {
    schemaVersion: 1,
    rubricVersion: GRADER_RUBRIC_VERSION,
    contractHash: CONTRACT_HASH,
    scope: { kind: "slice", id: "4.3" },
    graderSessionId: "grader-session-1",
    scores,
    deficiencies: [],
    verdict: level === 4 ? "strong" : level === 3 ? "acceptable" : "weak",
  };
  return candidate;
}

function route(id: string, provider: string): RouteDescriptor {
  return {
    id,
    provider,
    model: "*",
    executable: id,
    capabilities: [],
    compatibleFallbacks: [],
    reasoningLevels: ["high"],
  };
}

function inherit(value: Record<string, unknown>, key: string): void {
  const inherited = value[key];
  delete value[key];
  Object.setPrototypeOf(value, { [key]: inherited });
  value.padding = true;
}

describe("grader rubric and arithmetic", () => {
  it("exports a deeply frozen six-dimension rubric with levels zero through four", () => {
    expect(GRADER_RUBRIC_VERSION).toBe(1);
    expect(GRADER_RUBRIC).toHaveLength(6);
    expect(Object.isFrozen(GRADER_RUBRIC)).toBe(true);
    expect(new Set(GRADER_RUBRIC.map(({ id }) => id))).toHaveLength(6);
    expect(GRADER_RUBRIC.reduce((sum, { weight }) => sum + weight, 0)).toBe(100);
    for (const dimension of GRADER_RUBRIC) {
      expect(Object.isFrozen(dimension)).toBe(true);
      expect(Object.isFrozen(dimension.levels)).toBe(true);
      expect(Object.isFrozen(dimension.contractFields)).toBe(true);
      expect(dimension.levels.map(({ level }) => level)).toEqual([0, 1, 2, 3, 4]);
      expect(dimension.levels.every((anchor) => Object.isFrozen(anchor))).toBe(true);
      expect(dimension.contractFields.length).toBeGreaterThan(0);
    }
  });

  it("computes strong, acceptable, and weak verdicts from weighted scores", () => {
    expect(graderVerdict(report(4))).toBe("strong");
    expect(graderVerdict(report(3))).toBe("acceptable");
    expect(graderVerdict(report(2))).toBe("weak");

    const mixed = report(4);
    const scores = mixed.scores.map((score, index) => ({
      ...score,
      level: (index < 2 ? 0 : 4) as 0 | 4,
    }));
    expect(graderVerdict({ ...mixed, scores, verdict: "weak" })).toBe("weak");
  });

  it("accepts a complete report bound to the approved contract hash", () => {
    expect(parseGraderReport(report(), CONTRACT_HASH, APPROVED_SCOPE_IDS)).toEqual({ ok: true, value: report() });
  });

  it.each([
    ["empty", { kind: "slice", id: "" }],
    ["unknown slice", { kind: "slice", id: "missing" }],
    ["unknown phase", { kind: "phase", id: "missing" }],
  ])("rejects an %s approved-contract scope", (_description, scope) => {
    expect(parseGraderReport({ ...report(), scope }, CONTRACT_HASH, APPROVED_SCOPE_IDS)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("rejects an over-limit scope id even if it appears in the supplied membership", () => {
    const id = "s".repeat(4097);

    expect(parseGraderReport(
      { ...report(), scope: { kind: "slice", id } },
      CONTRACT_HASH,
      { ...APPROVED_SCOPE_IDS, sliceIds: [id] },
    )).toEqual({ ok: false, reason: "malformed" });
  });

  it("rejects empty score evidence", () => {
    const candidate = report();
    const scores = candidate.scores.map((score, index) => index === 0
      ? { ...score, evidence: "" }
      : score);

    expect(parseGraderReport({ ...candidate, scores }, CONTRACT_HASH, APPROVED_SCOPE_IDS)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("rejects whitespace-only score evidence", () => {
    const candidate = report();
    const scores = candidate.scores.map((score, index) => index === 0
      ? { ...score, evidence: "   " }
      : score);

    expect(parseGraderReport({ ...candidate, scores }, CONTRACT_HASH, APPROVED_SCOPE_IDS)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("rejects score evidence over the bounded-text limit", () => {
    const candidate = report();
    const scores = candidate.scores.map((score, index) => index === 0
      ? { ...score, evidence: "e".repeat(4097) }
      : score);

    expect(parseGraderReport({ ...candidate, scores }, CONTRACT_HASH, APPROVED_SCOPE_IDS)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it.each([
    ["empty", ""],
    ["whitespace-only", "   "],
    ["over-limit", "s".repeat(4097)],
  ])("rejects an %s deficiency summary", (_description, summary) => {
    const candidate = report();
    const deficiencies = [{
      dimensionId: GRADER_RUBRIC[0].id,
      summary,
      severity: "minor" as const,
    }];

    expect(parseGraderReport({ ...candidate, deficiencies }, CONTRACT_HASH, APPROVED_SCOPE_IDS)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("reads both modules from disk and rejects filesystem or process imports", async () => {
    const sources = await Promise.all([
      readFile(new URL("../src/verification/grader.ts", import.meta.url), "utf8"),
      readFile(new URL("../src/verification/grader-rubric.ts", import.meta.url), "utf8"),
    ]);
    const forbiddenModule = /(?:from\s+|import\s*(?:\(\s*)?)["'](?:node:)?(?:fs(?:\/promises)?|child_process|path)["']/;

    for (const source of sources) expect(source).not.toMatch(forbiddenModule);
  });
});

describe("grader report rejection reasons", () => {
  it("rejects a wrong rubric version with rubric_version_mismatch", () => {
    expect(parseGraderReport({ ...report(), rubricVersion: 2 }, CONTRACT_HASH, APPROVED_SCOPE_IDS)).toEqual({
      ok: false,
      reason: "rubric_version_mismatch",
    });
  });

  it("rejects an approval key with unexpected_key", () => {
    expect(parseGraderReport({ ...report(), approved: true }, CONTRACT_HASH, APPROVED_SCOPE_IDS)).toEqual({
      ok: false,
      reason: "unexpected_key",
    });
  });

  it("rejects a transition key with unexpected_key", () => {
    expect(parseGraderReport({ ...report(), transition: "merge" }, CONTRACT_HASH, APPROVED_SCOPE_IDS)).toEqual({
      ok: false,
      reason: "unexpected_key",
    });
  });

  it("rejects an arbitrary nested extra key with unexpected_key", () => {
    expect(parseGraderReport({ ...report(), scope: { kind: "slice", id: "4.3", merge: true } }, CONTRACT_HASH, APPROVED_SCOPE_IDS)).toEqual({
      ok: false,
      reason: "unexpected_key",
    });
  });

  it("rejects a mismatched contract hash with contract_mismatch", () => {
    expect(parseGraderReport(report(), "another-contract-hash", APPROVED_SCOPE_IDS)).toEqual({
      ok: false,
      reason: "contract_mismatch",
    });
  });

  it("rejects a self-declared verdict that disagrees with the weighted score", () => {
    expect(parseGraderReport({ ...report(4), verdict: "weak" }, CONTRACT_HASH, APPROVED_SCOPE_IDS)).toEqual({
      ok: false,
      reason: "verdict_mismatch",
    });
  });

  it("rejects a prototype-polluted report with prototype_pollution", () => {
    const polluted = { ...report() } as unknown as Record<string, unknown>;
    inherit(polluted, "contractHash");

    expect(parseGraderReport(polluted, CONTRACT_HASH, APPROVED_SCOPE_IDS)).toEqual({
      ok: false,
      reason: "prototype_pollution",
    });
  });
});

describe("grader route selection", () => {
  it("fails closed when high risk has only the implementer provider family", () => {
    expect(selectGraderRoute({
      risk: "high",
      implementerProvider: "codex",
      availableRoutes: [route("codex", "codex")],
    })).toEqual({ ok: false, code: "grader_family_unavailable" });
  });

  it("selects a different provider family for high-risk work", () => {
    const claude = route("claude", "claude");
    expect(selectGraderRoute({
      risk: "high",
      implementerProvider: "codex",
      availableRoutes: [route("codex", "codex"), claude],
    })).toEqual({ ok: true, route: claude, differentFamily: true });
  });

  it("prefers another family at standard risk and falls back to the same family", () => {
    const codex = route("codex", "codex");
    const claude = route("claude", "claude");
    expect(selectGraderRoute({ risk: "standard", implementerProvider: "codex", availableRoutes: [codex, claude] }))
      .toEqual({ ok: true, route: claude, differentFamily: true });
    expect(selectGraderRoute({ risk: "low", implementerProvider: "codex", availableRoutes: [codex] }))
      .toEqual({ ok: true, route: codex, differentFamily: false });
  });

  it("reports route unavailability when no route is injected", () => {
    expect(selectGraderRoute({ risk: "low", implementerProvider: "codex", availableRoutes: [] }))
      .toEqual({ ok: false, code: "grader_route_unavailable" });
  });
});
