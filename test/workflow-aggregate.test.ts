import { describe, expect, it } from "vitest";
import {
  hashCommand,
  hashEvent,
  parseCommandEnvelope,
  parseEventEnvelope,
  type CommandEnvelopeV1,
  type EventEnvelopeV1,
} from "../src/contracts/run.js";
import {
  decide,
  initialRunState,
  replay,
  type DecideDeps,
} from "../src/workflow/aggregate.js";

const RUN_ID = "run-1";
const SESSION = { sessionId: "sess-1", actor: "owner" };

function deps(): DecideDeps & { recordedAt: string } {
  let n = 0;
  return { recordedAt: "2026-07-19T00:00:00Z", nextEventId: () => `evt-${++n}` };
}

function envelope(
  overrides: Partial<CommandEnvelopeV1> & { commandId: string; type: CommandEnvelopeV1["type"] },
): CommandEnvelopeV1 {
  const base = {
    schemaVersion: 1 as const,
    runId: RUN_ID,
    expectedRevision: 0,
    session: SESSION,
    correlationId: "corr-1",
  };
  switch (overrides.type) {
    case "createWorkRequest":
      return { ...base, payload: { title: "t", goal: "g" }, ...overrides } as CommandEnvelopeV1;
    case "requireDecision":
      return {
        ...base,
        payload: { decisionId: "dec-1", question: "q?", consequential: true as const },
        ...overrides,
      } as CommandEnvelopeV1;
    case "recordOwnerAnswer":
      return {
        ...base,
        payload: { decisionId: "dec-1", answer: "yes" },
        ...overrides,
      } as CommandEnvelopeV1;
    default:
      throw new Error(`unsupported test command type: ${overrides.type}`);
    case "recommendExecutionMode":
      return { ...base, payload: { workItems: 2, maxCrewmatesPerExplorer: 3, perAgentTokenEstimate: 10 }, ...overrides } as CommandEnvelopeV1;
    case "approveExecutionMode":
      return { ...base, payload: { recommendationEventId: "evt-2" }, ...overrides } as CommandEnvelopeV1;
    case "overrideExecutionMode":
      return { ...base, payload: { recommendationEventId: "evt-2", selectedMode: "expedition" }, ...overrides } as CommandEnvelopeV1;
  }
}

describe("legal flow", () => {
  it("create → require → answer emits ordered events and clears the pending decision", () => {
    let state = initialRunState(RUN_ID);
    const d = deps();

    const create = envelope({ commandId: "c1", type: "createWorkRequest" });
    const r1 = decide(state, create, d);
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    state = r1.state;
    expect(state.revision).toBe(1);
    expect(state.workRequestCreated).toBe(true);
    expect(state.pendingDecision).toBeNull();
    expect(r1.events.map((e) => e.type)).toEqual(["workRequestCreated"]);
    expect(r1.events[0].sequence).toBe(1);
    expect(r1.events[0].previousHash).toBe("");
    const { hash: _h0, ...body0 } = r1.events[0];
    expect(r1.events[0].hash).toBe(hashEvent(body0 as never));

    const require = envelope({ commandId: "c2", type: "requireDecision", expectedRevision: 1 });
    const r2 = decide(state, require, d);
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    state = r2.state;
    expect(state.revision).toBe(2);
    expect(state.pendingDecision).toEqual({ decisionId: "dec-1", question: "q?" });
    expect(r2.events[0].previousHash).toBe(r1.events[0].hash);

    const answer = envelope({ commandId: "c3", type: "recordOwnerAnswer", expectedRevision: 2 });
    const r3 = decide(state, answer, d);
    expect(r3.ok).toBe(true);
    if (!r3.ok) return;
    state = r3.state;
    expect(state.revision).toBe(3);
    expect(state.pendingDecision).toBeNull();
    expect(r3.events[0].type).toBe("ownerAnswered");
  });
});

