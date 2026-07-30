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
      "surveyor_failure",
      "reasoning_effectiveness",
      "concurrency_conflict",
      "coordination",
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
      surveyor_failure: ["failed", "blocked", "deviated"],
      reasoning_effectiveness: ["complete", "failed"],
      concurrency_conflict: [
        "write_set_conflict",
        "shared_file",
        "unstable_test",
        "repeated_integration_failure",
      ],
      coordination: ["explorer", "expedition"],
    });
    expect(Object.isFrozen(OUTCOME_SIGNALS)).toBe(true);
    expect(Object.isFrozen(OUTCOME_CODES)).toBe(true);
    for (const codes of Object.values(OUTCOME_CODES)) expect(Object.isFrozen(codes)).toBe(true);
    expect(MAX_OUTCOME_RECORDS_PER_RUN).toBe(1_000);
    expect(MAX_OUTCOME_PATH_REFS).toBe(16);
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
      value: 8,
    }]);
    expect(Object.isFrozen(records)).toBe(true);
    expect(Object.isFrozen(records[0])).toBe(true);
    expect(JSON.stringify(records)).not.toContain("private coordination prose");
    expect(digest).toHaveBeenCalledTimes(1);
    expect(digest).toHaveBeenCalledWith(RUN_ID);
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

  it("caps records per run deterministically", () => {
    const events = Array.from(
      { length: MAX_OUTCOME_RECORDS_PER_RUN + 25 },
      (_, index) => event("executionModeRecommended", {
        recommendedMode: "explorer",
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
