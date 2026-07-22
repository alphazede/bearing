import { describe, expect, it } from "vitest";
import { parseAgentProfile, parseRunOverrides, resolveRun } from "../src/profile/profile.js";

function profile(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    agentRef: "agent/main",
    profileRef: "profiles/base-v1",
    credentialAccountRef: "accounts/nonsecret-ref",
    roles: ["navigator", "explorer", "crewmate", "surveyor"],
    toolAllow: ["read", "search", "write"], toolDeny: ["shell"],
    authority: { read: true, write: true, network: true, workspace: true, externalAction: false },
    enabledSkills: ["research"], context: "evidence-only", systemPromptRef: "prompts/system.md",
    limits: { timeoutMs: 1000, maxTurns: 4, maxTools: 5, maxRetries: 1, maxConcurrency: 1, maxDelegation: 1, tokenBudget: 100, costBudget: 2 },
    session: { persistence: "persistent", resume: "allowed", fork: "allowed" },
    structuredEvents: true, isolation: "required",
    selection: { provider: "provider", model: "model", reasoning: "high" }, ...overrides,
  };
}

function valid(overrides: Record<string, unknown> = {}) {
  const parsed = parseAgentProfile(profile(overrides));
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error(parsed.code);
  return parsed.value;
}

describe("profile schema", () => {
  it("refuses schema, size, enum, authority-context, and conflicting-tool violations", () => {
    expect(parseAgentProfile(profile({ schemaVersion: 2 })).ok).toBe(false);
    expect(parseAgentProfile(profile({ agentRef: "x".repeat(257) })).ok).toBe(false);
    expect(parseAgentProfile(profile({ context: "later" })).ok).toBe(false);
    expect(parseAgentProfile(profile({ context: "rag-assisted", authority: { read: false, write: false, network: false, workspace: false, externalAction: false } })).ok).toBe(false);
    expect(parseAgentProfile(profile({ toolDeny: ["read"] })).ok).toBe(false);
    expect(parseAgentProfile(profile({ limits: { ...profile().limits, maxTurns: 0 } })).ok).toBe(false);
  });

  it("uses one selection but distinct role identities and sessions", () => {
    const result = resolveRun(valid(), {}, "role-test");
    expect(result.status).toBe("ready"); if (result.status !== "ready") return;
    expect(result.value.roles.map((role) => role.selection)).toEqual(Array(4).fill({ provider: "provider", model: "model", reasoning: "high" }));
    expect(new Set(result.value.roles.map((role) => role.identity)).size).toBe(4);
    expect(new Set(result.value.roles.map((role) => role.sessionId)).size).toBe(4);
    expect(new Set(result.value.roles.map((role) => JSON.stringify(role.authority))).size).toBe(4);
    expect(new Set(result.value.roles.map((role) => JSON.stringify({ allow: role.toolAllow, deny: role.toolDeny }))).size).toBe(4);
  });

  it("does not create a session identity when profile persistence is off", () => {
    const result = resolveRun(valid({ session: { persistence: "off", resume: "never", fork: "never" } }), {}, "off-test");
    expect(result.status).toBe("ready"); if (result.status !== "ready") return;
    expect(result.value.roles.every((role) => role.sessionId === null)).toBe(true);
    expect(result.value.receipt.effective).toMatchObject({ session: "off" });
  });

  it("redacts secrets, defaults fallback off, blocks absent selection, and makes deterministic receipts", () => {
    const noFallback = valid({ selection: undefined });
    expect(noFallback.fallbackEnabled).toBe(false);
    expect(resolveRun(noFallback, {}, "missing-selection")).toEqual({ status: "blocked", code: "selection_missing" });
    expect(resolveRun(valid(), {}, "")).toEqual({ status: "blocked", code: "session_nonce_invalid" });
    expect(resolveRun(valid(), {}, "x".repeat(257))).toEqual({ status: "blocked", code: "session_nonce_invalid" });
    const a = resolveRun(valid(), {}, "deterministic"), b = resolveRun(valid(), {}, "deterministic");
    expect(a).toEqual(b); if (a.status !== "ready") return;
    expect(JSON.stringify(a.value.receipt)).not.toMatch(/credential|secret|systemPrompt/i);
    expect(a.value.receipt.effective.isolation).toBe("unattested");
  });

  it("keeps requested policy separate and gives each role a safe projection", () => {
    const result = resolveRun(valid(), { provider: "other", model: "other-model", reasoning: "low", timeoutMs: 9, maxTurns: 2 }, "run-a");
    expect(result.status).toBe("ready"); if (result.status !== "ready") return;
    expect(result.value.receipt.requested).toMatchObject({ route: { provider: "provider", model: "model", reasoning: "high" }, limits: { timeoutMs: 1000, maxTurns: 4 } });
    expect(result.value.receipt.effective).toMatchObject({ route: { provider: "other", model: "other-model", reasoning: "low" }, limits: { timeoutMs: 9, maxTurns: 2 } });
    expect(new Set(result.value.roles.map((role) => role.selection.provider))).toEqual(new Set(["other"]));
    expect(result.value.roles.find((role) => role.role === "surveyor")).toMatchObject({ executor: false, authority: { write: false, network: false, externalAction: false }, toolAllow: ["read"] });
    const second = resolveRun(valid(), {}, "run-b");
    expect(second.status === "ready" && second.value.roles[0].sessionId).not.toBe(result.value.roles[0].sessionId);
  });
});

describe("safe overrides", () => {
  it("only narrows tools and limits", () => {
    const result = resolveRun(valid(), { tools: ["read"], excludedTools: ["write"], offline: true, noSession: true, timeoutMs: 9, maxTurns: 2, budget: { tokens: 10, cost: 1 } }, "override-test");
    expect(result.status).toBe("ready"); if (result.status !== "ready") return;
    expect(result.value.roles[0].toolAllow).toEqual(["read"]);
    expect(result.value.roles[0].sessionId).toBeNull();
    expect(result.value.receipt.effective).toMatchObject({ authority: { network: false }, session: "off", limits: { timeoutMs: 9, maxTurns: 2, tokenBudget: 10, costBudget: 1 } });
  });

  it("rejects keys, per-role selection, authority expansion, and unsafe values", () => {
    expect(parseRunOverrides({ apiKey: "no" })).toEqual({ ok: false, code: "override_unsafe" });
    expect(parseRunOverrides({ roleSelection: { navigator: "x" } })).toEqual({ ok: false, code: "override_unsafe" });
    expect(parseRunOverrides({ authority: { externalAction: true } })).toEqual({ ok: false, code: "override_unsafe" });
    expect(parseRunOverrides({ timeoutMs: "forever" })).toEqual({ ok: false, code: "override_invalid" });
    expect(resolveRun(valid(), { tools: ["shell"] }, "unsafe-tools")).toEqual({ status: "blocked", code: "override_unsafe" });
    expect(resolveRun(valid(), { budget: { tokens: 101 } }, "unsafe-budget")).toEqual({ status: "blocked", code: "override_unsafe" });
  });
});