describe("idempotency", () => {
  it("identical duplicate commandId returns the prior outcome with no new events", () => {
    let state = initialRunState(RUN_ID);
    const d = deps();
    const create = envelope({ commandId: "c1", type: "createWorkRequest" });
    const r1 = decide(state, create, d);
    if (!r1.ok) throw new Error("expected ok");
    state = r1.state;

    const dup = decide(state, create, d);
    expect(dup.ok).toBe(true);
    if (!dup.ok) return;
    expect(dup.events).toEqual([]);
    expect(dup.outcome).toEqual(r1.outcome);
    expect(dup.state).toBe(state);
  });

  it("same commandId with different content is a conflict", () => {
    let state = initialRunState(RUN_ID);
    const d = deps();
    const r1 = decide(state, envelope({ commandId: "c1", type: "createWorkRequest" }), d);
    if (!r1.ok) throw new Error("expected ok");
    state = r1.state;

    const conflictCmd: CommandEnvelopeV1 = {
      schemaVersion: 1,
      commandId: "c1",
      runId: RUN_ID,
      expectedRevision: 0,
      type: "createWorkRequest",
      payload: { title: "other", goal: "g" },
      session: SESSION,
      correlationId: "corr-1",
    };
    const conflict = decide(state, conflictCmd, d);
    expect(conflict).toEqual({ ok: false, reason: "conflicting_duplicate", state });
  });
});

describe("revision guard", () => {
  it("a command whose expectedRevision differs from current is stale and does not advance state", () => {
    const state = initialRunState(RUN_ID);
    const d = deps();
    const r = decide(
      state,
      envelope({ commandId: "c1", type: "createWorkRequest", expectedRevision: 9 }),
      d,
    );
    expect(r).toEqual({ ok: false, reason: "stale_revision", state });
  });
});

describe("pending-decision gating", () => {
  function pendingState() {
    const d = deps();
    let state = initialRunState(RUN_ID);
    state = decide(state, envelope({ commandId: "c1", type: "createWorkRequest" }), d).state;
    state = decide(
      state,
      envelope({ commandId: "c2", type: "requireDecision", expectedRevision: 1 }),
      d,
    ).state;
    return state;
  }

  it("rejects a requireDecision while a decision is pending", () => {
    const state = pendingState();
    const r = decide(
      state,
      envelope({ commandId: "cx", type: "requireDecision", expectedRevision: 2 }),
      deps(),
    );
    expect(r).toEqual({ ok: false, reason: "pending_decision_blocks", state });
  });

  it("rejects a createWorkRequest while a decision is pending", () => {
    const state = pendingState();
    const r = decide(
      state,
      envelope({ commandId: "cx", type: "createWorkRequest", expectedRevision: 2 }),
      deps(),
    );
    expect(r).toEqual({ ok: false, reason: "pending_decision_blocks", state });
  });

  it("rejects an owner answer for the wrong decision id", () => {
    const state = pendingState();
    const wrongCmd: CommandEnvelopeV1 = {
      schemaVersion: 1,
      commandId: "cx",
      runId: RUN_ID,
      expectedRevision: 2,
      type: "recordOwnerAnswer",
      payload: { decisionId: "dec-other", answer: "yes" },
      session: SESSION,
      correlationId: "corr-1",
    };
    const r = decide(state, wrongCmd, deps());
    expect(r).toEqual({ ok: false, reason: "wrong_decision_id", state });
  });

  it("rejects a non-owner answer to the active decision", () => {
    const state = pendingState();
    const r = decide(
      state,
      envelope({
        commandId: "cx",
        type: "recordOwnerAnswer",
        expectedRevision: 2,
        session: { sessionId: "sess-1", actor: "agent" },
      }),
      deps(),
    );
    expect(r).toEqual({ ok: false, reason: "non_owner_answer", state });
  });

  it("rejects an owner answer when no decision is pending", () => {
    const d = deps();
    let state = initialRunState(RUN_ID);
    state = decide(state, envelope({ commandId: "c1", type: "createWorkRequest" }), d).state;
    const r = decide(
      state,
      envelope({ commandId: "cx", type: "recordOwnerAnswer", expectedRevision: 1 }),
      deps(),
    );
    expect(r).toEqual({ ok: false, reason: "pending_decision_blocks", state });
  });
});

describe("illegal transitions", () => {
  it("cannot create a second work request", () => {
    const d = deps();
    let state = initialRunState(RUN_ID);
    state = decide(state, envelope({ commandId: "c1", type: "createWorkRequest" }), d).state;
    const r = decide(
      state,
      envelope({ commandId: "c2", type: "createWorkRequest", expectedRevision: 1 }),
      d,
    );
    expect(r).toEqual({ ok: false, reason: "illegal_transition", state });
  });

  it("cannot require a decision before a work request exists", () => {
    const state = initialRunState(RUN_ID);
    const r = decide(
      state,
      envelope({ commandId: "c1", type: "requireDecision" }),
      deps(),
    );
    expect(r).toEqual({ ok: false, reason: "illegal_transition", state });
  });
});

