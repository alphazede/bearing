import { describe, expect, it } from "vitest";
import type { CommandEnvelopeV1 } from "../src/contracts/run.js";
import {
  AuthorityPolicy,
  type AuthorityFacts,
} from "../src/authority/authority-policy.js";
import {
  startSchedule,
  validateWorkGraph,
  type ScheduleLimits,
  type WorkGraph,
  type WorkNode,
} from "../src/execution/execution-scheduler.js";
import { decide, durableOwnerEvidence, initialRunState, type DecideDeps, type DurableOwnerEvidence } from "../src/workflow/aggregate.js";
import { resolveRun, parseAgentProfile } from "../src/profile/profile.js";
import { DEFAULT_REASONING_TIERS } from "../src/profile/reasoning-policy.js";
import { deriveVerificationProjection } from "../src/verification/verification-roles.js";
import { requiredGates } from "../src/verification/review-cadence.js";

const policy = new AuthorityPolicy();

function facts(overrides: Partial<AuthorityFacts> = {}): AuthorityFacts {
  return {
    schemaVersion: 1,
    role: "crewmate",
    action: "recommend",
    tool: "read",
    allowedTools: ["read", "write"],
    sessionId: "session-a",
    executionAncestry: [],
    ...overrides,
  };
}

function ownerEvidence(kind: "owner-approval" | "owner-override", selectedMode: "explorer" | "expedition"): DurableOwnerEvidence {
  const recommendedMode = kind === "owner-approval" ? selectedMode : selectedMode === "explorer" ? "expedition" : "explorer";
  const deps: DecideDeps = { recordedAt: "2026-07-19T00:00:00Z", nextEventId: (() => { let n = 0; return () => `event-${++n}`; })() };
  const command = (type: CommandEnvelopeV1["type"], commandId: string, expectedRevision: number, payload: object): CommandEnvelopeV1 => ({ schemaVersion: 1, type, commandId, runId: "authority-run", expectedRevision, payload, session: { sessionId: "owner-session", actor: "owner" }, correlationId: "authority" } as CommandEnvelopeV1);
  let state = initialRunState("authority-run");
  state = decide(state, command("createWorkRequest", "create", 0, { title: "t", goal: "g" }), deps).state;
  state = decide(state, command("recommendExecutionMode", "recommend", 1, { workItems: recommendedMode === "explorer" ? 2 : 5, maxCrewmatesPerExplorer: 3, perAgentTokenEstimate: 10 }), deps).state;
  state = decide(state, command(kind === "owner-approval" ? "approveExecutionMode" : "overrideExecutionMode", "owner-decision", 2, kind === "owner-approval" ? { recommendationEventId: state.executionRecommendation!.eventId } : { recommendationEventId: state.executionRecommendation!.eventId, selectedMode }), deps).state;
  return durableOwnerEvidence(state)!;
}

const expeditionApproval = ownerEvidence("owner-approval", "expedition");

/** The pinned-valid expedition shape: navigator -> trail-boss -> explorer -> crew/sub-explorer. */
function expeditionGraph(bossOverride: Partial<WorkNode> = {}): WorkGraph {
  const boss: WorkNode = {
    id: "boss",
    role: "trail-boss",
    parentId: "navigator",
    dependencies: ["navigator"],
    sessionId: "boss",
    tool: "execute",
    allowedTools: ["execute"],
    profileId: "boss",
    profileConcurrency: 1,
    ...bossOverride,
  };
  return {
    schemaVersion: 1,
    executionMode: "expedition",
    limits: { maxNodes: 6, maxCrewmatesPerExplorer: 2 },
    nodes: [
      { id: "navigator", role: "navigator", parentId: null, dependencies: [], sessionId: "navigator", tool: "execute", allowedTools: ["execute"], profileId: "navigator", profileConcurrency: 1 },
      boss,
      { id: "explorer", role: "explorer", parentId: "boss", dependencies: ["boss"], sessionId: "explorer", tool: "execute", allowedTools: ["execute"], profileId: "explorer", profileConcurrency: 2 },
      { id: "direct", role: "crewmate", parentId: "explorer", dependencies: ["explorer"], sessionId: "direct", tool: "execute", allowedTools: ["execute"], profileId: "crew", profileConcurrency: 2 },
      { id: "sub", role: "sub-explorer", parentId: "explorer", dependencies: ["explorer"], sessionId: "sub", tool: "execute", allowedTools: ["execute"], profileId: "sub", profileConcurrency: 1 },
      { id: "sub-crew", role: "crewmate", parentId: "sub", dependencies: ["sub"], sessionId: "sub-crew", tool: "execute", allowedTools: ["execute"], profileId: "crew", profileConcurrency: 2 },
    ],
  };
}

