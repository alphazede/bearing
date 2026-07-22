/** Provider-neutral process adapters.  Inspection is metadata-only. */
import { isAbsolute } from "node:path";
import type { IsolationMode, RoleProjection, Selection } from "../profile/profile.js";

export type FailureClass = "unavailable" | "verification_failed" | "isolation_required" | "unsupported_policy" | "timeout" | "cancelled" | "malformed_output" | "token_budget" | "nonzero_exit" | "unknown_side_effect";
export type ExecutionStatus = "completed" | "failed" | "blocked" | "cancelled" | "blocked_reconcile";

export interface RouteDescriptor {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly executable: string;
  readonly capabilities: readonly string[];
  readonly compatibleFallbacks: readonly string[];
  readonly reasoningLevels: readonly string[];
}

export interface RouteModelOption {
  readonly model: string;
  readonly label: string;
  readonly reasoningLevels: readonly string[];
  readonly defaultReasoning: string;
}

/** Exact built-ins; only these routes can be selected without a custom registry. */
export const BUILTIN_ROUTES: readonly RouteDescriptor[] = [
  { id: "codex", provider: "codex", model: "*", executable: "codex", capabilities: ["structured-events"], compatibleFallbacks: [], reasoningLevels: ["low", "medium", "high", "xhigh", "max", "ultra"] },
  { id: "claude", provider: "claude", model: "*", executable: "claude", capabilities: ["structured-events"], compatibleFallbacks: [], reasoningLevels: ["low", "medium", "high", "xhigh", "max"] },
  { id: "agy", provider: "agy", model: "*", executable: "agy", capabilities: ["headless-output"], compatibleFallbacks: [], reasoningLevels: ["low", "medium", "high", "thinking"] },
  { id: "grok-build", provider: "grok", model: "grok-build", executable: "grok-safe", capabilities: ["structured-events"], compatibleFallbacks: [], reasoningLevels: ["low", "medium", "high", "xhigh"] },
  { id: "opencode", provider: "opencode", model: "*", executable: "opencode", capabilities: ["structured-events"], compatibleFallbacks: [], reasoningLevels: ["default", "none", "minimal", "low", "medium", "high", "xhigh", "max"] },
  { id: "pi", provider: "pi", model: "*", executable: "pi", capabilities: ["structured-events"], compatibleFallbacks: [], reasoningLevels: ["off", "minimal", "low", "medium", "high", "xhigh"] },
];

export interface IsolationAttestation { readonly isolated: boolean; readonly evidence: string; }
export interface ProcessActivity { readonly sequence: number; readonly kind: string; readonly status?: string; readonly tool?: string; }
export interface ProcessInvocation { readonly routeId: string; readonly executable: string; readonly args: readonly string[]; readonly stdin: string; readonly cwd: string; readonly timeoutMs: number; readonly runId: string; readonly sessionKey?: string; readonly providerSessionId?: string; readonly promptFile?: boolean; readonly environment?: Readonly<Record<string, string>>; readonly onActivity?: (activity: ProcessActivity) => void; }
export interface ProcessResult {
  readonly exitCode?: number;
  readonly timedOut?: boolean;
  readonly cancelled?: boolean;
  readonly unknownSideEffect?: boolean;
  readonly retryable?: boolean;
  /** Provider evidence that this failed attempt did not perform an action. */
  readonly sideEffectFree?: boolean;
  readonly events?: unknown;
  readonly usage?: { readonly tokens: number };
  /** A provider-issued session id discovered from bounded structured output. */
  readonly providerSessionId?: string;
  readonly error?: unknown;
}

/** The only external-process seam.  It deliberately has no shell field. */
export interface ProcessRunner {
  readonly executableAvailable: (executable: string) => boolean;
  readonly verify?: (route: RouteDescriptor) => Promise<boolean>;
  readonly run: (invocation: ProcessInvocation) => Promise<ProcessResult>;
  readonly cancel?: (runId: string) => Promise<void> | void;
  readonly attestIsolation?: () => IsolationAttestation | undefined;
}