describe("boundary parsing", () => {
  it("rejects malformed command envelopes", () => {
    expect(parseCommandEnvelope(null).ok).toBe(false);
    expect(parseCommandEnvelope({}).ok).toBe(false);
    expect(
      parseCommandEnvelope({ schemaVersion: 1, type: "createWorkRequest" }).ok,
    ).toBe(false);
    expect(
      parseCommandEnvelope({
        schemaVersion: 1,
        commandId: "c1",
        runId: RUN_ID,
        expectedRevision: 0,
        type: "createWorkRequest",
        payload: { title: "t", goal: "g" },
        session: SESSION,
        correlationId: "corr-1",
      }).ok,
    ).toBe(true);
  });

  it("rejects a future-schema command envelope", () => {
    const r = parseCommandEnvelope({ schemaVersion: 2 });
    expect(r).toEqual({ ok: false, reason: "future_schema" });
  });

  it("accepts only bounded UUID provider sessions in journey checkpoints", () => {
    const checkpoint = {
      schemaVersion: 1,
      commandId: "checkpoint-1",
      runId: RUN_ID,
      expectedRevision: 1,
      type: "recordJourneyCheckpoint",
      payload: { stage: "gather-supplies", status: "waiting", artifacts: [], providerSessionId: "019f8d4e-a637-7e71-8c76-af9d7ec91adf" },
      session: SESSION,
      correlationId: "corr-1",
    };
    expect(parseCommandEnvelope(checkpoint).ok).toBe(true);
    expect(parseCommandEnvelope({ ...checkpoint, payload: { ...checkpoint.payload, providerSessionId: "../../foreign-session" } }).ok).toBe(false);
  });

  it("rejects malformed and future-schema event envelopes", () => {
    expect(parseEventEnvelope(null).ok).toBe(false);
    const future = parseEventEnvelope({ schemaVersion: 7 });
    expect(future.ok).toBe(false);
    if (future.ok) throw new Error("expected future schema rejection");
    expect(future.reason).toBe("future_schema");
  });
});

describe("replay equality", () => {
  it("replaying the event stream reconstructs an equal state", () => {
    const d = deps();
    let state = initialRunState(RUN_ID);
    state = decide(state, envelope({ commandId: "c1", type: "createWorkRequest" }), d).state;
    state = decide(
      state,
      envelope({ commandId: "c2", type: "requireDecision", expectedRevision: 1 }),
      d,
    ).state;
    state = decide(
      state,
      envelope({ commandId: "c3", type: "recordOwnerAnswer", expectedRevision: 2 }),
      d,
    ).state;

    const replayed = replay(state.events);
    expect(replayed.revision).toBe(state.revision);
    expect(replayed.workRequestCreated).toBe(state.workRequestCreated);
    expect(replayed.pendingDecision).toEqual(state.pendingDecision);
    expect(replayed.events).toEqual(state.events);
    expect([...replayed.outcomes]).toEqual([...state.outcomes]);

    const identical = decide(replayed, envelope({ commandId: "c1", type: "createWorkRequest" }), d);
    expect(identical.ok && identical.events).toEqual([]);
    const conflicting = decide(
      replayed,
      envelope({ commandId: "c1", type: "createWorkRequest", payload: { title: "other", goal: "g" } }),
      d,
    );
    expect(conflicting.ok ? "ok" : conflicting.reason).toBe("conflicting_duplicate");
  });

  it("replay over an empty stream yields the initial state", () => {
    const s = replay([]);
    expect(s.revision).toBe(0);
    expect(s.events).toEqual([]);
    expect(s.pendingDecision).toBeNull();
  });

  it("rejects illegal semantic histories", () => {
    const d = deps();
    const create = decide(initialRunState(RUN_ID), envelope({ commandId: "c1", type: "createWorkRequest" }), d);
    if (!create.ok) throw new Error("expected create");
    const require = decide(create.state, envelope({ commandId: "c2", type: "requireDecision", expectedRevision: 1 }), d);
    if (!require.ok) throw new Error("expected decision");
    const answer = decide(require.state, envelope({ commandId: "c3", type: "recordOwnerAnswer", expectedRevision: 2 }), d);
    if (!answer.ok) throw new Error("expected answer");

    expect(() => replay([require.events[0]])).toThrow();
    expect(() => replay([create.events[0], create.events[0]])).toThrow();
    expect(() => replay([create.events[0], require.events[0], require.events[0]])).toThrow();
    expect(() => replay([create.events[0], answer.events[0]])).toThrow();
    expect(() => replay([create.events[0], require.events[0], { ...answer.events[0], actor: "agent" }])).toThrow();
    expect(() => replay([create.events[0], require.events[0], { ...answer.events[0], payload: { decisionId: "other", answer: "yes" } }])).toThrow();
  });
});

