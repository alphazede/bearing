import { describe, expect, it } from "vitest";
import {
  advanceSchedule,
  type ExecutionMode,
  effectiveConcurrency,
  recommendExecutionMode,
  startSchedule,
  validateWorkGraph,
  type ExecutorRole,
  type ScheduleLimits,
  type WorkGraph,
  type WorkNode,
} from "../src/execution/execution-scheduler.js";
import type { CommandEnvelopeV1 } from "../src/contracts/run.js";
import { decide, durableOwnerEvidence, initialRunState, type DecideDeps, type DurableOwnerEvidence } from "../src/workflow/aggregate.js";

function ownerEvidence(kind: "owner-approval" | "owner-override", selectedMode: ExecutionMode): DurableOwnerEvidence {
  const recommendedMode = kind === "owner-approval" ? selectedMode : selectedMode === "explorer" ? "expedition" : "explorer";
  const deps: DecideDeps = { recordedAt: "2026-07-19T00:00:00Z", nextEventId: (() => { let n = 0; return () => `event-${++n}`; })() };
  const command = (type: CommandEnvelopeV1["type"], commandId: string, expectedRevision: number, payload: object): CommandEnvelopeV1 => ({ schemaVersion: 1, type, commandId, runId: "scheduler-run", expectedRevision, payload, session: { sessionId: "owner-session", actor: "owner" }, correlationId: "scheduler" } as CommandEnvelopeV1);
  let state = initialRunState("scheduler-run");
  state = decide(state, command("createWorkRequest", "create", 0, { title: "t", goal: "g" }), deps).state;
  state = decide(state, command("recommendExecutionMode", "recommend", 1, { workItems: recommendedMode === "explorer" ? 2 : 5, maxCrewmatesPerExplorer: 3, perAgentTokenEstimate: 10 }), deps).state;
  state = decide(state, command(kind === "owner-approval" ? "approveExecutionMode" : "overrideExecutionMode", "owner-decision", 2, kind === "owner-approval" ? { recommendationEventId: state.executionRecommendation!.eventId } : { recommendationEventId: state.executionRecommendation!.eventId, selectedMode }), deps).state;
  return durableOwnerEvidence(state)!;
}

const approval = (mode: ExecutionMode) => ownerEvidence("owner-approval", mode);
const override = (mode: ExecutionMode) => ownerEvidence("owner-override", mode);

function node(id: string, role: ExecutorRole, parentId: string | null, dependencies: readonly string[] = [], profileConcurrency = 4): WorkNode {
  return { id, role, parentId, dependencies, sessionId: `session-${id}`, tool: "execute", allowedTools: ["execute"], profileId: `profile-${role}`, profileConcurrency };
}

function explorerGraph(nodes: readonly WorkNode[] = [node("explorer", "explorer", null), node("crew-a", "crewmate", "explorer", ["explorer"])]): WorkGraph {
  return { schemaVersion: 1, executionMode: "explorer", limits: { maxNodes: 8, maxCrewmatesPerExplorer: 4 }, nodes };
}

function expeditionGraph(): WorkGraph {
  return {
    schemaVersion: 1,
    executionMode: "expedition",
    limits: { maxNodes: 8, maxCrewmatesPerExplorer: 2 },
    nodes: [
      node("navigator", "navigator", null),
      node("explorer-a", "explorer", "navigator", ["navigator"]),
      node("crew-a", "crewmate", "explorer-a", ["explorer-a"]),
      node("explorer-b", "explorer", "navigator", ["navigator"]),
      node("crew-b", "crewmate", "explorer-b", ["explorer-b"]),
    ],
  };
}

function limits(overrides: Partial<ScheduleLimits> = {}): ScheduleLimits {
  return { globalConcurrency: 4, roleConcurrency: { navigator: 1, explorer: 2, crewmate: 4 }, remainingTokenBudget: 100, perAgentTokenEstimate: 10, timeoutMs: 50, ...overrides };
}

