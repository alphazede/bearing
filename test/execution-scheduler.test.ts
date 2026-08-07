import { describe, expect, it } from "vitest";
import * as scheduler from "../src/execution/execution-scheduler.js";
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

function expeditionGraph(nodes: readonly WorkNode[] = [
  node("navigator", "navigator", null),
  node("explorer-a", "explorer", "navigator", ["navigator"]),
  node("crew-a", "crewmate", "explorer-a", ["explorer-a"]),
  node("explorer-b", "explorer", "navigator", ["navigator"]),
  node("crew-b", "crewmate", "explorer-b", ["explorer-b"]),
]): WorkGraph {
  return {
    schemaVersion: 1,
    executionMode: "expedition",
    limits: { maxNodes: 8, maxCrewmatesPerExplorer: 2 },
    nodes,
  };
}

function trailBossGraph(): WorkGraph {
  return expeditionGraph([
    node("navigator", "navigator", null),
    node("trail-boss", "trail-boss", "navigator", ["navigator"]),
    node("explorer", "explorer", "trail-boss", ["trail-boss"]),
    node("crew-direct", "crewmate", "explorer", ["explorer"]),
    node("sub-explorer", "sub-explorer", "explorer", ["explorer"]),
    node("crew-sub", "crewmate", "sub-explorer", ["sub-explorer"]),
  ]);
}

function limits(overrides: Partial<ScheduleLimits> = {}): ScheduleLimits {
  return { globalConcurrency: 4, roleConcurrency: { navigator: 1, explorer: 2, crewmate: 4 }, remainingTokenBudget: 100, perAgentTokenEstimate: 10, timeoutMs: 50, ...overrides };
}

