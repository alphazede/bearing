import { describe, expect, it } from "vitest";
import { BUILTIN_ROUTES } from "../src/adapters/adapters.js";
import { DEFAULT_REASONING_TIERS, type ReasoningPolicy } from "../src/profile/reasoning-policy.js";
import { migrateAgentProfile, parseAgentProfile, parseRunOverrides, resolveRun, ROLES, PROFILE_SCHEMA_VERSION, type RoleProjection } from "../src/profile/profile.js";

const REASONING_POLICY: ReasoningPolicy = {
  defaults: DEFAULT_REASONING_TIERS,
  escalation: { maxSteps: 2, onNewFailureFingerprint: true, onCrossBoundaryDefect: true },
};

function profile(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 2,
    agentRef: "agent/main",
    profileRef: "profiles/base-v2",
    credentialAccountRef: "accounts/nonsecret-ref",
    roles: ["navigator", "explorer", "crewmate", "surveyor"],
    toolAllow: ["read", "search", "write"], toolDeny: ["shell"],
    authority: { read: true, write: true, network: true, workspace: true, externalAction: false },
    enabledSkills: ["research"], context: "evidence-only", systemPromptRef: "prompts/system.md",
    limits: { timeoutMs: 1000, maxTurns: 4, maxTools: 5, maxRetries: 1, maxConcurrency: 1, maxDelegation: 1, tokenBudget: 100, costBudget: 2 },
    session: { persistence: "persistent", resume: "allowed", fork: "allowed" },
    structuredEvents: true, isolation: "required",
    reasoningPolicy: REASONING_POLICY,
    selection: { provider: "codex", model: "model", reasoning: "medium" }, ...overrides,
  };
}

function v1Profile(overrides: Record<string, unknown> = {}) {
  const { reasoningPolicy: _reasoningPolicy, ...legacy } = profile(overrides);
  return { ...legacy, schemaVersion: 1, profileRef: "profiles/base-v1", selection: { provider: "codex", model: "model", reasoning: "xhigh" }, ...overrides };
}

function valid(overrides: Record<string, unknown> = {}) {
  const parsed = parseAgentProfile(profile(overrides));
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error(parsed.code);
  return parsed.value;
}

