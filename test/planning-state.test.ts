import { describe, expect, it } from "vitest";
import {
  COMMAND_SCHEMA_VERSION,
  EVENT_SCHEMA_VERSION,
  parseCommandEnvelope,
  parseEventEnvelope,
  type EventEnvelopeV1,
  type EventType,
} from "../src/contracts/run.js";
import {
  PLAN_REVIEW_APPROVAL,
  PLAN_REVIEW_QUESTION,
  PLANNING_SIGNALS,
  PLANNING_STATES,
  derivePlanningState,
  next,
  type PlanningSignal,
  type PlanningState,
  type PlanningValidationRecord,
} from "../src/journey/planning-state.js";
import {
  decide,
  initialRunState,
  replay,
  type DecideDeps,
  type RunState,
} from "../src/workflow/aggregate.js";

const event = (
  type: EventType,
  payload: Readonly<Record<string, unknown>> = {},
  sequence = 0,
  actor: EventEnvelopeV1["actor"] = "bearing",
): EventEnvelopeV1 => ({
  schemaVersion: 1,
  eventId: `event-${sequence}`,
  runId: "run-1",
  sequence,
  recordedAt: "2026-07-24T00:00:00.000Z",
  type,
  actor,
  sessionId: "session-1",
  correlationId: "correlation-1",
  causationId: `command-${sequence}`,
  commandContentHash: "a".repeat(64),
  payload,
  evidenceRefs: [],
  previousHash: sequence === 0 ? "" : "b".repeat(64),
  hash: "c".repeat(64),
});

const checkpoint = (
  stage: string,
  status: string,
  extra: Readonly<Record<string, unknown>> = {},
  sequence = 0,
): EventEnvelopeV1 => event("journeyCheckpointRecorded", {
  stage,
  status,
  artifacts: [],
  ...extra,
}, sequence);

const deps = (): DecideDeps => {
  let eventNumber = 0;
  return {
    recordedAt: "2026-07-24T00:00:00.000Z",
    nextEventId: () => `event-${++eventNumber}`,
  };
};

function createWorkRequest(dependencies: DecideDeps): RunState {
  const parsed = parseCommandEnvelope({
    schemaVersion: 1,
    commandId: "command-create",
    runId: "run-1",
    expectedRevision: 0,
    type: "createWorkRequest",
    payload: { title: "Work", goal: "Plan it" },
    session: { sessionId: "session-owner", actor: "owner" },
    correlationId: "correlation-1",
  });
  if (!parsed.ok) throw new Error(`create command validation failed: ${parsed.reason}`);
  const created = decide(initialRunState("run-1"), parsed.value, dependencies);
  if (!created.ok) throw new Error(`create command failed: ${created.reason}`);
  return created.state;
}

function persistedReplay(state: RunState): RunState {
  const persisted = JSON.parse(JSON.stringify(state.events)) as unknown[];
  const events = persisted.map((candidate) => {
    const parsed = parseEventEnvelope(candidate);
    if (!parsed.ok) throw new Error(`event validation failed: ${parsed.reason}`);
    return parsed.value;
  });
  return replay(events);
}

const passValidation = (hash = "a".repeat(64)): PlanningValidationRecord => ({
  verdict: "PASS",
  findings: [],
  checkedContentHash: hash,
  currentContentHash: hash,
});

function recordCheckpoint(
  state: RunState,
  payload: Readonly<Record<string, unknown>>,
  dependencies: DecideDeps,
): RunState {
  const parsed = parseCommandEnvelope({
    schemaVersion: 1,
    commandId: `command-checkpoint-${state.revision}`,
    runId: "run-1",
    expectedRevision: state.revision,
    type: "recordJourneyCheckpoint",
    payload,
    session: { sessionId: "session-bearing", actor: "bearing" },
    correlationId: `correlation-${state.revision}`,
  });
  if (!parsed.ok) throw new Error(`checkpoint validation failed: ${parsed.reason}`);
  const recorded = decide(state, parsed.value, dependencies);
  if (!recorded.ok) throw new Error(`checkpoint command failed: ${recorded.reason}`);
  for (const recordedEvent of recorded.events) {
    expect(parseEventEnvelope(recordedEvent).ok).toBe(true);
  }
  return recorded.state;
}