describe("execution scheduler", () => {
  it("keeps schema v1 while accepting the depth-five expedition topology", () => {
    expect((scheduler as unknown as { WORK_GRAPH_SCHEMA_VERSION: number }).WORK_GRAPH_SCHEMA_VERSION).toBe(1);
    expect((scheduler as unknown as { MAX_ORCHESTRATION_DEPTH?: number }).MAX_ORCHESTRATION_DEPTH).toBe(5);
    expect(validateWorkGraph(trailBossGraph())).toMatchObject({ ok: true });
  });

  it("rejects Trail Boss outside expedition and Explorer bypass around an expected parent", () => {
    expect(validateWorkGraph({ ...trailBossGraph(), executionMode: "explorer" }))
      .toEqual({ ok: false, code: "trail_boss_requires_expedition" });
    expect(validateWorkGraph(expeditionGraph([
      ...trailBossGraph().nodes,
      node("explorer-bypass", "explorer", "navigator", ["navigator"]),
      node("crew-bypass", "crewmate", "explorer-bypass", ["explorer-bypass"]),
    ]))).toEqual({ ok: false, code: "illegal_role_topology" });
  });

  it("enforces Trail Boss and Sub-Explorer parent and mode boundaries", () => {
    expect(validateWorkGraph(expeditionGraph([
      ...trailBossGraph().nodes,
      node("crew-under-boss", "crewmate", "trail-boss", ["trail-boss"]),
    ]))).toEqual({ ok: false, code: "illegal_role_topology" });
    expect(validateWorkGraph(expeditionGraph(trailBossGraph().nodes.map((entry) =>
      entry.id === "sub-explorer" ? { ...entry, parentId: "trail-boss" } : entry,
    )))).toEqual({ ok: false, code: "sub_explorer_requires_explorer_parent", nodeId: "sub-explorer" });
    expect(validateWorkGraph(explorerGraph([
      node("explorer", "explorer", null),
      node("crew-direct", "crewmate", "explorer", ["explorer"]),
      node("sub-explorer", "sub-explorer", "explorer", ["explorer"]),
      node("crew-sub", "crewmate", "sub-explorer", ["sub-explorer"]),
    ]))).toEqual({ ok: false, code: "illegal_role_topology" });
  });

  it("rejects depth six before authority evaluation or launch", () => {
    const graph = expeditionGraph([
      ...trailBossGraph().nodes.filter((entry) => entry.id !== "crew-sub"),
      node("nested-sub-explorer", "sub-explorer", "sub-explorer", ["sub-explorer"]),
      node("crew-sub", "crewmate", "nested-sub-explorer", ["nested-sub-explorer"]),
    ]);
    const roleConcurrency = { navigator: 1, explorer: 2, crewmate: 4, "trail-boss": 1, "sub-explorer": 2 };

    expect(validateWorkGraph(graph)).toEqual({ ok: false, code: "orchestration_depth_exceeded", nodeId: "crew-sub" });
    expect(startSchedule({ graph, limits: limits({ roleConcurrency }), nowMs: 0 }))
      .toEqual({ state: "blocked", code: "orchestration_depth_exceeded", nodes: [], batches: [], transitions: [] });
  });

  it("requires explicit concurrency caps for every new role present", () => {
    expect(startSchedule({ graph: trailBossGraph(), evidence: approval("expedition"), limits: limits(), nowMs: 0 }))
      .toMatchObject({ state: "blocked", code: "graph_invalid" });
    expect(startSchedule({
      graph: trailBossGraph(),
      evidence: approval("expedition"),
      limits: limits({ roleConcurrency: { navigator: 1, explorer: 2, crewmate: 4, "trail-boss": 1 } }),
      nowMs: 0,
    })).toMatchObject({ state: "blocked", code: "graph_invalid" });
  });

  it("validates both legal execution hierarchies and retains direct-to-root ancestry", () => {
    expect(validateWorkGraph(explorerGraph()).ok).toBe(true);
    expect(validateWorkGraph(expeditionGraph()).ok).toBe(true);
    let schedule = startSchedule({ graph: expeditionGraph(), evidence: approval("expedition"), limits: limits(), nowMs: 0 });
    schedule = advanceSchedule(schedule, [{ nodeId: "navigator", outcome: "completed" }], 1);
    expect(schedule.nodes.find((entry) => entry.id === "explorer-a")?.executionAncestry).toEqual(["session-navigator"]);
    expect(schedule.nodes.find((entry) => entry.id === "crew-a")?.executionAncestry).toEqual(["session-explorer-a", "session-navigator"]);
  });

  it("F2 regression: advisor 11+11 split (explorer delegates all to Sub-Explorers) produces topology scheduler accepts", () => {
    // Simulates 2 subs, 0 direct crew on the explorer (nothing retained)
    const delegatedAll = expeditionGraph([
      node("navigator", "navigator", null),
      node("explorer", "explorer", "navigator", ["navigator"]),
      node("sub1", "sub-explorer", "explorer", ["explorer"]),
      node("sub2", "sub-explorer", "explorer", ["explorer"]),
      node("c1", "crewmate", "sub1", ["sub1"]),
      node("c2", "crewmate", "sub1", ["c1"]),
      node("c3", "crewmate", "sub2", ["sub2"]),
      node("c4", "crewmate", "sub2", ["c3"]),
    ]);
    expect(validateWorkGraph(delegatedAll)).toMatchObject({ ok: true });
    // Assert directly against legalTopology per F2 requirement (advisor output must satisfy scheduler)
    const byId = new Map(delegatedAll.nodes.map((n) => [n.id, n] as const));
    expect(scheduler.legalTopology("expedition", delegatedAll.nodes, byId, 10)).toBe(true);
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

const PREREQUISITE = {
  id: "runtime-fix-10",
  resumeAction: "merge the runtime fix and restart Bearing so Focus loads it",
} as const;

function gated(n: WorkNode): WorkNode {
  return { ...n, focusGated: true };
}

function prerequisiteGraph(): WorkGraph {
  return {
    ...expeditionGraph([
      node("navigator", "navigator", null),
      gated(node("explorer-a", "explorer", "navigator", ["navigator"])),
      node("crew-a", "crewmate", "explorer-a", ["explorer-a"]),
      node("explorer-b", "explorer", "navigator", ["navigator"]),
      node("crew-b", "crewmate", "explorer-b", ["explorer-b"]),
      gated(node("explorer-c", "explorer", "navigator", ["navigator"])),
      node("crew-c", "crewmate", "explorer-c", ["explorer-c"]),
    ]),
    globalRuntimePrerequisites: [PREREQUISITE],
  };
}

describe("global runtime prerequisite gating", () => {
  it("keeps every Focus-backed lane blocked while a declared prerequisite is merged but not runtime-active", () => {
    const staleRuntime = { isMet: () => false };
    let schedule = startSchedule({ graph: prerequisiteGraph(), evidence: approval("expedition"), limits: limits(), nowMs: 0, runtimeCheck: staleRuntime });
    // Gated lanes are blocked from the first projection, before any launch decision.
    expect(schedule.nodes.find((entry) => entry.id === "explorer-a")).toMatchObject({
      status: "blocked",
      reason: "runtime_prerequisite",
      blocker: { prerequisiteId: "runtime-fix-10", resumeAction: PREREQUISITE.resumeAction },
    });
    expect(schedule.nodes.find((entry) => entry.id === "explorer-c")).toMatchObject({
      status: "blocked",
      reason: "runtime_prerequisite",
      blocker: { prerequisiteId: "runtime-fix-10", resumeAction: PREREQUISITE.resumeAction },
    });
    expect(schedule.nodes.find((entry) => entry.id === "crew-a")?.status).toBe("blocked");
    expect(schedule.batches[0]?.nodeIds).toEqual(["navigator"]);
    // Dependency-independent (non-Focus-gated) work proceeds once its shared parent completes.
    schedule = advanceSchedule(schedule, [{ nodeId: "navigator", outcome: "completed" }], 1);
    expect(schedule.nodes.find((entry) => entry.id === "explorer-b")?.status).toBe("running");
    expect(schedule.nodes.find((entry) => entry.id === "explorer-a")?.status).toBe("blocked");
    // Still blocked after unrelated work completes while the runtime stays stale.
    schedule = advanceSchedule(schedule, [{ nodeId: "explorer-b", outcome: "completed" }], 2);
    expect(schedule.nodes.find((entry) => entry.id === "explorer-a")?.status).toBe("blocked");
    expect(schedule.batches.flatMap((batch) => batch.nodeIds)).not.toContain("explorer-a");
  });

  it("blocks every Focus-backed lane until all declared prerequisites are met", () => {
    const graph = {
      ...prerequisiteGraph(),
      globalRuntimePrerequisites: [PREREQUISITE, { id: "prereq-2", resumeAction: "re-run the validator build" }],
    };
    const check = { isMet: (id: string) => id === "runtime-fix-10" };
    const schedule = startSchedule({ graph, evidence: approval("expedition"), limits: limits(), nowMs: 0, runtimeCheck: check });
    expect(schedule.nodes.find((entry) => entry.id === "explorer-a")?.blocker).toEqual({ prerequisiteId: "prereq-2", resumeAction: "re-run the validator build" });
    expect(schedule.nodes.find((entry) => entry.id === "explorer-c")?.status).toBe("blocked");
  });

  it("releases gated lanes exactly once when the prerequisite becomes merged and runtime-active, without auto-replay", () => {
    let active = false;
    const check = { isMet: () => active };
    let schedule = startSchedule({ graph: prerequisiteGraph(), evidence: approval("expedition"), limits: limits(), nowMs: 0, runtimeCheck: check });
    expect(schedule.nodes.find((entry) => entry.id === "explorer-a")?.status).toBe("blocked");
    active = true; // the fix merged and the runtime restarted
    schedule = advanceSchedule(schedule, [{ nodeId: "navigator", outcome: "completed" }, { nodeId: "explorer-b", outcome: "completed" }], 1);
    expect(schedule.nodes.find((entry) => entry.id === "explorer-a")?.status).toBe("running");
    expect(schedule.batches.flatMap((batch) => batch.nodeIds).filter((id) => id === "explorer-a")).toEqual(["explorer-a"]);
    expect(schedule.transitions).toEqual(expect.arrayContaining([
      { nodeId: "explorer-a", from: "blocked", to: "pending", reason: "runtime_prerequisite" },
      { nodeId: "explorer-a", from: "pending", to: "running" },
    ]));
    // A completed gated lane is never replayed, even if the runtime regresses.
    schedule = advanceSchedule(schedule, [{ nodeId: "explorer-a", outcome: "completed" }, { nodeId: "explorer-c", outcome: "completed" }], 2);
    active = false;
    schedule = advanceSchedule(schedule, [], 3);
    expect(schedule.nodes.find((entry) => entry.id === "explorer-a")?.status).toBe("completed");
    expect(schedule.batches.flatMap((batch) => batch.nodeIds).filter((id) => id === "explorer-a")).toEqual(["explorer-a"]);
  });

  it("keeps runtime-blocked lanes releasable after every non-gated node completes", () => {
    let active = false;
    const check = { isMet: () => active };
    let schedule = startSchedule({ graph: prerequisiteGraph(), evidence: approval("expedition"), limits: limits(), nowMs: 0, runtimeCheck: check });
    // t1–t3: every non-gated lane completes while the prerequisite stays unmet.
    schedule = advanceSchedule(schedule, [{ nodeId: "navigator", outcome: "completed" }], 1);
    schedule = advanceSchedule(schedule, [{ nodeId: "explorer-b", outcome: "completed" }], 2);
    schedule = advanceSchedule(schedule, [{ nodeId: "crew-b", outcome: "completed" }], 3);
    // All remaining nodes are runtime-blocked lanes: the projection must not be
    // finished, or the release path would be unreachable.
    expect(schedule.state).not.toBe("finished");
    expect(schedule.nodes.find((entry) => entry.id === "explorer-a")).toMatchObject({ status: "blocked", reason: "runtime_prerequisite" });
    expect(schedule.nodes.find((entry) => entry.id === "crew-a")?.status).toBe("blocked");
    // t4: the prerequisite becomes met — a later advance must still release the lanes exactly once.
    active = true;
    schedule = advanceSchedule(schedule, [], 4);
    expect(schedule.nodes.find((entry) => entry.id === "explorer-a")?.status).toBe("running");
    expect(schedule.nodes.find((entry) => entry.id === "explorer-c")?.status).toBe("running");
    expect(schedule.batches.flatMap((batch) => batch.nodeIds).filter((id) => id === "explorer-a")).toEqual(["explorer-a"]);
    expect(schedule.transitions.filter((transition) => transition.nodeId === "explorer-a" && transition.to === "running")).toHaveLength(1);
    // t5: the released lane's own dependents launch only after it completes.
    schedule = advanceSchedule(schedule, [{ nodeId: "explorer-a", outcome: "completed" }], 5);
    expect(schedule.nodes.find((entry) => entry.id === "crew-a")?.status).toBe("running");
  });

  it("keeps a lone gated root active instead of finishing before launch", () => {
    const graph = {
      ...explorerGraph([gated(node("explorer", "explorer", null)), node("crew-a", "crewmate", "explorer", ["explorer"])]),
      globalRuntimePrerequisites: [PREREQUISITE],
    };
    let schedule = startSchedule({ graph, evidence: approval("explorer"), limits: limits(), nowMs: 0, runtimeCheck: { isMet: () => false } });
    // The only launchable root is runtime-gated: the projection must not finish
    // before anything has launched, or a later advance can never release it.
    expect(schedule.state).not.toBe("finished");
    expect(schedule.nodes.find((entry) => entry.id === "explorer")).toMatchObject({ status: "blocked", reason: "runtime_prerequisite" });
    schedule = advanceSchedule(schedule, [], 1);
    expect(schedule.state).not.toBe("finished");
  });

  it("releases blocked dependents once the gated lane they depend on launches", () => {
    let active = false;
    const check = { isMet: () => active };
    let schedule = startSchedule({ graph: prerequisiteGraph(), evidence: approval("expedition"), limits: limits(), nowMs: 0, runtimeCheck: check });
    expect(schedule.nodes.find((entry) => entry.id === "crew-a")?.status).toBe("blocked");
    active = true;
    schedule = advanceSchedule(schedule, [{ nodeId: "navigator", outcome: "completed" }, { nodeId: "explorer-b", outcome: "completed" }], 1);
    expect(schedule.nodes.find((entry) => entry.id === "explorer-a")?.status).toBe("running");
    expect(schedule.nodes.find((entry) => entry.id === "crew-a")?.status).toBe("pending");
    schedule = advanceSchedule(schedule, [{ nodeId: "explorer-a", outcome: "completed" }, { nodeId: "explorer-c", outcome: "completed" }], 2);
    expect(schedule.nodes.find((entry) => entry.id === "crew-a")?.status).toBe("running");
    expect(schedule.batches.flatMap((batch) => batch.nodeIds).filter((id) => id === "crew-a")).toEqual(["crew-a"]);
  });

  it("fails closed with a typed blocker when a prerequisite is declared but no runtime check is provided", () => {
    const schedule = startSchedule({ graph: prerequisiteGraph(), evidence: approval("expedition"), limits: limits(), nowMs: 0 });
    expect(schedule.nodes.find((entry) => entry.id === "explorer-a")).toMatchObject({
      status: "blocked",
      reason: "runtime_prerequisite",
      blocker: { prerequisiteId: "runtime-fix-10", resumeAction: PREREQUISITE.resumeAction },
    });
  });

  it("schedules exactly as before when no global prerequisite is declared, even with gated lanes marked", () => {
    const graph = expeditionGraph([
      node("navigator", "navigator", null),
      gated(node("explorer-a", "explorer", "navigator", ["navigator"])),
      node("crew-a", "crewmate", "explorer-a", ["explorer-a"]),
      node("explorer-b", "explorer", "navigator", ["navigator"]),
      node("crew-b", "crewmate", "explorer-b", ["explorer-b"]),
    ]);
    let schedule = startSchedule({ graph, evidence: approval("expedition"), limits: limits(), nowMs: 0 });
    expect(schedule.batches[0]?.nodeIds).toEqual(["navigator"]);
    schedule = advanceSchedule(schedule, [{ nodeId: "navigator", outcome: "completed" }], 1);
    expect(schedule.batches[1]?.nodeIds).toEqual(["explorer-a", "explorer-b"]);
    expect(schedule.nodes.find((entry) => entry.id === "explorer-a")?.status).toBe("running");
    expect(schedule.nodes.find((entry) => entry.id === "explorer-b")?.status).toBe("running");
  });

  it("validates the global prerequisite grammar and fails closed on malformed declarations", () => {
    expect(validateWorkGraph(prerequisiteGraph())).toMatchObject({ ok: true });
    expect(validateWorkGraph({ ...prerequisiteGraph(), globalRuntimePrerequisites: [{ id: "x" }] })).toMatchObject({ ok: false, code: "graph_invalid" });
    expect(validateWorkGraph({ ...prerequisiteGraph(), globalRuntimePrerequisites: [PREREQUISITE, PREREQUISITE] })).toMatchObject({ ok: false, code: "graph_invalid" });
    expect(validateWorkGraph({ ...prerequisiteGraph(), nodes: prerequisiteGraph().nodes.map((entry) => entry.id === "explorer-a" ? { ...entry, focusGated: "yes" } : entry) })).toMatchObject({ ok: false, code: "graph_invalid" });
  });
});
