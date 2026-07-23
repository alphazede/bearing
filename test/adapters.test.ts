import { describe, expect, it } from "vitest";
import { BUILTIN_ROUTES, SyntheticRunner, createAgentAdapter } from "../src/adapters/adapters.js";
import { parseAgentProfile, resolveRun } from "../src/profile/profile.js";

function role(overrides: Record<string, unknown> = {}) {
  const parsed = parseAgentProfile({ schemaVersion: 1, agentRef: "a", profileRef: "p", credentialAccountRef: "account-ref", roles: ["navigator", "explorer", "crewmate", "surveyor"], toolAllow: ["read"], toolDeny: [], authority: { read: true, write: false, network: false, workspace: true, externalAction: false }, enabledSkills: [], context: "off", systemPromptRef: "prompt", limits: { timeoutMs: 20, maxTurns: 2, maxTools: 2, maxRetries: 1, maxConcurrency: 1, maxDelegation: 1, tokenBudget: 5 }, session: { persistence: "off", resume: "never", fork: "never" }, structuredEvents: true, isolation: "auto", selection: { provider: "pi", model: "zai/glm-5.2", reasoning: "low" }, ...overrides });
  if (!parsed.ok) throw new Error(parsed.code);
  const run = resolveRun(parsed.value, {}, "adapter-test"); if (run.status !== "ready") throw new Error(run.code);
  return run.value.roles[0];
}
function adapter(runner = new SyntheticRunner(), overrides: Record<string, unknown> = {}) {
  const value = createAgentAdapter(role(overrides).selection, runner); if (!value) throw new Error("missing adapter"); return value;
}
const repositoryPath = "/tmp/bearing-repository";