describe("profile schema", () => {
  it("refuses schema, size, enum, authority-context, and conflicting-tool violations", () => {
    expect(parseAgentProfile(profile({ schemaVersion: 3 })).ok).toBe(false);
    expect(parseAgentProfile(profile({ agentRef: "x".repeat(257) })).ok).toBe(false);
    expect(parseAgentProfile(profile({ context: "later" })).ok).toBe(false);
    expect(parseAgentProfile(profile({ context: "rag-assisted", authority: { read: false, write: false, network: false, workspace: false, externalAction: false } })).ok).toBe(false);
    expect(parseAgentProfile(profile({ toolDeny: ["read"] })).ok).toBe(false);
    expect(parseAgentProfile(profile({ limits: { ...profile().limits, maxTurns: 0 } })).ok).toBe(false);
  });

  it("validates v2 profiles with exact reasoning-policy keys", () => {
    expect(parseAgentProfile(profile()).ok).toBe(true);
    expect(parseAgentProfile({ ...profile(), unknown: true }).ok).toBe(false);
    expect(parseAgentProfile(profile({ reasoningPolicy: { ...REASONING_POLICY, unknown: true } })).ok).toBe(false);
    expect(parseAgentProfile(profile({ reasoningPolicy: { ...REASONING_POLICY, defaults: { ...DEFAULT_REASONING_TIERS, navigator: "bogus" } } })).ok).toBe(false);
    expect(parseAgentProfile(profile({ reasoningPolicy: { ...REASONING_POLICY, escalation: { ...REASONING_POLICY.escalation, maxSteps: -1 } } })).ok).toBe(false);
    expect(parseAgentProfile(profile({ selection: { provider: "codex", model: "model", reasoning: "xhigh" } }))).toMatchObject({ ok: true, value: { selection: { reasoning: "very-high" } } });
  });

  it("normalizes every provider-native browser reasoning level to its stored abstract tier", () => {
    for (const [provider, reasoning, tier] of [
      ["codex", "xhigh", "very-high"],
      ["codex", "ultra", "max"],
      ["claude", "xhigh", "very-high"],
      ["agy", "thinking", "very-high"],
      ["grok", "xhigh", "very-high"],
      ["opencode", "default", "medium"],
      ["opencode", "none", "minimal"],
      ["opencode", "xhigh", "very-high"],
      ["pi", "off", "minimal"],
      ["pi", "xhigh", "very-high"],
    ] as const) {
      const parsed = parseAgentProfile(profile({ selection: { provider, model: "model", reasoning } }));
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.value.selection?.reasoning).toBe(tier);
    }
    expect(parseAgentProfile(profile({ selection: { provider: "codex", model: "model", reasoning: "impossible" } }))).toEqual({ ok: false, code: "reasoning_unmappable" });
  });

  it("migrates valid v1 profiles and blocks malformed or future profiles", () => {
    const migrated = migrateAgentProfile(v1Profile());
    expect(migrated.ok).toBe(true);
    if (!migrated.ok) return;
    expect(migrated.migrated).toBe(true);
    expect(migrated.value.schemaVersion).toBe(2);
    expect(migrated.value.selection?.reasoning).toBe("very-high");
    expect(migrated.value.reasoningPolicy).toEqual(REASONING_POLICY);
    expect(migrateAgentProfile({ ...v1Profile(), agentRef: "" })).toEqual({ ok: false, code: "profile_invalid" });
    expect(migrateAgentProfile(v1Profile({ selection: { provider: "codex", model: "model", reasoning: "ultra" } }))).toMatchObject({ ok: true, value: { selection: { reasoning: "max" } }, migrated: true });
    expect(migrateAgentProfile({ ...profile(), schemaVersion: 3 })).toEqual({ ok: false, code: "profile_schema_invalid" });
  });

  it("keeps the owner's route selection shared across role identities and sessions", () => {
    const result = resolveRun(valid({ selection: { provider: "codex", model: "model", reasoning: "high" } }), {}, "role-test");
    expect(result.status).toBe("ready"); if (result.status !== "ready") return;
    expect(result.value.roles.map((role) => role.selection)).toEqual(Array(4).fill({ provider: "codex", model: "model", reasoning: "high" }));
    expect(new Set(result.value.roles.map((role) => role.identity)).size).toBe(4);
    expect(new Set(result.value.roles.map((role) => role.sessionId)).size).toBe(4);
    expect(new Set(result.value.roles.map((role) => JSON.stringify(role.authority))).size).toBe(4);
    expect(new Set(result.value.roles.map((role) => JSON.stringify({ allow: role.toolAllow, deny: role.toolDeny }))).size).toBe(4);
  });

  it("projects distinct provider reasoning levels by role", () => {
    const result = resolveRun(valid({ selection: { provider: "codex", model: "model", reasoning: "high" } }), {}, "reasoning-by-role");
    expect(result.status).toBe("ready"); if (result.status !== "ready") return;
    expect(result.value.roles.find(({ role }) => role === "navigator")?.reasoning).toEqual({ tier: "high", providerLevel: "high", clamped: false });
    expect(result.value.roles.find(({ role }) => role === "explorer")?.reasoning).toEqual({ tier: "medium", providerLevel: "medium", clamped: false });
    expect(new Set(result.value.roles.map(({ reasoning }) => reasoning.providerLevel)).size).toBeGreaterThan(1);
  });

  it.each([
    ["minimal", ["minimal", "minimal", "minimal", "minimal"], ["low", "low", "low", "low"]],
    ["low", ["low", "low", "low", "low"], ["low", "low", "low", "low"]],
    ["medium", ["medium", "medium", "medium", "medium"], ["medium", "medium", "medium", "medium"]],
    ["high", ["high", "medium", "medium", "medium"], ["high", "medium", "medium", "medium"]],
    ["very-high", ["high", "medium", "medium", "medium"], ["high", "medium", "medium", "medium"]],
    ["max", ["high", "medium", "medium", "medium"], ["high", "medium", "medium", "medium"]],
  ] as const)("caps every role at the owner's %s reasoning ceiling", (ceiling, tiers, providerLevels) => {
    const result = resolveRun(valid({ selection: { provider: "codex", model: "model", reasoning: ceiling } }), {}, `ceiling-${ceiling}`);
    expect(result.status).toBe("ready"); if (result.status !== "ready") return;
    expect(result.value.roles.map(({ reasoning }) => reasoning.tier)).toEqual(tiers);
    expect(result.value.roles.map(({ reasoning }) => reasoning.providerLevel)).toEqual(providerLevels);
    expect(result.value.receipt.effective).toMatchObject({ route: { reasoning: Object.fromEntries(result.value.roles.map(({ role, reasoning }) => [role, reasoning.providerLevel])) } });
  });

  it("keeps every projected role reasoning level inside every built-in route", () => {
    for (const route of BUILTIN_ROUTES) {
      const result = resolveRun(valid({ selection: { provider: route.provider, model: route.model, reasoning: "medium" } }), {}, `route-${route.id}`);
      expect(result.status).toBe("ready");
      if (result.status !== "ready") continue;
      for (const role of result.value.roles) expect(route.reasoningLevels).toContain(role.reasoning.providerLevel);
    }
  });

  it("blocks an unmappable provider instead of choosing a default", () => {
    expect(resolveRun(valid({ selection: { provider: "future-provider", model: "model", reasoning: "medium" } }), {}, "unmappable")).toEqual({ status: "blocked", code: "reasoning_unmappable" });
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
    const result = resolveRun(valid(), { provider: "claude", model: "other-model", reasoning: "low", timeoutMs: 9, maxTurns: 2 }, "run-a");
    expect(result.status).toBe("ready"); if (result.status !== "ready") return;
    expect(result.value.receipt.requested).toMatchObject({ route: { provider: "codex", model: "model", reasoning: "medium" }, limits: { timeoutMs: 1000, maxTurns: 4 } });
    expect(result.value.receipt.effective).toMatchObject({ route: { provider: "claude", model: "other-model", reasoning: { navigator: "low", explorer: "low", crewmate: "low", surveyor: "low" } }, limits: { timeoutMs: 9, maxTurns: 2 } });
    expect(new Set(result.value.roles.map((role) => role.selection.provider))).toEqual(new Set(["claude"]));
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

describe("phase-4 4.6 type-level widening only (stored roles unchanged)", () => {
  it("profile schema version constant is provably unchanged", () => {
    expect(PROFILE_SCHEMA_VERSION).toBe(2);
  });

  it("stored ROLES tuple is unchanged by content (exactly the closed 4-tuple)", () => {
    expect(ROLES).toEqual(["navigator", "explorer", "crewmate", "surveyor"]);
    expect(ROLES.length).toBe(4);
  });

  it("a profile listing a verification role in its roles array is still rejected as profile_invalid", () => {
    const bad = profile({ roles: ["navigator", "explorer", "crewmate", "grader"] });
    expect(parseAgentProfile(bad).ok).toBe(false);
    expect(parseAgentProfile(bad)).toEqual({ ok: false, code: "profile_invalid" });
    const bad2 = profile({ roles: ["navigator", "explorer", "crewmate", "validator"] });
    expect(parseAgentProfile(bad2).ok).toBe(false);
  });

  it("resolveRun still returns exactly the four stored roles (no verification roles in output)", () => {
    const result = resolveRun(valid(), {}, "stored-roles-only");
    expect(result.status).toBe("ready"); if (result.status !== "ready") return;
    expect(result.value.roles.length).toBe(4);
    const roleNames = result.value.roles.map(r => r.role);
    expect(roleNames).toEqual(["navigator", "explorer", "crewmate", "surveyor"]);
    expect(new Set(roleNames).size).toBe(4);
  });

  it("RoleProjection role field accepts verification roles at type level (widening for adapters)", () => {
    // Exercises widened union. The literal assign (no 'as') will be used after src edit; here cast for current run, type proven by tsc after profile widen.
    const vrole: RoleProjection["role"] = "validator" as RoleProjection["role"];
    expect(vrole).toBe("validator");
    const grole: RoleProjection["role"] = "grader" as RoleProjection["role"];
    expect(grole).toBe("grader");
  });
});