describe("hash chain", () => {
  it("every event hash recomputes from its body and chains previousHash", () => {
    const d = deps();
    let state = initialRunState(RUN_ID);
    state = decide(state, envelope({ commandId: "c1", type: "createWorkRequest" }), d).state;
    state = decide(
      state,
      envelope({ commandId: "c2", type: "requireDecision", expectedRevision: 1 }),
      d,
    ).state;

    let prev = "";
    for (const e of state.events) {
      const { hash: _h, ...body } = e;
      expect(e.previousHash).toBe(prev);
      expect(e.hash).toBe(hashEvent(body as never));
      prev = e.hash;
    }
  });
});

describe("command content hash", () => {
  it("ignores commandId but includes everything else", () => {
    const a = envelope({ commandId: "c1", type: "createWorkRequest" });
    const b = { ...a, commandId: "c2" };
    const c = { ...a, correlationId: "corr-2" };
    expect(hashCommand(a)).toBe(hashCommand(b));
    expect(hashCommand(a)).not.toBe(hashCommand(c));
  });
});

// --- Slice 3.4: frozen pre-Phase-3 event corpus ------------------------------
// Captured from the pre-Phase-3 code path (the tracked build output at commit
// ea763c4, which predates every Phase 3 selection slice) and committed as data
// before aggregate.ts was touched. Regenerating these events with the new code
// would only prove that the new code agrees with itself.

const FROZEN_APPROVED_RUN = [
    {
      "schemaVersion": 1,
      "eventId": "event-1",
      "runId": "run-legacy-approved",
      "sequence": 1,
      "recordedAt": "2026-07-20T00:00:00.000Z",
      "type": "workRequestCreated",
      "actor": "owner",
      "sessionId": "session-owner",
      "correlationId": "correlation-legacy",
      "causationId": "command-create",
      "commandContentHash": "2052b6a3fd7b9599a2a62508db9234912845c9bf12788bf2143382ee4c3d0f75",
      "payload": {
        "title": "Legacy run",
        "goal": "Replay unchanged"
      },
      "evidenceRefs": [],
      "previousHash": "",
      "hash": "e24065b7c9775f477dd40073e8ab9784a121c1aac23f6bfc2887da1bb12292ea"
    },
    {
      "schemaVersion": 1,
      "eventId": "event-2",
      "runId": "run-legacy-approved",
      "sequence": 2,
      "recordedAt": "2026-07-20T00:00:00.000Z",
      "type": "executionModeRecommended",
      "actor": "owner",
      "sessionId": "session-owner",
      "correlationId": "correlation-legacy",
      "causationId": "command-recommend",
      "commandContentHash": "d24452c73508eecb1932df7c14232bdd4c669dc797eb368137e48fb035e2cc41",
      "payload": {
        "workItems": 2,
        "maxCrewmatesPerExplorer": 3,
        "perAgentTokenEstimate": 10,
        "recommendedMode": "explorer",
        "selectedMode": "explorer",
        "overridden": false,
        "estimatedAgents": 3,
        "estimatedTokens": 30,
        "tradeoffs": {
          "tokens": "lower manager token overhead",
          "coordination": "one Explorer coordinates all Crewmates"
        },
        "launchAuthorized": false
      },
      "evidenceRefs": [],
      "previousHash": "e24065b7c9775f477dd40073e8ab9784a121c1aac23f6bfc2887da1bb12292ea",
      "hash": "5fa877e3f4a5b7de983223d401bc976a0bb23fef88f7f2f417aa8406c4025b7e"
    },
    {
      "schemaVersion": 1,
      "eventId": "event-3",
      "runId": "run-legacy-approved",
      "sequence": 3,
      "recordedAt": "2026-07-20T00:00:00.000Z",
      "type": "executionModeApproved",
      "actor": "owner",
      "sessionId": "session-owner",
      "correlationId": "correlation-legacy",
      "causationId": "command-decision",
      "commandContentHash": "7c0dd31a4029a5ad640f2e675e331b9dafc006efa9d9710cbb099f3d8b2f8f25",
      "payload": {
        "recommendationEventId": "event-2",
        "selectedMode": "explorer",
        "overridden": false
      },
      "evidenceRefs": [],
      "previousHash": "5fa877e3f4a5b7de983223d401bc976a0bb23fef88f7f2f417aa8406c4025b7e",
      "hash": "332b74b71d7c4d3500f47d4236de635dce51958ad6404ecec28a11927765bef6"
    }
  ] as unknown as readonly EventEnvelopeV1[];

