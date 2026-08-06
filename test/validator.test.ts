import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  INHERITED_REASON_VERDICTS,
  composeValidatorVerdict,
  deriveValidatorEscalation,
  validateScope,
  type FocusCompletionReason,
  type ValidatorScope,
} from "../src/verification/validator.js";
import type { CommandEvidence, FocusCompletion } from "../src/journey/focus-mode.js";

const passed = (commandId: string): CommandEvidence => ({
  commandId,
  status: "passed",
  summary: `${commandId} passed`,
});
const failed = (commandId: string): CommandEvidence => ({
  commandId,
  status: "failed",
  summary: `${commandId} failed`,
});

function provenScope(): ValidatorScope {
  return {
    slices: [
      {
        sliceId: "4.2",
        requirementIds: ["AC-4.1", "AC-4.1b"],
        evidenceCommandIds: ["CMD-TEST-VALIDATOR", "CMD-TYPECHECK"],
        completion: { ok: true, changedPaths: ["src/verification/validator.ts"] },
        evidence: [passed("CMD-TEST-VALIDATOR"), passed("CMD-TYPECHECK")],
      },
    ],
    readinessClaims: [{ text: "Slice 4.2 is green", sliceIds: ["4.2"] }],
  };
}

describe("validator inherited boundary", () => {
  it("maps every FocusCompletion failure reason to its declared verdict", () => {
    const expected: Record<FocusCompletionReason, "FAIL" | "NEEDS_MORE_EVIDENCE"> = {
      path_outside_write_set: "FAIL",
      no_product_change: "FAIL",
      git_state: "FAIL",
      artifact_missing: "NEEDS_MORE_EVIDENCE",
      artifact_unchanged: "FAIL",
      command_regressed: "FAIL",
      evidence_invalid: "NEEDS_MORE_EVIDENCE",
    };

    expect(INHERITED_REASON_VERDICTS).toEqual(expected);
    for (const [reason, verdict] of Object.entries(expected) as [FocusCompletionReason, typeof expected[FocusCompletionReason]][]) {
      const scope = provenScope();
      const completion: FocusCompletion = { ok: false, reason };
      const report = validateScope({
        ...scope,
        slices: [{ ...scope.slices[0], completion }],
        readinessClaims: [],
      });
      expect(report.reasons).toContain(reason);
      expect(report.verdict).toBe(verdict);
    }
  });

  it("reads the module from disk and rejects runtime or filesystem-bound imports", async () => {
    const source = await readFile(new URL("../src/verification/validator.ts", import.meta.url), "utf8");
    const forbiddenModule = /(?:from\s+|import\s*(?:\(\s*)?)["'](?:node:)?(?:fs(?:\/promises)?|child_process|path)["']/;
    const runtimeFocusImport = /^import(?!\s+type\b).*from\s+["']\.\.\/journey\/focus-mode\.js["']/m;

    expect(source).not.toMatch(forbiddenModule);
    expect(source).not.toMatch(runtimeFocusImport);
  });
});

describe("validator scope sufficiency", () => {
  it("exposes only completion-ok slices with deterministic requirement evidence", () => {
    const report = validateScope({
      slices: [
        {
          sliceId: "2.1",
          requirementIds: ["RISK-2", "AC-2", "AC-2"],
          evidenceCommandIds: [],
          completion: { ok: true, changedPaths: ["src/two.ts"] },
          evidence: [],
        },
        {
          sliceId: "1.1",
          requirementIds: ["AC-1"],
          evidenceCommandIds: [],
          completion: { ok: false, reason: "artifact_missing" },
          evidence: [],
        },
        {
          sliceId: "2.1",
          requirementIds: ["AC-1"],
          evidenceCommandIds: [],
          completion: { ok: true, changedPaths: ["src/two-again.ts"] },
          evidence: [],
        },
      ],
      readinessClaims: [],
    });

    expect((report as unknown as { completedSlices: unknown }).completedSlices).toEqual([
      { sliceId: "2.1", requirementIds: ["AC-1", "AC-2", "RISK-2"] },
    ]);
  });

  it("returns PASS with no escalation for a fully proven scope", () => {
    expect(validateScope(provenScope())).toEqual({
      verdict: "PASS",
      reasons: [],
      escalation: "none",
      completedSlices: [{ sliceId: "4.2", requirementIds: ["AC-4.1", "AC-4.1b"] }],
    });
  });

  it("marks a contract slice without a completion record as slice_unvalidated", () => {
    const scope = provenScope();
    const report = validateScope({
      ...scope,
      slices: [
        ...scope.slices,
        {
          sliceId: "4.2b",
          requirementIds: ["AC-4.1"],
          evidenceCommandIds: ["CMD-TYPECHECK"],
          evidence: [],
        },
      ],
      readinessClaims: [],
    });

    expect(report).toEqual({
      verdict: "NEEDS_MORE_EVIDENCE",
      reasons: ["slice_unvalidated", "evidence_command_uncovered"],
      escalation: "re_execute_slice",
      completedSlices: [{ sliceId: "4.2", requirementIds: ["AC-4.1", "AC-4.1b"] }],
    });
  });

  it("marks a requirement carried only by a non-passing slice as requirement_unproven", () => {
    const scope = provenScope();
    const report = validateScope({
      ...scope,
      slices: [{
        ...scope.slices[0],
        completion: { ok: false, reason: "artifact_missing" },
      }],
      readinessClaims: [],
    });

    expect(report.reasons).toEqual(["artifact_missing", "requirement_unproven"]);
    expect(report.verdict).toBe("NEEDS_MORE_EVIDENCE");
  });

  it("marks a required command absent from the passed-evidence union as evidence_command_uncovered", () => {
    const scope = provenScope();
    const report = validateScope({
      ...scope,
      slices: [{
        ...scope.slices[0],
        evidence: [passed("CMD-TEST-VALIDATOR"), failed("CMD-TYPECHECK")],
      }],
      readinessClaims: [],
    });

    expect(report).toEqual({
      verdict: "NEEDS_MORE_EVIDENCE",
      reasons: ["evidence_command_uncovered"],
      escalation: "re_execute_slice",
      completedSlices: [{ sliceId: "4.2", requirementIds: ["AC-4.1", "AC-4.1b"] }],
    });
  });

  it("does not credit a slice with another slice's passing command evidence", () => {
    const report = validateScope({
      slices: [
        {
          sliceId: "A",
          requirementIds: ["REQ-A"],
          evidenceCommandIds: ["cmd-test"],
          completion: { ok: true, changedPaths: ["src/a.ts"] },
          evidence: [passed("cmd-test")],
        },
        {
          sliceId: "B",
          requirementIds: ["REQ-B"],
          evidenceCommandIds: ["cmd-test"],
          completion: { ok: true, changedPaths: ["src/b.ts"] },
          evidence: [],
        },
      ],
      readinessClaims: [],
    });

    expect(report).toEqual({
      verdict: "NEEDS_MORE_EVIDENCE",
      reasons: ["evidence_command_uncovered"],
      escalation: "re_execute_slice",
      completedSlices: [
        { sliceId: "A", requirementIds: ["REQ-A"] },
        { sliceId: "B", requirementIds: ["REQ-B"] },
      ],
    });
  });

  it("fails a readiness claim that names a slice without an ok completion", () => {
    const scope = provenScope();
    const report = validateScope({
      ...scope,
      readinessClaims: [{ text: "The phase is merge-ready", sliceIds: ["4.2", "4.3"] }],
    });

    expect(report).toEqual({
      verdict: "FAIL",
      reasons: ["unsupported_readiness_claim"],
      escalation: "owner_decision_required",
      completedSlices: [{ sliceId: "4.2", requirementIds: ["AC-4.1", "AC-4.1b"] }],
    });
  });

  it("never passes an empty scope", () => {
    expect(validateScope({ slices: [], readinessClaims: [] })).toEqual({
      verdict: "NEEDS_MORE_EVIDENCE",
      reasons: ["slice_unvalidated"],
      escalation: "re_execute_slice",
      completedSlices: [],
    });
  });
});

describe("validator verdict and escalation composition", () => {
  it("gives FAIL precedence over NEEDS_MORE_EVIDENCE and otherwise does not score reasons", () => {
    expect(composeValidatorVerdict(["slice_unvalidated", "git_state"])).toBe("FAIL");
    expect(composeValidatorVerdict(["requirement_unproven", "evidence_command_uncovered"])).toBe("NEEDS_MORE_EVIDENCE");
    expect(composeValidatorVerdict([])).toBe("PASS");
  });

  it("covers none, retry, park-ranger, and owner-decision escalation branches", () => {
    expect(deriveValidatorEscalation("PASS", [])).toBe("none");
    expect(deriveValidatorEscalation("NEEDS_MORE_EVIDENCE", ["slice_unvalidated"])).toBe("re_execute_slice");
    expect(deriveValidatorEscalation("FAIL", ["path_outside_write_set"])).toBe("park_ranger_gate");
    expect(deriveValidatorEscalation("FAIL", ["no_product_change"])).toBe("park_ranger_gate");
    expect(deriveValidatorEscalation("FAIL", ["git_state"])).toBe("owner_decision_required");
    expect(deriveValidatorEscalation("FAIL", ["unsupported_readiness_claim"])).toBe("owner_decision_required");
  });
});