const limits: ScheduleLimits = {
  globalConcurrency: 3,
  roleConcurrency: { navigator: 1, explorer: 1, crewmate: 2, "trail-boss": 1, "sub-explorer": 1 },
  remainingTokenBudget: 100,
  perAgentTokenEstimate: 10,
  timeoutMs: 50,
};

describe("Trail Boss orchestration-only boundary", () => {
  it("denies Trail Boss execution of implementation tools even with expedition evidence", () => {
    for (const tool of ["write", "edit", "shell", "bash"]) {
      expect(policy.evaluate(facts({
        role: "trail-boss",
        action: "execute",
        tool,
        allowedTools: [tool, "read"],
        evidence: expeditionApproval,
        executionMode: "expedition",
      }))).toEqual({ allowed: false, code: "authority_orchestration_only" });
    }
  });

  it("still allows Trail Boss orchestration tools inside an approved expedition", () => {
    for (const tool of ["read", "execute"]) {
      expect(policy.evaluate(facts({
        role: "trail-boss",
        action: "execute",
        tool,
        allowedTools: [tool],
        evidence: expeditionApproval,
        executionMode: "expedition",
      }))).toEqual({ allowed: true });
    }
  });

  it("rejects work graphs whose Trail Boss node executes an implementation tool", () => {
    expect(validateWorkGraph(expeditionGraph({ tool: "bash", allowedTools: ["bash", "read"] })))
      .toEqual({ ok: false, code: "trail_boss_orchestration_only", nodeId: "boss" });
  });

  it("rejects work graphs whose Trail Boss node carries implementation tools in its allowlist", () => {
    expect(validateWorkGraph(expeditionGraph({ tool: "read", allowedTools: ["read", "write"] })))
      .toEqual({ ok: false, code: "trail_boss_orchestration_only", nodeId: "boss" });
  });

  it("accepts an orchestration-only Trail Boss expedition graph", () => {
    expect(validateWorkGraph(expeditionGraph()).ok).toBe(true);
  });

  it("fails the schedule closed when a Trail Boss node declares implementation capability", () => {
    const result = startSchedule({
      graph: expeditionGraph({ tool: "write", allowedTools: ["write"] }),
      evidence: expeditionApproval,
      limits,
      nowMs: 0,
    });
    expect(result).toMatchObject({ state: "blocked", code: "trail_boss_orchestration_only" });
  });
});

describe("Park Ranger review-dispatch ownership", () => {
  it("requires the Park Ranger gate at every review-dispatch boundary", () => {
    expect(requiredGates("per-slice", "slice")).toContain("park-ranger");
    expect(requiredGates("per-phase", "phase")).toContain("park-ranger");
    expect(requiredGates("completion-only", "phase")).toContain("park-ranger");
    expect(requiredGates("completion-only", "completion")).toContain("park-ranger");
  });

  it("keeps the Park Ranger projection read-only and non-executor", () => {
    const prof = parseAgentProfile({
      schemaVersion: 2,
      agentRef: "a/main",
      profileRef: "p/base",
      credentialAccountRef: "acct",
      roles: ["navigator", "explorer", "crewmate", "surveyor"],
      toolAllow: ["read", "search", "write"],
      toolDeny: [],
      authority: { read: true, write: true, network: true, workspace: true, externalAction: false },
      enabledSkills: [],
      context: "evidence-only",
      systemPromptRef: "sys",
      limits: { timeoutMs: 1000, maxTurns: 4, maxTools: 5, maxRetries: 1, maxConcurrency: 1, maxDelegation: 1, tokenBudget: 100 },
      session: { persistence: "persistent", resume: "allowed", fork: "allowed" },
      structuredEvents: true,
      isolation: "required",
      reasoningPolicy: { defaults: DEFAULT_REASONING_TIERS, escalation: { maxSteps: 2, onNewFailureFingerprint: true, onCrossBoundaryDefect: true } },
      selection: { provider: "codex", model: "m", reasoning: "medium" },
    });
    if (!prof.ok) throw new Error("bad profile");
    const run = resolveRun(prof.value, {}, "nonce-123");
    if (run.status !== "ready") throw new Error(run.code);

    const res = deriveVerificationProjection({ run: run.value, role: "park-ranger", policy: { defaults: DEFAULT_REASONING_TIERS, escalation: { maxSteps: 2, onNewFailureFingerprint: true, onCrossBoundaryDefect: true } }, sessionNonce: "park" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.role).toBe("park-ranger");
    expect(res.value.executor).toBe(false);
    expect(res.value.authority.write).toBe(false);
    expect(res.value.authority.externalAction).toBe(false);
    expect(res.value.toolAllow).toEqual(["read", "search"]);
  });
});