export interface Inspection { readonly route: RouteDescriptor; readonly available: boolean; readonly capabilities: readonly string[]; }
export interface Verification { readonly ok: boolean; readonly failure?: "unavailable" | "verification_failed"; }
export interface ExecuteRequest { readonly runId: string; readonly repositoryPath: string; readonly role: RoleProjection; readonly task: { readonly prompt: string }; readonly fallbackRoute?: string; readonly allowSubagents?: boolean; readonly onActivity?: (activity: ProcessActivity) => void; }
export interface ExecutionReceipt {
  readonly status: ExecutionStatus;
  readonly requestedRoute: string;
  readonly effectiveRoute: string;
  readonly isolation: "attested" | "local" | "off" | "blocked";
  readonly warningCodes: readonly string[];
  readonly failure?: FailureClass;
  readonly usage: { readonly tokens: number };
  readonly events: readonly { readonly type: string; readonly data?: Readonly<Record<string, unknown>> }[];
  readonly attempts: number;
  readonly error?: { readonly code: FailureClass };
}

export interface AgentAdapter {
  inspect(): Inspection;
  verify(): Promise<Verification>;
  execute(request: ExecuteRequest): Promise<ExecutionReceipt>;
  cancel(runId: string): Promise<void>;
  attestIsolation(): IsolationAttestation | undefined;
}

const secretKey = /key|secret|token|credential|authorization|password/i;
const secretValue = /(?:\b(?:api[_ -]?key|secret|token|password|authorization)\s*[=:]\s*|\bBearer\s+|\bsk-[A-Za-z0-9_-]{8,}|\bAKIA[A-Z0-9]{16})[^\s,;]*/gi;
const MAX_EVENTS = 1024;
const MAX_EVENT_TYPE = 128;
const MAX_VALUE_DEPTH = 8;
const MAX_COLLECTION_SIZE = 256;
const MAX_STRING_LENGTH = 512 * 1024;
function events(value: unknown): readonly { readonly type: string; readonly data?: Readonly<Record<string, unknown>> }[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_EVENTS) return undefined;
  if (!value.every((event) => typeof event === "object" && event !== null && !Array.isArray(event) && typeof (event as { type?: unknown }).type === "string" && (event as { type: string }).type.length > 0 && (event as { type: string }).type.length <= MAX_EVENT_TYPE)) return undefined;
  return value.map((event) => ({ type: (event as { type: string }).type, ...(typeof (event as { data?: unknown }).data === "object" && (event as { data?: unknown }).data !== null && !Array.isArray((event as { data?: unknown }).data) ? { data: sanitize((event as { data: Record<string, unknown> }).data) as Readonly<Record<string, unknown>> } : {}) }));
}
function sanitize(value: unknown, depth = 0): unknown {
  if (depth >= MAX_VALUE_DEPTH) return "[truncated]";
  if (typeof value === "string") { const redacted = value.replace(secretValue, "[redacted]"); return redacted.length <= MAX_STRING_LENGTH ? redacted : `${redacted.slice(0, MAX_STRING_LENGTH)}[truncated]`; }
  if (Array.isArray(value)) return value.slice(0, MAX_COLLECTION_SIZE).map((entry) => sanitize(entry, depth + 1));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).slice(0, MAX_COLLECTION_SIZE).map(([key, entry]) => [key, secretKey.test(key) ? "[redacted]" : sanitize(entry, depth + 1)]));
}

