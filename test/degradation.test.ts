import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { OutcomeRecord } from "../src/improvement/outcome-projection.js";
import {
  DEGRADATION_REASONS,
  detectDegradation,
  type DegradationInput,
} from "../src/improvement/degradation.js";

const RUN_REF = "a".repeat(64);
const FINGERPRINT = "b".repeat(64);
const RECORDED_AT = "2026-07-26T12:00:00.000Z";

function retry(
  code: "admitted" | "retry_requires_warrant" | "same_attempt_higher_reasoning"
    | "retry_limit_reached" | "escalation_required",
  fingerprintRef = FINGERPRINT,
): OutcomeRecord {
  return Object.freeze({
    schemaVersion: 1,
    runRef: RUN_REF,
    recordedAt: RECORDED_AT,
    signal: "retry",
    code,
    reasoningTier: "medium",
    fingerprintRef,
  });
}

function token(
  code: "within_budget" | "exhausted",
  tokens: number,
  budget: number,
): OutcomeRecord {
  return Object.freeze({
    schemaVersion: 1,
    runRef: RUN_REF,
    recordedAt: RECORDED_AT,
    signal: "token_usage",
    code,
    tokens,
    budget,
  }) as OutcomeRecord;
}

function recovery(
  code: "repaired" | "stopped",
  attempts = 1,
): OutcomeRecord {
  return Object.freeze({
    schemaVersion: 1,
    runRef: RUN_REF,
    recordedAt: RECORDED_AT,
    signal: "recovery",
    code,
    attempts,
  }) as OutcomeRecord;
}

describe("degradation detector", () => {
  it("reports every fired reason in a stable closed order", () => {
    const result = detectDegradation({
      outcomes: [
        retry("admitted"),
        retry("admitted"),
        retry("retry_requires_warrant", "c".repeat(64)),
        token("exhausted", 101, 100),
        recovery("repaired"),
        recovery("stopped", 2),
      ],
      sessionContinuity: "lost",
    });

    expect(DEGRADATION_REASONS).toEqual([
      "token_budget_exhausted",
      "equivalent_failures_repeated",
      "recovery_repeated",
      "retry_refused",
      "continuity_lost",
    ]);
    expect(result).toEqual({
      ok: true,
      reasons: DEGRADATION_REASONS,
    });
    expect(Object.isFrozen(DEGRADATION_REASONS)).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
    if (result.ok) expect(Object.isFrozen(result.reasons)).toBe(true);
  });

  it("treats exhaustion as a failed invocation strictly exceeding its role budget", () => {
    expect(detectDegradation({
      outcomes: [token("exhausted", 10, 10)],
    })).toEqual({ ok: false, reason: "no_signal" });
    expect(detectDegradation({
      outcomes: [token("exhausted", 11, 10)],
    })).toEqual({
      ok: true,
      reasons: ["token_budget_exhausted"],
    });
    expect(detectDegradation({
      outcomes: [token("within_budget", 60, 100), token("exhausted", 50, 100)],
    })).toEqual({ ok: false, reason: "no_signal" });
    expect(detectDegradation({
      outcomes: [
        token("within_budget", 90_000, 200_000),
        token("within_budget", 90_000, 200_000),
        token("within_budget", 90_000, 200_000),
      ],
    })).toEqual({ ok: false, reason: "no_signal" });
    expect(detectDegradation({
      outcomes: [token("within_budget", 200_000, 200_000)],
    })).toEqual({ ok: false, reason: "no_signal" });
    expect(detectDegradation({
      outcomes: [token("exhausted", 200_001, 200_000)],
    })).toEqual({ ok: true, reasons: ["token_budget_exhausted"] });
  });

  it("detects repeated projected fingerprints without reading raw events", () => {
    expect(detectDegradation({
      outcomes: [
        retry("admitted"),
        retry("escalation_required"),
      ],
    })).toEqual({
      ok: true,
      reasons: ["equivalent_failures_repeated"],
    });
  });

  it.each([
    "retry_requires_warrant",
    "same_attempt_higher_reasoning",
    "retry_limit_reached",
  ] as const)("detects the %s retry refusal", (code) => {
    expect(detectDegradation({
      outcomes: [retry(code)],
    })).toEqual({
      ok: true,
      reasons: ["retry_refused"],
    });
  });

  it("detects repeated recovery and a continuity-lost disclosure", () => {
    expect(detectDegradation({
      outcomes: [recovery("stopped", 2)],
      sessionContinuity: "lost",
    })).toEqual({
      ok: true,
      reasons: ["recovery_repeated", "continuity_lost"],
    });
  });

  it("fails closed to a typed no-signal result for healthy or missing evidence", () => {
    const healthy = detectDegradation({
      outcomes: [retry("admitted", "c".repeat(64)), token("within_budget", 99, 100), recovery("repaired")],
      sessionContinuity: "intact",
    });
    const missing = detectDegradation({});

    expect(healthy).toEqual({ ok: false, reason: "no_signal" });
    expect(missing).toEqual({ ok: false, reason: "no_signal" });
    expect(healthy).toBeTruthy();
    expect(missing).toBeTruthy();
    expect(healthy.ok).toBe(false);
    expect(missing.ok).toBe(false);
    expect(Object.isFrozen(healthy)).toBe(true);
    expect(Object.isFrozen(missing)).toBe(true);
  });

  it("ignores malformed and prototype-carried optional evidence without throwing", () => {
    const inherited = Object.create({
      outcomes: [retry("retry_requires_warrant")],
      sessionContinuity: "lost",
    }) as DegradationInput;
    const malformed = {
      outcomes: [
        null,
        { signal: "retry", code: "private_retry_code", fingerprintRef: FINGERPRINT },
        { signal: "token_usage", code: "exhausted", tokens: -1, budget: 1 },
        { signal: "recovery", code: "private_recovery", attempts: 2 },
      ],
      sessionContinuity: "unknown",
    } as unknown as DegradationInput;

    expect(detectDegradation(inherited)).toEqual({ ok: false, reason: "no_signal" });
    expect(detectDegradation(malformed)).toEqual({ ok: false, reason: "no_signal" });
    expect(detectDegradation(null as unknown as DegradationInput))
      .toEqual({ ok: false, reason: "no_signal" });
  });

  it("poisons malformed token evidence without suppressing independent degradation reasons", () => {
    expect(detectDegradation({
      outcomes: [
        token("within_budget", 60, 100),
        { signal: "token_usage", code: "within_budget", tokens: -1, budget: 100 } as unknown as OutcomeRecord,
        token("exhausted", 40, 100),
      ],
      sessionContinuity: "lost",
    })).toEqual({ ok: true, reasons: ["continuity_lost"] });
  });

  it("does not inspect unlisted input fields", () => {
    const input: Record<string, unknown> = {};
    Object.defineProperty(input, "privateTranscript", {
      enumerable: true,
      get: () => {
        throw new Error("unlisted input field was read");
      },
    });

    expect(detectDegradation(input as DegradationInput))
      .toEqual({ ok: false, reason: "no_signal" });
  });

  it("imports no filesystem, process, worker, or network builtin and exposes no ambient egress", async () => {
    const source = await readFile(
      new URL("../src/improvement/degradation.ts", import.meta.url),
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
