import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SyntheticRunner } from "../src/adapters/adapters.js";
import { AdapterVerification, ReadinessService } from "../src/onboarding/readiness.js";

describe("readiness service", () => {
  it("inspects passively without verification or initialization", () => {
    let checks = 0;
    const service = new ReadinessService({ executableAvailable: () => { checks += 1; return true; } }, { verify: async () => { throw new Error("must not verify"); } });
    const routes = service.inspect();
    expect(routes).toHaveLength(5);
    expect(routes.every((route) => route.detected)).toBe(true);
    expect(checks).toBe(5);
  });

  it("discovers models only for the selected route and reuses its repository cache", async () => {
    const repository = await mkdtemp(join(tmpdir(), "bearing-readiness-"));
    const repositories: string[] = [];
    const inspection = {
      executableAvailable: () => true,
      modelOptions: (_route: unknown, repositoryPath?: string) => {
        repositories.push(repositoryPath ?? "");
        return [{ model: "repo/model", label: "Repo model", reasoningLevels: ["medium", "high"], defaultReasoning: "high" }];
      },
    };
    const service = new ReadinessService(inspection);
    try {
      expect(service.inspect(repository)).toHaveLength(5);
      expect(repositories).toEqual([]);
      expect(service.discover("opencode", repository)).toMatchObject([{ model: "repo/model" }]);
      expect(repositories).toEqual([repository]);
      expect((await service.check({ provider: "opencode", model: "repo/model", reasoning: "high" }, repository)).status).toBe("detected");
      expect(repositories).toEqual([repository]);
    } finally { await rm(repository, { recursive: true, force: true }); }
  });

  it("shares provider and model across role-specific reasoning and distinguishes detected from verified", async () => {
    const detected = await new ReadinessService({ executableAvailable: () => true }).check({ provider: "codex", model: "gpt-5.6-terra", reasoning: "high" });
    expect(detected.status).toBe("detected");
    if (detected.status === "blocked") return;
    expect(detected.verified).toBe(false);
    expect(detected.run.roles.every((role) => role.limits.tokenBudget === Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(detected.run.roles.every((role) => role.limits.timeoutMs === 2_100_000)).toBe(true);
    expect(new Set(detected.run.roles.map((role) => `${role.selection.provider}/${role.selection.model}`))).toEqual(new Set(["codex/gpt-5.6-terra"]));
    expect(new Set(detected.run.roles.map((role) => role.selection.reasoning))).toEqual(new Set(["high"]));
    expect(new Set(detected.run.roles.map((role) => role.reasoning.providerLevel)).size).toBe(1);
    expect(new Set(detected.run.roles.map((role) => role.identity)).size).toBe(4);
    expect(new Set(detected.run.roles.map((role) => JSON.stringify(role.authority))).size).toBe(2);
    expect(detected.run.roles.every((role) => role.authority.network === false)).toBe(true);
    expect(new Set(detected.run.roles.map((role) => JSON.stringify({ allow: role.toolAllow, deny: role.toolDeny }))).size).toBe(4);
    expect(detected.run.roles.find((role) => role.role === "surveyor")).toMatchObject({ executor: false, authority: { write: false, network: false }, toolAllow: ["read"] });
    expect(JSON.stringify(detected)).not.toMatch(/credentialAccountRef|accounts\/|apiKey|password/i);

    const verified = await new ReadinessService({ executableAvailable: () => true }, { verify: async () => true }).check({ provider: "codex", model: "gpt-5.6-terra", reasoning: "high" });
    expect(verified.status).toBe("ready");
  });

  it("enables agent-tool network authority only for the AGY route", async () => {
    const service = new ReadinessService({ executableAvailable: () => true });
    const agy = await service.check({ provider: "agy", model: "Gemini 3.5 Flash (Low)", reasoning: "low" });
    expect(agy.status).toBe("detected");
    if (agy.status === "blocked") return;
    expect(agy.run.roles.every((role) => role.authority.network === true)).toBe(true);
  });

  it("returns one stable repair code without fallback or auto-selection", async () => {
    const service = new ReadinessService({ executableAvailable: () => false });
    expect(await service.check({ provider: "codex", model: "gpt-5.6-terra", reasoning: "medium" })).toEqual({ status: "blocked", detected: false, verified: false, code: "selection_unavailable", repair: "choose_detected_route" });
    expect(await service.check({ provider: "unknown", model: "unknown", reasoning: "medium" })).toEqual({ status: "blocked", detected: false, verified: false, code: "selection_unavailable", repair: "choose_detected_route" });
  });

  it("clamps to a discovered model's native levels and blocks without a lower level", async () => {
    const inspection = {
      executableAvailable: () => true,
      modelOptions: () => [{ model: "openai/gpt-5", label: "GPT-5", reasoningLevels: ["default", "medium", "high"], defaultReasoning: "default" }],
    };
    expect((await new ReadinessService(inspection).check({ provider: "opencode", model: "openai/gpt-5", reasoning: "high" })).status).toBe("detected");
    expect((await new ReadinessService(inspection).check({ provider: "opencode", model: "openai/gpt-5", reasoning: "max" })).status).toBe("detected");
    const noLowerLevel = {
      executableAvailable: () => true,
      modelOptions: () => [{ model: "only/high", label: "Only high", reasoningLevels: ["high"], defaultReasoning: "high" }],
    };
    expect((await new ReadinessService(noLowerLevel).check({ provider: "opencode", model: "only/high", reasoning: "high" })).status).toBe("detected");
  });

  it("clamps every absent resolved role level to the selected model ladder", async () => {
    const inspection = {
      executableAvailable: () => true,
      modelOptions: () => [{ model: "google/gemini", label: "Google Gemini", reasoningLevels: ["default", "low", "high"], defaultReasoning: "default" }],
    };
    const result = await new ReadinessService(inspection).check({ provider: "opencode", model: "google/gemini", reasoning: "high" });
    expect(result.status).toBe("detected");
    if (result.status === "blocked") return;
    expect(Object.fromEntries(result.run.roles.map((role) => [role.role, role.reasoning.providerLevel]))).toEqual({
      navigator: "high",
      explorer: "high",
      crewmate: "high",
      surveyor: "high",
    });
  });

  it("clamps role defaults to the nearest lower discovered model level", async () => {
    const opencode = await new ReadinessService({
      executableAvailable: () => true,
      modelOptions: () => [{ model: "anthropic/claude-sonnet-4", label: "Claude Sonnet 4", reasoningLevels: ["low", "high"], defaultReasoning: "high" }],
    }).check({ provider: "opencode", model: "anthropic/claude-sonnet-4", reasoning: "high" });
    expect(opencode.status).toBe("detected");
    if (opencode.status === "blocked") return;
    expect(Object.fromEntries(opencode.run.roles.map((role) => [role.role, role.reasoning.providerLevel]))).toEqual({
      navigator: "high",
      explorer: "high",
      crewmate: "high",
      surveyor: "high",
    });
    expect(opencode.run.roles.filter((role) => role.role !== "navigator").every((role) => role.reasoning.clamped)).toBe(false);
    expect(opencode.run.receipt.effective).toMatchObject({ route: { reasoning: { navigator: "high", explorer: "high", crewmate: "high", surveyor: "high" } } });

    const pi = await new ReadinessService({
      executableAvailable: () => true,
      modelOptions: () => [{ model: "zai/glm-5.2", label: "GLM 5.2", reasoningLevels: ["off"], defaultReasoning: "off" }],
    }).check({ provider: "pi", model: "zai/glm-5.2", reasoning: "high" });
    expect(pi.status).toBe("detected");
    if (pi.status !== "blocked") expect(pi.run.roles.every((role) => role.reasoning.providerLevel === "off" && role.reasoning.clamped)).toBe(true);
  });

  it("blocks rather than returning role reasoning outside the provider route ladder", async () => {
    const result = await new ReadinessService({
      executableAvailable: () => true,
      modelOptions: () => [{ model: "gpt-test", label: "GPT test", reasoningLevels: ["none", "high"], defaultReasoning: "high" }],
    }).check({ provider: "codex", model: "gpt-test", reasoning: "high" });

    expect(result.status).toBe("detected");
  });

  it("runs an OpenCode default-only model without a variant argument", async () => {
    const runner = new SyntheticRunner();
    const result = await new ReadinessService({
      executableAvailable: () => true,
      modelOptions: () => [{ model: "provider/default-only", label: "Default only", reasoningLevels: ["default"], defaultReasoning: "default" }],
    }, new AdapterVerification(runner)).check({ provider: "opencode", model: "provider/default-only", reasoning: "high" });

    expect(result.status).toBe("ready");
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0].args).not.toContain("--variant");
  });

  it("clamps every absent resolved role level to the selected model ladder", async () => {
    const inspection = {
      executableAvailable: () => true,
      modelOptions: () => [{ model: "google/gemini", label: "Google Gemini", reasoningLevels: ["default", "low", "high"], defaultReasoning: "default" }],
    };
    const result = await new ReadinessService(inspection).check({ provider: "opencode", model: "google/gemini", reasoning: "high" });
    expect(result.status).toBe("detected");
    if (result.status === "blocked") return;
    expect(Object.fromEntries(result.run.roles.map((role) => [role.role, role.reasoning.providerLevel]))).toEqual({
      navigator: "high",
      explorer: "high",
      crewmate: "high",
      surveyor: "high",
    });
  });

  it("clamps role defaults to the nearest lower discovered model level", async () => {
    const opencode = await new ReadinessService({
      executableAvailable: () => true,
      modelOptions: () => [{ model: "anthropic/claude-sonnet-4", label: "Claude Sonnet 4", reasoningLevels: ["low", "high"], defaultReasoning: "high" }],
    }).check({ provider: "opencode", model: "anthropic/claude-sonnet-4", reasoning: "high" });
    expect(opencode.status).toBe("detected");
    if (opencode.status === "blocked") return;
    expect(Object.fromEntries(opencode.run.roles.map((role) => [role.role, role.reasoning.providerLevel]))).toEqual({
      navigator: "high",
      explorer: "high",
      crewmate: "high",
      surveyor: "high",
    });
    expect(opencode.run.roles.filter((role) => role.role !== "navigator").every((role) => role.reasoning.clamped)).toBe(false);
    expect(opencode.run.receipt.effective).toMatchObject({ route: { reasoning: { navigator: "high", explorer: "high", crewmate: "high", surveyor: "high" } } });

    const pi = await new ReadinessService({
      executableAvailable: () => true,
      modelOptions: () => [{ model: "zai/glm-5.2", label: "GLM 5.2", reasoningLevels: ["off"], defaultReasoning: "off" }],
    }).check({ provider: "pi", model: "zai/glm-5.2", reasoning: "high" });
    expect(pi.status).toBe("detected");
    if (pi.status !== "blocked") expect(pi.run.roles.every((role) => role.reasoning.providerLevel === "off" && role.reasoning.clamped)).toBe(true);
  });

  it("uses the route fallback when discovery returns no models", async () => {
    const result = await new ReadinessService({ executableAvailable: () => true, modelOptions: () => [] }).check({ provider: "codex", model: "*", reasoning: "medium" });
    expect(result.status).toBe("detected");
  });

  it("preserves the Codex wildcard selection for configured-model execution", async () => {
    const result = await new ReadinessService({ executableAvailable: () => true }).check({ provider: "codex", model: "*", reasoning: "medium" });
    expect(result.status).toBe("detected");
    if (result.status !== "blocked") expect(result.run.roles[0].selection).toEqual({ provider: "codex", model: "*", reasoning: "medium" });
  });

  it("applies startup overrides only while resolving the selected run", async () => {
    const result = await new ReadinessService({ executableAvailable: () => true }, undefined, { offline: true, maxTurns: 3 }).check({ provider: "codex", model: "gpt-5.6-sol", reasoning: "medium" });
    expect(result.status).toBe("detected");
    if (result.status === "blocked") return;
    expect(result.run.receipt.effective).toMatchObject({ authority: { network: false }, limits: { maxTurns: 3 } });
    const routed = await new ReadinessService({ executableAvailable: (executable) => executable === "pi" }, undefined, { provider: "pi", model: "zai/glm-5.2", reasoning: "low" }).check({ provider: "codex", model: "gpt-5.6-sol", reasoning: "medium" });
    expect(routed.status).toBe("detected");
    if (routed.status !== "blocked") {
      expect(routed.run.roles[0].selection).toEqual({ provider: "pi", model: "zai/glm-5.2", reasoning: "low" });
      expect(routed.run.receipt.requested.route).toMatchObject({ provider: "codex", model: "gpt-5.6-sol", reasoning: "medium" });
      expect(routed.run.receipt.effective.route).toMatchObject({ provider: "pi", model: "zai/glm-5.2", reasoning: { navigator: "low", explorer: "low", crewmate: "low", surveyor: "low" } });
    }
    const lowered = await new ReadinessService({ executableAvailable: () => true }, undefined, { budget: { tokens: 120_000 } }).check({ provider: "codex", model: "*", reasoning: "medium" });
    expect(lowered.status).toBe("detected");
    if (lowered.status !== "blocked") expect(lowered.run.roles.every((role) => role.limits.tokenBudget === 120_000)).toBe(true);
  });
});
