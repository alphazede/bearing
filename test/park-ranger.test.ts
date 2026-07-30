import { readFile } from "node:fs/promises";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { RouteDescriptor } from "../src/adapters/adapters.js";
import {
  adjudicateClaim,
  clampPriority,
  parseParkRangerReport,
  selectParkRangerRoute,
  synthesizeFindings,
  type LensId,
  type LensReport,
  type ParkRangerFinding,
  type ParkRangerReport,
  type Question,
} from "../src/verification/park-ranger.js";
import type { ValidatorReport } from "../src/verification/validator.js";

const PASSING_VALIDATOR: ValidatorReport = { verdict: "PASS", reasons: [], escalation: "none" };

function finding(overrides: Partial<ParkRangerFinding> = {}): ParkRangerFinding {
  return {
    id: "bounds-check",
    priority: "P1",
    summary: "The bounds check accepts an invalid index",
    location: { path: "src/index.ts", line: 12 },
    reproduction: {
      inputs: "index=-1",
      observedFailure: "The invalid index is accepted",
      commandId: "CMD-TEST-RANGER",
    },
    reachability: {
      entryPoint: "validateIndex",
      trustBoundary: "untrusted-input",
      path: ["validateIndex", "readItem"],
    },
    lens: "correctness",
    confirmedBy: ["correctness"],
    ...overrides,
  };
}

function report(
  lens: LensId = "correctness",
  findings: readonly ParkRangerFinding[] = [finding({ lens, confirmedBy: [lens] })],
): ParkRangerReport {
  return {
    lens,
    sessionId: `${lens}-session`,
    findings,
    questions: [],
    adjudications: [],
  };
}

function lensReport(
  lens: LensId,
  findings: readonly ParkRangerFinding[],
  questions: readonly Question[] = [],
): LensReport {
  return { lens, sessionId: `${lens}-session`, findings, questions };
}

