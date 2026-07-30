import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  MAX_EQUIVALENT_FAILURES,
  admitRetry,
  failureFingerprint,
  type EscalationScope,
  type FailureFingerprintInput,
  type RetryAttempt,
  type RetryLedgerEntry,
  type RetryWarrant,
} from "../src/execution/retry-control.js";

const baseFailure = {
  stage: "focus",
  failureCode: "completion_invalid",
  commandId: "CMD-TEST-RETRY",
  errorSignature: "path_outside_write_set",
  relevantState: { plan: true, artifacts: 2, nested: { second: 2, first: 1 } },
  changedPaths: ["src/z.ts", "src/a.ts", "src/z.ts"],
  hypothesisId: "hypothesis-1",
} as const satisfies FailureFingerprintInput;

function attempt(
  fingerprint: string,
  overrides: Partial<RetryAttempt> = {},
): RetryAttempt {
  return {
    fingerprint,
    warrant: "changed_strategy",
    reasoningTier: "medium",
    scope: "within-slice",
    ...overrides,
  };
}

describe("retry control", () => {
  it("canonicalizes the full failure identity and normalizes changed paths", () => {
    const equivalent = failureFingerprint({
      ...baseFailure,
      relevantState: { nested: { first: 1, second: 2 }, artifacts: 2, plan: true },
      changedPaths: ["src/a.ts", "src/z.ts"],
    });
    const fingerprint = failureFingerprint(baseFailure);

    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(equivalent).toBe(fingerprint);
    for (const changed of [
      { ...baseFailure, stage: "review" },
      { ...baseFailure, failureCode: "focus_invalid" },
      { ...baseFailure, commandId: "CMD-OTHER" },
      { ...baseFailure, errorSignature: "artifact_missing" as const },
      { ...baseFailure, relevantState: { ...baseFailure.relevantState, artifacts: 3 } },
      { ...baseFailure, changedPaths: ["src/a.ts"] },
      { ...baseFailure, hypothesisId: "hypothesis-2" },
    ]) {
      expect(failureFingerprint(changed)).not.toBe(fingerprint);
    }
  });

  it.each([
    "new_hypothesis",
    "new_evidence",
    "changed_strategy",
    "changed_environment",
    "approved_amendment",
  ] as const)("admits and records the %s warrant", (warrant: RetryWarrant) => {
    const proposal = attempt("f".repeat(64), { warrant });
    const result = admitRetry([], proposal);

    expect(result).toEqual({
      ok: true,
      ledger: [{
        fingerprint: proposal.fingerprint,
        warrant,
        reasoningTier: "medium",
        outcome: "admitted",
      }],
    });
  });

  it("refuses and records an unwarranted repeat", () => {
    const fingerprint = "a".repeat(64);
    expect(admitRetry([], attempt(fingerprint, { warrant: undefined })))
      .toMatchObject({ ok: false, reason: "retry_requires_warrant" });
    const prior = admitRetry([], attempt(fingerprint));
    expect(prior.ok).toBe(true);

    const result = admitRetry(prior.ledger, attempt(fingerprint, { warrant: undefined }));

    expect(result).toMatchObject({ ok: false, reason: "retry_requires_warrant" });
    expect(result.ledger.at(-1)).toEqual({
      fingerprint,
      warrant: null,
      reasoningTier: "medium",
      outcome: "retry_requires_warrant",
    });
  });

  it("requires a new hypothesis or evidence when only reasoning rises", () => {
    const fingerprint = "b".repeat(64);
    const prior = admitRetry([], attempt(fingerprint));
    expect(prior.ok).toBe(true);

    for (const warrant of [undefined, "changed_strategy", "changed_environment", "approved_amendment"] as const) {
      const result = admitRetry(prior.ledger, attempt(fingerprint, {
        warrant,
        reasoningTier: "high",
      }));
      expect(result).toMatchObject({ ok: false, reason: "same_attempt_higher_reasoning" });
      expect(result.ledger.at(-1)?.outcome).toBe("same_attempt_higher_reasoning");
    }

    for (const warrant of ["new_hypothesis", "new_evidence"] as const) {
      expect(admitRetry(prior.ledger, attempt(fingerprint, {
        warrant,
        reasoningTier: "high",
      }))).toMatchObject({ ok: true });
    }
  });

  it.each([
    ["within-slice", "explorer"],
    ["cross-slice", "trail-boss"],
    ["cross-phase", "navigator"],
    ["contract-change", "owner"],
  ] as const)("escalates %s equivalents to %s without admitting another attempt", (
    scope: EscalationScope,
    target,
  ) => {
    const fingerprint = "c".repeat(64);
    const ledger: readonly RetryLedgerEntry[] = Array.from(
      { length: MAX_EQUIVALENT_FAILURES },
      () => ({
        fingerprint,
        warrant: "new_evidence",
        reasoningTier: "medium",
        outcome: "admitted",
      }),
    );

    const result = admitRetry(ledger, attempt(fingerprint, { scope }));

    expect(result).toMatchObject({ ok: true, escalation: target });
    expect(result.ledger).toHaveLength(ledger.length + 1);
    expect(result.ledger.at(-1)).toEqual({
      fingerprint,
      warrant: "changed_strategy",
      reasoningTier: "medium",
      outcome: "escalation_required",
    });
    expect(result.ledger.at(-1)?.outcome).not.toBe("admitted");
  });

  it("imports no filesystem, process, or path modules and uses no ambient clock or randomness", async () => {
    const source = await readFile(
      new URL("../src/execution/retry-control.ts", import.meta.url),
      "utf8",
    );

    expect(source).not.toMatch(/(?:from\s+|import\s*\()["'](?:node:)?(?:fs(?:\/promises)?|child_process|path)["']/);
    expect(source).not.toMatch(/\b(?:Date\.now|Math\.random)\s*\(/);
  });
});