class ProcessAgentAdapter implements AgentAdapter {
  private readonly cancelled = new Set<string>();
  private static readonly sessions = new WeakMap<ProcessRunner, Map<string, string>>();
  constructor(private readonly route: RouteDescriptor, private readonly selection: Selection, private readonly runner: ProcessRunner) {}
  inspect(): Inspection { return { route: this.route, available: this.runner.executableAvailable(this.route.executable), capabilities: [...this.route.capabilities] }; }
  async verify(): Promise<Verification> {
    if (!this.inspect().available) return { ok: false, failure: "unavailable" };
    if (!this.runner.verify) return { ok: false, failure: "verification_failed" };
    return (await this.runner.verify(this.route)) ? { ok: true } : { ok: false, failure: "verification_failed" };
  }
  attestIsolation(): IsolationAttestation | undefined { return this.runner.attestIsolation?.(); }
  async cancel(runId: string): Promise<void> { if (this.cancelled.has(runId)) return; this.cancelled.add(runId); await this.runner.cancel?.(runId); }
  async execute(request: ExecuteRequest): Promise<ExecutionReceipt> {
    const requested = this.route.id;
    if (!isAbsolute(request.repositoryPath)) return this.receipt("blocked", requested, requested, "blocked", [], "unsupported_policy", 0, [], 0);
    const isolation = this.isolation(request.role.isolationRequested);
    if (isolation.state === "blocked") return this.receipt("blocked", requested, requested, "blocked", isolation.warnings, "isolation_required", 0, [], 0);
    const available = this.inspect().available;
    const primaryVerification = request.role.fallbackEnabled && request.fallbackRoute ? await this.verify() : undefined;
    const effective = available && primaryVerification?.ok !== false ? this.route : request.role.fallbackEnabled ? this.fallback(request.fallbackRoute, request.role.selection) : undefined;
    if (!effective) return this.receipt("blocked", requested, requested, isolation.state, isolation.warnings, "unavailable", 0, [], 0);
    const adapter = effective.id === this.route.id ? this : new ProcessAgentAdapter(effective, { ...request.role.selection, provider: effective.provider, model: effective.model }, this.runner);
    if (adapter !== this) {
      const fallbackVerified = await adapter.verify();
      if (!fallbackVerified.ok) return this.receipt("blocked", requested, requested, isolation.state, isolation.warnings, fallbackVerified.failure ?? "verification_failed", 0, [], 0);
    }
    return adapter.run(request, requested, isolation.state, isolation.warnings);
  }
  private fallback(id: string | undefined, selection: Selection): RouteDescriptor | undefined {
    if (!id || !this.route.compatibleFallbacks.includes(id)) return undefined;
    // Fallback is an explicit caller choice; profile policy remains unchanged.
    return BUILTIN_ROUTES.find((route) => route.id === id && route.provider === selection.provider && this.runner.executableAvailable(route.executable));
  }
  private isolation(mode: IsolationMode): { state: "attested" | "local" | "off" | "blocked"; warnings: readonly string[] } {
    if (mode === "off") return { state: "off", warnings: ["local_execution_deliberate"] };
    if (this.attestIsolation()?.isolated) return { state: "attested", warnings: [] };
    return mode === "required" ? { state: "blocked", warnings: ["isolation_required"] } : { state: "local", warnings: ["local_execution_unattested"] };
  }
  private async run(request: ExecuteRequest, requested: string, isolation: "attested" | "local" | "off", warnings: readonly string[]): Promise<ExecutionReceipt> {
    const sessionKey = this.sessionKey(request);
    const invocation = buildInvocation(this.route, this.selection, request, sessionKey ? this.sessions().get(sessionKey) : undefined);
    if (!invocation.ok) return this.receipt("blocked", requested, this.route.id, isolation, [...warnings, ...invocation.warnings], "unsupported_policy", 0, [], 0);
    const effectiveWarnings = [...warnings, ...invocation.warnings];
    let attempts = 0;
    for (;;) {
      if (this.cancelled.has(request.runId)) return this.receipt("cancelled", requested, this.route.id, isolation, warnings, "cancelled", 0, [], attempts);
      attempts += 1;
      const result = await this.runner.run(invocation.value);
      const failure: FailureClass | undefined = result.unknownSideEffect ? "unknown_side_effect" : result.cancelled || this.cancelled.has(request.runId) ? "cancelled" : result.timedOut ? "timeout" : result.exitCode !== 0 ? "nonzero_exit" : !events(result.events) ? "malformed_output" : result.usage === undefined || !Number.isSafeInteger(result.usage.tokens) || result.usage.tokens < 0 || result.usage.tokens > request.role.limits.tokenBudget ? "token_budget" : undefined;
      if (!failure) {
        if (sessionKey && result.providerSessionId) this.sessions().set(sessionKey, result.providerSessionId);
        return this.receipt("completed", requested, this.route.id, isolation, effectiveWarnings, undefined, result.usage!.tokens, events(result.events)!, attempts);
      }
      if (failure === "unknown_side_effect") return this.receipt("blocked_reconcile", requested, this.route.id, isolation, effectiveWarnings, failure, result.usage?.tokens ?? 0, [], attempts);
      if (result.sideEffectFree === true && attempts <= request.role.limits.maxRetries && !this.cancelled.has(request.runId)) continue;
      return this.receipt(failure === "cancelled" ? "cancelled" : "failed", requested, this.route.id, isolation, effectiveWarnings, failure, result.usage?.tokens ?? 0, [], attempts);
    }
  }
  private sessions(): Map<string, string> {
    let sessions = ProcessAgentAdapter.sessions.get(this.runner);
    if (!sessions) { sessions = new Map(); ProcessAgentAdapter.sessions.set(this.runner, sessions); }
    return sessions;
  }
  private sessionKey(request: ExecuteRequest): string | undefined {
    if (this.route.provider !== "codex" || request.role.sessionId === null) return undefined;
    return JSON.stringify([request.role.sessionId, this.route.id, request.repositoryPath, this.selection.model, this.selection.reasoning]);
  }
  private receipt(status: ExecutionStatus, requestedRoute: string, effectiveRoute: string, isolation: ExecutionReceipt["isolation"], warningCodes: readonly string[], failure: FailureClass | undefined, tokens: number, structuredEvents: ExecutionReceipt["events"], attempts: number): ExecutionReceipt {
    return { status, requestedRoute, effectiveRoute, isolation, warningCodes, ...(failure ? { failure, error: { code: failure } } : {}), usage: { tokens }, events: structuredEvents, attempts };
  }
}

