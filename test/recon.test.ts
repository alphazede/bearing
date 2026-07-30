import { describe, expect, expectTypeOf, it } from "vitest";
import {
  routeRecon,
  validateReconBrief,
  validateReconReport,
  type ReconBrief,
  type ReconReport,
} from "../src/journey/recon.js";

const brief: ReconBrief = {
  assumptionId: "ASSUMPTION-1",
  assumption: "The existing parser can process the bounded fixture.",
  materiality: ["architecture", "risk"],
  falsificationCriterion: "The parser rejects any valid corpus fixture.",
  smallestExperiment: "Run the parser over the smallest representative corpus.",
  writeSet: ["tmp/recon/parser-fixture.json"],
  evidenceCommandIds: ["CMD-RECON"],
  timeboxMinutes: 30,
};

const report: ReconReport = {
  assumptionId: "ASSUMPTION-1",
  measurements: [{ name: "accepted fixtures", value: "12 of 12", method: "Run CMD-RECON against the bounded corpus." }],
  feasibilityEvidence: ["CMD-RECON passed with all fixtures accepted."],
  constraints: ["The experiment covers only the bounded corpus."],
  rejectedOptions: [{ option: "Replace the parser", reason: "The existing parser satisfied the criterion." }],
  recommendation: "proceed",
  materialChange: { cost: false, architecture: false, scope: false, risk: false },
  prototypePaths: ["tmp/recon/parser-fixture.json"],
  productionEligible: false,
};

describe("recon", () => {
  it("validates the brief and report and routes a clean proceed result", () => {
    expect(validateReconBrief(brief)).toEqual({ ok: true, value: brief });
    expect(validateReconReport(report, brief)).toEqual({ ok: true, value: report });
    expect(routeRecon({ brief, report })).toEqual({
      ok: true,
      state: "RECON_READY",
      brief,
      report,
    });
  });

  it("makes a true production-eligibility flag unconstructable and rejects it at runtime", () => {
    expectTypeOf<ReconReport["productionEligible"]>().toEqualTypeOf<false>();

    expect(validateReconReport({ ...report, productionEligible: true }, brief)).toEqual({
      ok: false,
      code: "recon_report_invalid",
      issues: ["productionEligible must be false"],
    });
  });

  it.each([
    ["proceed", "RECON_READY"],
    ["revise", "ARCHITECTURE_READY"],
    ["stop", "RECON_FAILED"],
  ] as const)("routes %s to %s", (recommendation, state) => {
    expect(routeRecon({ brief, report: { ...report, recommendation } })).toEqual(expect.objectContaining({ ok: true, state }));
  });

  it.each(["proceed", "revise", "stop"] as const)("escalates a material change regardless of %s", (recommendation) => {
    const changed = {
      ...report,
      recommendation,
      materialChange: { ...report.materialChange, cost: true },
    };

    expect(routeRecon({ brief, report: changed })).toEqual(expect.objectContaining({
      ok: true,
      state: "OWNER_DECISION_REQUIRED",
    }));
  });

  it("returns typed failures for malformed input instead of silently skipping", () => {
    expect(routeRecon({ brief: { ...brief, timeboxMinutes: 0 } })).toEqual(expect.objectContaining({
      ok: false,
      code: "recon_brief_invalid",
    }));
    expect(routeRecon({ brief, report: { ...report, measurements: [] } })).toEqual(expect.objectContaining({
      ok: false,
      code: "recon_report_invalid",
    }));
    expect(routeRecon({ report })).toEqual(expect.objectContaining({
      ok: false,
      code: "recon_brief_invalid",
    }));
  });

  it("applies the shared bounded path predicate to experiment and prototype paths", () => {
    expect(validateReconBrief({ ...brief, writeSet: ["tmp/recon/*.json"] })).toEqual(expect.objectContaining({
      ok: false,
      code: "recon_brief_invalid",
    }));
    expect(validateReconReport({ ...report, prototypePaths: ["../prototype.ts"] }, brief)).toEqual(expect.objectContaining({
      ok: false,
      code: "recon_report_invalid",
    }));
  });

  it("rejects reports whose measurements are unrelated to the falsification criterion", () => {
    const unrelated = {
      ...report,
      measurements: [{ name: "weather", value: "sunny", method: "look outside" }],
    };

    expect(validateReconReport(unrelated, brief)).toEqual(expect.objectContaining({
      ok: false,
      code: "recon_report_invalid",
      issues: expect.arrayContaining(["at least one measurement must be tied to the falsification criterion"]),
    }));
  });

  it("does not treat a shared generic topic word as criterion evidence", () => {
    const latencyBrief = { ...brief, falsificationCriterion: "Parser latency must stay below 100ms." };
    const versionOnly = {
      ...report,
      measurements: [{ name: "parser version", value: "1.0", method: "Read the parser version." }],
    };

    expect(validateReconReport(versionOnly, latencyBrief)).toEqual(expect.objectContaining({
      ok: false,
      code: "recon_report_invalid",
      issues: expect.arrayContaining(["at least one measurement must be tied to the falsification criterion"]),
    }));
  });

  it("preserves concise domain terms when tying measurements to a criterion", () => {
    const oomBrief = { ...brief, falsificationCriterion: "OOM at 1 GB." };
    const oomReport = {
      ...report,
      measurements: [{ name: "OOM count", value: "0", method: "Run CMD-RECON at 1 GB." }],
    };
    const unmatchable = { ...brief, falsificationCriterion: "At 1 GB." };

    expect(validateReconBrief(oomBrief)).toEqual({ ok: true, value: oomBrief });
    expect(validateReconReport(oomReport, oomBrief)).toEqual({ ok: true, value: oomReport });
    expect(validateReconBrief(unmatchable)).toEqual(expect.objectContaining({
      ok: false,
      code: "recon_brief_invalid",
    }));
  });

  it("rejects sparse arrays instead of accepting missing entries", () => {
    expect(validateReconBrief({
      ...brief,
      writeSet: new Array(1),
      evidenceCommandIds: new Array(1),
    })).toEqual(expect.objectContaining({
      ok: false,
      code: "recon_brief_invalid",
    }));
    expect(validateReconReport({
      ...report,
      feasibilityEvidence: new Array(1),
      constraints: new Array(1),
      rejectedOptions: new Array(1),
    }, brief)).toEqual(expect.objectContaining({
      ok: false,
      code: "recon_report_invalid",
    }));
  });

  it("keeps Recon optional when both records are absent", () => {
    expect(routeRecon()).toEqual({ ok: true, state: "SKIPPED" });
    expect(routeRecon({})).toEqual({ ok: true, state: "SKIPPED" });
  });
});