const FROZEN_OVERRIDDEN_RUN = [
    {
      "schemaVersion": 1,
      "eventId": "event-1",
      "runId": "run-legacy-overridden",
      "sequence": 1,
      "recordedAt": "2026-07-20T00:00:00.000Z",
      "type": "workRequestCreated",
      "actor": "owner",
      "sessionId": "session-owner",
      "correlationId": "correlation-legacy",
      "causationId": "command-create",
      "commandContentHash": "82c2820db631f610afd2dca362d235197bfc7d87c77155ef383e26604fec6a0e",
      "payload": {
        "title": "Legacy run",
        "goal": "Replay unchanged"
      },
      "evidenceRefs": [],
      "previousHash": "",
      "hash": "2ca35b6c83a241d6f6eb38ef0cfff8a8f64507db58859a1d3762624980898a66"
    },
    {
      "schemaVersion": 1,
      "eventId": "event-2",
      "runId": "run-legacy-overridden",
      "sequence": 2,
      "recordedAt": "2026-07-20T00:00:00.000Z",
      "type": "executionModeRecommended",
      "actor": "owner",
      "sessionId": "session-owner",
      "correlationId": "correlation-legacy",
      "causationId": "command-recommend",
      "commandContentHash": "59c0055ee4cf0e3681e32476d271a8c342219684c4d7e6dfb4edb8c3a7df7307",
      "payload": {
        "workItems": 5,
        "maxCrewmatesPerExplorer": 2,
        "perAgentTokenEstimate": 1000,
        "recommendedMode": "expedition",
        "selectedMode": "expedition",
        "overridden": false,
        "estimatedAgents": 9,
        "estimatedTokens": 9000,
        "tradeoffs": {
          "tokens": "higher Navigator and Explorer token overhead",
          "coordination": "bounded Explorer groups reduce coordination fan-out"
        },
        "launchAuthorized": false
      },
      "evidenceRefs": [],
      "previousHash": "2ca35b6c83a241d6f6eb38ef0cfff8a8f64507db58859a1d3762624980898a66",
      "hash": "92dc33f249aba7f04ebbd8b18527011f8fff1c4072ef98f5fcfe16066809e39f"
    },
    {
      "schemaVersion": 1,
      "eventId": "event-3",
      "runId": "run-legacy-overridden",
      "sequence": 3,
      "recordedAt": "2026-07-20T00:00:00.000Z",
      "type": "executionModeOverridden",
      "actor": "owner",
      "sessionId": "session-owner",
      "correlationId": "correlation-legacy",
      "causationId": "command-decision",
      "commandContentHash": "9f9398030f9aa3e1f3cc746ef8f1002f844bbc829ed4553017dd417917496e3f",
      "payload": {
        "recommendationEventId": "event-2",
        "selectedMode": "explorer",
        "overridden": true
      },
      "evidenceRefs": [],
      "previousHash": "92dc33f249aba7f04ebbd8b18527011f8fff1c4072ef98f5fcfe16066809e39f",
      "hash": "b9ad4cb1251173a85f376951ff9a8191f8440bd07d99fad69d68cebb77e5537b"
    }
  ] as unknown as readonly EventEnvelopeV1[];

const FROZEN_APPROVED_RECOMMENDATION = {
    "workItems": 2,
    "maxCrewmatesPerExplorer": 3,
    "perAgentTokenEstimate": 10,
    "recommendedMode": "explorer",
    "selectedMode": "explorer",
    "overridden": false,
    "estimatedAgents": 3,
    "estimatedTokens": 30,
    "tradeoffs": {
      "tokens": "lower manager token overhead",
      "coordination": "one Explorer coordinates all Crewmates"
    },
    "launchAuthorized": false,
    "eventId": "event-2"
  };

