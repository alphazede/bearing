import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { NodeProcessRunner } from "../src/adapters/process-runner.js";
import { createAgentAdapter, type ProcessInvocation } from "../src/adapters/adapters.js";
import { parseAgentProfile, resolveRun, type Selection } from "../src/profile/profile.js";

const repositoryPath = "/tmp/bearing-repository";

function role(selection: Selection, overrides: Record<string, unknown> = {}, runOverrides: Record<string, unknown> = {}) {
  const parsed = parseAgentProfile({ schemaVersion: 1, agentRef: "a", profileRef: "p", credentialAccountRef: "environment", roles: ["navigator", "explorer", "crewmate", "surveyor"], toolAllow: ["read", "write"], toolDeny: ["external-action"], authority: { read: true, write: true, network: false, workspace: true, externalAction: false }, enabledSkills: [], context: "off", systemPromptRef: "prompt", limits: { timeoutMs: 50, maxTurns: 2, maxTools: 2, maxRetries: 1, maxConcurrency: 1, maxDelegation: 1, tokenBudget: 50 }, session: { persistence: "off", resume: "never", fork: "never" }, structuredEvents: true, isolation: "auto", selection, ...overrides });
  if (!parsed.ok) throw new Error(parsed.code);
  const run = resolveRun(parsed.value, runOverrides, "process-runner-test"); if (run.status !== "ready") throw new Error(run.code);
  return run.value.roles.find((projection) => projection.role === "crewmate")!;
}

function fakeChild(output = '{"type":"complete","usage":{"total_tokens":2}}\n', exitCode = 0, errorOutput = "") {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  Object.assign(child, { pid: undefined, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => { queueMicrotask(() => child.emit("close", null)); return true; } });
  queueMicrotask(() => { child.stdout.end(output); child.stderr.end(errorOutput); child.emit("close", exitCode); });
  return child;
}

function harness(output?: string, exitCode?: number, errorOutput?: string) {
  const calls: { executable: string; args: readonly string[]; options: unknown; stdin: string }[] = [];
  const spawn = (executable: string, args: readonly string[], options: unknown) => {
    const child = fakeChild(output, exitCode, errorOutput);
    const call = { executable, args, options, stdin: "" };
    const end = child.stdin.end.bind(child.stdin);
    child.stdin.end = ((chunk?: string | Uint8Array) => { if (chunk !== undefined) call.stdin = String(chunk); return end(chunk); }) as typeof child.stdin.end;
    calls.push(call);
    return child;
  };
  return { runner: new NodeProcessRunner(spawn, () => true, (executable, cwd) => ({ executable, cwd })), calls };
}

