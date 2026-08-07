/** Provider-neutral process adapters.  Inspection is metadata-only. */
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { resolveBackgroundReasoning } from "../profile/reasoning-policy.js";
export const BACKGROUND_BRIEF_CAPABILITY = "read-only-background-brief";
export const MAX_BACKGROUND_BRIEF_CHARS = 4_096;
/** Exact built-ins; only these routes can be selected without a custom registry. */
export const BUILTIN_ROUTES = [
    { id: "codex", provider: "codex", model: "*", executable: "codex", capabilities: ["structured-events"], compatibleFallbacks: [], reasoningLevels: ["low", "medium", "high", "xhigh", "max", "ultra"] },
    { id: "claude", provider: "claude", model: "*", executable: "claude", capabilities: ["structured-events"], compatibleFallbacks: [], reasoningLevels: ["low", "medium", "high", "xhigh", "max"] },
    { id: "deepseek-codex", provider: "codex", model: "deepseek-v4-flash", executable: "codex-deepseek", capabilities: ["structured-events"], compatibleFallbacks: [], reasoningLevels: ["max"] },
    { id: "deepseek-claude", provider: "claude", model: "deepseek-v4-flash", executable: "claude-deepseek", capabilities: ["structured-events"], compatibleFallbacks: [], reasoningLevels: ["max"] },
    { id: "agy", provider: "agy", model: "*", executable: "agy", capabilities: ["headless-output"], compatibleFallbacks: [], reasoningLevels: ["low", "medium", "high", "thinking"] },
    { id: "grok-build", provider: "grok", model: "grok-build", executable: "grok-safe", capabilities: ["structured-events"], compatibleFallbacks: [], reasoningLevels: ["low", "medium", "high", "xhigh"] },
    { id: "opencode", provider: "opencode", model: "*", executable: "opencode", capabilities: ["structured-events"], compatibleFallbacks: [], reasoningLevels: ["default", "none", "minimal", "low", "medium", "high", "xhigh", "max"] },
    { id: "pi", provider: "pi", model: "*", executable: "pi", capabilities: ["structured-events", BACKGROUND_BRIEF_CAPABILITY], compatibleFallbacks: [], reasoningLevels: ["off", "minimal", "low", "medium", "high", "xhigh"] },
];
const secretKey = /key|secret|token|credential|authorization|password/i;
const secretValue = /(?:\b(?:api[_ -]?key|secret|token|password|authorization)\s*[=:]\s*|\bBearer\s+|\bsk-[A-Za-z0-9_-]{8,}|\bAKIA[A-Z0-9]{16})[^\s,;]*/gi;
const MAX_EVENTS = 1024;
const MAX_EVENT_TYPE = 128;
const MAX_VALUE_DEPTH = 8;
const MAX_COLLECTION_SIZE = 256;
const MAX_STRING_LENGTH = 512 * 1024;
const RESUME_FAILURE_SIGNATURES = {
    codex: [
        "session not found for thread_id: {sessionId}",
        "no rollout found for thread id {sessionId}",
        "state db missing rollout path for thread {sessionId}",
    ],
};
function events(value) {
    if (!Array.isArray(value) || value.length > MAX_EVENTS)
        return undefined;
    if (!value.every((event) => typeof event === "object" && event !== null && !Array.isArray(event) && typeof event.type === "string" && event.type.length > 0 && event.type.length <= MAX_EVENT_TYPE))
        return undefined;
    return value.map((event) => ({ type: event.type, ...(typeof event.data === "object" && event.data !== null && !Array.isArray(event.data) ? { data: sanitize(event.data) } : {}) }));
}
function sanitize(value, depth = 0) {
    if (depth >= MAX_VALUE_DEPTH)
        return "[truncated]";
    if (typeof value === "string") {
        const redacted = value.replace(secretValue, "[redacted]");
        return redacted.length <= MAX_STRING_LENGTH ? redacted : `${redacted.slice(0, MAX_STRING_LENGTH)}[truncated]`;
    }
    if (Array.isArray(value))
        return value.slice(0, MAX_COLLECTION_SIZE).map((entry) => sanitize(entry, depth + 1));
    if (typeof value !== "object" || value === null)
        return value;
    return Object.fromEntries(Object.entries(value).slice(0, MAX_COLLECTION_SIZE).map(([key, entry]) => [key, secretKey.test(key) ? "[redacted]" : sanitize(entry, depth + 1)]));
}
function sessionUnavailable(routeId, providerSessionId, result) {
    if (!providerSessionId || result.exitCode === undefined || result.exitCode === 0 || (events(result.events)?.length ?? 0) > 0)
        return false;
    if (typeof result.error !== "object" || result.error === null || Array.isArray(result.error))
        return false;
    const stderr = result.error.stderr;
    if (typeof stderr !== "string" || stderr.length > MAX_STRING_LENGTH)
        return false;
    const signatures = RESUME_FAILURE_SIGNATURES[routeId];
    if (!signatures)
        return false;
    const normalized = stderr.toLowerCase();
    const sessionId = providerSessionId.toLowerCase();
    return signatures.some((signature) => normalized.includes(signature.replace("{sessionId}", sessionId)));
}
class ProcessAgentAdapter {
    route;
    selection;
    runner;
    cancelled = new Set();
    static sessions = new WeakMap();
    constructor(route, selection, runner) {
        this.route = route;
        this.selection = selection;
        this.runner = runner;
    }
    inspect() { return { route: this.route, available: this.runner.executableAvailable(this.route.executable), capabilities: [...this.route.capabilities] }; }
    async verify() {
        if (!this.inspect().available)
            return { ok: false, failure: "unavailable" };
        if (!this.runner.verify)
            return { ok: false, failure: "verification_failed" };
        return (await this.runner.verify(this.route)) ? { ok: true } : { ok: false, failure: "verification_failed" };
    }
    attestIsolation() { return this.runner.attestIsolation?.(); }
    async cancel(runId) { if (this.cancelled.has(runId))
        return; this.cancelled.add(runId); await this.runner.cancel?.(runId); }
    async execute(request) {
        const requested = this.route.id;
        if (!isAbsolute(request.repositoryPath))
            return this.receipt("blocked", requested, requested, "blocked", [], "unsupported_policy", 0, [], 0);
        const isolation = this.isolation(request.role.isolationRequested);
        if (isolation.state === "blocked")
            return this.receipt("blocked", requested, requested, "blocked", isolation.warnings, "isolation_required", 0, [], 0);
        const available = this.inspect().available;
        const primaryVerification = request.role.fallbackEnabled && request.fallbackRoute ? await this.verify() : undefined;
        const effective = available && primaryVerification?.ok !== false ? this.route : request.role.fallbackEnabled ? this.fallback(request.fallbackRoute, request.role.selection) : undefined;
        if (!effective)
            return this.receipt("blocked", requested, requested, isolation.state, isolation.warnings, "unavailable", 0, [], 0);
        const adapter = effective.id === this.route.id ? this : new ProcessAgentAdapter(effective, { ...request.role.selection, provider: effective.provider, model: effective.model }, this.runner);
        if (adapter !== this) {
            const fallbackVerified = await adapter.verify();
            if (!fallbackVerified.ok)
                return this.receipt("blocked", requested, requested, isolation.state, isolation.warnings, fallbackVerified.failure ?? "verification_failed", 0, [], 0);
        }
        return adapter.run(request, requested, isolation.state, isolation.warnings);
    }
    async readOnlyBackgroundBrief(request) {
        const backgroundReasoning = resolveBackgroundReasoning(request.role.selection.provider, request.role.reasoning.tier);
        if (!this.route.capabilities.includes(BACKGROUND_BRIEF_CAPABILITY) || !backgroundReasoning.ok || backgroundReasoning.tier !== "medium")
            return undefined;
        const role = {
            ...request.role,
            sessionId: null,
            reasoning: { tier: backgroundReasoning.tier, providerLevel: backgroundReasoning.providerLevel, clamped: backgroundReasoning.clamped },
            authority: { ...request.role.authority, read: true, write: false, network: false, externalAction: false },
            toolAllow: request.role.toolAllow.filter((tool) => /^(?:read|search)$/i.test(tool)),
            limits: { ...request.role.limits, maxRetries: 0 },
        };
        const receipt = await this.execute({ runId: request.runId, repositoryPath: request.repositoryPath, role, task: request.task });
        if (receipt.status !== "completed")
            return undefined;
        const content = receipt.events.flatMap((event) => {
            const value = event.data?.content;
            return typeof value === "string" ? [value] : [];
        }).at(-1)?.trim();
        return content ? content.slice(0, MAX_BACKGROUND_BRIEF_CHARS) : undefined;
    }
    fallback(id, selection) {
        if (!id || !this.route.compatibleFallbacks.includes(id))
            return undefined;
        // Fallback is an explicit caller choice; profile policy remains unchanged.
        return BUILTIN_ROUTES.find((route) => route.id === id && route.provider === selection.provider && this.runner.executableAvailable(route.executable));
    }
    isolation(mode) {
        if (mode === "off")
            return { state: "off", warnings: ["local_execution_deliberate"] };
        if (this.attestIsolation()?.isolated)
            return { state: "attested", warnings: [] };
        return mode === "required" ? { state: "blocked", warnings: ["isolation_required"] } : { state: "local", warnings: ["local_execution_unattested"] };
    }
    async run(request, requested, isolation, warnings) {
        const sessionKey = this.sessionKey(request);
        const suppliedSession = request.providerSessionId;
        if (suppliedSession !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(suppliedSession))
            return this.receipt("blocked", requested, this.route.id, isolation, warnings, "unsupported_policy", 0, [], 0);
        const resumeSession = suppliedSession ?? (sessionKey ? this.sessions().get(sessionKey) : undefined);
        const invocation = buildInvocation(this.route, this.selection, request, resumeSession);
        if (!invocation.ok)
            return this.receipt("blocked", requested, this.route.id, isolation, [...warnings, ...invocation.warnings], "unsupported_policy", 0, [], 0);
        const effectiveWarnings = [...warnings, ...invocation.warnings];
        let attempts = 0;
        for (;;) {
            if (this.cancelled.has(request.runId))
                return this.receipt("cancelled", requested, this.route.id, isolation, warnings, "cancelled", 0, [], attempts);
            attempts += 1;
            const result = await this.runner.run(invocation.value);
            const failure = result.unknownSideEffect ? "unknown_side_effect" : result.cancelled || this.cancelled.has(request.runId) ? "cancelled" : result.timedOut ? "timeout" : result.exitCode !== 0 ? sessionUnavailable(this.route.id, invocation.providerSessionId === resumeSession ? resumeSession : undefined, result) ? "session_unavailable" : "nonzero_exit" : !events(result.events) ? "malformed_output" : result.usage === undefined || !Number.isSafeInteger(result.usage.tokens) || result.usage.tokens < 0 || result.usage.tokens > request.role.limits.tokenBudget ? "token_budget" : undefined;
            if (!failure) {
                const providerSessionId = result.providerSessionId ?? invocation.providerSessionId;
                if (sessionKey && providerSessionId)
                    this.sessions().set(sessionKey, providerSessionId);
                return this.receipt("completed", requested, this.route.id, isolation, effectiveWarnings, undefined, result.usage.tokens, events(result.events), attempts, providerSessionId);
            }
            if (failure === "unknown_side_effect")
                return this.receipt("blocked_reconcile", requested, this.route.id, isolation, effectiveWarnings, failure, result.usage?.tokens ?? 0, [], attempts);
            if (result.sideEffectFree === true && attempts <= request.role.limits.maxRetries && !this.cancelled.has(request.runId))
                continue;
            return this.receipt(failure === "cancelled" ? "cancelled" : "failed", requested, this.route.id, isolation, effectiveWarnings, failure, result.usage?.tokens ?? 0, [], attempts);
        }
    }
    sessions() {
        let sessions = ProcessAgentAdapter.sessions.get(this.runner);
        if (!sessions) {
            sessions = new Map();
            ProcessAgentAdapter.sessions.set(this.runner, sessions);
        }
        return sessions;
    }
    sessionKey(request) {
        if (!["codex", "claude", "pi"].includes(this.route.provider) || request.role.sessionId === null)
            return undefined;
        return JSON.stringify([request.sessionScope ?? request.runId, request.role.sessionId, this.route.id, request.repositoryPath, this.selection.model, this.selection.reasoning]);
    }
    receipt(status, requestedRoute, effectiveRoute, isolation, warningCodes, failure, tokens, structuredEvents, attempts, providerSessionId) {
        return { status, requestedRoute, effectiveRoute, isolation, warningCodes, ...(failure ? { failure, error: { code: failure } } : {}), usage: { tokens }, events: structuredEvents, attempts, ...(providerSessionId ? { providerSessionId } : {}) };
    }
}
function buildInvocation(route, selection, request, providerSessionId) {
    const role = request.role;
    const reasoning = role.reasoning.providerLevel;
    if (role.authority.externalAction || !role.authority.read || !role.authority.workspace)
        return { ok: false, warnings: ["authority_unsupported"] };
    if (!route.reasoningLevels.includes(reasoning))
        return { ok: false, warnings: ["reasoning_unsupported"] };
    if (!role.authority.write && role.toolAllow.some((tool) => /write|edit|shell|bash/i.test(tool)))
        return { ok: false, warnings: ["tool_authority_conflict"] };
    const common = { routeId: route.id, executable: route.executable, stdin: request.task.prompt, cwd: request.repositoryPath, timeoutMs: role.limits.timeoutMs, runId: request.runId, ...(request.focusMode ? { environment: { BEARING_FOCUS: "1" } } : {}), ...(request.onActivity ? { onActivity: request.onActivity } : {}) };
    if (route.provider === "codex") {
        if (role.toolDeny.some((tool) => tool !== "external-action"))
            return { ok: false, warnings: ["codex_tool_deny_unsupported"] };
        if (role.authority.network)
            return { ok: false, warnings: ["codex_network_policy_unsupported"] };
        const sandbox = role.authority.write ? "workspace-write" : "read-only";
        const modelArgs = selection.model === "*" ? [] : ["-m", selection.model];
        const session = role.sessionId === null ? {} : { sessionKey: role.sessionId };
        if (providerSessionId)
            return { ok: true, value: { ...common, ...session, providerSessionId, args: ["exec", "resume", providerSessionId, "--json", ...modelArgs, "-c", `model_reasoning_effort="${reasoning}"`, "-c", 'approval_policy="never"', "-c", `sandbox_mode="${sandbox}"`, "-"] }, warnings: [], providerSessionId };
        return { ok: true, value: { ...common, ...session, args: ["exec", "--json", ...modelArgs, "-c", `model_reasoning_effort="${reasoning}"`, "-c", 'approval_policy="never"', "-C", request.repositoryPath, "-s", sandbox, ...(role.sessionId === null ? ["--ephemeral"] : []), "-"] }, warnings: [] };
    }
    if (route.provider === "grok") {
        const args = [...(request.allowSubagents === true ? ["--allow-subagents"] : []), "--", "--output-format", "streaming-json", "--prompt-file", "/dev/stdin", "--cwd", request.repositoryPath, "--model", selection.model, "--reasoning-effort", reasoning, "--max-turns", String(role.limits.maxTurns), "--tools", role.toolAllow.join(","), "--disallowed-tools", role.toolDeny.join(","), "--sandbox", "strict", "--permission-mode", "dontAsk", "--no-memory", ...(request.allowSubagents === true ? [] : ["--no-subagents"]), ...(!role.authority.network ? ["--disable-web-search"] : [])];
        return { ok: true, value: { ...common, args }, warnings: [] };
    }
    if (route.provider === "claude") {
        if (role.authority.network || role.authority.externalAction)
            return { ok: false, warnings: ["claude_policy_unsupported"] };
        const modelArgs = selection.model === "*" ? [] : ["--model", selection.model];
        const requestedTools = new Set(role.toolAllow.map((tool) => tool.toLowerCase()));
        if ([...requestedTools].some((tool) => !["read", "search", "edit", "write"].includes(tool)))
            return { ok: false, warnings: ["claude_tool_policy_unsupported"] };
        const allowedTools = [requestedTools.has("read") ? "Read" : "", ...(requestedTools.has("search") ? ["Glob", "Grep"] : []), ...(requestedTools.has("edit") || requestedTools.has("write") ? ["Edit"] : []), requestedTools.has("write") ? "Write" : ""].filter(Boolean).join(",");
        const persistent = role.sessionId !== null;
        const sessionId = persistent ? providerSessionId ?? randomUUID() : undefined;
        const sessionArgs = !persistent ? ["--no-session-persistence"] : providerSessionId ? ["--resume", providerSessionId] : ["--session-id", sessionId];
        // DeepSeek max emits one `system/thinking_tokens` record per progress update.
        // Long Navigator turns can exceed the runner's bounded structured-event stream
        // before the valid final result arrives. Claude's single-result JSON preserves
        // the same final text and usage without the unbounded progress telemetry.
        const outputFormat = route.id === "deepseek-claude" ? "json" : "stream-json";
        const verbosityArgs = route.id === "deepseek-claude" ? [] : ["--verbose"];
        return { ok: true, value: { ...common, args: ["--print", "--output-format", outputFormat, ...verbosityArgs, ...modelArgs, "--effort", reasoning, "--permission-mode", "dontAsk", "--allowedTools", allowedTools, ...sessionArgs] }, warnings: [], ...(sessionId ? { providerSessionId: sessionId } : {}) };
    }
    if (route.provider === "agy") {
        if (!role.authority.network)
            return { ok: false, warnings: ["agy_network_policy_unsupported"] };
        if (role.limits.tokenBudget !== Number.MAX_SAFE_INTEGER)
            return { ok: false, warnings: ["agy_token_budget_unsupported"] };
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
export function routeFor(selection) {
    return BUILTIN_ROUTES.find((route) => route.provider === selection.provider && route.model === selection.model)
        ?? BUILTIN_ROUTES.find((route) => route.provider === selection.provider && route.model === "*");
}
export function createAgentAdapter(selection, runner) { const route = routeFor(selection); return route ? new ProcessAgentAdapter(route, selection, runner) : undefined; }
/** Deterministic test port; it never opens a process or contacts a provider. */
export class SyntheticRunner {
    available;
    results;
    attestation;
    calls = [];
    cancelled = [];
    constructor(available = new Set(BUILTIN_ROUTES.map((route) => route.executable)), results = [{ exitCode: 0, events: [{ type: "complete" }], usage: { tokens: 0 } }], attestation) {
        this.available = available;
        this.results = results;
        this.attestation = attestation;
    }
    executableAvailable(executable) { return this.available.has(executable); }
    async run(invocation) { this.calls.push(invocation); return this.results[Math.min(this.calls.length - 1, this.results.length - 1)] ?? { exitCode: 1 }; }
    async cancel(runId) { this.cancelled.push(runId); }
    attestIsolation() { return this.attestation; }
}
