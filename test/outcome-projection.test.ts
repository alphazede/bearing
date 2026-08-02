import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { EventEnvelopeV1 } from "../src/contracts/run.js";
import {
  MAX_OUTCOME_PATH_REFS,
  MAX_OUTCOME_RECORDS_PER_RUN,
  OUTCOME_CODES,
  OUTCOME_SIGNALS,
  projectOutcomes,
} from "../src/improvement/outcome-projection.js";

const HASH = "0".repeat(64);
const RUN_ID = "private-run-1";
const RUN_REF = "a".repeat(64);
const FIRST_FINGERPRINT = "1".repeat(64);
const FIRST_FINGERPRINT_REF = "b".repeat(64);
const SECOND_FINGERPRINT = "2".repeat(64);
const SECOND_FINGERPRINT_REF = "c".repeat(64);
const RECORDED_AT = "2026-07-26T12:00:00.000Z";

function event(
  type: EventEnvelopeV1["type"],
  payload: Readonly<Record<string, unknown>>,
  sequence = 1,
): EventEnvelopeV1 {
  return {
    schemaVersion: 1,
    eventId: `event-${sequence}`,
    runId: RUN_ID,
    sequence,
    recordedAt: RECORDED_AT,
    type,
    actor: "bearing",
    sessionId: "local-runtime",
    correlationId: `correlation-${sequence}`,
    causationId: `command-${sequence}`,
    commandContentHash: HASH,
    payload,
    evidenceRefs: [],
    previousHash: sequence === 1 ? "" : HASH,
    hash: HASH,
  };
}

function checkpoint(
  payload: Readonly<Record<string, unknown>>,
  sequence = 1,
): EventEnvelopeV1 {
  return event("journeyCheckpointRecorded", {
    stage: "execute-explorer",
    status: "complete",
    artifacts: [],
    ...payload,
  }, sequence);
}

function digestFor(values: Readonly<Record<string, string>> = {}) {
  return vi.fn((value: string): string => values[value] ?? RUN_REF);
}

