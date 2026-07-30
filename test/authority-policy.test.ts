import { describe, expect, it } from "vitest";
import type { CommandEnvelopeV1 } from "../src/contracts/run.js";
import {
  AUTHORITY_POLICY_SCHEMA_VERSION,
  AuthorityPolicy,
  type AuthorityFacts,
} from "../src/authority/authority-policy.js";
import {
  startSchedule,
  type ScheduleLimits,
  type WorkGraph,
} from "../src/execution/execution-scheduler.js";
import { ROLES } from "../src/profile/profile.js";
import { decide, durableOwnerEvidence, initialRunState, type DecideDeps, type DurableOwnerEvidence } from "../src/workflow/aggregate.js";

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

const approval = ownerEvidence("owner-approval", "explorer");
const expeditionApproval = ownerEvidence("owner-approval", "expedition");

describe("AuthorityPolicy", () => {
  it("widens only the accepted authority-fact role set and keeps profile roles unchanged", () => {
    expect(AUTHORITY_POLICY_SCHEMA_VERSION).toBe(1);
    expect(ROLES).toEqual(["navigator", "explorer", "crewmate", "surveyor"]);
    const candidates = ["navigator", "explorer", "crewmate", "surveyor", "trail-boss", "sub-explorer", "unknown"] as const;
    const accepted = candidates.filter((role) =>
      policy.evaluate(facts({ role: role as AuthorityFacts["role"] })).allowed);

    expect(accepted).toEqual([
      "navigator",
      "explorer",
      "crewmate",
      "surveyor",
      "trail-boss",
      "sub-explorer",
    ]);
  });

  it("requires durable owner evidence for both new roles and grants neither certification", () => {
    for (const role of ["trail-boss", "sub-explorer"] as const) {
      expect(policy.evaluate(facts({ role, action: "execute", executionMode: "expedition" })))
        .toEqual({ allowed: false, code: "authority_approval_missing" });
      expect(policy.evaluate(facts({
        role,
        action: "execute",
        evidence: { ...expeditionApproval },
        executionMode: "expedition",
      }))).toEqual({ allowed: false, code: "authority_facts_invalid" });
      expect(policy.evaluate(facts({
        role,
        action: "execute",
        evidence: expeditionApproval,
        executionMode: "expedition",
      }))).toEqual({ allowed: true });
      expect(policy.evaluate(facts({ role, action: "certify", certifiedExecutionSessionId: "execution-a" })))
        .toEqual({ allowed: false, code: "authority_role_denied" });
    }
  });

  it("denies Trail Boss outside expedition and preserves matching-mode enforcement", () => {
    expect(policy.evaluate(facts({
      role: "trail-boss",
      action: "execute",
      evidence: approval,
      executionMode: "explorer",
    }))).toEqual({ allowed: false, code: "authority_execution_mode_denied" });
    expect(policy.evaluate(facts({
      role: "sub-explorer",
      action: "execute",
      evidence: expeditionApproval,
      executionMode: "explorer",
    }))).toEqual({ allowed: false, code: "authority_execution_mode_denied" });
  });

  it("lets the scheduler consume both widened roles only with explicit caps and expedition evidence", () => {
    const graph: WorkGraph = {
      schemaVersion: 1,
      executionMode: "expedition",
      limits: { maxNodes: 6, maxCrewmatesPerExplorer: 2 },
      nodes: [
        { id: "navigator", role: "navigator", parentId: null, dependencies: [], sessionId: "navigator", tool: "execute", allowedTools: ["execute"], profileId: "navigator", profileConcurrency: 1 },
        { id: "boss", role: "trail-boss", parentId: "navigator", dependencies: ["navigator"], sessionId: "boss", tool: "execute", allowedTools: ["execute"], profileId: "boss", profileConcurrency: 1 },
        { id: "explorer", role: "explorer", parentId: "boss", dependencies: ["boss"], sessionId: "explorer", tool: "execute", allowedTools: ["execute"], profileId: "explorer", profileConcurrency: 2 },
        { id: "direct", role: "crewmate", parentId: "explorer", dependencies: ["explorer"], sessionId: "direct", tool: "execute", allowedTools: ["execute"], profileId: "crew", profileConcurrency: 2 },
        { id: "sub", role: "sub-explorer", parentId: "explorer", dependencies: ["explorer"], sessionId: "sub", tool: "execute", allowedTools: ["execute"], profileId: "sub", profileConcurrency: 1 },
        { id: "sub-crew", role: "crewmate", parentId: "sub", dependencies: ["sub"], sessionId: "sub-crew", tool: "execute", allowedTools: ["execute"], profileId: "crew", profileConcurrency: 2 },
      ],
    };
    const limits: ScheduleLimits = {
      globalConcurrency: 3,
      roleConcurrency: { navigator: 1, explorer: 1, crewmate: 2, "trail-boss": 1, "sub-explorer": 1 },
      remainingTokenBudget: 100,
      perAgentTokenEstimate: 10,
      timeoutMs: 50,
    };

    expect(startSchedule({ graph, evidence: expeditionApproval, limits, nowMs: 0 }))
      .toMatchObject({ state: "active", batches: [{ nodeIds: ["navigator"] }] });
  });

  it("permits recommendations and only non-Surveyor executions with durable owner evidence", () => {
    for (const role of ["navigator", "explorer", "crewmate", "surveyor"] as const) {
      expect(policy.evaluate(facts({ role }))).toEqual({ allowed: true });
      const execution = policy.evaluate(facts({ role, action: "execute", evidence: approval, executionMode: "explorer" }));
      expect(execution).toEqual(role === "surveyor" ? { allowed: false, code: "authority_surveyor_not_executor" } : { allowed: true });
    }
  });

  it("fails closed for missing, forged, and non-durable approval evidence", () => {
    expect(policy.evaluate(facts({ action: "execute" }))).toEqual({ allowed: false, code: "authority_approval_missing" });
    expect(policy.evaluate(facts({ action: "execute", evidence: { kind: "owner-approval", recordedBy: "owner", durable: true, recordId: "approval-1", recommendationEventId: "recommendation-1", selectedMode: "explorer" } as never, executionMode: "explorer" }))).toEqual({ allowed: false, code: "authority_facts_invalid" });
    expect(policy.evaluate(facts({ action: "execute", evidence: { ...approval } as never, executionMode: "explorer" }))).toEqual({ allowed: false, code: "authority_facts_invalid" });
    expect(policy.evaluate(facts({ action: "execute", evidence: { ...approval, durable: false } as never, executionMode: "explorer" }))).toEqual({ allowed: false, code: "authority_facts_invalid" });
    expect(policy.evaluate(facts({ action: "execute", evidence: ownerEvidence("owner-override", "explorer"), executionMode: "explorer" }))).toEqual({ allowed: true });
    expect(policy.evaluate(facts({ action: "execute", evidence: approval, executionMode: "expedition" }))).toEqual({ allowed: false, code: "authority_execution_mode_denied" });
  });

  it("freezes derived evidence so mutation cannot change authorization", () => {
    expect(Object.isFrozen(approval)).toBe(true);
    expect(Reflect.set(approval as object, "selectedMode", "expedition")).toBe(false);
    expect(policy.evaluate(facts({ action: "execute", evidence: approval, executionMode: "explorer" }))).toEqual({ allowed: true });
    expect(policy.evaluate(facts({ action: "execute", evidence: approval, executionMode: "expedition" }))).toEqual({ allowed: false, code: "authority_execution_mode_denied" });
  });

  it("keeps Surveyor independent and makes certification Surveyor-only", () => {
    expect(policy.evaluate(facts({ role: "surveyor", executionAncestry: ["execution-a"] }))).toEqual({ allowed: false, code: "authority_surveyor_ancestry_denied" });
    for (const role of ["navigator", "explorer", "crewmate"] as const) {
      expect(policy.evaluate(facts({ role, action: "certify", certifiedExecutionSessionId: "execution-a" }))).toEqual({ allowed: false, code: "authority_role_denied" });
    }
    expect(policy.evaluate(facts({ role: "surveyor", action: "certify", certifiedExecutionSessionId: "session-a" }))).toEqual({ allowed: false, code: "authority_self_certification" });
    expect(policy.evaluate(facts({ role: "surveyor", action: "certify", executionAncestry: ["execution-a"], certifiedExecutionSessionId: "execution-a" }))).toEqual({ allowed: false, code: "authority_surveyor_ancestry_denied" });
    expect(policy.evaluate(facts({ role: "surveyor", action: "certify", certifiedExecutionSessionId: "execution-a" }))).toEqual({ allowed: true });
  });

  it("uses stable denials for tool, role, and malformed facts", () => {
    expect(policy.evaluate(facts({ tool: "shell" }))).toEqual({ allowed: false, code: "authority_tool_denied" });
    expect(policy.evaluate({ ...facts(), unexpected: true })).toEqual({ allowed: false, code: "authority_facts_invalid" });
    expect(policy.evaluate(facts({ role: "surveyor", action: "certify" }))).toEqual({ allowed: false, code: "authority_facts_invalid" });
  });
});