describe("next", () => {
  it("keeps both ledger schemas at version 1", () => {
    expect(COMMAND_SCHEMA_VERSION).toBe(1);
    expect(EVENT_SCHEMA_VERSION).toBe(1);
  });

  it("advances the full legal path without recon", () => {
    const signals: readonly PlanningSignal[] = [
      "requirementsReady",
      "architectureReady",
      "executionPlanReady",
      "planningValidated",
      "ownerApproved",
    ];
    let state: PlanningState = "DRAFT";
    for (const signal of signals) {
      const result = next(state, signal);
      expect(result).not.toBe("illegal_transition");
      state = result as PlanningState;
    }
    expect(state).toBe("OWNER_APPROVED");
  });

  it("advances the full legal path with recon", () => {
    const signals: readonly PlanningSignal[] = [
      "requirementsReady",
      "architectureReady",
      "reconReady",
      "executionPlanReady",
      "planningValidated",
      "ownerApproved",
    ];
    let state: PlanningState = "DRAFT";
    for (const signal of signals) {
      const result = next(state, signal);
      expect(result).not.toBe("illegal_transition");
      state = result as PlanningState;
    }
    expect(state).toBe("OWNER_APPROVED");
  });

  it("accepts exactly the explicitly allowed state and signal edges", () => {
    const allowed = new Map<string, PlanningState>([
      ["DRAFT:requirementsReady", "REQUIREMENTS_READY"],
      ["DRAFT:requirementsGap", "REQUIREMENTS_GAP"],
      ["REQUIREMENTS_READY:architectureReady", "ARCHITECTURE_READY"],
      ["REQUIREMENTS_READY:designConflict", "DESIGN_CONFLICT"],
      ["ARCHITECTURE_READY:reconReady", "RECON_READY"],
      ["ARCHITECTURE_READY:executionPlanReady", "EXECUTION_PLAN_READY"],
      ["ARCHITECTURE_READY:reconFailed", "RECON_FAILED"],
      ["ARCHITECTURE_READY:missingValidation", "MISSING_VALIDATION"],
      ["ARCHITECTURE_READY:unsafeParallelism", "UNSAFE_PARALLELISM"],
      ["ARCHITECTURE_READY:ownerDecisionRequired", "OWNER_DECISION_REQUIRED"],
      ["RECON_READY:executionPlanReady", "EXECUTION_PLAN_READY"],
      ["RECON_READY:missingValidation", "MISSING_VALIDATION"],
      ["RECON_READY:unsafeParallelism", "UNSAFE_PARALLELISM"],
      ["RECON_READY:ownerDecisionRequired", "OWNER_DECISION_REQUIRED"],
      ["EXECUTION_PLAN_READY:planningValidated", "PLANNING_VALIDATED"],
      ["EXECUTION_PLAN_READY:missingValidation", "MISSING_VALIDATION"],
      ["EXECUTION_PLAN_READY:unsafeParallelism", "UNSAFE_PARALLELISM"],
      ["EXECUTION_PLAN_READY:ownerDecisionRequired", "OWNER_DECISION_REQUIRED"],
      ["PLANNING_VALIDATED:ownerApproved", "OWNER_APPROVED"],
      ["REQUIREMENTS_GAP:requirementsReady", "REQUIREMENTS_READY"],
      ["DESIGN_CONFLICT:architectureReady", "ARCHITECTURE_READY"],
      ["RECON_FAILED:reconReady", "RECON_READY"],
      ["MISSING_VALIDATION:executionPlanReady", "EXECUTION_PLAN_READY"],
      ["MISSING_VALIDATION:planningValidated", "PLANNING_VALIDATED"],
      ["UNSAFE_PARALLELISM:executionPlanReady", "EXECUTION_PLAN_READY"],
      ["UNSAFE_PARALLELISM:planningValidated", "PLANNING_VALIDATED"],
      ["OWNER_DECISION_REQUIRED:executionPlanReady", "EXECUTION_PLAN_READY"],
      ["OWNER_DECISION_REQUIRED:planningValidated", "PLANNING_VALIDATED"],
    ]);

    for (const state of PLANNING_STATES) {
      for (const signal of PLANNING_SIGNALS) {
        expect(next(state, signal), `${state} + ${signal}`).toBe(
          allowed.get(`${state}:${signal}`) ?? "illegal_transition",
        );
      }
    }
  });
});