describe("execution scheduler", () => {
  it("validates both legal execution hierarchies and retains direct-to-root ancestry", () => {
    expect(validateWorkGraph(explorerGraph()).ok).toBe(true);
    expect(validateWorkGraph(expeditionGraph()).ok).toBe(true);
    let schedule = startSchedule({ graph: expeditionGraph(), evidence: approval("expedition"), limits: limits(), nowMs: 0 });
    schedule = advanceSchedule(schedule, [{ nodeId: "navigator", outcome: "completed" }], 1);
    expect(schedule.nodes.find((entry) => entry.id === "explorer-a")?.executionAncestry).toEqual(["session-navigator"]);
    expect(schedule.nodes.find((entry) => entry.id === "crew-a")?.executionAncestry).toEqual(["session-explorer-a", "session-navigator"]);
  });

  it("recommends deterministically, estimates cost, and keeps recommendation non-authoritative", () => {
    expect(recommendExecutionMode({ workItems: 2, maxCrewmatesPerExplorer: 3, perAgentTokenEstimate: 10 })).toMatchObject({ recommendedMode: "explorer", selectedMode: "explorer", estimatedAgents: 3, estimatedTokens: 30, launchAuthorized: false });
    expect(recommendExecutionMode({ workItems: 5, maxCrewmatesPerExplorer: 2, perAgentTokenEstimate: 10, overrideMode: "explorer" })).toMatchObject({ recommendedMode: "expedition", selectedMode: "explorer", overridden: true, launchAuthorized: false });
    expect(startSchedule({ graph: explorerGraph(), evidence: override("explorer"), limits: limits(), nowMs: 0 }).state).toBe("active");
  });

  it("uses the minimum global, role, profile, and token-budget cap", () => {
    expect(effectiveConcurrency({ global: 9, role: 7, profile: 5, remainingTokenBudget: 35, perAgentTokenEstimate: 10 })).toBe(3);
    expect(effectiveConcurrency({ global: 2, role: 7, profile: 5, remainingTokenBudget: 100, perAgentTokenEstimate: 10 })).toBe(2);
  });

  it("does not permit policy injection and clamps inconsistent derived caps", () => {
    expect(startSchedule({ graph: explorerGraph(), limits: limits(), nowMs: 0, policy: { evaluate: () => ({ allowed: true }) } } as never)).toMatchObject({ state: "blocked", code: "authority_approval_missing" });
    const schedule = startSchedule({ graph: explorerGraph(), evidence: approval("explorer"), limits: limits(), nowMs: 0 });
    expect(advanceSchedule({ ...schedule, batches: [...schedule.batches, { nodeIds: Array(10).fill("overflow"), atMs: 0, remainingTokenBudget: -10 }] }, [{ nodeId: "explorer", outcome: "completed" }], 1)).toMatchObject({ state: "blocked", code: "budget_exhausted" });
  });

  it("launches dependency-ready nodes in graph FIFO order", () => {
    const graph = explorerGraph([
      node("explorer", "explorer", null),
      node("crew-b", "crewmate", "explorer", ["explorer"]),
      node("crew-a", "crewmate", "explorer", ["explorer"]),
    ]);
    let schedule = startSchedule({ graph, evidence: approval("explorer"), limits: limits({ globalConcurrency: 2 }), nowMs: 0 });
    expect(schedule.batches[0]?.nodeIds).toEqual(["explorer"]);
    schedule = advanceSchedule(schedule, [{ nodeId: "explorer", outcome: "completed" }], 1);
    expect(schedule.batches[1]?.nodeIds).toEqual(["crew-b", "crew-a"]);
  });

  it("rejects cycles, duplicate ids, and missing prerequisites before launch", () => {
    expect(validateWorkGraph(explorerGraph([node("explorer", "explorer", null, ["crew-a"]), node("crew-a", "crewmate", "explorer", ["explorer"])]))).toMatchObject({ ok: false, code: "dependency_cycle" });
    expect(validateWorkGraph(explorerGraph([node("explorer", "explorer", null), node("explorer", "crewmate", "explorer")]))).toMatchObject({ ok: false, code: "duplicate_node_id" });
    expect(validateWorkGraph(explorerGraph([node("explorer", "explorer", null), node("crew-a", "crewmate", "explorer", ["missing"])]))).toMatchObject({ ok: false, code: "missing_dependency", nodeId: "crew-a" });
  });

  it("blocks dependents after a failed prerequisite", () => {
    let schedule = startSchedule({ graph: explorerGraph(), evidence: approval("explorer"), limits: limits(), nowMs: 0 });
    schedule = advanceSchedule(schedule, [{ nodeId: "explorer", outcome: "failed" }], 1);
    expect(schedule.state).toBe("finished");
    expect(schedule.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "explorer", status: "failed" }),
      expect.objectContaining({ id: "crew-a", status: "blocked", reason: "failed_prerequisite" }),
    ]));
  });

  it("blocks launch when any effective cap is zero", () => {
    expect(startSchedule({ graph: explorerGraph(), evidence: approval("explorer"), limits: limits({ globalConcurrency: 0 }), nowMs: 0 })).toMatchObject({ state: "blocked", code: "zero_cap" });
    expect(startSchedule({ graph: explorerGraph(), evidence: approval("explorer"), limits: limits({ roleConcurrency: { navigator: 1, explorer: 0, crewmate: 4 } }), nowMs: 0 })).toMatchObject({ state: "blocked", code: "zero_cap" });
    const graph = explorerGraph([node("explorer", "explorer", null, [], 0), node("crew-a", "crewmate", "explorer", ["explorer"])]);
    expect(startSchedule({ graph, evidence: approval("explorer"), limits: limits(), nowMs: 0 })).toMatchObject({ state: "blocked", code: "zero_cap" });
  });

  it("times out running nodes and never launches their dependents", () => {
    let schedule = startSchedule({ graph: explorerGraph(), evidence: approval("explorer"), limits: limits({ timeoutMs: 5 }), nowMs: 10 });
    schedule = advanceSchedule(schedule, [], 15);
    expect(schedule.state).toBe("finished");
    expect(schedule.nodes.map(({ id, status }) => ({ id, status }))).toEqual([{ id: "explorer", status: "timed_out" }, { id: "crew-a", status: "blocked" }]);
  });

  it("stops new work when the remaining budget is exhausted", () => {
    let schedule = startSchedule({ graph: explorerGraph(), evidence: approval("explorer"), limits: limits({ remainingTokenBudget: 10 }), nowMs: 0 });
    schedule = advanceSchedule(schedule, [{ nodeId: "explorer", outcome: "completed" }], 1);
    expect(schedule).toMatchObject({ state: "blocked", code: "budget_exhausted" });
    expect(schedule.nodes.find((entry) => entry.id === "crew-a")?.status).toBe("pending");
  });

  it("requires durable owner approval or override", () => {
    expect(startSchedule({ graph: explorerGraph(), limits: limits(), nowMs: 0 })).toMatchObject({ state: "blocked", code: "authority_approval_missing" });
  });

  it("fails closed on invalid node facts without changing node outcomes", () => {
    const schedule = startSchedule({ graph: explorerGraph(), evidence: approval("explorer"), limits: limits(), nowMs: 0 });
    for (const facts of [[{ nodeId: "unknown", outcome: "completed" }], [{ nodeId: "explorer", outcome: "completed" }, { nodeId: "explorer", outcome: "failed" }], [{ nodeId: "explorer", outcome: "unknown" }], Array.from({ length: 3 }, () => ({ nodeId: "explorer", outcome: "completed" }))]) {
      expect(advanceSchedule(schedule, facts, 1)).toMatchObject({ state: "blocked", code: "node_facts_invalid", nodes: schedule.nodes });
    }
  });

  it("rejects Surveyor insertion before authority or scheduling", () => {
    const graph = { ...explorerGraph(), nodes: [node("explorer", "explorer", null), { ...node("surveyor", "crewmate", "explorer"), role: "surveyor" }] };
    expect(validateWorkGraph(graph)).toMatchObject({ ok: false, code: "surveyor_not_executor", nodeId: "surveyor" });
    expect(startSchedule({ graph, evidence: approval("explorer"), limits: limits(), nowMs: 0 })).toMatchObject({ state: "blocked", code: "surveyor_not_executor" });
  });
});