describe("outcome projection", () => {
  it("exports frozen closed signal and per-signal code domains with explicit bounds", () => {
    expect(OUTCOME_SIGNALS).toEqual([
      "validation_failure",
      "retry",
      "grader_score",
      "park_ranger_finding",
      "park_ranger_review",
      "slice_completion",
      "surveyor_failure",
      "reasoning_effectiveness",
      "concurrency_conflict",
      "coordination",
      "token_usage",
      "recovery",
    ]);
    expect(OUTCOME_CODES).toEqual({
      validation_failure: [
        "REQUIREMENTS_GAP",
        "DESIGN_CONFLICT",
        "RECON_FAILED",
        "MISSING_VALIDATION",
        "UNSAFE_PARALLELISM",
        "OWNER_DECISION_REQUIRED",
        "git_state",
        "path_outside_write_set",
        "artifact_missing",
        "evidence_invalid",
        "no_product_change",
      ],
      retry: [
        "admitted",
        "retry_requires_warrant",
        "same_attempt_higher_reasoning",
        "retry_limit_reached",
        "escalation_required",
      ],
      grader_score: ["strong", "acceptable", "weak"],
      park_ranger_finding: ["P0", "P1", "P2", "P3"],
      park_ranger_review: ["complete"],
      slice_completion: ["complete"],
      surveyor_failure: ["failed", "blocked", "deviated"],
      reasoning_effectiveness: ["complete", "failed"],
      concurrency_conflict: [
        "write_set_conflict",
        "shared_file",
        "unstable_test",
        "repeated_integration_failure",
      ],
      coordination: ["explorer", "expedition"],
      token_usage: ["within_budget", "exhausted"],
      recovery: ["repaired", "stopped"],
    });
    expect(Object.isFrozen(OUTCOME_SIGNALS)).toBe(true);
    expect(Object.isFrozen(OUTCOME_CODES)).toBe(true);
    for (const codes of Object.values(OUTCOME_CODES)) expect(Object.isFrozen(codes)).toBe(true);
    expect(MAX_OUTCOME_RECORDS_PER_RUN).toBe(1_000);
    expect(MAX_OUTCOME_PATH_REFS).toBe(16);
  });

  it("projects only bounded typed token totals and recovery outcomes, never checkpoint result prose", () => {
    const records = projectOutcomes({
      runId: RUN_ID,
      digest: digestFor(),
      events: [checkpoint({
        lastResultJson: JSON.stringify({ tokens: 999_999, recovery: "private provider prose" }),
        tokenUsage: { total: 12, budget: 10, state: "exhausted" },
        recoveryOutcome: { outcome: "repaired", attempts: 2 },
      })],
    });

    expect(records).toEqual([
      {
        schemaVersion: 1,
        runRef: RUN_REF,
        recordedAt: RECORDED_AT,
        signal: "token_usage",
        code: "exhausted",
        tokens: 12,
        budget: 10,
      },
      {
        schemaVersion: 1,
        runRef: RUN_REF,
        recordedAt: RECORDED_AT,
        signal: "recovery",
        code: "repaired",
        attempts: 2,
      },
    ]);
    expect(JSON.stringify(records)).not.toContain("private provider prose");
    expect(JSON.stringify(records)).not.toContain("999999");
  });

  it("drops missing, malformed, unbounded, unknown, and prototype-carried token or recovery evidence", () => {
    const invalid = [
      { tokenUsage: { total: -1, budget: 10, state: "within_budget" } },
      { tokenUsage: { total: Number.MAX_SAFE_INTEGER + 1, budget: 10, state: "exhausted" } },
      { tokenUsage: { total: 9, budget: 10, state: "unknown" } },
      { tokenUsage: { total: 9, budget: 10, state: "exhausted" } },
      { recoveryOutcome: { outcome: "unknown", attempts: 1 } },
      { recoveryOutcome: { outcome: "repaired", attempts: 0 } },
    ];
    for (const payload of invalid) {
      const records = projectOutcomes({ runId: RUN_ID, digest: digestFor(), events: [checkpoint(payload)] });
      expect(records.filter(({ signal }) => signal === "token_usage" || signal === "recovery")).toEqual([]);
    }

    const inherited = Object.assign(Object.create({
      tokenUsage: { total: 12, budget: 10, state: "exhausted" },
      recoveryOutcome: { outcome: "repaired", attempts: 2 },
    }) as Record<string, unknown>, { stage: "execute-explorer", status: "complete", artifacts: [] });
    expect(projectOutcomes({ runId: RUN_ID, digest: digestFor(), events: [event("journeyCheckpointRecorded", inherited)] })).toEqual([]);
  });

  it("emits each bounded cumulative token total once as a deterministic delta", () => {
    const records = projectOutcomes({
      runId: RUN_ID,
      digest: digestFor(),
      events: [
        checkpoint({ tokenUsage: { total: 0, budget: 10, state: "within_budget" } }, 1),
        checkpoint({ tokenUsage: { total: 3, budget: 10, state: "within_budget" } }, 2),
        checkpoint({ tokenUsage: { total: 3, budget: 10, state: "within_budget" } }, 3),
        checkpoint({ tokenUsage: { total: 5, budget: 10, state: "within_budget" } }, 4),
      ],
    });

    const tokenRecords = records.filter((record): record is Extract<typeof record, { readonly signal: "token_usage" }> => record.signal === "token_usage");
    expect(tokenRecords.map(({ tokens }) => tokens)).toEqual([0, 3, 2]);
  });

  it("retains per-invocation budget state while projecting cumulative totals as deltas", () => {
    const records = projectOutcomes({
      runId: RUN_ID,
      digest: digestFor(),
      events: [
        checkpoint({ tokenUsage: { total: 90_000, budget: 200_000, state: "within_budget" } }, 1),
        checkpoint({ tokenUsage: { total: 180_000, budget: 200_000, state: "within_budget" } }, 2),
        checkpoint({ tokenUsage: { total: 270_000, budget: 200_000, state: "within_budget" } }, 3),
      ],
    });
    const tokenRecords = records.filter((record) => record.signal === "token_usage");
    expect(tokenRecords.map(({ code, tokens }) => ({ code, tokens }))).toEqual([
      { code: "within_budget", tokens: 90_000 },
      { code: "within_budget", tokens: 90_000 },
      { code: "within_budget", tokens: 90_000 },
    ]);
  });

  it("skips durable exhausted replay and a zero-token healthy follow-up without poisoning prior evidence", () => {
    const records = projectOutcomes({
      runId: RUN_ID,
      digest: digestFor(),
      events: [
        checkpoint({ tokenUsage: { total: 250_001, budget: 200_000, state: "exhausted" } }, 1),
        checkpoint({ tokenUsage: { total: 250_001, budget: 200_000, state: "exhausted" } }, 2),
        checkpoint({ tokenUsage: { total: 250_001, budget: 200_000, state: "within_budget" } }, 3),
      ],
    });
    expect(records.filter((record) => record.signal === "token_usage")).toEqual([expect.objectContaining({
      code: "exhausted",
      tokens: 250_001,
      budget: 200_000,
    })]);
  });

  it("poisons an equal-total healthy-to-exhausted transition", () => {
    const records = projectOutcomes({
      runId: RUN_ID,
      digest: digestFor(),
      events: [
        checkpoint({ tokenUsage: { total: 90_000, budget: 200_000, state: "within_budget" } }, 1),
        checkpoint({ tokenUsage: { total: 90_000, budget: 200_000, state: "exhausted" } }, 2),
      ],
    });
    expect(records.filter((record) => record.signal === "token_usage")).toEqual([]);
  });

  it("poisons an impossible zero-token exhausted first checkpoint", () => {
    const records = projectOutcomes({
      runId: RUN_ID,
      digest: digestFor(),
      events: [checkpoint({ tokenUsage: { total: 0, budget: 200_000, state: "exhausted" } }, 1)],
    });
    expect(records.filter((record) => record.signal === "token_usage")).toEqual([]);
  });

  it("permanently poisons token projection after a budget change or total regression", () => {
    const records = projectOutcomes({
      runId: RUN_ID,
      digest: digestFor(),
      events: [
        checkpoint({ tokenUsage: { total: 60, budget: 100, state: "within_budget" } }, 1),
        checkpoint({ tokenUsage: { total: 80, budget: 200, state: "within_budget" } }, 2),
        checkpoint({ tokenUsage: { total: 110, budget: 100, state: "exhausted" } }, 3),
      ],
    });
    expect(records.filter(({ signal }) => signal === "token_usage")).toEqual([]);
  });

  it("prevalidates the complete token series so the record cap cannot hide late poison", () => {
    const records = projectOutcomes({
      runId: RUN_ID,
      digest: digestFor(),
      events: [
        checkpoint({ tokenUsage: { total: 1, budget: 100, state: "within_budget" } }, 1),
        ...Array.from({ length: MAX_OUTCOME_RECORDS_PER_RUN }, (_, index) => event("executionModeRecommended", {
          workItems: 1,
          estimatedAgents: 1,
          recommendedMode: "explorer",
        }, index + 2)),
        checkpoint({ tokenUsage: { total: -1, budget: 100, state: "within_budget" } }, MAX_OUTCOME_RECORDS_PER_RUN + 2),
      ],
    });
    expect(records).toHaveLength(MAX_OUTCOME_RECORDS_PER_RUN);
    expect(records.some(({ signal }) => signal === "token_usage")).toBe(false);
  });

  it("deduplicates consecutive recovery replays but emits the same outcome after a checkpoint gap", () => {
    const recoveryOutcome = { outcome: "repaired", attempts: 1 } as const;
    const records = projectOutcomes({
      runId: RUN_ID,
      digest: digestFor(),
      events: [
        checkpoint({ recoveryOutcome }, 1),
        checkpoint({ recoveryOutcome }, 2),
        checkpoint({}, 3),
        checkpoint({ recoveryOutcome }, 4),
      ],
    });

    expect(records.filter(({ signal }) => signal === "recovery")).toHaveLength(2);
  });

  it("projects the allowlisted coordination fields and freezes the result", () => {
    const digest = digestFor();
    const records = projectOutcomes({
      runId: RUN_ID,
      digest,
      events: [event("executionModeRecommended", {
        workItems: 4,
        maxCrewmatesPerExplorer: 3,
        perAgentTokenEstimate: 10,
        recommendedMode: "expedition",
        selectedMode: "expedition",
        overridden: false,
        estimatedAgents: 8,
        estimatedTokens: 80,
        tradeoffs: {
          tokens: "private cost prose",
          coordination: "private coordination prose",
        },
        launchAuthorized: false,
      })],
    });

    expect(records).toEqual([{
      schemaVersion: 1,
      runRef: RUN_REF,
      recordedAt: RECORDED_AT,
      signal: "coordination",
      code: "expedition",
      workItemCount: 4,
      estimatedAgents: 8,
    }]);
    expect(Object.isFrozen(records)).toBe(true);
    expect(Object.isFrozen(records[0])).toBe(true);
    expect(JSON.stringify(records)).not.toContain("private coordination prose");
    expect(digest).toHaveBeenCalledTimes(1);
    expect(digest).toHaveBeenCalledWith(RUN_ID);
  });

  it("emits no coordination record for incomplete or invalid triples", () => {
    const basePayload = { recommendedMode: "explorer", workItems: 3, estimatedAgents: 5 };
    const cases: Readonly<Record<string, unknown>>[] = [
      { recommendedMode: "explorer", workItems: 3 },
      { recommendedMode: "explorer", estimatedAgents: 5 },
      { workItems: 3, estimatedAgents: 5 },
      { recommendedMode: "explorer", workItems: 3, estimatedAgents: -1 },
      { recommendedMode: "explorer", workItems: 3, estimatedAgents: 1.5 },
      { recommendedMode: "explorer", workItems: 3, estimatedAgents: 2_000_001 },
      { recommendedMode: "invalid-mode", workItems: 3, estimatedAgents: 5 },
      { recommendedMode: "expedition", workItems: NaN, estimatedAgents: 2 },
    ];
    for (const payload of cases) {
      const records = projectOutcomes({
        runId: RUN_ID,
        digest: digestFor(),
        events: [event("executionModeRecommended", payload)],
      });
      expect(records.filter((r) => r.signal === "coordination")).toEqual([]);
    }
    // valid still emits
    const valid = projectOutcomes({
      runId: RUN_ID,
      digest: digestFor(),
      events: [event("executionModeRecommended", basePayload)],
    });
    expect(valid).toEqual([{
      schemaVersion: 1,
      runRef: RUN_REF,
      recordedAt: RECORDED_AT,
      signal: "coordination",
      code: "explorer",
      workItemCount: 3,
      estimatedAgents: 5,
    }]);
  });

  it("projects structured failures, retry outcomes, and conflicts without carrying free text or raw identifiers", () => {
    const secretValues = [
      "private plan prose",
      "src/private-secret.ts",
      "Should this private plan ship?",
      "owner secret answer",
      "private result summary",
      "private lane id",
      RUN_ID,
      FIRST_FINGERPRINT,
    ];
    const digest = digestFor({
      [RUN_ID]: RUN_REF,
      [FIRST_FINGERPRINT]: FIRST_FINGERPRINT_REF,
    });
    const runtimeStateJson = JSON.stringify({
      version: 1,
      trace: [{
        sequence: 1,
        recordedAt: "trace.private",
        kind: "private.trace",
        status: "private.status",
      }],
      retry: [{
        fingerprint: FIRST_FINGERPRINT,
        warrant: "new_evidence",
        reasoningTier: "high",
        outcome: "admitted",
      }],
      concurrency: {
        admittedLanes: ["private lane id"],
        cap: 2,
        controller: "explorer",
        reducedBy: "shared_file",
      },
      grading: { verdict: "weak", findingCount: 4 },
    });
    const records = projectOutcomes({
      runId: RUN_ID,
      digest,
      events: [checkpoint({
        status: "failed",
        artifacts: ["src/private-secret.ts"],
        planDirectory: "docs/plans/private-plan",
        question: "Should this private plan ship?",
        lastResultJson: JSON.stringify({
          summary: "private result summary",
          answer: "owner secret answer",
          plan: "private plan prose",
          changedPaths: ["src/private-secret.ts"],
        }),
        qaJson: JSON.stringify([{
          question: "Should this private plan ship?",
          answer: "owner secret answer",
        }]),
        planningFailure: "MISSING_VALIDATION",
        runtimeStateJson,
      })],
    });

    expect(records).toEqual([
      {
        schemaVersion: 1,
        runRef: RUN_REF,
        recordedAt: RECORDED_AT,
        signal: "validation_failure",
        code: "MISSING_VALIDATION",
      },
      {
        schemaVersion: 1,
        runRef: RUN_REF,
        recordedAt: RECORDED_AT,
        signal: "retry",
        code: "admitted",
        reasoningTier: "high",
        fingerprintRef: FIRST_FINGERPRINT_REF,
      },
      {
        schemaVersion: 1,
        runRef: RUN_REF,
        recordedAt: RECORDED_AT,
        signal: "concurrency_conflict",
        code: "shared_file",
        value: 2,
      },
    ]);
    const rendered = JSON.stringify(records);
    for (const secret of secretValues) expect(rendered).not.toContain(secret);
    expect(records.every((record) => !Object.hasOwn(record, "pathRefs"))).toBe(true);
    expect(digest.mock.calls.map(([value]) => value)).toEqual([RUN_ID, FIRST_FINGERPRINT]);
  });

  it("emits only newly appended retry entries from cumulative checkpoint state", () => {
    const first = {
      fingerprint: FIRST_FINGERPRINT,
      warrant: "new_evidence",
      reasoningTier: "medium",
      outcome: "admitted",
    } as const;
    const second = {
      fingerprint: SECOND_FINGERPRINT,
      warrant: null,
      reasoningTier: "high",
      outcome: "retry_requires_warrant",
    } as const;
    const state = (retry: readonly (typeof first | typeof second)[]) => JSON.stringify({
      version: 1,
      trace: [],
      retry,
    });
    const digest = digestFor({
      [RUN_ID]: RUN_REF,
      [FIRST_FINGERPRINT]: FIRST_FINGERPRINT_REF,
      [SECOND_FINGERPRINT]: SECOND_FINGERPRINT_REF,
    });

    const records = projectOutcomes({
      runId: RUN_ID,
      digest,
      events: [
        checkpoint({ runtimeStateJson: state([first]) }, 1),
        checkpoint({ runtimeStateJson: state([first, second]) }, 2),
        checkpoint({ runtimeStateJson: state([first, second]) }, 3),
      ],
    });

    expect(records.map(({ code, fingerprintRef }) => ({ code, fingerprintRef }))).toEqual([
      { code: "admitted", fingerprintRef: FIRST_FINGERPRINT_REF },
      { code: "retry_requires_warrant", fingerprintRef: SECOND_FINGERPRINT_REF },
    ]);
  });

  it("ignores prototype-carried optional values and never evaluates unknown payload fields", () => {
    const inherited = Object.create({
      planningFailure: "DESIGN_CONFLICT",
      runtimeStateJson: JSON.stringify({
        version: 1,
        trace: [],
        retry: [{
          fingerprint: FIRST_FINGERPRINT,
          warrant: "new_evidence",
          reasoningTier: "high",
          outcome: "admitted",
        }],
      }),
    }) as Record<string, unknown>;
    Object.assign(inherited, {
      stage: "execute-explorer",
      status: "failed",
      artifacts: [],
    });
    Object.defineProperty(inherited, "unknownPrivateField", {
      enumerable: true,
      get: () => { throw new Error("unknown field was read"); },
    });
    const inheritedRecommendation = Object.create({
      recommendedMode: "explorer",
      estimatedAgents: 2,
    }) as Record<string, unknown>;

    expect(projectOutcomes({
      runId: RUN_ID,
      digest: digestFor(),
      events: [
        event("journeyCheckpointRecorded", inherited),
        event("executionModeRecommended", inheritedRecommendation, 2),
      ],
    })).toEqual([]);
  });

  it("drops untyped codes and signal families whose required structured source is absent", () => {
    const runtimeStateJson = JSON.stringify({
      version: 1,
      trace: [],
      retry: [],
      grading: { verdict: "weak", findingCount: 7 },
    });

    expect(projectOutcomes({
      runId: RUN_ID,
      digest: digestFor(),
      events: [checkpoint({
        status: "failed",
        planningFailure: "private arbitrary failure prose",
        runtimeStateJson,
        verification: {
          layer: "park-ranger",
          verdict: "repair-required",
          findingCount: 7,
        },
      })],
    })).toEqual([]);
  });

  it("projects every grader verification verdict and ignores other or absent verification layers", () => {
    const graderVerdicts = ["strong", "acceptable", "weak"] as const;

    for (const verdict of graderVerdicts) {
      const records = projectOutcomes({
        runId: RUN_ID,
        digest: digestFor(),
        events: [checkpoint({ verification: { layer: "grader", verdict } })],
      });

      expect(records).toEqual([{
        schemaVersion: 1,
        runRef: RUN_REF,
        recordedAt: RECORDED_AT,
        signal: "grader_score",
        code: verdict,
      }]);
    }

    for (const verification of [
      { layer: "validator", verdict: "PASS" },
      { layer: "park-ranger", verdict: "accept" },
      undefined,
    ] as const) {
      expect(projectOutcomes({
        runId: RUN_ID,
        digest: digestFor(),
        events: [checkpoint(verification === undefined ? {} : { verification })],
      }).filter(({ signal }) => signal === "grader_score")).toEqual([]);
    }
  });

  it("projects exact completion and Park Ranger evidence with event order and one digest per raw slice", () => {
    const findingRef = "f".repeat(64);
    const sliceRefs = {
      "slice\u00001.1": "1".repeat(64),
      "slice\u00002.1": "2".repeat(64),
    };
    const digest = digestFor(sliceRefs);
    const records = projectOutcomes({
      runId: RUN_ID,
      digest,
      events: [
        checkpoint({
          verification: {
            layer: "validator",
            verdict: "PASS",
            completedSlices: [
              { sliceId: "1.1", requirementIds: ["AC-1"] },
              { sliceId: "2.1", requirementIds: ["AC-2"] },
            ],
          },
        }, 10),
        checkpoint({
          verification: {
            layer: "park-ranger",
            verdict: "repair-required",
            findingCount: 1,
            reviewedSliceIds: ["1.1", "2.1"],
            confirmedFindings: [{ findingRef, priority: "P1", sliceIds: ["1.1", "2.1"] }],
          },
        }, 11),
        checkpoint({
          verification: {
            layer: "validator",
            verdict: "PASS",
            completedSlices: [{ sliceId: "1.1", requirementIds: ["AC-1"] }],
          },
        }, 12),
        checkpoint({
          verification: {
            layer: "park-ranger",
            verdict: "repair-required",
            findingCount: 1,
            reviewedSliceIds: ["1.1", "2.1"],
            confirmedFindings: [{ findingRef, priority: "P1", sliceIds: ["1.1", "2.1"] }],
          },
        }, 13),
      ],
    });

    expect(records).toEqual([
      {
        schemaVersion: 1,
        runRef: RUN_REF,
        sliceRef: "1".repeat(64),
        recordedAt: RECORDED_AT,
        sequence: 10,
        signal: "slice_completion",
        code: "complete",
        requirementRefs: ["AC-1"],
      },
      {
        schemaVersion: 1,
        runRef: RUN_REF,
        sliceRef: "2".repeat(64),
        recordedAt: RECORDED_AT,
        sequence: 10,
        signal: "slice_completion",
        code: "complete",
        requirementRefs: ["AC-2"],
      },
      {
        schemaVersion: 1,
        runRef: RUN_REF,
        sliceRef: "1".repeat(64),
        recordedAt: RECORDED_AT,
        sequence: 11,
        signal: "park_ranger_review",
        code: "complete",
      },
      {
        schemaVersion: 1,
        runRef: RUN_REF,
        sliceRef: "2".repeat(64),
        recordedAt: RECORDED_AT,
        sequence: 11,
        signal: "park_ranger_review",
        code: "complete",
      },
      {
        schemaVersion: 1,
        runRef: RUN_REF,
        sliceRef: "1".repeat(64),
        recordedAt: RECORDED_AT,
        sequence: 11,
        signal: "park_ranger_finding",
        code: "P1",
        findingRef,
      },
      {
        schemaVersion: 1,
        runRef: RUN_REF,
        sliceRef: "2".repeat(64),
        recordedAt: RECORDED_AT,
        sequence: 11,
        signal: "park_ranger_finding",
        code: "P1",
        findingRef,
      },
    ]);
    expect(digest.mock.calls.filter(([value]) => value.startsWith("slice\u0000"))).toEqual([
      ["slice\u00001.1"],
      ["slice\u00002.1"],
    ]);
  });

  it("caps records per run deterministically", () => {
    const events = Array.from(
      { length: MAX_OUTCOME_RECORDS_PER_RUN + 25 },
      (_, index) => event("executionModeRecommended", {
        recommendedMode: "explorer",
        workItems: 1,
        estimatedAgents: 2,
      }, index + 1),
    );

    const records = projectOutcomes({ runId: RUN_ID, events, digest: digestFor() });

    expect(records).toHaveLength(MAX_OUTCOME_RECORDS_PER_RUN);
    expect(records.every(Object.isFrozen)).toBe(true);
  });

  it("imports no filesystem, process, worker, or network builtin and has no ambient egress call", async () => {
    const source = await readFile(
      new URL("../src/improvement/outcome-projection.ts", import.meta.url),
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