describe("derivePlanningState", () => {
  it("gates a restored validated checkpoint on its recorded PASS and current-content hash", () => {
    const dependencies = deps();
    let state = createWorkRequest(dependencies);
    state = recordCheckpoint(state, {
      stage: "gather-supplies",
      status: "complete",
      artifacts: [],
      planningState: "REQUIREMENTS_READY",
    }, dependencies);
    state = recordCheckpoint(state, {
      stage: "map-route",
      status: "complete",
      artifacts: [],
      planningState: "EXECUTION_PLAN_READY",
    }, dependencies);
    state = recordCheckpoint(state, {
      stage: "draft-implementation",
      status: "complete",
      artifacts: [],
      planningState: "PLANNING_VALIDATED",
      lastResultJson: JSON.stringify({
        status: "action",
        summary: "validated",
        artifacts: ["docs/plans/import/implementation.md"],
        tokens: 1,
        planningValidation: passValidation(),
      }),
    }, dependencies);

    expect(derivePlanningState(persistedReplay(state).events)).toBe("PLANNING_VALIDATED");

    const stale = state.events.map((entry) => entry.type === "journeyCheckpointRecorded" && entry.payload.planningState === "PLANNING_VALIDATED"
      ? {
        ...entry,
        payload: {
          ...entry.payload,
          lastResultJson: JSON.stringify({
            status: "action",
            planningValidation: { ...passValidation(), currentContentHash: "b".repeat(64) },
          }),
        },
      }
      : entry);
    expect(derivePlanningState(stale)).toBe("EXECUTION_PLAN_READY");

    const unvalidated = state.events.map((entry) => entry.type === "journeyCheckpointRecorded" && entry.payload.planningState === "PLANNING_VALIDATED"
      ? { ...entry, payload: { ...entry.payload, lastResultJson: undefined } }
      : entry);
    expect(derivePlanningState(unvalidated)).toBe("EXECUTION_PLAN_READY");
  });

  it("replays a composite map-route checkpoint through its structural states before validation", () => {
    expect(derivePlanningState([
      event("workRequestCreated", { title: "Work", goal: "Plan it" }),
      checkpoint("gather-supplies", "complete", { planningState: "REQUIREMENTS_READY" }, 1),
      checkpoint("map-route", "waiting", {
        planningState: "PLANNING_VALIDATED",
        lastResultJson: JSON.stringify({ planningValidation: passValidation() }),
      }, 2),
    ])).toBe("PLANNING_VALIDATED");
  });

  it("replays a Recon checkpoint between architecture and drafting", () => {
    expect(derivePlanningState([
      event("workRequestCreated", { title: "Work", goal: "Plan it" }),
      checkpoint("gather-supplies", "complete", { planningState: "REQUIREMENTS_READY" }, 1),
      checkpoint("map-route", "complete", { planningState: "ARCHITECTURE_READY" }, 2),
      checkpoint("recon", "complete", { planningState: "RECON_READY" }, 3),
      checkpoint("draft-implementation", "complete", {
        planningState: "PLANNING_VALIDATED",
        lastResultJson: JSON.stringify({ planningValidation: passValidation() }),
      }, 4),
    ])).toBe("PLANNING_VALIDATED");
  });

  it("replays a pre-Recon v1 ledger unchanged", () => {
    expect(derivePlanningState([
      event("workRequestCreated", { title: "Work", goal: "Plan it" }),
      checkpoint("gather-supplies", "complete", {}, 1),
      checkpoint("map-route", "complete", {}, 2),
      checkpoint("draft-implementation", "complete", {
        lastResultJson: JSON.stringify({ planningValidation: passValidation() }),
      }, 3),
    ])).toBe("PLANNING_VALIDATED");
  });

  it("replays a non-PASS validation state from a waiting browser checkpoint", () => {
    expect(derivePlanningState([
      event("workRequestCreated", { title: "Work", goal: "Plan it" }),
      checkpoint("gather-supplies", "complete", { planningState: "REQUIREMENTS_READY" }, 1),
      checkpoint("map-route", "waiting", {
        planningFailure: "MISSING_VALIDATION",
        lastResultJson: JSON.stringify({
          planningValidation: {
            verdict: "NEEDS_AMENDMENT",
            findings: [{ code: "validation_missing" }],
            checkedContentHash: "a".repeat(64),
            currentContentHash: "a".repeat(64),
          },
        }),
      }, 2),
    ])).toBe("MISSING_VALIDATION");
  });

  it("records repository fit without advancing the derived planning state", () => {
    const dependencies = deps();
    const before = createWorkRequest(dependencies);
    const fitted = recordCheckpoint(before, {
      stage: "repository-fit",
      status: "complete",
      artifacts: [],
      repositoryFitDecision: {
        outcome: "confirmed",
        planDirectory: "docs/plans/server-spine",
        repository: "/workspace/repository",
        decidedAt: "2026-07-25T00:00:00.000Z",
      },
      resolvedPlanDirectory: "docs/plans/server-spine",
    }, dependencies);

    expect(derivePlanningState(fitted.events)).toBe(derivePlanningState(before.events));
    expect(derivePlanningState(persistedReplay(fitted).events)).toBe("DRAFT");
  });

  it("reaches owner approval only after the full successful planning path", () => {
    const approval = event("executionModeApproved", {
      recommendationEventId: "recommendation-1",
      selectedMode: "explorer",
      overridden: false,
    }, 5);
    const events = [
      event("workRequestCreated", { title: "Work", goal: "Plan it" }),
      checkpoint("set-bearings", "complete", {}, 1),
      checkpoint("gather-supplies", "complete", {}, 2),
      checkpoint("map-route", "complete", {}, 3),
      checkpoint("draft-implementation", "complete", {
        lastResultJson: JSON.stringify({ planningValidation: passValidation() }),
      }, 4),
      approval,
      event("decisionRequired", {
        decisionId: "plan-review-1",
        question: PLAN_REVIEW_QUESTION,
      }, 6),
      event("ownerAnswered", {
        decisionId: "plan-review-1",
        answer: PLAN_REVIEW_APPROVAL,
      }, 7, "owner"),
    ];

    expect(derivePlanningState(events)).toBe("OWNER_APPROVED");
    expect(derivePlanningState([events[0], approval])).toBe("DRAFT");
  });

  it("does not accept owner approval from a checkpoint marker", () => {
    const planned = [
      event("workRequestCreated", { title: "Work", goal: "Plan it" }),
      checkpoint("gather-supplies", "complete", {}, 1),
      checkpoint("map-route", "complete", {}, 2),
      checkpoint("draft-implementation", "complete", {
        lastResultJson: JSON.stringify({ planningValidation: passValidation() }),
      }, 3),
    ];
    const marker = checkpoint("draft-implementation", "waiting", {
      planningState: "OWNER_APPROVED",
      lastResultJson: JSON.stringify({ planningValidation: passValidation() }),
    }, 4);

    expect(derivePlanningState([...planned, marker])).toBe("PLANNING_VALIDATED");
    expect(derivePlanningState([
      ...planned,
      marker,
      event("executionModeApproved", {
        recommendationEventId: "recommendation-1",
        selectedMode: "explorer",
        overridden: false,
      }, 5),
      event("decisionRequired", {
        decisionId: "plan-review-1",
        question: PLAN_REVIEW_QUESTION,
      }, 6),
      event("ownerAnswered", {
        decisionId: "plan-review-1",
        answer: PLAN_REVIEW_APPROVAL,
      }, 7, "owner"),
    ])).toBe("OWNER_APPROVED");
  });

  it("honors an explicit planning marker independently of checkpoint status", () => {
    expect(derivePlanningState([
      checkpoint("gather-supplies", "waiting", { planningState: "REQUIREMENTS_READY" }),
      checkpoint("map-route", "waiting", { planningState: "ARCHITECTURE_READY" }, 1),
    ])).toBe("ARCHITECTURE_READY");
  });

  it.each([
    ["REQUIREMENTS_GAP", "gather-supplies"],
    ["DESIGN_CONFLICT", "map-route"],
    ["RECON_FAILED", "map-route"],
    ["MISSING_VALIDATION", "draft-implementation"],
    ["UNSAFE_PARALLELISM", "draft-implementation"],
    ["OWNER_DECISION_REQUIRED", "draft-implementation"],
  ] as const)("derives %s from a failed checkpoint", (planningFailure, stage) => {
    expect(derivePlanningState([
      event("workRequestCreated", { title: "Work", goal: "Plan it" }),
      checkpoint(stage, "failed", { planningFailure }, 1),
    ])).toBe(planningFailure);
  });

  it("derives every happy-path ledger marker", () => {
    const events = [
      event("workRequestCreated", { title: "Work", goal: "Plan it" }),
      checkpoint("gather-supplies", "complete", {}, 1),
      checkpoint("map-route", "complete", {}, 2),
      checkpoint("draft-implementation", "complete", {
        lastResultJson: JSON.stringify({ planningValidation: passValidation() }),
      }, 3),
      checkpoint("draft-implementation", "complete", {
        planningState: "PLANNING_VALIDATED",
        lastResultJson: JSON.stringify({ planningValidation: passValidation() }),
      }, 4),
      event("executionModeApproved", {
        recommendationEventId: "recommendation-1",
        selectedMode: "explorer",
        overridden: false,
      }, 5),
      event("decisionRequired", {
        decisionId: "plan-review-1",
        question: PLAN_REVIEW_QUESTION,
      }, 6),
      event("ownerAnswered", {
        decisionId: "plan-review-1",
        answer: PLAN_REVIEW_APPROVAL,
      }, 7, "owner"),
    ];

    expect(derivePlanningState(events)).toBe("OWNER_APPROVED");
  });

  it.each(PLANNING_STATES.filter((state) => state !== "PLANNING_VALIDATED" && state !== "OWNER_APPROVED"))("does not approve directly from %s", (state) => {
    const events = [
      checkpoint("draft-implementation", "waiting", { planningState: state }),
      event("executionModeApproved", {
        recommendationEventId: "recommendation-1",
        selectedMode: "explorer",
        overridden: false,
      }, 1),
    ];

    expect(derivePlanningState(events)).toBe(state);
  });

  it("is deterministic and respects event order", () => {
    const failedThenRecovered = [
      checkpoint("draft-implementation", "failed", { planningFailure: "MISSING_VALIDATION" }),
      checkpoint("draft-implementation", "complete", {
        planningState: "PLANNING_VALIDATED",
        lastResultJson: JSON.stringify({ planningValidation: passValidation() }),
      }, 1),
    ];
    const recoveredThenFailed = [...failedThenRecovered].reverse();

    expect(derivePlanningState(failedThenRecovered)).toBe("PLANNING_VALIDATED");
    expect(derivePlanningState(failedThenRecovered)).toBe(
      derivePlanningState(failedThenRecovered),
    );
    expect(derivePlanningState(recoveredThenFailed)).toBe("MISSING_VALIDATION");
  });

  it("ignores malformed and unknown events without corrupting state", () => {
    const events: readonly unknown[] = [
      checkpoint("gather-supplies", "complete"),
      null,
      { type: "futureEvent", payload: {} },
      { type: "journeyCheckpointRecorded", payload: "malformed" },
      { type: "executionModeApproved", payload: {} },
      { type: "workRequestCreated", payload: {} },
      { type: "journeyCheckpointRecorded", payload: { status: "failed", planningFailure: "UNKNOWN" } },
    ];

    expect(() => derivePlanningState(events)).not.toThrow();
    expect(derivePlanningState(events)).toBe("REQUIREMENTS_READY");
  });

  it("derives the canonical planning marker after validated ledger replay", () => {
    const dependencies = deps();
    let state = createWorkRequest(dependencies);
    state = recordCheckpoint(state, {
      stage: "gather-supplies",
      status: "complete",
      artifacts: [],
      planningState: "REQUIREMENTS_READY",
    }, dependencies);
    state = recordCheckpoint(state, {
      stage: "map-route",
      status: "complete",
      artifacts: [],
      planningState: "EXECUTION_PLAN_READY",
    }, dependencies);
    state = recordCheckpoint(state, {
      stage: "draft-implementation",
      status: "complete",
      artifacts: [],
      planningState: "PLANNING_VALIDATED",
      lastResultJson: JSON.stringify({ planningValidation: passValidation() }),
    }, dependencies);

    const replayed = persistedReplay(state);

    expect(derivePlanningState(replayed.events)).toBe("PLANNING_VALIDATED");
  });

  it("keeps live and replayed state deterministic for inherited planning failure", () => {
    const dependencies = deps();
    const state = createWorkRequest(dependencies);
    const payload = Object.assign(Object.create({
      planningFailure: "MISSING_VALIDATION",
    }), {
      stage: "draft-implementation",
      status: "failed",
      artifacts: [],
    });
    const parsed = parseCommandEnvelope({
      schemaVersion: 1,
      commandId: "command-checkpoint",
      runId: "run-1",
      expectedRevision: state.revision,
      type: "recordJourneyCheckpoint",
      payload,
      session: { sessionId: "session-bearing", actor: "bearing" },
      correlationId: "correlation-1",
    });

    expect(parsed.ok).toBe(false);
    expect(derivePlanningState(state.events)).toBe("DRAFT");
    expect(derivePlanningState(persistedReplay(state).events)).toBe("DRAFT");
  });

  it("ignores inherited checkpoint properties during projection", () => {
    const payload = Object.assign(Object.create({
      planningFailure: "MISSING_VALIDATION",
    }), {
      stage: "draft-implementation",
      status: "failed",
      artifacts: [],
    });
    const live = [{ type: "journeyCheckpointRecorded", payload }];
    const replayed = JSON.parse(JSON.stringify(live)) as unknown[];

    expect(derivePlanningState(live)).toBe(derivePlanningState(replayed));
    expect(derivePlanningState(live)).toBe("DRAFT");
    expect(derivePlanningState(replayed)).toBe("DRAFT");
  });
});