const FROZEN_OVERRIDDEN_RECOMMENDATION = {
    "workItems": 5,
    "maxCrewmatesPerExplorer": 2,
    "perAgentTokenEstimate": 1000,
    "recommendedMode": "expedition",
    "selectedMode": "expedition",
    "overridden": false,
    "estimatedAgents": 9,
    "estimatedTokens": 9000,
    "tradeoffs": {
      "tokens": "higher Navigator and Explorer token overhead",
      "coordination": "bounded Explorer groups reduce coordination fan-out"
    },
    "launchAuthorized": false,
    "eventId": "event-2"
  };

describe("frozen pre-Phase-3 replay corpus", () => {
  it("replays a legacy approved run to the same state", () => {
    const state = replay(FROZEN_APPROVED_RUN);
    expect(state.runId).toBe("run-legacy-approved");
    expect(state.revision).toBe(3);
    expect(state.events).toEqual(FROZEN_APPROVED_RUN);
    expect(state.executionRecommendation).toEqual(FROZEN_APPROVED_RECOMMENDATION);
    expect(state.executionApproval).toEqual({ eventId: "event-3", kind: "owner-approval", selectedMode: "explorer" });
  });

  it("replays a legacy overridden run to the same state", () => {
    const state = replay(FROZEN_OVERRIDDEN_RUN);
    expect(state.revision).toBe(3);
    expect(state.executionRecommendation).toEqual(FROZEN_OVERRIDDEN_RECOMMENDATION);
    expect(state.executionApproval).toEqual({ eventId: "event-3", kind: "owner-override", selectedMode: "explorer" });
  });

  it("carries no algorithm version and keeps its recorded hash chain", () => {
    for (const corpus of [FROZEN_APPROVED_RUN, FROZEN_OVERRIDDEN_RUN]) {
      const recommended = corpus.find((event) => event.type === "executionModeRecommended")!;
      expect(Object.keys(recommended.payload)).toHaveLength(10);
      expect(recommended.payload.algorithmVersion).toBeUndefined();
      expect(parseEventEnvelope(recommended).ok).toBe(true);
      let previousHash = "";
      for (const event of corpus) {
        const { hash: _hash, ...body } = event;
        expect(event.previousHash).toBe(previousHash);
        expect(event.hash).toBe(hashEvent(body));
        previousHash = event.hash;
      }
    }
  });

  it("still raises a replay error when a legacy derived field is hand-edited", () => {
    const tampered = FROZEN_APPROVED_RUN.map((event) => event.type === "executionModeRecommended"
      ? { ...event, payload: { ...event.payload, estimatedAgents: 4 } }
      : event);
    expect(() => replay(tampered)).toThrow(/execution recommendation is not deterministic/);
  });
});

// --- Slice 3.4: version-dispatched replay derivation -------------------------

const SELECTION_BASE = {
  algorithmVersion: 2 as const,
  threshold: 8,
  hardTriggers: { multiRepository: false, securityCriticalIntegration: false, dataMigration: false, irreversibleOperations: false, phaseExplorerCount: 0 },
  complexity: { phaseCount: 0, sliceCount: 0, dependencyEdgeCount: 0, sharedFileOverlapCount: 0, serviceCount: 0, expectedConcurrency: 0, integrationCheckpointCount: 0, riskRating: "low" as const },
  subExplorerCount: 0,
};

function selection(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...SELECTION_BASE, ...overrides };
}

/** create → recommend, using the aggregate's own decide path. */
function recommendRun(payload: Record<string, unknown>, runId = RUN_ID): readonly EventEnvelopeV1[] {
  const d = deps();
  let state = initialRunState(runId);
  const created = decide(state, { ...envelope({ commandId: "c1", type: "createWorkRequest" }), runId } as CommandEnvelopeV1, d);
  if (!created.ok) throw new Error(`create failed: ${created.reason}`);
  state = created.state;
  const recommended = decide(state, {
    ...envelope({ commandId: "c2", type: "recommendExecutionMode", expectedRevision: 1 }), runId, payload,
  } as unknown as CommandEnvelopeV1, d);
  if (!recommended.ok) throw new Error(`recommend failed: ${recommended.reason}`);
  return recommended.state.events;
}

function tamper(events: readonly EventEnvelopeV1[], patch: Record<string, unknown>): readonly EventEnvelopeV1[] {
  return events.map((event) => event.type === "executionModeRecommended"
    ? { ...event, payload: { ...event.payload, ...patch } }
    : event);
}

const THREE_INPUTS = { workItems: 2, maxCrewmatesPerExplorer: 3, perAgentTokenEstimate: 10 };