function chunkedHarness(chunks: readonly string[]) {
  const spawn = () => {
    const child = new EventEmitter() as ChildProcessWithoutNullStreams;
    Object.assign(child, { pid: undefined, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
    queueMicrotask(() => {
      for (const chunk of chunks) child.stdout.write(chunk);
      child.stdout.end();
      child.stderr.end();
      child.emit("close", 0);
    });
    return child;
  };
  return new NodeProcessRunner(spawn, () => true, (executable, cwd) => ({ executable, cwd }));
}

async function execute(selection: Selection, overrides: Record<string, unknown> = {}, runOverrides: Record<string, unknown> = {}) {
  const h = harness();
  const adapter = createAgentAdapter(selection, h.runner); if (!adapter) throw new Error("missing adapter");
  const receipt = await adapter.execute({ runId: `${selection.provider}-${selection.model}`, repositoryPath, role: role(selection, overrides, runOverrides), task: { prompt: "private source password=hunter2" } });
  return { ...h, receipt };
}

describe("production process runner", () => {
  it("builds exact provider argv and keeps prompt on stdin", async () => {
    const codex = await execute({ provider: "codex", model: "gpt-5.6-sol", reasoning: "medium" });
    expect(codex.calls[0]).toMatchObject({ executable: "codex", args: ["exec", "--json", "-m", "gpt-5.6-sol", "-c", 'model_reasoning_effort="medium"', "-c", 'approval_policy="never"', "-C", repositoryPath, "-s", "workspace-write", "--ephemeral", "-"], options: { cwd: repositoryPath, shell: false, detached: true, stdio: ["pipe", "pipe", "pipe"] }, stdin: "private source password=hunter2" });
    const grok = await execute({ provider: "grok", model: "grok-build", reasoning: "medium" });
    expect(grok.calls[0].executable).toBe("grok-safe");
    expect(grok.calls[0].args).toEqual(["--", "--output-format", "streaming-json", "--prompt-file", "/dev/stdin", "--cwd", repositoryPath, "--model", "grok-build", "--reasoning-effort", "medium", "--max-turns", "2", "--tools", "read,write", "--disallowed-tools", "external-action", "--sandbox", "strict", "--permission-mode", "dontAsk", "--no-memory", "--no-subagents", "--disable-web-search"]);
    const claude = await execute({ provider: "claude", model: "sonnet", reasoning: "high" });
    expect(claude.calls[0]).toMatchObject({ executable: "claude", args: ["--print", "--output-format", "stream-json", "--verbose", "--model", "sonnet", "--effort", "high", "--permission-mode", "dontAsk", "--allowedTools", "Read,Edit,Write", "--no-session-persistence"], stdin: "private source password=hunter2" });
    const pi = await execute({ provider: "pi", model: "zai/glm-5.2", reasoning: "medium" }, {}, { noSession: true });
    expect(pi.calls[0]).toMatchObject({ executable: "pi", args: ["--mode", "json", "--print", "--model", "zai/glm-5.2", "--thinking", "medium", "--tools", "read,write", "--exclude-tools", "external-action", "--no-session", "--offline"] });
    const piV4 = await execute({ provider: "pi", model: "deepseek/deepseek-v4-pro", reasoning: "high" });
    expect(piV4.calls[0].args).toContain("deepseek/deepseek-v4-pro");
    const agy = await execute({ provider: "agy", model: "Gemini 3.5 Flash (Low)", reasoning: "low" }, { authority: { read: true, write: true, network: true, workspace: true, externalAction: false }, limits: { timeoutMs: 50, maxTurns: 2, maxTools: 2, maxRetries: 1, maxConcurrency: 1, maxDelegation: 1, tokenBudget: Number.MAX_SAFE_INTEGER } });
    expect(agy.calls[0]).toMatchObject({ executable: "agy", stdin: "", args: expect.arrayContaining(["--sandbox", "--add-dir", expect.stringMatching(/^\/tmp\/bearing-prompt-/), "--mode", "accept-edits", "--model", "Gemini 3.5 Flash (Low)", "--print"]) });
    expect(agy.calls[0].args).not.toContain("--dangerously-skip-permissions");
    expect(agy.calls[0].args.at(-1)).toMatch(/^Read and follow the complete task in @\/tmp\/bearing-prompt-/);
    const opencode = await execute({ provider: "opencode", model: "openai/gpt-5", reasoning: "high" });
    expect(opencode.calls[0]).toMatchObject({ executable: "opencode", stdin: "", args: expect.arrayContaining(["run", "--format", "json", "--dir", repositoryPath, "--model", "openai/gpt-5", "--variant", "high", "--file"]) });
    expect(JSON.parse((opencode.calls[0].options as { env: Record<string, string> }).env.OPENCODE_PERMISSION)).toMatchObject({ "*": "deny", read: "allow", edit: "allow", bash: "deny", task: "deny", webfetch: "deny", websearch: "deny", external_directory: "deny" });
    for (const result of [codex, grok, claude, agy, opencode, pi, piV4]) {
      expect(result.calls[0].args.join(" ")).not.toMatch(/hunter2|private source/);
      expect(JSON.stringify(result.receipt)).not.toMatch(/hunter2|private source/);
    }
  });

  it("represents read-only authority exactly and blocks unrepresentable policy", async () => {
    const codex = await execute({ provider: "codex", model: "gpt-5.6-terra", reasoning: "medium" }, { authority: { read: true, write: false, network: true, workspace: true, externalAction: false }, toolAllow: ["read"], toolDeny: ["external-action"] });
    expect(codex.calls).toHaveLength(0);
    expect(codex.receipt).toMatchObject({ status: "blocked", failure: "unsupported_policy", warningCodes: expect.arrayContaining(["codex_network_policy_unsupported"]) });
    const readOnly = { authority: { read: true, write: false, network: false, workspace: true, externalAction: false } };
    const grok = await execute({ provider: "grok", model: "grok-build", reasoning: "medium" }, readOnly);
    expect(grok.calls[0].args).toEqual(expect.arrayContaining(["--tools", "read", "--disallowed-tools", "external-action", "--sandbox", "strict"]));
    expect(grok.receipt.warningCodes).not.toContain("tools_narrowed");
    const pi = await execute({ provider: "pi", model: "zai/glm-5.2", reasoning: "medium" }, readOnly);
    expect(pi.calls[0].args).toEqual(expect.arrayContaining(["--tools", "read", "--exclude-tools", "external-action"]));
    expect(pi.receipt.warningCodes).not.toContain("tools_narrowed");
    const denied = await execute({ provider: "codex", model: "gpt-5.6-sol", reasoning: "medium" }, { toolDeny: ["shell"] });
    expect(denied.calls).toHaveLength(0);
    expect(denied.receipt).toMatchObject({ status: "blocked", failure: "unsupported_policy" });
    const invalidReasoning = await execute({ provider: "pi", model: "zai/glm-5.2", reasoning: "unbounded" });
    expect(invalidReasoning.calls).toHaveLength(0);
    expect(invalidReasoning.receipt).toMatchObject({ status: "blocked", failure: "unsupported_policy" });
    const boundedAgy = await execute({ provider: "agy", model: "Gemini 3.5 Flash (Low)", reasoning: "low" }, { authority: { read: true, write: true, network: true, workspace: true, externalAction: false } });
    expect(boundedAgy.calls).toHaveLength(0);
    expect(boundedAgy.receipt.warningCodes).toContain("agy_token_budget_unsupported");
  });

  it("honors Claude tool narrowing and lets Pi use its configured default model", async () => {
    const claude = await execute({ provider: "claude", model: "sonnet", reasoning: "medium" }, {}, { tools: ["read"] });
    expect(claude.calls[0].args).toEqual(expect.arrayContaining(["--allowedTools", "Read"]));
    expect(claude.calls[0].args.join(",")).not.toMatch(/Edit|Write|Glob|Grep/);
    const pi = await execute({ provider: "pi", model: "*", reasoning: "medium" });
    expect(pi.calls[0].args).not.toContain("--model");
  });

  it("inspects passively and parses JSON and JSONL without retaining stderr", async () => {
    let inspected = 0;
    const h = harness('{"type":"message","data":"ok"}\n{"event":"complete","usage":{"input_tokens":2,"output_tokens":3}}\n');
    const runner = new NodeProcessRunner((h.runner as unknown as { spawnProcess: never }).spawnProcess, () => { inspected += 1; return true; }, (executable, cwd) => ({ executable, cwd }));
    expect(runner.executableAvailable("codex")).toBe(true);
    expect(inspected).toBe(1);
    expect(h.calls).toHaveLength(0);
    const result = await h.runner.run({ routeId: "codex", executable: "codex", args: [], stdin: "x", cwd: repositoryPath, timeoutMs: 50, runId: "jsonl" });
    expect(result).toMatchObject({ exitCode: 0, usage: { tokens: 5 }, events: [{ type: "message", data: { content: "ok" } }, { type: "complete" }] });
  });

  it("streams only ordered, allowlisted activity metadata from complete JSONL lines", async () => {
    const output = '{"type":"tool.started","status":"running","tool":{"name":"Read","arguments":"password=hunter2"},"message":"raw model content","path":"/private/source"}\nnot-json\n{"event":"turn.completed","status":"sk-abcdefgh","name":"private-source","usage":{"input_tokens":2,"output_tokens":3}}';
    const activities: unknown[] = [];
    const runner = chunkedHarness([output.slice(0, 19), output.slice(19, 81), output.slice(81)]);
    const invocation: ProcessInvocation = { routeId: "codex", executable: "codex", args: [], stdin: "private prompt", cwd: repositoryPath, timeoutMs: 50, runId: "activity", onActivity: (event) => activities.push(event) };
    const result = await runner.run(invocation);
    expect(activities).toEqual([
      { sequence: 1, kind: "tool.started", status: "running", tool: "Read" },
      { sequence: 2, kind: "turn.completed" },
    ]);
    expect(JSON.stringify(activities)).not.toMatch(/hunter2|raw model content|private|source|arguments|path|prompt/i);

    const baseline = await harness(output).runner.run({ ...invocation, runId: "baseline", onActivity: undefined });
    expect(result).toEqual(baseline);
  });

  it("does not let activity observers change process results", async () => {
    const output = '{"type":"message","usage":{"total_tokens":1}}\n';
    const result = await chunkedHarness([output]).run({ routeId: "codex", executable: "codex", args: [], stdin: "x", cwd: repositoryPath, timeoutMs: 50, runId: "observer", onActivity: () => { throw new Error("observer failed"); } });
    expect(result).toEqual(await harness(output).runner.run({ routeId: "codex", executable: "codex", args: [], stdin: "x", cwd: repositoryPath, timeoutMs: 50, runId: "baseline-observer" }));
  });

  it("parses OpenCode step-finish token usage", async () => {
    const h = harness('{"type":"text","part":{"text":"BEARING_RESULT {\\"kind\\":\\"action\\",\\"summary\\":\\"done\\",\\"artifacts\\":[]}"}}\n{"type":"step_finish","part":{"tokens":{"input":2,"output":3,"reasoning":1}}}\n{"type":"step_finish","part":{"tokens":{"input":4,"output":2,"reasoning":0}}}\n');
    expect(await h.runner.run({ routeId: "opencode", executable: "opencode", args: [], stdin: "x", cwd: repositoryPath, timeoutMs: 50, runId: "opencode-usage" })).toMatchObject({ exitCode: 0, usage: { tokens: 12 }, events: [{ type: "text", data: { content: expect.stringContaining("BEARING_RESULT") } }, { type: "step_finish" }, { type: "step_finish" }] });
  });

  it("resolves discovery commands through the safe executable boundary", () => {
    const inspected: Array<{ executable: string; args: readonly string[]; cwd: string }> = [];
    const runner = new NodeProcessRunner(undefined, () => true, (executable, cwd) => executable === "agy" ? { executable: "/usr/local/bin/agy", cwd } : undefined, (executable, args, cwd) => {
      inspected.push({ executable, args, cwd });
      return "Gemini 3.5 Flash (Medium)\n";
    });
    const route = { id: "agy", provider: "agy", model: "*", executable: "agy", capabilities: [], compatibleFallbacks: [], reasoningLevels: ["medium"] };
    expect(runner.modelOptions(route, repositoryPath)).toEqual([{ model: "Gemini 3.5 Flash (Medium)", label: "Gemini 3.5 Flash (Medium)", reasoningLevels: ["medium"], defaultReasoning: "medium" }]);
    expect(inspected).toEqual([{ executable: "/usr/local/bin/agy", args: ["models"], cwd: repositoryPath }]);
  });

  it("reads Pi's selected model from its configured agent directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bearing-pi-config-"));
    const previous = process.env.PI_CODING_AGENT_DIR;
    try {
      await writeFile(join(directory, "settings.json"), JSON.stringify({ defaultProvider: "zai", defaultModel: "glm-5.2", defaultThinkingLevel: "high" }));
      process.env.PI_CODING_AGENT_DIR = directory;
      const runner = new NodeProcessRunner(undefined, () => true);
      expect(runner.currentSelection({ id: "pi", provider: "pi", model: "*", executable: "pi", capabilities: [], compatibleFallbacks: [], reasoningLevels: ["off", "minimal", "low", "medium", "high", "xhigh"] })).toEqual({ model: "zai/glm-5.2", reasoning: "high" });
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("retains bounded response text and redacts secret patterns", async () => {
    const h = harness('{"type":"message","message":"ordinary response password=hunter2 retained","usage":{"total_tokens":1}}');
    const adapter = createAgentAdapter({ provider: "codex", model: "gpt-5.6-sol", reasoning: "medium" }, h.runner);
    if (!adapter) throw new Error("missing adapter");
    const receipt = await adapter.execute({ runId: "content", repositoryPath, role: role({ provider: "codex", model: "gpt-5.6-sol", reasoning: "medium" }), task: { prompt: "x" } });
    expect(receipt).toMatchObject({ status: "completed", events: [{ type: "message", data: { content: "ordinary response [redacted] retained" } }] });
    expect(JSON.stringify(receipt)).not.toContain("hunter2");
  });

  it("retains real Codex item.completed agent_message text", async () => {
    const h = harness('{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"BEARING_RESULT {\\"kind\\":\\"question\\",\\"question\\":\\"Which database? password=hunter2 please\\"}"}}\n{"type":"turn.completed","usage":{"input_tokens":4,"output_tokens":3}}\n');
    const result = await h.runner.run({ routeId: "codex", executable: "codex", args: [], stdin: "x", cwd: repositoryPath, timeoutMs: 50, runId: "codex-agent-message" });
    expect(result).toMatchObject({ exitCode: 0, usage: { tokens: 7 }, events: [{ type: "item.completed", data: { content: 'BEARING_RESULT {"kind":"question","question":"Which database? [redacted] please"}' } }, { type: "turn.completed" }] });
    expect(JSON.stringify(result)).not.toContain("hunter2");
  });

  it("discovers only a valid Codex thread id from structured output", async () => {
    const thread = "123e4567-e89b-12d3-a456-426614174000";
    const h = harness(`{"type":"thread.started","thread_id":"${thread}"}\n{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}\n`);
    expect(await h.runner.run({ routeId: "codex", executable: "codex", args: [], stdin: "x", cwd: repositoryPath, timeoutMs: 50, runId: "thread" })).toMatchObject({ providerSessionId: thread, usage: { tokens: 2 } });
    const invalid = harness('{"type":"thread.started","thread_id":"not-a-thread"}\n{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}\n');
    expect((await invalid.runner.run({ routeId: "codex", executable: "codex", args: [], stdin: "x", cwd: repositoryPath, timeoutMs: 50, runId: "invalid-thread" })).providerSessionId).toBeUndefined();
  });

  it("bounds output, rejects malformed JSON, times out, and cancels idempotently", async () => {
    const invocation: ProcessInvocation = { routeId: "codex", executable: "codex", args: [], stdin: "secret", cwd: repositoryPath, timeoutMs: 5, runId: "r" };
    expect(await harness("not json").runner.run(invocation)).toEqual({ unknownSideEffect: true });
    expect(await harness("x".repeat(1024 * 1024 + 1)).runner.run(invocation)).toMatchObject({ exitCode: 0, events: "oversized" });
    expect(JSON.stringify(await harness('{"type":"complete"}', 0, "password=never-returned".repeat(5000)).runner.run(invocation))).not.toContain("never-returned");
    const child = new EventEmitter() as ChildProcessWithoutNullStreams;
    let kills = 0;
    Object.assign(child, { pid: undefined, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => { kills += 1; return true; } });
    const runner = new NodeProcessRunner(() => child, () => true, (executable, cwd) => ({ executable, cwd }));
    expect(await runner.run(invocation)).toMatchObject({ timedOut: true });
    expect(kills).toBe(1);
    const cancellable = fakeChild();
    let cancelKills = 0;
    cancellable.kill = () => { cancelKills += 1; queueMicrotask(() => cancellable.emit("close", null)); return true; };
    const cancellationRunner = new NodeProcessRunner(() => cancellable, () => true, (executable, cwd) => ({ executable, cwd }));
    const pending = cancellationRunner.run({ ...invocation, runId: "cancel" });
    cancellationRunner.cancel("cancel"); cancellationRunner.cancel("cancel");
    expect(await pending).toEqual({ cancelled: true });
    expect(cancelKills).toBe(1);
  });

  it("marks ambiguous tool output for reconciliation", async () => {
    const h = harness('{"type":"tool.started"}\nmalformed');
    const result = await h.runner.run({ routeId: "codex", executable: "codex", args: [], stdin: "x", cwd: repositoryPath, timeoutMs: 50, runId: "unknown" });
    expect(result).toEqual({ unknownSideEffect: true });
    const child = new EventEmitter() as ChildProcessWithoutNullStreams;
    Object.assign(child, { pid: undefined, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
    const runner = new NodeProcessRunner(() => child, () => true, (executable, cwd) => ({ executable, cwd }));
    const pending = runner.run({ routeId: "codex", executable: "codex", args: [], stdin: "x", cwd: repositoryPath, timeoutMs: 5, runId: "tool-timeout" });
    child.stdout.write('{"type":"tool.started"}\n');
    expect(await pending).toEqual({ unknownSideEffect: true });
  });

  it("uses numeric process-group termination exactly once", async () => {
    const child = new EventEmitter() as ChildProcessWithoutNullStreams;
    Object.assign(child, { pid: 4321, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const runner = new NodeProcessRunner(() => child, () => true, (executable, cwd) => ({ executable, cwd }));
    const pending = runner.run({ routeId: "codex", executable: "codex", args: [], stdin: "x", cwd: repositoryPath, timeoutMs: 50, runId: "group" });
    runner.cancel("group"); runner.cancel("group"); child.emit("close", null);
    await pending;
    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith(-4321, "SIGTERM");
    kill.mockRestore();
  });

  it("refuses an unresolved executable before spawning", async () => {
    let spawned = false;
    const runner = new NodeProcessRunner(() => { spawned = true; return fakeChild(); }, () => true);
    const result = await runner.run({ routeId: "codex", executable: "bearing-no-such-executable", args: [], stdin: "x", cwd: process.cwd(), timeoutMs: 50, runId: "missing" });
    expect(result).toEqual({ exitCode: 1 });
    expect(spawned).toBe(false);
  });
});
