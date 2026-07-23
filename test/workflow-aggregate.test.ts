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

  it("rejects malformed and future-schema event envelopes", () => {
    expect(parseEventEnvelope(null).ok).toBe(false);
    expect(parseEventEnvelope({ schemaVersion: 7 }).reason).toBe("future_schema");
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