describe("version-dispatched selection", () => {
  it("keeps the ten-key version-1 payload when no selection vector is supplied", () => {
    const events = recommendRun(THREE_INPUTS);
    const payload = events[1].payload;
    expect(Object.keys(payload)).toHaveLength(10);
    expect(payload.algorithmVersion).toBeUndefined();
    expect(payload.recommendedMode).toBe("explorer");
    expect(parseEventEnvelope(events[1]).ok).toBe(true);
    expect(replay(events).executionRecommendation).toMatchObject({ recommendedMode: "explorer", eventId: "evt-2" });
  });

  it("emits the fifteen-key version-2 payload when a selection vector is supplied", () => {
    const events = recommendRun({ ...THREE_INPUTS, selection: selection({ hardTriggers: { ...SELECTION_BASE.hardTriggers, dataMigration: true } }) });
    const payload = events[1].payload;
    expect(Object.keys(payload)).toHaveLength(15);
    expect(payload).toMatchObject({
      algorithmVersion: 2, complexityScore: 0, firedHardTriggers: ["data_migration"],
      recommendedOrchestration: "trail-boss", recommendedMode: "expedition", launchAuthorized: false,
    });
    expect(parseEventEnvelope(events[1]).ok).toBe(true);
    expect(replay(events).executionRecommendation).toMatchObject({ recommendedOrchestration: "trail-boss" });
  });

  it("re-derives from the threshold recorded in the event, not from any module default", () => {
    const critical = { complexity: { ...SELECTION_BASE.complexity, riskRating: "critical" as const } };
    const lenient = recommendRun({ ...THREE_INPUTS, selection: selection({ ...critical, threshold: 4 }) }, "run-lenient");
    const strict = recommendRun({ ...THREE_INPUTS, selection: selection({ ...critical, threshold: 5 }) }, "run-strict");
    expect(lenient[1].payload.recommendedOrchestration).toBe("trail-boss");
    expect(strict[1].payload.recommendedOrchestration).toBe("explorer");
    expect(replay(lenient).executionRecommendation).toMatchObject({ recommendedOrchestration: "trail-boss" });
    expect(replay(strict).executionRecommendation).toMatchObject({ recommendedOrchestration: "explorer" });
  });

  it.each([
    ["complexityScore", { complexityScore: 1 }],
    ["firedHardTriggers", { firedHardTriggers: ["data_migration"] }],
    ["recommendedOrchestration", { recommendedOrchestration: "trail-boss", recommendedMode: "expedition" }],
    ["recommendedMode", { recommendedMode: "expedition" }],
    ["estimatedAgents", { estimatedAgents: 99 }],
  ])("raises a replay error when %s is hand-edited on a version-2 event", (_label, patch) => {
    const events = recommendRun({ ...THREE_INPUTS, selection: selection() });
    expect(() => replay(tamper(events, patch))).toThrow(/execution recommendation is not deterministic/);
  });

  it("raises a replay error when the recorded threshold is hand-edited", () => {
    const critical = { complexity: { ...SELECTION_BASE.complexity, riskRating: "critical" as const } };
    const events = recommendRun({ ...THREE_INPUTS, selection: selection({ ...critical, threshold: 8 }) });
    expect(events[1].payload.recommendedOrchestration).toBe("explorer");
    expect(() => replay(tamper(events, { selection: selection({ ...critical, threshold: 4 }) }))).toThrow(/execution recommendation is not deterministic/);
  });

  it.each([1, 3, "2", null])("raises a replay error for algorithm version %s", (algorithmVersion) => {
    const events = recommendRun({ ...THREE_INPUTS, selection: selection() });
    expect(() => replay(tamper(events, { algorithmVersion }))).toThrow(/unknown execution selection algorithm version/);
  });

  it("fails closed when a version-2 event carries no usable signal vector", () => {
    const events = recommendRun({ ...THREE_INPUTS, selection: selection() });
    expect(() => replay(tamper(events, { selection: { threshold: 8 } }))).toThrow(/execution recommendation is not deterministic/);
  });

  it("leaves the owner approval and override paths untouched on a version-2 recommendation", () => {
    const d = deps();
    let state = initialRunState(RUN_ID);
    const created = decide(state, envelope({ commandId: "c1", type: "createWorkRequest" }), d);
    if (!created.ok) throw new Error("create failed");
    state = created.state;
    const recommended = decide(state, {
      ...envelope({ commandId: "c2", type: "recommendExecutionMode", expectedRevision: 1 }),
      payload: { ...THREE_INPUTS, selection: selection({ hardTriggers: { ...SELECTION_BASE.hardTriggers, dataMigration: true } }) },
    } as unknown as CommandEnvelopeV1, d);
    if (!recommended.ok) throw new Error("recommend failed");
    state = recommended.state;
    expect(state.executionRecommendation).toMatchObject({ recommendedMode: "expedition", launchAuthorized: false });

    const agentApproval = decide(state, {
      ...envelope({ commandId: "c3", type: "approveExecutionMode", expectedRevision: 2 }),
      payload: { recommendationEventId: "evt-2" }, session: { sessionId: "sess-1", actor: "agent" },
    } as CommandEnvelopeV1, d);
    expect(agentApproval).toMatchObject({ ok: false, reason: "non_owner_approval" });

    const sameMode = decide(state, {
      ...envelope({ commandId: "c4", type: "overrideExecutionMode", expectedRevision: 2 }),
      payload: { recommendationEventId: "evt-2", selectedMode: "expedition" },
    } as CommandEnvelopeV1, d);
    expect(sameMode).toMatchObject({ ok: false, reason: "illegal_transition" });

    const approved = decide(state, {
      ...envelope({ commandId: "c5", type: "approveExecutionMode", expectedRevision: 2 }),
      payload: { recommendationEventId: "evt-2" },
    } as CommandEnvelopeV1, d);
    if (!approved.ok) throw new Error("approve failed");
    expect(approved.events[0].payload).toEqual({ recommendationEventId: "evt-2", selectedMode: "expedition", overridden: false });
    expect(replay(approved.state.events).executionApproval).toEqual({ eventId: "evt-3", kind: "owner-approval", selectedMode: "expedition" });
  });
});