type InvocationBuild = { readonly ok: true; readonly value: ProcessInvocation; readonly warnings: readonly string[] } | { readonly ok: false; readonly warnings: readonly string[] };

function buildInvocation(route: RouteDescriptor, selection: Selection, request: ExecuteRequest, providerSessionId?: string): InvocationBuild {
  const role = request.role;
  if (role.authority.externalAction || !role.authority.read || !role.authority.workspace) return { ok: false, warnings: ["authority_unsupported"] };
  if (!route.reasoningLevels.includes(selection.reasoning)) return { ok: false, warnings: ["reasoning_unsupported"] };
  if (!role.authority.write && role.toolAllow.some((tool) => /write|edit|shell|bash/i.test(tool))) return { ok: false, warnings: ["tool_authority_conflict"] };
  const common = { routeId: route.id, executable: route.executable, stdin: request.task.prompt, cwd: request.repositoryPath, timeoutMs: role.limits.timeoutMs, runId: request.runId, ...(request.onActivity ? { onActivity: request.onActivity } : {}) };
  if (route.provider === "codex") {
    if (role.toolDeny.some((tool) => tool !== "external-action")) return { ok: false, warnings: ["codex_tool_deny_unsupported"] };
    if (role.authority.network) return { ok: false, warnings: ["codex_network_policy_unsupported"] };
    const sandbox = role.authority.write ? "workspace-write" : "read-only";
    const modelArgs = selection.model === "*" ? [] : ["-m", selection.model];
    const session = role.sessionId === null ? {} : { sessionKey: role.sessionId };
    if (providerSessionId) return { ok: true, value: { ...common, ...session, providerSessionId, args: ["exec", "resume", providerSessionId, "--json", ...modelArgs, "-c", `model_reasoning_effort="${selection.reasoning}"`, "-c", 'approval_policy="never"', "-c", `sandbox_mode="${sandbox}"`, "-"] }, warnings: [] };
    return { ok: true, value: { ...common, ...session, args: ["exec", "--json", ...modelArgs, "-c", `model_reasoning_effort="${selection.reasoning}"`, "-c", 'approval_policy="never"', "-C", request.repositoryPath, "-s", sandbox, ...(role.sessionId === null ? ["--ephemeral"] : []), "-"] }, warnings: [] };
  }
  if (route.provider === "grok") {
    const args = [...(request.allowSubagents === true ? ["--allow-subagents"] : []), "--", "--output-format", "streaming-json", "--prompt-file", "/dev/stdin", "--cwd", request.repositoryPath, "--model", selection.model, "--reasoning-effort", selection.reasoning, "--max-turns", String(role.limits.maxTurns), "--tools", role.toolAllow.join(","), "--disallowed-tools", role.toolDeny.join(","), "--sandbox", "strict", "--permission-mode", "dontAsk", "--no-memory", ...(request.allowSubagents === true ? [] : ["--no-subagents"]), ...(!role.authority.network ? ["--disable-web-search"] : [])];
    return { ok: true, value: { ...common, args }, warnings: [] };
  }
  if (route.provider === "claude") {
    if (role.authority.network || role.authority.externalAction) return { ok: false, warnings: ["claude_policy_unsupported"] };
    const modelArgs = selection.model === "*" ? [] : ["--model", selection.model];
    const requestedTools = new Set(role.toolAllow.map((tool) => tool.toLowerCase()));
    if ([...requestedTools].some((tool) => !["read", "search", "edit", "write"].includes(tool))) return { ok: false, warnings: ["claude_tool_policy_unsupported"] };
    const allowedTools = [requestedTools.has("read") ? "Read" : "", ...(requestedTools.has("search") ? ["Glob", "Grep"] : []), ...(requestedTools.has("edit") || requestedTools.has("write") ? ["Edit"] : []), requestedTools.has("write") ? "Write" : ""].filter(Boolean).join(",");
    return { ok: true, value: { ...common, args: ["--print", "--output-format", "stream-json", "--verbose", ...modelArgs, "--effort", selection.reasoning, "--permission-mode", "dontAsk", "--allowedTools", allowedTools, "--no-session-persistence"] }, warnings: [] };
  }
  if (route.provider === "agy") {
    if (!role.authority.network) return { ok: false, warnings: ["agy_network_policy_unsupported"] };
    if (role.limits.tokenBudget !== Number.MAX_SAFE_INTEGER) return { ok: false, warnings: ["agy_token_budget_unsupported"] };
    const mode = role.authority.write ? "accept-edits" : "plan";
    const modelArgs = selection.model === "*" ? [] : ["--model", selection.model];
    return { ok: true, value: { ...common, args: ["--sandbox", "--add-dir", "__BEARING_PROMPT_DIR__", "--mode", mode, ...modelArgs, "--print", "Read and follow the complete task in @__BEARING_PROMPT_FILE__."], promptFile: true }, warnings: ["usage_unavailable", "provider_permissions_inherited"] };
  }
  if (route.provider === "opencode") {
    const modelArgs = selection.model === "*" ? [] : ["--model", selection.model];
    const variantArgs = selection.reasoning === "default" ? [] : ["--variant", selection.reasoning];
    const requestedTools = new Set(role.toolAllow.map((tool) => tool.toLowerCase()));
    const permissions = {
      "*": "deny",
      read: requestedTools.has("read") ? "allow" : "deny",
      glob: requestedTools.has("search") ? "allow" : "deny",
      grep: requestedTools.has("search") ? "allow" : "deny",
      edit: role.authority.write && (requestedTools.has("write") || requestedTools.has("edit")) ? "allow" : "deny",
      bash: role.authority.write && (requestedTools.has("shell") || requestedTools.has("bash")) ? "allow" : "deny",
      skill: "allow",
      task: request.allowSubagents === true ? "allow" : "deny",
      webfetch: role.authority.network && (requestedTools.has("web") || requestedTools.has("webfetch")) ? "allow" : "deny",
      websearch: role.authority.network && (requestedTools.has("search") || requestedTools.has("web") || requestedTools.has("websearch")) ? "allow" : "deny",
      external_directory: "deny",
      question: "deny",
    };
    return { ok: true, value: { ...common, args: ["run", "--format", "json", "--dir", request.repositoryPath, ...modelArgs, ...variantArgs, "--file", "__BEARING_PROMPT_FILE__", "Read and follow the attached task instructions."], promptFile: true, environment: { OPENCODE_PERMISSION: JSON.stringify(permissions) } }, warnings: [] };
  }
  if (route.provider === "pi") {
    const modelArgs = selection.model === "*" ? [] : ["--model", selection.model];
    const args = ["--mode", "json", "--print", ...modelArgs, "--thinking", selection.reasoning, "--tools", role.toolAllow.join(","), "--exclude-tools", role.toolDeny.join(","), "--no-session", ...(!role.authority.network ? ["--offline"] : [])];
    return { ok: true, value: { ...common, args }, warnings: [] };
  }
  return { ok: false, warnings: ["route_unsupported"] };
}

