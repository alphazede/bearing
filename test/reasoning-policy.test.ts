import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BUILTIN_ROUTES } from "../src/adapters/adapters.js";
import {
  DEFAULT_REASONING_TIERS,
  GLOBAL_DEFAULT_REASONING_TIER,
  REASONING_PROVIDER_MAP,
  REASONING_TIERS,
  resolveBackgroundReasoning,
  resolveReasoning,
  type ReasoningPolicy,
  type ReasoningProvider,
  type ReasoningTier,
} from "../src/profile/reasoning-policy.js";

const EXPECTED_LEVELS = {
  minimal: { codex: "low", claude: "low", grok: "low", agy: "low", pi: "minimal", opencode: "minimal" },
  low: { codex: "low", claude: "low", grok: "low", agy: "low", pi: "low", opencode: "low" },
  medium: { codex: "medium", claude: "medium", grok: "medium", agy: "medium", pi: "medium", opencode: "medium" },
  high: { codex: "high", claude: "high", grok: "high", agy: "high", pi: "high", opencode: "high" },
  "very-high": { codex: "xhigh", claude: "xhigh", grok: "xhigh", agy: "thinking", pi: "xhigh", opencode: "xhigh" },
  max: { codex: "max", claude: "max", grok: "xhigh", agy: "thinking", pi: "xhigh", opencode: "max" },
} as const satisfies Readonly<Record<ReasoningTier, Readonly<Record<ReasoningProvider, string>>>>;

const PROVIDERS = ["codex", "claude", "grok", "agy", "pi", "opencode"] as const;
const INVALID_TIER = "bogus" as ReasoningTier;
const INVALID_TIER_CASES = (["policy default", "global override"] as const).flatMap((source) =>
  ([undefined, 1, 6] as const).map((escalationStep) => ({ source, escalationStep })),
);

function policy(tier: ReasoningTier = "medium", maxSteps = 10): ReasoningPolicy {
  return {
    defaults: { test: tier },
    escalation: { maxSteps, onNewFailureFingerprint: true, onCrossBoundaryDefect: true },
  };
}

const CELLS = REASONING_TIERS.flatMap((tier) => PROVIDERS.map((provider) => ({ tier, provider, expected: EXPECTED_LEVELS[tier][provider] })));

describe("reasoning provider mapping", () => {
  it("resolves the background brief at abstract medium without changing foreground policy", () => {
    expect(resolveBackgroundReasoning("pi")).toEqual({ ok: true, tier: "medium", providerLevel: "medium", clamped: false, reason: "default" });
    expect(resolveBackgroundReasoning("unknown-provider")).toEqual({ ok: false, code: "reasoning_unmappable" });
  });

  it("documents reachable abstract and legacy CLI reasoning values", () => {
    const readme = readFileSync(new URL("../guide/execution-modes.md", import.meta.url), "utf8");

    expect(readme).toContain("`--reasoning very-high` is accepted directly");
    expect(readme).toContain("`--reasoning ultra --provider codex` is accepted as a legacy alias and normalizes to abstract `max`");
  });

  it.each(CELLS)("maps $tier to $expected for $provider", ({ tier, provider, expected }) => {
    const result = resolveReasoning({ role: "test", provider, policy: policy(tier) });
    expect(result.ok && result.providerLevel).toBe(expected);
  });

  it.each([
    ["grok", "xhigh"],
    ["pi", "xhigh"],
    ["agy", "thinking"],
  ] as const)("clamps max to %s's ceiling", (provider, providerLevel) => {
    expect(resolveReasoning({ role: "test", provider, policy: policy("max") })).toEqual({
      ok: true,
      tier: "very-high",
      providerLevel,
      clamped: true,
      reason: "clamped",
    });
  });

  it("maps very-high to thinking on agy and never uses thinking below it", () => {
    expect(resolveReasoning({ role: "test", provider: "agy", policy: policy("very-high") })).toMatchObject({ ok: true, providerLevel: "thinking", clamped: false });
    for (const tier of REASONING_TIERS.slice(0, 4)) {
      expect(resolveReasoning({ role: "test", provider: "agy", policy: policy(tier) })).not.toMatchObject({ providerLevel: "thinking" });
    }
  });

  it("never produces codex ultra", () => {
    for (const tier of REASONING_TIERS) {
      expect(resolveReasoning({ role: "test", provider: "codex", policy: policy(tier) })).not.toMatchObject({ providerLevel: "ultra" });
    }
  });

  it("keeps escalation past a provider ceiling at the ceiling", () => {
    expect(resolveReasoning({ role: "test", provider: "grok", policy: policy("high"), escalationStep: 10 })).toEqual({
      ok: true,
      tier: "very-high",
      providerLevel: "xhigh",
      clamped: true,
      reason: "clamped",
    });
  });

  it("fails closed for an unknown provider", () => {
    expect(resolveReasoning({ role: "test", provider: "future-provider", policy: policy() })).toEqual({ ok: false, code: "reasoning_unmappable" });
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])("fails closed for non-finite escalation step %s", (escalationStep) => {
    const resolve = () => resolveReasoning({ role: "test", provider: "codex", policy: policy(), escalationStep });

    expect(resolve).not.toThrow();
    expect(resolve()).toEqual({ ok: false, code: "reasoning_unmappable" });
  });

  it.each(INVALID_TIER_CASES)("fails closed for an invalid $source with escalation step $escalationStep", ({ source, escalationStep }) => {
    const resolve = () => resolveReasoning({
      role: "test",
      provider: "codex",
      policy: policy(source === "policy default" ? INVALID_TIER : "medium"),
      ...(source === "global override" ? { globalOverride: INVALID_TIER } : {}),
      ...(escalationStep === undefined ? {} : { escalationStep }),
    });

    expect(resolve).not.toThrow();
    expect(resolve()).toEqual({ ok: false, code: "reasoning_unmappable" });
  });

  it("uses the global default for an unknown role", () => {
    expect(resolveReasoning({ role: "unknown-role", provider: "codex", policy: { ...policy("high"), defaults: DEFAULT_REASONING_TIERS } })).toMatchObject({
      ok: true,
      tier: GLOBAL_DEFAULT_REASONING_TIER,
      providerLevel: "medium",
      reason: "default",
    });
  });

  it("never lets the owner ceiling raise the role default", () => {
    expect(resolveReasoning({ role: "test", provider: "claude", policy: policy("low"), globalOverride: "high" })).toEqual({
      ok: true,
      tier: "low",
      providerLevel: "low",
      clamped: false,
      reason: "default",
    });
  });

  it("never escalates above the owner ceiling", () => {
    expect(resolveReasoning({ role: "test", provider: "codex", policy: policy("low"), globalOverride: "medium", escalationStep: 10 })).toEqual({
      ok: true,
      tier: "medium",
      providerLevel: "medium",
      clamped: true,
      reason: "clamped",
    });
  });

  it("keeps every mapped level inside the real provider ladder", () => {
    for (const tier of REASONING_TIERS) {
      for (const provider of PROVIDERS) {
        const route = BUILTIN_ROUTES.find((candidate) => candidate.provider === provider);
        expect(route?.reasoningLevels).toContain(REASONING_PROVIDER_MAP[tier][provider]);
      }
    }
  });
});