describe("provider-neutral adapters", () => {
  it("has the exact static routes and inspects without process initialization", () => {
    expect(BUILTIN_ROUTES.map(({ id, provider, model, executable }) => [id, provider, model, executable])).toEqual([["codex", "codex", "*", "codex"], ["claude", "claude", "*", "claude"], ["agy", "agy", "*", "agy"], ["grok-build", "grok", "grok-build", "grok-safe"], ["opencode", "opencode", "*", "opencode"], ["pi", "pi", "*", "pi"]]);
    const runner = new SyntheticRunner(); expect(adapter(runner).inspect().available).toBe(true); expect(runner.calls).toEqual([]);
    expect(createAgentAdapter({ provider: "codex", model: "gpt-5.6-sol", reasoning: "medium" }, runner)).toBeDefined();
    expect(createAgentAdapter({ provider: "unknown", model: "nope", reasoning: "medium" }, runner)).toBeUndefined();
  });

  it("uses argv only, policy limits, and redacted structured receipts", async () => {
    const runner = new SyntheticRunner(undefined, [{ exitCode: 0, events: [{ type: "done", data: { apiToken: "nope", nested: { secret: "nope" }, okay: true } }], usage: { tokens: 2 } }], { isolated: true, evidence: "test" });
    const receipt = await adapter(runner).execute({ runId: "r", repositoryPath, role: role(), task: { prompt: "do work" } });
    expect(runner.calls[0]).toMatchObject({ executable: "pi", args: ["--mode", "json", "--print", "--model", "zai/glm-5.2", "--thinking", "low", "--tools", "read", "--exclude-tools", "", "--no-session", "--offline"], stdin: "do work", cwd: repositoryPath });
    expect(receipt).toMatchObject({ status: "completed", isolation: "attested", events: [{ data: { apiToken: "[redacted]", nested: { secret: "[redacted]" }, okay: true } }] });
    expect(JSON.stringify(receipt)).not.toMatch(/nope|credential|prompt/i);
  });

  it("passes the optional activity observer through the provider-neutral process seam", async () => {
    const runner = new SyntheticRunner();
    const onActivity = () => {};
    await adapter(runner).execute({ runId: "activity", repositoryPath, role: role(), task: { prompt: "do work" }, onActivity });
    expect(runner.calls[0]?.onActivity).toBe(onActivity);
  });

  it("allows Grok subagents only through an explicit execution request", async () => {
    const selection = { provider: "grok", model: "grok-build", reasoning: "medium" };
    const runner = new SyntheticRunner();
    const grok = createAgentAdapter(selection, runner);
    if (!grok) throw new Error("missing grok adapter");
    await grok.execute({ runId: "grok-expedition", repositoryPath, role: role({ selection }), task: { prompt: "coordinate" }, allowSubagents: true });
    expect(runner.calls[0].args.slice(0, 2)).toEqual(["--allow-subagents", "--"]);
    expect(runner.calls[0].args).not.toContain("--no-subagents");

    const boundedRunner = new SyntheticRunner();
    const bounded = createAgentAdapter(selection, boundedRunner);
    if (!bounded) throw new Error("missing grok adapter");
    await bounded.execute({ runId: "grok-bounded", repositoryPath, role: role({ selection }), task: { prompt: "work" } });
    expect(boundedRunner.calls[0].args[0]).toBe("--");
    expect(boundedRunner.calls[0].args).toContain("--no-subagents");
  });

  it("pins non-interactive Codex approval policy through current config argv", async () => {
    const runner = new SyntheticRunner();
    const codex = createAgentAdapter({ provider: "codex", model: "gpt-5.6-sol", reasoning: "medium" }, runner);
    if (!codex) throw new Error("missing adapter");
    await codex.execute({ runId: "codex-policy", repositoryPath, role: role({ selection: { provider: "codex", model: "gpt-5.6-sol", reasoning: "medium" } }), task: { prompt: "x" } });
    expect(runner.calls[0]?.args).toContain('approval_policy="never"');
    expect(runner.calls[0]?.args).not.toContain("-a");
  });

  it("uses the configured Codex model for wildcard selection and pins concrete models", async () => {
    const wildcardRunner = new SyntheticRunner();
    const wildcard = createAgentAdapter({ provider: "codex", model: "*", reasoning: "medium" }, wildcardRunner);
    if (!wildcard) throw new Error("missing wildcard adapter");
    await wildcard.execute({ runId: "codex-wildcard", repositoryPath, role: role({ selection: { provider: "codex", model: "*", reasoning: "medium" } }), task: { prompt: "x" } });
    expect(wildcardRunner.calls[0]?.args).toEqual(["exec", "--json", "-c", 'model_reasoning_effort="medium"', "-c", 'approval_policy="never"', "-C", repositoryPath, "-s", "read-only", "--ephemeral", "-"]);

    const concreteRunner = new SyntheticRunner();
    const concrete = createAgentAdapter({ provider: "codex", model: "gpt-5.6-sol", reasoning: "high" }, concreteRunner);
    if (!concrete) throw new Error("missing concrete adapter");
    await concrete.execute({ runId: "codex-concrete", repositoryPath, role: role({ selection: { provider: "codex", model: "gpt-5.6-sol", reasoning: "high" } }), task: { prompt: "x" } });
    expect(concreteRunner.calls[0]?.args).toEqual(["exec", "--json", "-m", "gpt-5.6-sol", "-c", 'model_reasoning_effort="high"', "-c", 'approval_policy="never"', "-C", repositoryPath, "-s", "read-only", "--ephemeral", "-"]);
  });

  it("captures and resumes a Codex session while unsupported harnesses stay isolated", async () => {
    const selection = { provider: "codex", model: "gpt-5.6-sol", reasoning: "medium" };
    const persistent = role({ selection, session: { persistence: "persistent", resume: "allowed", fork: "allowed" } });
    const thread = "123e4567-e89b-12d3-a456-426614174000";
    const runner = new SyntheticRunner(undefined, [
      { exitCode: 0, events: [{ type: "turn.completed" }], usage: { tokens: 1 }, providerSessionId: thread },
      { exitCode: 0, events: [{ type: "turn.completed" }], usage: { tokens: 1 } },
    ]);
    const first = createAgentAdapter(selection, runner); if (!first) throw new Error("missing Codex adapter");
    await first.execute({ runId: "first", repositoryPath, role: persistent, task: { prompt: "first" } });
    const second = createAgentAdapter(selection, runner); if (!second) throw new Error("missing Codex adapter");
    await second.execute({ runId: "second", repositoryPath, role: persistent, task: { prompt: "second" } });
    expect(runner.calls[0]?.args).toEqual(expect.arrayContaining(["exec", "--json"]));
    expect(runner.calls[0]?.args).not.toContain("--ephemeral");
    expect(runner.calls[1]?.args).toEqual(expect.arrayContaining(["exec", "resume", thread, "--json", 'sandbox_mode="read-only"']));

    const piSelection = { provider: "pi", model: "zai/glm-5.2", reasoning: "low" };
    const piRunner = new SyntheticRunner();
    const pi = createAgentAdapter(piSelection, piRunner); if (!pi) throw new Error("missing Pi adapter");
    await pi.execute({ runId: "pi", repositoryPath, role: role({ selection: piSelection, session: { persistence: "persistent", resume: "allowed", fork: "allowed" } }), task: { prompt: "isolated" } });
    expect(piRunner.calls[0]?.args).toContain("--no-session");
    expect(piRunner.calls[0]?.providerSessionId).toBeUndefined();
  });

  it("truthfully resolves isolation modes", async () => {
    expect((await adapter().execute({ runId: "a", repositoryPath, role: role({ isolation: "required" }), task: { prompt: "x" } }))).toMatchObject({ status: "blocked", failure: "isolation_required" });
    expect((await adapter().execute({ runId: "b", repositoryPath, role: role(), task: { prompt: "x" } })).warningCodes).toContain("local_execution_unattested");
    expect((await adapter().execute({ runId: "c", repositoryPath, role: role({ isolation: "off" }), task: { prompt: "x" } })).isolation).toBe("off");
  });

  it("keeps configured routes fail-closed without silent model fallback", async () => {
    const unavailable = new SyntheticRunner(new Set<string>());
    expect(await adapter(unavailable).execute({ runId: "x", repositoryPath, role: role(), task: { prompt: "x" } })).toMatchObject({ status: "blocked", failure: "unavailable", requestedRoute: "pi", effectiveRoute: "pi" });
    const failedVerification = Object.assign(new SyntheticRunner(), { verify: async () => false });
    expect(await adapter(failedVerification).execute({ runId: "verify", repositoryPath, role: role(), task: { prompt: "x" } })).toMatchObject({ status: "completed" });
    expect(await adapter(new SyntheticRunner()).verify()).toMatchObject({ ok: false, failure: "verification_failed" });
  });

  it("bounds failures, cancellation, and retries without retrying unknown effects", async () => {
    for (const [result, failure] of [[{ timedOut: true }, "timeout"], [{ exitCode: 0, events: "bad", usage: { tokens: 1 } }, "malformed_output"], [{ exitCode: 0, events: [], usage: { tokens: 6 } }, "token_budget"], [{ exitCode: 4, error: { apiKey: "not-in-receipt" } }, "nonzero_exit"], [{ unknownSideEffect: true, retryable: true }, "unknown_side_effect"]] as const) {
      const runner = new SyntheticRunner(undefined, [result]); const a = adapter(runner); const receipt = await a.execute({ runId: failure, repositoryPath, role: role(), task: { prompt: "x" } });
      expect(receipt.failure).toBe(failure); expect(receipt.attempts).toBe(failure === "unknown_side_effect" ? 1 : 1);
      expect(JSON.stringify(receipt)).not.toContain("not-in-receipt");
    }
    const runner = new SyntheticRunner(); const a = adapter(runner); await a.cancel("cancel"); await a.cancel("cancel");
    expect((await a.execute({ runId: "cancel", repositoryPath, role: role(), task: { prompt: "x" } })).status).toBe("cancelled"); expect(runner.cancelled).toEqual(["cancel"]);
    const retry = new SyntheticRunner(undefined, [{ exitCode: 1, retryable: true, sideEffectFree: true }, { exitCode: 0, events: [], usage: { tokens: 1 } }]);
    expect((await adapter(retry).execute({ runId: "retry", repositoryPath, role: role(), task: { prompt: "x" } })).attempts).toBe(2);
    const unproven = new SyntheticRunner(undefined, [{ exitCode: 1, retryable: true }, { exitCode: 0, events: [], usage: { tokens: 1 } }]);
    expect((await adapter(unproven).execute({ runId: "unproven", repositoryPath, role: role(), task: { prompt: "x" } })).attempts).toBe(1);
  });

  it("bounds structured event count and type length", async () => {
    const tooMany = new SyntheticRunner(undefined, [{ exitCode: 0, events: Array.from({ length: 1025 }, () => ({ type: "x" })), usage: { tokens: 1 } }]);
    expect((await adapter(tooMany).execute({ runId: "many", repositoryPath, role: role(), task: { prompt: "x" } })).failure).toBe("malformed_output");
    const longType = new SyntheticRunner(undefined, [{ exitCode: 0, events: [{ type: "x".repeat(129) }], usage: { tokens: 1 } }]);
    expect((await adapter(longType).execute({ runId: "long", repositoryPath, role: role(), task: { prompt: "x" } })).failure).toBe("malformed_output");
  });
});
