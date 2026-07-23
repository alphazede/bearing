import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { BUILTIN_ROUTES, createAgentAdapter, routeFor } from "../adapters/adapters.js";
import { parseAgentProfile, resolveRun, } from "../profile/profile.js";
export const REASONING_LEVELS = ["default", "off", "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "thinking"];
export class AdapterVerification {
    runner;
    constructor(runner) {
        this.runner = runner;
    }
    async verify(selection, role, repositoryPath) {
        const adapter = createAgentAdapter(selection, this.runner);
        if (!adapter)
            return false;
        const receipt = await adapter.execute({ runId: `readiness-${randomUUID()}`, repositoryPath, role: { ...role, authority: { ...role.authority, write: false, network: selection.provider === "agy" ? role.authority.network : false, externalAction: false }, toolAllow: role.toolAllow.filter((tool) => !/write|edit|shell|bash/i.test(tool)), sessionId: null }, task: { prompt: "Return a short structured completion confirming readiness. Do not read or write repository files." } });
        return receipt.status === "completed" && receipt.events.some((event) => /^(complete|completed|done|result|turn\.completed|agent_end|step_finish)$/i.test(event.type));
    }
}
const BASE_PROFILE = (() => {
    const parsed = parseAgentProfile({
        schemaVersion: 1,
        agentRef: "bearing/default",
        profileRef: "bearing/default-v1",
        credentialAccountRef: "environment",
        roles: ["navigator", "explorer", "crewmate", "surveyor"],
        toolAllow: ["read", "search", "write"],
        toolDeny: ["external-action"],
        authority: { read: true, write: true, network: true, workspace: true, externalAction: false },
        enabledSkills: [],
        context: "off",
        systemPromptRef: "bearing/default",
        limits: { timeoutMs: 2_100_000, maxTurns: 20, maxTools: 100, maxRetries: 1, maxConcurrency: 1, maxDelegation: 2, tokenBudget: Number.MAX_SAFE_INTEGER },
        session: { persistence: "persistent", resume: "allowed", fork: "allowed" },
        structuredEvents: true,
        fallbackEnabled: false,
        isolation: "auto",
    });
    if (!parsed.ok)
        throw new Error("invalid built-in profile");
    return parsed.value;
})();
function descriptor(selection) {
    const route = routeFor(selection);
    return route?.reasoningLevels.includes(selection.reasoning) ? route : undefined;
}
function fallback(route, current) {
    const model = current?.model ?? route.model;
    const reasoning = route.reasoningLevels.includes(current?.reasoning ?? "") ? current.reasoning : route.reasoningLevels[0];
    return [{ model, label: model === "*" ? "Agent default" : model, reasoningLevels: route.reasoningLevels, defaultReasoning: reasoning }];
}
function normalized(options, fallbackOption) {
    const seen = new Set();
    const safe = options.flatMap((option) => {
        const model = typeof option.model === "string" && /^[^\s\u0000-\u001f]{1,256}$/.test(option.model) ? option.model : undefined;
        const levels = Array.isArray(option.reasoningLevels) ? option.reasoningLevels.filter((level) => typeof level === "string" && REASONING_LEVELS.includes(level)).slice(0, REASONING_LEVELS.length) : [];
        if (!model || !levels.length || seen.has(model))
            return [];
        seen.add(model);
        return [{ model, label: model === "*" ? "Agent default" : model, reasoningLevels: levels, defaultReasoning: levels.includes(option.defaultReasoning) ? option.defaultReasoning : levels[0] }];
    });
    return safe.length ? safe.slice(0, 64) : fallbackOption;
}
export class ReadinessService {
    inspection;
    verification;
    overrides;
    models = new Map();
    constructor(inspection, verification, overrides = {}) {
        this.inspection = inspection;
        this.verification = verification;
        this.overrides = overrides;
    }
    inspect(_repositoryPath = process.cwd()) {
        return BUILTIN_ROUTES.slice(0, 16).map((route) => {
            const detected = this.inspection.executableAvailable(route.executable);
            const current = this.inspection.currentSelection?.(route);
            const selectedModel = fallback(route, current)[0];
            return {
                id: route.id,
                provider: route.provider,
                model: selectedModel.model,
                reasoning: selectedModel.reasoningLevels.includes(current?.reasoning ?? "") ? current.reasoning : selectedModel.defaultReasoning,
                detected,
                capabilities: route.capabilities.slice(0, 16),
            };
        });
    }
    discover(routeId, repositoryPath, detected = false) {
        const route = BUILTIN_ROUTES.find((candidate) => candidate.id === routeId);
        if (!route || (!detected && !this.inspection.executableAvailable(route.executable)))
            return undefined;
        let repository;
        try {
            repository = realpathSync(repositoryPath);
            if (!statSync(repository).isDirectory())
                return undefined;
        }
        catch {
            return undefined;
        }
        const key = `${repository}\u0000${route.id}`;
        const cached = this.models.get(key);
        if (cached)
            return cached;
        const safeFallback = fallback(route, this.inspection.currentSelection?.(route));
        let discovered = [];
        try {
            discovered = this.inspection.modelOptions?.(route, repository) ?? [];
        }
        catch { /* static fallback */ }
        const choices = normalized(discovered, safeFallback);
        this.models.set(key, choices);
        return choices;
    }
    async check(selection, repositoryPath = process.cwd()) {
        const effectiveSelection = {
            provider: this.overrides.provider ?? selection.provider,
            model: this.overrides.model ?? selection.model,
            reasoning: this.overrides.reasoning ?? selection.reasoning,
        };
        const route = descriptor(effectiveSelection);
        const detected = route ? this.inspection.executableAvailable(route.executable) : false;
        const models = route && detected ? this.discover(route.id, repositoryPath, true) : undefined;
        const selectedModel = models?.find(({ model }) => model === effectiveSelection.model);
        if (!route || !detected || !models || (this.inspection.modelOptions !== undefined && (!selectedModel || !selectedModel.reasoningLevels.includes(effectiveSelection.reasoning)))) {
            return { status: "blocked", detected, verified: false, code: "selection_unavailable", repair: "choose_detected_route" };
        }
        const resolved = resolveRun({ ...BASE_PROFILE, selection }, this.overrides, randomUUID());
        if (resolved.status !== "ready") {
            return { status: "blocked", detected, verified: false, code: "selection_unavailable", repair: "choose_detected_route" };
        }
        const verificationRole = resolved.value.roles.find((role) => role.role === "crewmate") ?? resolved.value.roles[0];
        const verified = this.verification ? await this.verification.verify(effectiveSelection, verificationRole, repositoryPath).catch(() => false) : false;
        return { status: verified ? "ready" : "detected", detected: true, verified, run: resolved.value };
    }
}