function inherit(value: Record<string, unknown>, key: string): void {
  const inherited = value[key];
  delete value[key];
  Object.setPrototypeOf(value, { [key]: inherited });
  value.padding = true;
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

describe("Park Ranger report contract", () => {
  it("reads the module from disk and rejects filesystem or process imports", async () => {
    const source = await readFile(new URL("../src/verification/park-ranger.ts", import.meta.url), "utf8");
    const forbiddenModule = /(?:from\s+|import\s*(?:\(\s*)?)["'](?:node:)?(?:fs(?:\/promises)?|child_process|path)["']/;

    expect(source).not.toMatch(forbiddenModule);
  });

  it("rejects an empty observed failure with finding_unreproduced", () => {
    const candidate = report("correctness", [finding({
      reproduction: { inputs: "index=-1", observedFailure: "" },
    })]);

    expect(parseParkRangerReport(candidate)).toEqual({ ok: false, reason: "finding_unreproduced" });
  });

  it("rejects empty reproduction inputs with finding_unreproduced", () => {
    const candidate = report("correctness", [finding({
      reproduction: { inputs: "", observedFailure: "The invalid index is accepted" },
    })]);

    expect(parseParkRangerReport(candidate)).toEqual({ ok: false, reason: "finding_unreproduced" });
  });

  it("keeps unreproduced suspicions non-promotable in questions", () => {
    expectTypeOf<Question>().not.toHaveProperty("priority");
    const suspicion = {
      id: "possible-race",
      summary: "Could race under concurrent access",
      location: { path: "src/cache.ts", line: 30 },
      lens: "correctness",
    } satisfies Question;
    const accepted = { ...report("correctness", []), questions: [suspicion] };
    expect(parseParkRangerReport(accepted)).toEqual({ ok: true, value: accepted });

    const promoted = { ...accepted, questions: [{ ...suspicion, priority: "P0" }] };
    expect(parseParkRangerReport(promoted)).toEqual({ ok: false, reason: "unexpected_key" });
  });

  it("rejects an inbound claim missing from adjudications", () => {
    const claim = { text: "Slice 4.4 is merge-ready", sliceIds: ["4.4"] };

    expect(parseParkRangerReport(report(), [claim])).toEqual({ ok: false, reason: "claim_unadjudicated" });
  });

  it("rejects an empty reachability path", () => {
    const candidate = report("correctness", [finding({
      reachability: { entryPoint: "validateIndex", trustBoundary: "untrusted-input", path: [] },
    })]);

    expect(parseParkRangerReport(candidate)).toEqual({ ok: false, reason: "finding_unreachable" });
  });

  it("accepts a constructed tautological assertion as a reproduced test-strength finding", () => {
    const tautologicalSource = "expect(true).toBe(true)";
    const candidate = finding({
      id: "test-restates-literal",
      priority: "P2",
      summary: "The assertion restates its own literal",
      reproduction: {
        inputs: tautologicalSource,
        observedFailure: "The test passes without measuring a product artifact",
      },
      lens: "test-strength",
      confirmedBy: ["test-strength"],
      testStrength: "tautological_assertion",
    });
    const parsed = parseParkRangerReport(report("test-strength", [candidate]));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(parsed.value.findings[0]).toMatchObject({
      testStrength: "tautological_assertion",
      reproduction: { inputs: tautologicalSource },
    });
  });

  it("exposes all three test-strength codes through the finding contract", () => {
    const codes: ParkRangerFinding["testStrength"][] = [
      "tautological_assertion",
      "missing_negative_case",
      "failure_path_uncovered",
    ];
    const parsed = codes.map((testStrength, index) => parseParkRangerReport(report("test-strength", [finding({
      id: `strength-${index}`,
      lens: "test-strength",
      confirmedBy: ["test-strength"],
      testStrength,
    })])));

    expect(parsed.every(({ ok }) => ok)).toBe(true);
    expect(parsed.map((result) => result.ok ? result.value.findings[0]?.testStrength : undefined)).toEqual(codes);
  });

  it("carries the regression risk a repair would most likely break", () => {
    const parsed = parseParkRangerReport(report("correctness", [finding({
      id: "regression-risk-carried",
      lens: "correctness",
      confirmedBy: ["correctness"],
      regressionRisk: {
        behavior: "A rejected creating POST leaves no journey state the next request can reuse",
        verifiedBy: "CMD-UNIT",
      },
    })]));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(parsed.value.findings[0]?.regressionRisk).toEqual({
      behavior: "A rejected creating POST leaves no journey state the next request can reuse",
      verifiedBy: "CMD-UNIT",
    });
  });

  it("rejects a regression risk that is empty or carries an unexpected key", () => {
    const empty = parseParkRangerReport(report("correctness", [finding({
      id: "regression-risk-empty",
      lens: "correctness",
      confirmedBy: ["correctness"],
      regressionRisk: { behavior: "", verifiedBy: "CMD-UNIT" },
    } as unknown as ParkRangerFinding)]));
    const extra = parseParkRangerReport(report("correctness", [finding({
      id: "regression-risk-extra",
      lens: "correctness",
      confirmedBy: ["correctness"],
      regressionRisk: { behavior: "still works", verifiedBy: "CMD-UNIT", severity: "high" },
    } as unknown as ParkRangerFinding)]));

    expect(empty.ok).toBe(false);
    expect(extra.ok).toBe(false);
  });

  it("rejects a prototype-polluted report", () => {
    const polluted = { ...report() } as unknown as Record<string, unknown>;
    inherit(polluted, "sessionId");

    expect(parseParkRangerReport(polluted)).toEqual({ ok: false, reason: "prototype_pollution" });
  });

  it("accepts repeated non-cyclic references while still rejecting a true cycle", () => {
    const sharedLocation = { path: "src/index.ts", line: 12 };
    const candidate = report("correctness", [
      finding({ id: "bounds-check-negative", location: sharedLocation }),
      finding({ id: "bounds-check-upper", location: sharedLocation }),
    ]);
    const cyclic = { ...report() } as unknown as Record<string, unknown>;
    cyclic.self = cyclic;

    expect(parseParkRangerReport(candidate)).toEqual({ ok: true, value: candidate });
    expect(parseParkRangerReport(cyclic)).toEqual({ ok: false, reason: "prototype_pollution" });
  });

  it("rejects excessive object nesting with a typed failure instead of throwing", () => {
    let candidate: Record<string, unknown> = {};
    for (let depth = 0; depth < 20_000; depth += 1) candidate = { nested: candidate };

    expect(parseParkRangerReport(candidate)).toEqual({ ok: false, reason: "malformed" });
  });
});

describe("reachability and claim adjudication", () => {
  it("clamps every trust-boundary severity ceiling", () => {
    expect(["P0", "P1", "P2", "P3"].map((priority) => clampPriority(priority as ParkRangerFinding["priority"], "untrusted-input")))
      .toEqual(["P0", "P1", "P2", "P3"]);
    expect(["P0", "P1", "P2", "P3"].map((priority) => clampPriority(priority as ParkRangerFinding["priority"], "in-process")))
      .toEqual(["P1", "P1", "P2", "P3"]);
    expect(["P0", "P1", "P2", "P3"].map((priority) => clampPriority(priority as ParkRangerFinding["priority"], "local-only")))
      .toEqual(["P2", "P2", "P2", "P3"]);
  });

  it("makes a merge-ready claim unsupported for an open P1 despite a passing validator", () => {
    expect(adjudicateClaim({
      claim: { text: "Slice 4.4 is merge-ready", sliceIds: ["4.4"] },
      validator: PASSING_VALIDATOR,
      validatedSliceIds: ["4.4"],
      findings: [finding({ priority: "P1" })],
    })).toEqual({ verdict: "unsupported", reasons: ["open_p1_finding"] });
  });

  it("makes any inbound readiness claim unsupported for an open P0 regardless of wording", () => {
    expect(adjudicateClaim({
      claim: { text: "Slice 1 is complete and safe to ship", sliceIds: ["1"] },
      validator: PASSING_VALIDATOR,
      validatedSliceIds: ["1"],
      findings: [finding({ priority: "P0" })],
    })).toEqual({ verdict: "unsupported", reasons: ["open_p0_finding"] });
  });

  it("does not support a claim for a slice outside the validator scope", () => {
    expect(adjudicateClaim({
      claim: { text: "Slice missing is merge-ready", sliceIds: ["missing"] },
      validator: PASSING_VALIDATOR,
      validatedSliceIds: ["4.4"],
      findings: [],
    })).toEqual({ verdict: "unsupported", reasons: ["claim_scope_unvalidated"] });
  });
});

describe("ensemble synthesis", () => {
  it("demotes a single-lens candidate P0 to P1 and records why", () => {
    const result = synthesizeFindings([
      lensReport("security", [finding({
        id: "unsafe-lookup",
        priority: "P0",
        lens: "security",
        confirmedBy: ["security"],
      })]),
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.findings).toHaveLength(1);
    expect(result.value.findings[0]).toMatchObject({
      priority: "P1",
      confirmedBy: ["security"],
      reasons: ["p0_requires_two_confirming_lenses"],
    });
    expect(result.value.verdict).toBe("repair-required");
  });

  it("does not let a single lens self-assert a second P0 confirmation", () => {
    const result = synthesizeFindings([
      lensReport("correctness", [finding({
        priority: "P0",
        confirmedBy: ["correctness", "security"],
      })]),
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.findings[0]).toMatchObject({
      priority: "P1",
      confirmedBy: ["correctness"],
      reasons: ["p0_requires_two_confirming_lenses"],
    });
    expect(result.value.verdict).toBe("repair-required");
  });

  it("deduplicates by location and neutral code and unions confirming lenses", () => {
    const correctness = finding({ id: "correctness-1", code: "unsafe-index", priority: "P0" });
    const security = finding({
      id: "security-7",
      code: "unsafe-index",
      priority: "P1",
      lens: "security",
      confirmedBy: ["security"],
    });
    const result = synthesizeFindings([
      lensReport("correctness", [correctness]),
      lensReport("security", [security]),
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.findings).toHaveLength(1);
    expect(result.value.findings[0]).toMatchObject({ priority: "P0", confirmedBy: ["correctness", "security"] });
    expect(result.value.verdict).toBe("block");
  });

  it("returns byte-identical synthesis across two runs over the same input", () => {
    const inputs = [
      lensReport("security", [finding({
        id: "z-last",
        priority: "P2",
        location: { path: "src/z.ts", line: 9 },
        lens: "security",
        confirmedBy: ["security"],
      })]),
      lensReport("correctness", [finding({
        id: "a-first",
        priority: "P1",
        location: { path: "src/a.ts", line: 3 },
      })]),
    ];

    const first = JSON.stringify(synthesizeFindings(inputs));
    const second = JSON.stringify(synthesizeFindings(inputs));
    expect(second).toBe(first);
    expect(JSON.parse(first).ok).toBe(true);
    expect(JSON.parse(first).value.findings.map(({ id }: { id: string }) => id)).toEqual(["a-first", "z-last"]);
  });

  it("applies independence to every lens session", () => {
    const inputs = [lensReport("correctness", []), lensReport("security", [])];

    // Rejection is a typed result, never a throw: this is projected through a read-only endpoint
    // (DES-4.9) where an escaping throw would become an opaque 500. Note a rejection is TRUTHY,
    // so callers must branch on `.ok`.
    expect(synthesizeFindings(inputs, {
      implementerSessionIds: ["security-session"],
      executionAncestry: [],
    })).toEqual({ ok: false, reason: "self_certification" });
  });

  it("reuses the grader's high-risk different-family route policy", () => {
    const codex = route("codex", "codex");
    const claude = route("claude", "claude");

    expect(selectParkRangerRoute({
      risk: "high",
      implementerProvider: "codex",
      availableRoutes: [codex, claude],
    })).toEqual({ ok: true, route: claude, differentFamily: true });
    expect(selectParkRangerRoute({
      risk: "high",
      implementerProvider: "codex",
      availableRoutes: [codex],
    })).toEqual({ ok: false, code: "grader_family_unavailable" });
  });
});
