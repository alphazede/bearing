import { describe, expect, it } from "vitest";
import type { CommandEnvelopeV1 } from "../src/contracts/run.js";
import { startSchedule, type ScheduleLimits, type WorkGraph } from "../src/execution/execution-scheduler.js";
import { decide, durableOwnerEvidence, initialRunState, isDurableOwnerEvidence, isIssuedRunState, replay, type DecideDeps } from "../src/workflow/aggregate.js";

const runId = "run-mode";
const deps: DecideDeps = { recordedAt: "2026-07-19T00:00:00Z", nextEventId: (() => { let n = 0; return () => `evt-${++n}`; })() };
const limits: ScheduleLimits = { globalConcurrency: 2, roleConcurrency: { navigator: 1, explorer: 1, crewmate: 2 }, remainingTokenBudget: 100, perAgentTokenEstimate: 10, timeoutMs: 50 };
const graph: WorkGraph = { schemaVersion: 1, executionMode: "explorer", limits: { maxNodes: 2, maxCrewmatesPerExplorer: 2 }, nodes: [
  { id: "explorer", role: "explorer", parentId: null, dependencies: [], sessionId: "explorer-session", tool: "execute", allowedTools: ["execute"], profileId: "explorer", profileConcurrency: 1 },
  { id: "crew", role: "crewmate", parentId: "explorer", dependencies: ["explorer"], sessionId: "crew-session", tool: "execute", allowedTools: ["execute"], profileId: "crew", profileConcurrency: 2 },
] };
const expeditionGraph: WorkGraph = { schemaVersion: 1, executionMode: "expedition", limits: { maxNodes: 5, maxCrewmatesPerExplorer: 2 }, nodes: [
  { id: "navigator", role: "navigator", parentId: null, dependencies: [], sessionId: "navigator-session", tool: "execute", allowedTools: ["execute"], profileId: "navigator", profileConcurrency: 1 },
  { id: "explorer-a", role: "explorer", parentId: "navigator", dependencies: ["navigator"], sessionId: "explorer-a-session", tool: "execute", allowedTools: ["execute"], profileId: "explorer", profileConcurrency: 1 },
  { id: "crew-a", role: "crewmate", parentId: "explorer-a", dependencies: ["explorer-a"], sessionId: "crew-a-session", tool: "execute", allowedTools: ["execute"], profileId: "crew", profileConcurrency: 2 },
] };

function command(type: CommandEnvelopeV1["type"], commandId: string, expectedRevision: number, payload: object, actor = "owner"): CommandEnvelopeV1 {
  return { schemaVersion: 1, type, commandId, runId, expectedRevision, payload, session: { sessionId: `${actor}-session`, actor }, correlationId: "mode-correlation" } as CommandEnvelopeV1;
}

describe("durable execution-mode authority", () => {
  it("binds recorded owner approval or override to its selected execution mode", () => {
    let state = initialRunState(runId);
    state = decide(state, command("createWorkRequest", "create", 0, { title: "t", goal: "g" }), deps).state;
    state = decide(state, command("recommendExecutionMode", "recommend", 1, { workItems: 2, maxCrewmatesPerExplorer: 3, perAgentTokenEstimate: 10 }), deps).state;
    expect(startSchedule({ graph, evidence: durableOwnerEvidence(state), limits, nowMs: 0 })).toMatchObject({ state: "blocked", code: "authority_approval_missing" });

    const structuralForgery = { ...state };
    const forgedTransition = decide(structuralForgery, command("forged-state", "approveExecutionMode", 2, { recommendationEventId: "evt-2" }), deps);
    expect(forgedTransition).toMatchObject({ ok: false, reason: "malformed_command" });
    expect(isIssuedRunState(forgedTransition.state)).toBe(false);
    expect(durableOwnerEvidence(forgedTransition.state)).toBeUndefined();

    const forged = decide(state, command("approveExecutionMode", "forged", 2, { recommendationEventId: "evt-2" }, "agent"), deps);
    expect(forged).toMatchObject({ ok: false, reason: "non_owner_approval" });
    expect(durableOwnerEvidence(forged.state)).toBeUndefined();

    const approved = decide(state, command("approveExecutionMode", "approve", 2, { recommendationEventId: "evt-2" }), deps);
    expect(approved.ok).toBe(true);
    if (!approved.ok) return;
    expect(isIssuedRunState(approved.state)).toBe(true);
    expect(durableOwnerEvidence({ ...approved.state })).toBeUndefined();
    const evidence = durableOwnerEvidence(approved.state)!;
    expect(evidence).toMatchObject({ recordId: "evt-3", recommendationEventId: "evt-2", selectedMode: "explorer" });
    expect(Object.isFrozen(evidence)).toBe(true);
    const rawEvidenceCopy = { ...evidence };
    expect(isDurableOwnerEvidence(rawEvidenceCopy)).toBe(false);
    expect(startSchedule({ graph, evidence: rawEvidenceCopy, limits, nowMs: 0 })).toMatchObject({ state: "blocked", code: "authority_facts_invalid" });
    expect(startSchedule({ graph, evidence, limits, nowMs: 0 }).state).toBe("active");
    const restarted = replay(approved.state.events);
    expect(isIssuedRunState(restarted)).toBe(true);
    const replayEvidence = durableOwnerEvidence(restarted)!;
    expect(replayEvidence).toMatchObject({ recordId: "evt-3", recommendationEventId: "evt-2", selectedMode: "explorer" });
    expect(replayEvidence).not.toBe(evidence);
    expect(isDurableOwnerEvidence(replayEvidence)).toBe(true);
    expect(startSchedule({ graph, evidence: replayEvidence, limits, nowMs: 0 }).state).toBe("active");
    expect(startSchedule({ graph: expeditionGraph, evidence: durableOwnerEvidence(approved.state), limits, nowMs: 0 })).toMatchObject({ state: "blocked", code: "authority_execution_mode_denied" });
    expect(() => replay([...state.events, { ...approved.events[0]!, payload: { ...approved.events[0]!.payload, overridden: true } }])).toThrow();

    let overrideState = initialRunState(runId);
    overrideState = decide(overrideState, command("createWorkRequest", "create-other", 0, { title: "t", goal: "g" }), deps).state;
    overrideState = decide(overrideState, command("recommendExecutionMode", "recommend-other", 1, { workItems: 2, maxCrewmatesPerExplorer: 3, perAgentTokenEstimate: 10 }), deps).state;
    const overridden = decide(overrideState, command("overrideExecutionMode", "override", 2, { recommendationEventId: "evt-5", selectedMode: "expedition" }), deps);
    expect(overridden.ok).toBe(true);
    if (!overridden.ok) return;
    expect(startSchedule({ graph, evidence: durableOwnerEvidence(overridden.state), limits, nowMs: 0 })).toMatchObject({ state: "blocked", code: "authority_execution_mode_denied" });
    expect(startSchedule({ graph: expeditionGraph, evidence: durableOwnerEvidence(overridden.state), limits, nowMs: 0 }).state).toBe("active");
  });
});
