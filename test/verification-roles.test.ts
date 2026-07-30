import { describe, expect, it } from "vitest";
import { resolveRun, parseAgentProfile } from "../src/profile/profile.js";
import { DEFAULT_REASONING_TIERS } from "../src/profile/reasoning-policy.js";
import {
  VERIFICATION_ROLES,
  deriveVerificationProjection,
  verificationSessionScope,
  assertIsolatedVerification,
  assertIndependentVerification,
  type VerificationRole,
} from "../src/verification/verification-roles.js";

const REASONING_POLICY = {
  defaults: DEFAULT_REASONING_TIERS,
  escalation: { maxSteps: 2, onNewFailureFingerprint: true, onCrossBoundaryDefect: true },
};

function makeRun(reasoning = "medium", agentRef = "a/main") {
  const prof = parseAgentProfile({
    schemaVersion: 2,
    agentRef,
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
    reasoningPolicy: REASONING_POLICY,
    selection: { provider: "codex", model: "m", reasoning },
  });
  if (!prof.ok) throw new Error("bad profile");
  const r = resolveRun(prof.value, {}, "nonce-123");
  if (r.status !== "ready") throw new Error(r.code);
  return r.value;
}

describe("verification roles clean room", () => {
  it("exports the three roles and types", () => {
    expect(VERIFICATION_ROLES).toEqual(["validator", "grader", "park-ranger"]);
  });

  it("derive produces read-only, network-off, context-off, executor:false projection", () => {
    const run = makeRun();
    const res = deriveVerificationProjection({ run, role: "validator", policy: REASONING_POLICY, sessionNonce: "s1" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.role).toBe("validator");
    expect(res.value.executor).toBe(false);
    expect(res.value.authority.write).toBe(false);
    expect(res.value.authority.externalAction).toBe(false);
    expect(res.value.authority.network).toBe(false);
    expect(res.value.context).toBe("off");
  });

  it("retains search tools without write or external-action authority", () => {
    const run = makeRun();
    const res = deriveVerificationProjection({ run, role: "validator", policy: REASONING_POLICY, sessionNonce: "search" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.toolAllow).toEqual(["read", "search"]);
    expect(res.value.authority.write).toBe(false);
    expect(res.value.authority.externalAction).toBe(false);
  });

  it("clamps verifier reasoning to the owner's selected tier", () => {
    const run = makeRun("minimal");
    const res = deriveVerificationProjection({ run, role: "grader", policy: REASONING_POLICY, sessionNonce: "reasoning" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.reasoning).toEqual({ tier: "minimal", providerLevel: "low", clamped: true });
  });

  it("keeps verifier session ids distinct for agent refs sharing a prefix", () => {
    const alice = deriveVerificationProjection({
      run: makeRun("medium", "team:alice"),
      role: "grader",
      policy: REASONING_POLICY,
      sessionNonce: "shared",
    });
    const bob = deriveVerificationProjection({
      run: makeRun("medium", "team:bob"),
      role: "grader",
      policy: REASONING_POLICY,
      sessionNonce: "shared",
    });
    if (!alice.ok || !bob.ok) throw new Error("projection failed");

    expect(alice.value.sessionId).toBe("team:alice:grader:session:shared");
    expect(bob.value.sessionId).toBe("team:bob:grader:session:shared");
    expect(alice.value.sessionId).not.toBe(bob.value.sessionId);
  });

  it("unmapped provider yields reasoning_unmappable", () => {
    const run = makeRun();
    // Force the failure path: the projection resolves reasoning against roles[0].selection.provider,
    // and resolveReasoning returns reasoning_unmappable for a provider absent from the policy map.
    const unmapped = {
      ...run,
      roles: [
        { ...run.roles[0], selection: { ...run.roles[0].selection, provider: "no-such-provider" } },
        ...run.roles.slice(1),
      ],
    } as typeof run;
    const res = deriveVerificationProjection({ run: unmapped, role: "grader", policy: REASONING_POLICY, sessionNonce: "s2" });
    expect(res).toEqual({ ok: false, code: "reasoning_unmappable" });
  });

  it("assertIsolatedVerification refuses providerSessionId, focusMode, or write authority", () => {
    const run = makeRun();
    const p = deriveVerificationProjection({ run, role: "park-ranger", policy: REASONING_POLICY, sessionNonce: "iso" });
    if (!p.ok) throw new Error("proj");
    const v = p.value;
    expect(assertIsolatedVerification({ role: v })).toEqual({ ok: true });
    expect(assertIsolatedVerification({ role: v, providerSessionId: "abc" })).toEqual({ ok: false, code: "verification_not_isolated" });
    expect(assertIsolatedVerification({ role: v, focusMode: true })).toEqual({ ok: false, code: "verification_not_isolated" });
    const badAuth = { ...v, authority: { ...v.authority, write: true } };
    expect(assertIsolatedVerification({ role: badAuth as any })).toEqual({ ok: false, code: "verification_not_isolated" });
  });

  it("assertIndependentVerification refuses self-cert and shared ancestry", () => {
    expect(assertIndependentVerification({ verifierSessionId: "v1", implementerSessionIds: ["v1"], executionAncestry: [] })).toEqual({ ok: false, code: "self_certification" });
    expect(assertIndependentVerification({ verifierSessionId: "v2", implementerSessionIds: ["i1"], executionAncestry: ["anc"] })).toEqual({ ok: false, code: "shared_ancestry" });
    expect(assertIndependentVerification({ verifierSessionId: "v3", implementerSessionIds: ["i1", "i2"], executionAncestry: [] })).toEqual({ ok: true });
  });

  it("verificationSessionScope produces distinct namespaced scope", () => {
    const s = verificationSessionScope({ runId: "r1", role: "validator", contentHash: "deadbeef" });
    expect(typeof s).toBe("string");
    expect(s.length).toBeGreaterThan(5);
  });
});
