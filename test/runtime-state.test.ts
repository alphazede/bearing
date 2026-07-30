import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MAX_RUNTIME_STATE_ARRAY,
  MAX_RUNTIME_STATE_JSON,
  MAX_RUNTIME_STATE_STRING,
  parseRuntimeState,
  serializeRuntimeState,
  type RuntimeStateRecord,
} from "../src/contracts/runtime-state.js";

const validRecord: RuntimeStateRecord = {
  version: 1,
  trace: [{
    sequence: 1,
    recordedAt: "2026-07-25T12:00:00.000Z",
    kind: "stage.started",
    status: "running",
    tool: "codex",
  }],
  retry: [{
    fingerprint: "a".repeat(64),
    warrant: "new_evidence",
    reasoningTier: "high",
    outcome: "admitted",
  }],
  concurrency: {
    admittedLanes: ["5.1"],
    cap: 1,
    controller: "explorer",
    reducedBy: "unstable_test",
  },
  grading: {
    verdict: "acceptable",
    rubricVersion: "1",
    findingCount: 2,
  },
  sessionContinuity: "lost",
};

function parse(value: unknown) {
  return parseRuntimeState(JSON.stringify(value));
}

describe("runtime state contract", () => {
  it("round-trips one bounded version-1 record without coercion", () => {
    const json = serializeRuntimeState(validRecord);

    expect(parseRuntimeState(json)).toEqual({ ok: true, value: validRecord });
  });

  it("accepts the minimal record and both continuity values", () => {
    expect(parse({ version: 1, trace: [], retry: [] })).toMatchObject({ ok: true });
    expect(parse({ version: 1, trace: [], retry: [], sessionContinuity: "intact" })).toMatchObject({ ok: true });
    expect(parse({ version: 1, trace: [], retry: [], sessionContinuity: "lost" })).toMatchObject({ ok: true });
  });

  it("accepts the retry-control no-warrant representation and a serial concurrency cap", () => {
    expect(parse({
      ...validRecord,
      retry: [{ ...validRecord.retry[0], warrant: null, outcome: "retry_requires_warrant" }],
      concurrency: { ...validRecord.concurrency, admittedLanes: [], cap: 0 },
    })).toMatchObject({ ok: true });
  });

  it("returns typed reasons for malformed JSON and an unsupported internal version", () => {
    expect(parseRuntimeState("{")).toEqual({ ok: false, reason: "malformed_json" });
    expect(parse({ ...validRecord, version: 2 })).toEqual({ ok: false, reason: "unsupported_version" });
    expect(parse({ ...validRecord, version: "1" })).toEqual({ ok: false, reason: "unsupported_version" });
  });

  it.each([
    ["record", { ...validRecord, extra: true }],
    ["trace entry", { ...validRecord, trace: [{ ...validRecord.trace[0], extra: true }] }],
    ["retry entry", { ...validRecord, retry: [{ ...validRecord.retry[0], extra: true }] }],
    ["concurrency decision", { ...validRecord, concurrency: { ...validRecord.concurrency, extra: true } }],
    ["grading summary", { ...validRecord, grading: { ...validRecord.grading, extra: true } }],
  ])("rejects an unknown %s key", (_label, value) => {
    expect(parse(value)).toEqual({ ok: false, reason: "unknown_key" });
  });

  it("rejects an oversized payload before parsing it", () => {
    expect(parseRuntimeState(" ".repeat(MAX_RUNTIME_STATE_JSON + 1)))
      .toEqual({ ok: false, reason: "payload_too_large" });
  });

  it.each([
    ["trace", { ...validRecord, trace: Array.from({ length: 21 }, () => validRecord.trace[0]) }],
    ["retry", { ...validRecord, retry: Array.from({ length: MAX_RUNTIME_STATE_ARRAY + 1 }, () => validRecord.retry[0]) }],
    ["admitted lanes", {
      ...validRecord,
      concurrency: {
        ...validRecord.concurrency,
        admittedLanes: Array.from({ length: MAX_RUNTIME_STATE_ARRAY + 1 }, (_, index) => `lane-${index}`),
      },
    }],
  ])("rejects an over-length %s array rather than truncating it", (_label, value) => {
    expect(parse(value)).toEqual({ ok: false, reason: "array_too_long" });
  });

  it("rejects over-length free-form strings rather than truncating them", () => {
    expect(parse({
      ...validRecord,
      retry: [{ ...validRecord.retry[0], outcome: "x".repeat(MAX_RUNTIME_STATE_STRING + 1) }],
    })).toEqual({ ok: false, reason: "string_too_long" });
  });

  it.each([
    { ...validRecord.trace[0], kind: "sk-ABCDEFGH" },
    { ...validRecord.trace[0], tool: "unsafe/value" },
    { ...validRecord.trace[0], status: "token=secret" },
  ])("re-applies the journey activity safety gates to %#", (activity) => {
    expect(parse({ ...validRecord, trace: [activity] }))
      .toEqual({ ok: false, reason: "unsafe_trace" });
  });

  it.each([
    { ...validRecord, trace: "not-an-array" },
    { ...validRecord, retry: "not-an-array" },
    { ...validRecord, sessionContinuity: "unknown" },
    { ...validRecord, retry: [{ ...validRecord.retry[0], fingerprint: "not-a-hash" }] },
    { ...validRecord, retry: [{ ...validRecord.retry[0], outcome: "unknown" }] },
    { ...validRecord, grading: { ...validRecord.grading, verdict: "unknown" } },
  ])("rejects malformed record values %#", (value) => {
    expect(parse(value)).toEqual({ ok: false, reason: "malformed" });
  });

  it("has no filesystem, process, path, clock, or random dependency", () => {
    const source = readFileSync(new URL("../src/contracts/runtime-state.ts", import.meta.url), "utf8");

    expect(source).not.toMatch(/(?:from|require\()[^\n]*(?:node:)?(?:fs|child_process|path)/);
    expect(source).not.toContain("Date.now");
    expect(source).not.toContain("Math.random");
    expect(source).not.toMatch(/(?:COMMAND|EVENT)_SCHEMA_VERSION/);
  });
});