export function routeFor(selection: Selection): RouteDescriptor | undefined { return BUILTIN_ROUTES.find((route) => route.provider === selection.provider && (route.model === "*" || route.model === selection.model)); }
export function createAgentAdapter(selection: Selection, runner: ProcessRunner): AgentAdapter | undefined { const route = routeFor(selection); return route ? new ProcessAgentAdapter(route, selection, runner) : undefined; }

/** Deterministic test port; it never opens a process or contacts a provider. */
export class SyntheticRunner implements ProcessRunner {
  readonly calls: ProcessInvocation[] = [];
  readonly cancelled: string[] = [];
  constructor(private readonly available = new Set(BUILTIN_ROUTES.map((route) => route.executable)), private readonly results: readonly ProcessResult[] = [{ exitCode: 0, events: [{ type: "complete" }], usage: { tokens: 0 } }], private readonly attestation?: IsolationAttestation) {}
  executableAvailable(executable: string): boolean { return this.available.has(executable); }
  async run(invocation: ProcessInvocation): Promise<ProcessResult> { this.calls.push(invocation); return this.results[Math.min(this.calls.length - 1, this.results.length - 1)] ?? { exitCode: 1 }; }
  async cancel(runId: string): Promise<void> { this.cancelled.push(runId); }
  attestIsolation(): IsolationAttestation | undefined { return this.attestation; }
}