describe("owner improvement application", () => {
  it("accepts one atomic owner event only after a settled review checkpoint", () => {
    const d = deps();
    let state = initialRunState(RUN_ID);
    const created = decide(state, envelope({ commandId: "application-create", type: "createWorkRequest" }), d);
    if (!created.ok) throw new Error(created.reason);
    state = created.state;
    const payload = {
      improvementProposalRef: "ab".repeat(32),
      externalEvidenceHash: "cd".repeat(32),
      surface: "review-cadence",
      targetJson: '{"role":"surveyor"}',
      valueJson: '"per-slice"',
    } as const;
    const premature = decide(state, {
      schemaVersion: 1,
      commandId: "application-premature",
      runId: RUN_ID,
      expectedRevision: state.revision,
      session: SESSION,
      correlationId: "application-premature",
      type: "recordOwnerImprovementApplication",
      payload,
    }, d);
    expect(premature).toMatchObject({ ok: false, reason: "illegal_transition" });

    const checkpoint = decide(state, {
      schemaVersion: 1,
      commandId: "application-checkpoint",
      runId: RUN_ID,
      expectedRevision: state.revision,
      session: { sessionId: "bearing", actor: "bearing" },
      correlationId: "application-checkpoint",
      type: "recordJourneyCheckpoint",
      payload: { stage: "review", status: "complete", artifacts: [] },
    }, d);
    if (!checkpoint.ok) throw new Error(checkpoint.reason);
    state = checkpoint.state;

    const nonOwner = decide(state, {
      schemaVersion: 1,
      commandId: "application-agent",
      runId: RUN_ID,
      expectedRevision: state.revision,
      session: { sessionId: "agent", actor: "bearing" },
      correlationId: "application-agent",
      type: "recordOwnerImprovementApplication",
      payload,
    }, d);
    expect(nonOwner).toMatchObject({ ok: false, reason: "non_owner_approval" });

    const applied = decide(state, {
      schemaVersion: 1,
      commandId: "application-owner",
      runId: RUN_ID,
      expectedRevision: state.revision,
      session: SESSION,
      correlationId: "application-owner",
      type: "recordOwnerImprovementApplication",
      payload,
    }, d);
    if (!applied.ok) throw new Error(applied.reason);
    expect(applied.events).toHaveLength(1);
    expect(applied.events[0]).toMatchObject({
      type: "ownerImprovementApplicationRecorded",
      actor: "owner",
      payload,
    });
    expect(applied.state.journeyCheckpoint).toEqual(state.journeyCheckpoint);
    expect(replay(applied.state.events).journeyCheckpoint).toEqual(state.journeyCheckpoint);
  });
});
