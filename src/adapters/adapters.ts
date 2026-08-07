/** Provider-neutral process adapters.  Inspection is metadata-only. */
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { resolveBackgroundReasoning } from "../profile/reasoning-policy.js";
import type { IsolationMode, RoleProjection, Selection } from "../profile/profile.js";

type FailureClass = "unavailable" | "verification_failed" | "isolation_required" | "unsupported_policy" | "timeout" | "cancelled" | "malformed_output" | "token_budget" | "nonzero_exit" | "session_unavailable" | "unknown_side_effect";
type ExecutionStatus = "completed" | "failed" | "blocked" | "cancelled" | "blocked_reconcile";
export const BACKGROUND_BRIEF_CAPABILITY = "read-only-background-brief";
export const MAX_BACKGROUND_BRIEF_CHARS = 4_096;

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
  { id: "deepseek-codex", provider: "codex", model: "deepseek-v4-flash", executable: "codex-deepseek", capabilities: ["structured-events"], compatibleFallbacks: [], reasoningLevels: ["max"] },
  { id: "deepseek-claude", provider: "claude", model: "deepseek-v4-flash", executable: "claude-deepseek", capabilities: ["structured-events"], compatibleFallbacks: [], reasoningLevels: ["max"] },
  { id: "agy", provider: "agy", model: "*", executable: "agy", capabilities: ["headless-output"], compatibleFallbacks: [], reasoningLevels: ["low", "medium", "high", "thinking"] },
  { id: "grok-build", provider: "grok", model: "grok-build", executable: "grok-safe", capabilities: ["structured-events"], compatibleFallbacks: [], reasoningLevels: ["low", "medium", "high", "xhigh"] },
  { id: "opencode", provider: "opencode", model: "*", executable: "opencode", capabilities: ["structured-events"], compatibleFallbacks: [], reasoningLevels: ["default", "none", "minimal", "low", "medium", "high", "xhigh", "max"] },
  { id: "pi", provider: "pi", model: "*", executable: "pi", capabilities: ["structured-events", BACKGROUND_BRIEF_CAPABILITY], compatibleFallbacks: [], reasoningLevels: ["off", "minimal", "low", "medium", "high", "xhigh"] },
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

interface Inspection { readonly route: RouteDescriptor; readonly available: boolean; readonly capabilities: readonly string[]; }
interface Verification { readonly ok: boolean; readonly failure?: "unavailable" | "verification_failed"; }
interface ExecuteRequest { readonly runId: string; readonly sessionScope?: string; readonly repositoryPath: string; readonly role: RoleProjection; readonly task: { readonly prompt: string }; readonly fallbackRoute?: string; readonly allowSubagents?: boolean; readonly focusMode?: boolean; readonly providerSessionId?: string; readonly onActivity?: (activity: ProcessActivity) => void; }
interface BackgroundBriefRequest { readonly runId: string; readonly repositoryPath: string; readonly role: RoleProjection; readonly task: { readonly prompt: string }; }
interface ExecutionReceipt {
  readonly status: ExecutionStatus;
  readonly requestedRoute: string;
  readonly effectiveRoute: string;
  readonly isolation: "attested" | "local" | "off" | "blocked";
  readonly warningCodes: readonly string[];
  readonly failure?: FailureClass;
  readonly usage: { readonly tokens: number };
  readonly events: readonly { readonly type: string; readonly data?: Readonly<Record<string, unknown>> }[];
  readonly attempts: number;
  readonly providerSessionId?: string;
  readonly error?: { readonly code: FailureClass };
}

export interface AgentAdapter {
  inspect(): Inspection;
  verify(): Promise<Verification>;
  execute(request: ExecuteRequest): Promise<ExecutionReceipt>;
  readOnlyBackgroundBrief(request: BackgroundBriefRequest): Promise<string | undefined>;
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
const RESUME_FAILURE_SIGNATURES: Readonly<Record<string, readonly string[]>> = {
  codex: [
    "session not found for thread_id: {sessionId}",
    "no rollout found for thread id {sessionId}",
    "state db missing rollout path for thread {sessionId}",
  ],
};
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
function sessionUnavailable(routeId: string, providerSessionId: string | undefined, result: ProcessResult): boolean {
  if (!providerSessionId || result.exitCode === undefined || result.exitCode === 0 || (events(result.events)?.length ?? 0) > 0) return false;
  if (typeof result.error !== "object" || result.error === null || Array.isArray(result.error)) return false;
  const stderr = (result.error as { readonly stderr?: unknown }).stderr;
  if (typeof stderr !== "string" || stderr.length > MAX_STRING_LENGTH) return false;
  const signatures = RESUME_FAILURE_SIGNATURES[routeId];
  if (!signatures) return false;
  const normalized = stderr.toLowerCase();
  const sessionId = providerSessionId.toLowerCase();
  return signatures.some((signature) => normalized.includes(signature.replace("{sessionId}", sessionId)));
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
  async readOnlyBackgroundBrief(request: BackgroundBriefRequest): Promise<string | undefined> {
    const backgroundReasoning = resolveBackgroundReasoning(request.role.selection.provider, request.role.reasoning.tier);
    if (!this.route.capabilities.includes(BACKGROUND_BRIEF_CAPABILITY) || !backgroundReasoning.ok || backgroundReasoning.tier !== "medium") return undefined;
    const role: RoleProjection = {
      ...request.role,
      sessionId: null,
      reasoning: { tier: backgroundReasoning.tier, providerLevel: backgroundReasoning.providerLevel, clamped: backgroundReasoning.clamped },
      authority: { ...request.role.authority, read: true, write: false, network: false, externalAction: false },
      toolAllow: request.role.toolAllow.filter((tool) => /^(?:read|search)$/i.test(tool)),
      limits: { ...request.role.limits, maxRetries: 0 },
    };
    const receipt = await this.execute({ runId: request.runId, repositoryPath: request.repositoryPath, role, task: request.task });
    if (receipt.status !== "completed") return undefined;
    const content = receipt.events.flatMap((event) => {
      const value = event.data?.content;
      return typeof value === "string" ? [value] : [];
    }).at(-1)?.trim();
    return content ? content.slice(0, MAX_BACKGROUND_BRIEF_CHARS) : undefined;
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
    const suppliedSession = request.providerSessionId;
    if (suppliedSession !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(suppliedSession)) return this.receipt("blocked", requested, this.route.id, isolation, warnings, "unsupported_policy", 0, [], 0);
    const resumeSession = suppliedSession ?? (sessionKey ? this.sessions().get(sessionKey) : undefined);
    const invocation = buildInvocation(this.route, this.selection, request, resumeSession);
    if (!invocation.ok) return this.receipt("blocked", requested, this.route.id, isolation, [...warnings, ...invocation.warnings], "unsupported_policy", 0, [], 0);
    const effectiveWarnings = [...warnings, ...invocation.warnings];
    let attempts = 0;
    for (;;) {
      if (this.cancelled.has(request.runId)) return this.receipt("cancelled", requested, this.route.id, isolation, warnings, "cancelled", 0, [], attempts);
      attempts += 1;
      const result = await this.runner.run(invocation.value);
      const failure: FailureClass | undefined = result.unknownSideEffect ? "unknown_side_effect" : result.cancelled || this.cancelled.has(request.runId) ? "cancelled" : result.timedOut ? "timeout" : result.exitCode !== 0 ? sessionUnavailable(this.route.id, invocation.providerSessionId === resumeSession ? resumeSession : undefined, result) ? "session_unavailable" : "nonzero_exit" : !events(result.events) ? "malformed_output" : result.usage === undefined || !Number.isSafeInteger(result.usage.tokens) || result.usage.tokens < 0 || result.usage.tokens > request.role.limits.tokenBudget ? "token_budget" : undefined;
      if (!failure) {
        const providerSessionId = result.providerSessionId ?? invocation.providerSessionId;
        if (sessionKey && providerSessionId) this.sessions().set(sessionKey, providerSessionId);
        return this.receipt("completed", requested, this.route.id, isolation, effectiveWarnings, undefined, result.usage!.tokens, events(result.events)!, attempts, providerSessionId);
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
    if (!["codex", "claude", "pi"].includes(this.route.provider) || request.role.sessionId === null) return undefined;
    return JSON.stringify([request.sessionScope ?? request.runId, request.role.sessionId, this.route.id, request.repositoryPath, this.selection.model, this.selection.reasoning]);
  }
  private receipt(status: ExecutionStatus, requestedRoute: string, effectiveRoute: string, isolation: ExecutionReceipt["isolation"], warningCodes: readonly string[], failure: FailureClass | undefined, tokens: number, structuredEvents: ExecutionReceipt["events"], attempts: number, providerSessionId?: string): ExecutionReceipt {
    return { status, requestedRoute, effectiveRoute, isolation, warningCodes, ...(failure ? { failure, error: { code: failure } } : {}), usage: { tokens }, events: structuredEvents, attempts, ...(providerSessionId ? { providerSessionId } : {}) };
  }
}

type InvocationBuild = { readonly ok: true; readonly value: ProcessInvocation; readonly warnings: readonly string[]; readonly providerSessionId?: string } | { readonly ok: false; readonly warnings: readonly string[] };

function buildInvocation(route: RouteDescriptor, selection: Selection, request: ExecuteRequest, providerSessionId?: string): InvocationBuild {
  const role = request.role;
  const reasoning = role.reasoning.providerLevel;
  if (role.authority.externalAction || !role.authority.read || !role.authority.workspace) return { ok: false, warnings: ["authority_unsupported"] };
  if (!route.reasoningLevels.includes(reasoning)) return { ok: false, warnings: ["reasoning_unsupported"] };
  if (!role.authority.write && role.toolAllow.some((tool) => /write|edit|shell|bash/i.test(tool))) return { ok: false, warnings: ["tool_authority_conflict"] };
  const common = { routeId: route.id, executable: route.executable, stdin: request.task.prompt, cwd: request.repositoryPath, timeoutMs: role.limits.timeoutMs, runId: request.runId, ...(request.focusMode ? { environment: { BEARING_FOCUS: "1" } } : {}), ...(request.onActivity ? { onActivity: request.onActivity } : {}) };
  if (route.provider === "codex") {
    if (role.toolDeny.some((tool) => tool !== "external-action")) return { ok: false, warnings: ["codex_tool_deny_unsupported"] };
    if (role.authority.network) return { ok: false, warnings: ["codex_network_policy_unsupported"] };
    const sandbox = role.authority.write ? "workspace-write" : "read-only";
    const modelArgs = selection.model === "*" ? [] : ["-m", selection.model];
    const session = role.sessionId === null ? {} : { sessionKey: role.sessionId };
    if (providerSessionId) return { ok: true, value: { ...common, ...session, providerSessionId, args: ["exec", "resume", providerSessionId, "--json", ...modelArgs, "-c", `model_reasoning_effort="${reasoning}"`, "-c", 'approval_policy="never"', "-c", `sandbox_mode="${sandbox}"`, "-"] }, warnings: [], providerSessionId };
    return { ok: true, value: { ...common, ...session, args: ["exec", "--json", ...modelArgs, "-c", `model_reasoning_effort="${reasoning}"`, "-c", 'approval_policy="never"', "-C", request.repositoryPath, "-s", sandbox, ...(role.sessionId === null ? ["--ephemeral"] : []), "-"] }, warnings: [] };
  }
  if (route.provider === "grok") {
    const args = [...(request.allowSubagents === true ? ["--allow-subagents"] : []), "--", "--output-format", "streaming-json", "--prompt-file", "/dev/stdin", "--cwd", request.repositoryPath, "--model", selection.model, "--reasoning-effort", reasoning, "--max-turns", String(role.limits.maxTurns), "--tools", role.toolAllow.join(","), "--disallowed-tools", role.toolDeny.join(","), "--sandbox", "strict", "--permission-mode", "dontAsk", "--no-memory", ...(request.allowSubagents === true ? [] : ["--no-subagents"]), ...(!role.authority.network ? ["--disable-web-search"] : [])];
    return { ok: true, value: { ...common, args }, warnings: [] };
  }
  if (route.provider === "claude") {
    if (role.authority.network || role.authority.externalAction) return { ok: false, warnings: ["claude_policy_unsupported"] };
    const modelArgs = selection.model === "*" ? [] : ["--model", selection.model];
    const requestedTools = new Set(role.toolAllow.map((tool) => tool.toLowerCase()));
    if ([...requestedTools].some((tool) => !["read", "search", "edit", "write"].includes(tool))) return { ok: false, warnings: ["claude_tool_policy_unsupported"] };
    const allowedTools = [requestedTools.has("read") ? "Read" : "", ...(requestedTools.has("search") ? ["Glob", "Grep"] : []), ...(requestedTools.has("edit") || requestedTools.has("write") ? ["Edit"] : []), requestedTools.has("write") ? "Write" : ""].filter(Boolean).join(",");
    const persistent = role.sessionId !== null;
    const sessionId = persistent ? providerSessionId ?? randomUUID() : undefined;
    const sessionArgs = !persistent ? ["--no-session-persistence"] : providerSessionId ? ["--resume", providerSessionId] : ["--session-id", sessionId!];
    // DeepSeek max emits one `system/thinking_tokens` record per progress update.
    // Long Navigator turns can exceed the runner's bounded structured-event stream
    // before the valid final result arrives. Claude's single-result JSON preserves
    // the same final text and usage without the unbounded progress telemetry.
    const outputFormat = route.id === "deepseek-claude" ? "json" : "stream-json";
    const verbosityArgs = route.id === "deepseek-claude" ? [] : ["--verbose"];
    return { ok: true, value: { ...common, args: ["--print", "--output-format", outputFormat, ...verbosityArgs, ...modelArgs, "--effort", reasoning, "--permission-mode", "dontAsk", "--allowedTools", allowedTools, ...sessionArgs] }, warnings: [], ...(sessionId ? { providerSessionId: sessionId } : {}) };
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
    const variantArgs = reasoning === "default" ? [] : ["--variant", reasoning];
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
    const sessionId = role.sessionId === null ? undefined : providerSessionId ?? randomUUID();
    const args = ["--mode", "json", "--print", ...modelArgs, "--thinking", reasoning, "--tools", role.toolAllow.join(","), "--exclude-tools", role.toolDeny.join(","), ...(sessionId ? ["--session-id", sessionId] : ["--no-session"]), ...(!role.authority.network ? ["--offline"] : [])];
    return { ok: true, value: { ...common, args }, warnings: [], ...(sessionId ? { providerSessionId: sessionId } : {}) };
  }
  return { ok: false, warnings: ["route_unsupported"] };
}

export function routeFor(selection: Selection): RouteDescriptor | undefined {
  return BUILTIN_ROUTES.find((route) => route.provider === selection.provider && route.model === selection.model)
    ?? BUILTIN_ROUTES.find((route) => route.provider === selection.provider && route.model === "*");
}
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
