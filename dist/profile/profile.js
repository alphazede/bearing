/** Pure, fail-closed profile and run-policy resolution. */
import { DEFAULT_REASONING_TIERS, REASONING_PROVIDER_MAP, REASONING_TIERS, resolveReasoning, } from "./reasoning-policy.js";
export const PROFILE_SCHEMA_VERSION = 2;
export const ROLES = ["navigator", "explorer", "crewmate", "surveyor"];
const MAX_STRING = 256;
const MAX_ARRAY = 64;
const PROFILE_KEYS = new Set(["schemaVersion", "agentRef", "profileRef", "credentialAccountRef", "roles", "toolAllow", "toolDeny", "authority", "enabledSkills", "context", "systemPromptRef", "limits", "session", "structuredEvents", "fallbackEnabled", "isolation", "reasoningPolicy", "selection"]);
const PROFILE_V1_KEYS = new Set([...PROFILE_KEYS].filter((key) => key !== "reasoningPolicy"));
const REASONING_POLICY_KEYS = new Set(["defaults", "escalation"]);
const REASONING_DEFAULT_KEYS = new Set(Object.keys(DEFAULT_REASONING_TIERS));
const REASONING_ESCALATION_KEYS = new Set(["maxSteps", "onNewFailureFingerprint", "onCrossBoundaryDefect"]);
const OVERRIDE_KEYS = new Set(["agentRef", "profileRef", "provider", "model", "reasoning", "tools", "excludedTools", "noSession", "offline", "timeoutMs", "maxTurns", "budget", "decisionDepth"]);
const DEFAULT_REASONING_POLICY = {
    defaults: DEFAULT_REASONING_TIERS,
    escalation: { maxSteps: 2, onNewFailureFingerprint: true, onCrossBoundaryDefect: true },
};
function object(v) { return typeof v === "object" && v !== null && !Array.isArray(v); }
function exactKeys(v, keys, optional = new Set()) { return Object.keys(v).every((key) => keys.has(key)) && [...keys].filter((key) => !optional.has(key)).every((key) => key in v); }
function text(v) { return typeof v === "string" && v.length > 0 && v.length <= MAX_STRING; }
function list(v) { return Array.isArray(v) && v.length <= MAX_ARRAY && v.every(text) && new Set(v).size === v.length; }
function positive(v) { return typeof v === "number" && Number.isSafeInteger(v) && v > 0; }
function nonNegative(v) { return typeof v === "number" && Number.isSafeInteger(v) && v >= 0; }
function enumValue(v, values) { return typeof v === "string" && values.includes(v); }
export function parseAgentProfile(input) {
    const migrated = migrateAgentProfile(input);
    return migrated.ok ? { ok: true, value: migrated.value } : migrated;
}
export function migrateAgentProfile(input) {
    if (!object(input))
        return { ok: false, code: "profile_invalid" };
    if (input.schemaVersion === PROFILE_SCHEMA_VERSION) {
        const parsed = parseV2Profile(input);
        return parsed.ok ? { ok: true, value: parsed.value, migrated: false } : parsed;
    }
    if (input.schemaVersion !== 1)
        return { ok: false, code: "profile_schema_invalid" };
    const legacy = parseV1Profile(input);
    if (!legacy.ok)
        return legacy;
    let migratedSelection;
    if (legacy.value.selection) {
        const tier = normalizeReasoningTier(legacy.value.selection.reasoning, legacy.value.selection.provider);
        if (!tier)
            return { ok: false, code: "reasoning_unmappable" };
        migratedSelection = { ...legacy.value.selection, reasoning: tier };
    }
    const migrated = parseV2Profile({ ...legacy.value, schemaVersion: PROFILE_SCHEMA_VERSION, reasoningPolicy: DEFAULT_REASONING_POLICY, ...(migratedSelection ? { selection: migratedSelection } : {}) });
    return migrated.ok ? { ok: true, value: migrated.value, migrated: true } : migrated;
}
function parseV2Profile(input) {
    if (!exactKeys(input, PROFILE_KEYS, new Set(["selection", "fallbackEnabled"])))
        return { ok: false, code: "profile_invalid" };
    if (input.schemaVersion !== PROFILE_SCHEMA_VERSION)
        return { ok: false, code: "profile_schema_invalid" };
    const roles = input.roles, allowed = input.toolAllow, denied = input.toolDeny;
    if (!text(input.agentRef) || !text(input.profileRef) || !text(input.credentialAccountRef) || !text(input.systemPromptRef) || !list(roles) || roles.length !== ROLES.length || !ROLES.every((role) => roles.includes(role)) || !list(allowed) || !list(denied) || allowed.some((tool) => denied.includes(tool)) || !list(input.enabledSkills) || !enumValue(input.context, ["off", "evidence-only", "rag-assisted"]) || !enumValue(input.isolation, ["auto", "required", "off"]) || typeof input.structuredEvents !== "boolean" || (input.fallbackEnabled !== undefined && typeof input.fallbackEnabled !== "boolean"))
        return { ok: false, code: "profile_invalid" };
    if (!authority(input.authority) || (input.context !== "off" && !input.authority.read) || !limits(input.limits) || !session(input.session) || !reasoningPolicy(input.reasoningPolicy))
        return { ok: false, code: "profile_invalid" };
    let normalizedSelection;
    if (input.selection !== undefined) {
        if (!legacySelection(input.selection))
            return { ok: false, code: "profile_invalid" };
        const reasoning = normalizeReasoningTier(input.selection.reasoning, input.selection.provider);
        if (!reasoning)
            return { ok: false, code: "reasoning_unmappable" };
        normalizedSelection = { ...input.selection, reasoning };
        if (!selection(normalizedSelection))
            return { ok: false, code: "profile_invalid" };
    }
    const { selection: _selection, ...profile } = input;
    return { ok: true, value: { ...profile, fallbackEnabled: input.fallbackEnabled ?? false, ...(normalizedSelection ? { selection: normalizedSelection } : {}) } };
}
function authority(v) { return object(v) && exactKeys(v, new Set(["read", "write", "network", "workspace", "externalAction"])) && Object.values(v).every((value) => typeof value === "boolean"); }
function limits(v) { return object(v) && exactKeys(v, new Set(["timeoutMs", "maxTurns", "maxTools", "maxRetries", "maxConcurrency", "maxDelegation", "tokenBudget", "costBudget"]), new Set(["costBudget"])) && [v.timeoutMs, v.maxTurns, v.maxTools, v.maxRetries, v.maxConcurrency, v.maxDelegation, v.tokenBudget, ...(v.costBudget === undefined ? [] : [v.costBudget])].every(positive); }
function session(v) { return object(v) && exactKeys(v, new Set(["persistence", "resume", "fork"])) && enumValue(v.persistence, ["off", "ephemeral", "persistent"]) && enumValue(v.resume, ["never", "allowed", "required"]) && enumValue(v.fork, ["never", "allowed"]); }
function reasoningPolicy(v) {
    if (!object(v) || !exactKeys(v, REASONING_POLICY_KEYS) || !object(v.defaults) || !exactKeys(v.defaults, REASONING_DEFAULT_KEYS) || !Object.values(v.defaults).every((tier) => enumValue(tier, REASONING_TIERS)) || !object(v.escalation) || !exactKeys(v.escalation, REASONING_ESCALATION_KEYS))
        return false;
    return nonNegative(v.escalation.maxSteps) && typeof v.escalation.onNewFailureFingerprint === "boolean" && typeof v.escalation.onCrossBoundaryDefect === "boolean";
}
function parseV1Profile(input) {
    if (!exactKeys(input, PROFILE_V1_KEYS, new Set(["selection", "fallbackEnabled"])))
        return { ok: false, code: "profile_invalid" };
    if (input.schemaVersion !== 1)
        return { ok: false, code: "profile_schema_invalid" };
    const roles = input.roles, allowed = input.toolAllow, denied = input.toolDeny;
    if (!text(input.agentRef) || !text(input.profileRef) || !text(input.credentialAccountRef) || !text(input.systemPromptRef) || !list(roles) || roles.length !== ROLES.length || !ROLES.every((role) => roles.includes(role)) || !list(allowed) || !list(denied) || allowed.some((tool) => denied.includes(tool)) || !list(input.enabledSkills) || !enumValue(input.context, ["off", "evidence-only", "rag-assisted"]) || !enumValue(input.isolation, ["auto", "required", "off"]) || typeof input.structuredEvents !== "boolean" || (input.fallbackEnabled !== undefined && typeof input.fallbackEnabled !== "boolean"))
        return { ok: false, code: "profile_invalid" };
    if (!authority(input.authority) || (input.context !== "off" && !input.authority.read) || !limits(input.limits) || !session(input.session) || (input.selection !== undefined && !legacySelection(input.selection)))
        return { ok: false, code: "profile_invalid" };
    return { ok: true, value: { ...input, fallbackEnabled: input.fallbackEnabled ?? false } };
}
function selection(v) { return object(v) && exactKeys(v, new Set(["provider", "model", "reasoning"])) && text(v.provider) && text(v.model) && enumValue(v.reasoning, REASONING_TIERS); }
function legacySelection(v) { return object(v) && exactKeys(v, new Set(["provider", "model", "reasoning"])) && text(v.provider) && text(v.model) && text(v.reasoning); }
export function normalizeReasoningTier(providerLevel, provider) {
    if (enumValue(providerLevel, REASONING_TIERS))
        return providerLevel;
    if ((provider === undefined || provider === "codex") && providerLevel === "ultra")
        return "max";
    if ((provider === undefined || provider === "opencode") && providerLevel === "default")
        return "medium";
    if ((provider === undefined || provider === "opencode") && providerLevel === "none" || (provider === undefined || provider === "pi") && providerLevel === "off")
        return "minimal";
    const providers = provider === undefined ? Object.keys(REASONING_PROVIDER_MAP.minimal) : Object.hasOwn(REASONING_PROVIDER_MAP.minimal, provider) ? [provider] : [];
    const candidates = REASONING_TIERS.filter((tier) => providers.some((candidate) => REASONING_PROVIDER_MAP[tier][candidate] === providerLevel));
    return candidates.includes("very-high") ? "very-high" : candidates[0];
}
export function parseRunOverrides(input) {
    if (!object(input))
        return { ok: false, code: "override_invalid" };
    if (Object.keys(input).some((key) => /key|secret|token|credential|authority|role/i.test(key)))
        return { ok: false, code: "override_unsafe" };
    if (!exactKeys(input, OVERRIDE_KEYS, OVERRIDE_KEYS))
        return { ok: false, code: "override_invalid" };
    const tools = input.tools, excluded = input.excludedTools;
    if ([input.agentRef, input.profileRef, input.provider, input.model].some((value) => value !== undefined && !text(value)) || (input.reasoning !== undefined && !enumValue(input.reasoning, REASONING_TIERS)) || (tools !== undefined && !list(tools)) || (excluded !== undefined && !list(excluded)) || (Array.isArray(tools) && Array.isArray(excluded) && tools.some((tool) => excluded.includes(tool))) || (input.noSession !== undefined && typeof input.noSession !== "boolean") || (input.offline !== undefined && typeof input.offline !== "boolean") || (input.timeoutMs !== undefined && !positive(input.timeoutMs)) || (input.maxTurns !== undefined && !positive(input.maxTurns)) || (input.decisionDepth !== undefined && !enumValue(input.decisionDepth, ["focused", "standard", "deep"])) || (input.budget !== undefined && (!object(input.budget) || !exactKeys(input.budget, new Set(["tokens", "cost"]), new Set(["tokens", "cost"])) || (input.budget.tokens === undefined && input.budget.cost === undefined) || [input.budget.tokens, input.budget.cost].some((value) => value !== undefined && !positive(value)))))
        return { ok: false, code: "override_invalid" };
    return { ok: true, value: input };
}
export function resolveRun(profile, rawOverrides, sessionNonce) {
    if (!profile.selection)
        return { status: "blocked", code: "selection_missing" };
    if (!text(sessionNonce))
        return { status: "blocked", code: "session_nonce_invalid" };
    const parsed = parseRunOverrides(rawOverrides);
    if (!parsed.ok)
        return { status: "blocked", code: parsed.code };
    const overrides = parsed.value;
    if ((overrides.tools && overrides.tools.some((tool) => !profile.toolAllow.includes(tool))) || (overrides.excludedTools && overrides.excludedTools.some((tool) => profile.toolDeny.includes(tool))) || (overrides.timeoutMs !== undefined && overrides.timeoutMs > profile.limits.timeoutMs) || (overrides.maxTurns !== undefined && overrides.maxTurns > profile.limits.maxTurns) || (overrides.budget?.tokens !== undefined && overrides.budget.tokens > profile.limits.tokenBudget) || (overrides.budget?.cost !== undefined && (profile.limits.costBudget === undefined || overrides.budget.cost > profile.limits.costBudget)))
        return { status: "blocked", code: "override_unsafe" };
    const tools = (overrides.tools ?? profile.toolAllow).filter((tool) => !overrides.excludedTools?.includes(tool));
    const effectiveReasoning = overrides.reasoning ?? profile.selection.reasoning;
    if (!enumValue(effectiveReasoning, REASONING_TIERS))
        return { status: "blocked", code: "reasoning_unmappable" };
    const selected = { provider: overrides.provider ?? profile.selection.provider, model: overrides.model ?? profile.selection.model, reasoning: effectiveReasoning };
    const roleReasoning = new Map();
    for (const role of ROLES) {
        const resolved = resolveReasoning({ role, provider: selected.provider, policy: profile.reasoningPolicy, globalOverride: effectiveReasoning });
        if (!resolved.ok)
            return { status: "blocked", code: resolved.code };
        roleReasoning.set(role, { tier: resolved.tier, providerLevel: resolved.providerLevel, clamped: resolved.clamped });
    }
    const noSession = overrides.noSession === true || profile.session.persistence === "off";
    const effectiveLimits = { timeoutMs: overrides.timeoutMs ?? profile.limits.timeoutMs, maxTurns: overrides.maxTurns ?? profile.limits.maxTurns, tokenBudget: overrides.budget?.tokens ?? profile.limits.tokenBudget, ...(profile.limits.costBudget === undefined && overrides.budget?.cost === undefined ? {} : { costBudget: overrides.budget?.cost ?? profile.limits.costBudget }) };
    const requestedRoute = { agentRef: profile.agentRef, profileRef: profile.profileRef, ...profile.selection };
    const effectiveRoute = { agentRef: overrides.agentRef ?? profile.agentRef, profileRef: overrides.profileRef ?? profile.profileRef, provider: selected.provider, model: selected.model, reasoning: Object.fromEntries(ROLES.map((role) => [role, roleReasoning.get(role).providerLevel])) };
    const authority = { ...profile.authority, network: overrides.offline === true ? false : profile.authority.network };
    const requestedLimits = { ...profile.limits };
    const receipt = { requested: { route: requestedRoute, isolation: profile.isolation, context: profile.context, limits: requestedLimits }, effective: { route: effectiveRoute, isolation: "unattested", context: profile.context, limits: effectiveLimits, tools, authority, session: noSession ? "off" : profile.session.persistence, ...(overrides.decisionDepth ? { decisionDepth: overrides.decisionDepth } : {}) }, blockingCodes: [], warningCodes: profile.fallbackEnabled ? [] : ["fallback_disabled"] };
    const projection = (role) => {
        const readOnly = { ...authority, write: false, externalAction: false };
        const withoutWrite = tools.filter((tool) => !/write|edit|shell|bash/i.test(tool));
        const reasoning = roleReasoning.get(role);
        const shared = { role, identity: `${effectiveRoute.agentRef}:${role}`, sessionId: noSession ? null : `${effectiveRoute.agentRef}:${role}:session:${sessionNonce}`, selection: selected, reasoning, toolDeny: [...profile.toolDeny], isolationRequested: profile.isolation, fallbackEnabled: profile.fallbackEnabled, limits: { ...profile.limits, ...effectiveLimits } };
        if (role === "navigator")
            return { ...shared, toolAllow: tools.filter((tool) => !/search/i.test(tool)), authority: { ...authority, network: false, externalAction: false }, context: "off", executor: true };
        if (role === "explorer")
            return { ...shared, toolAllow: withoutWrite, authority: readOnly, context: profile.context, executor: true };
        if (role === "surveyor")
            return { ...shared, toolAllow: withoutWrite.filter((tool) => !/search/i.test(tool)), authority: { ...readOnly, network: false }, context: "off", executor: false };
        return { ...shared, toolAllow: authority.write ? [...tools] : withoutWrite, authority: { ...authority }, context: profile.context, executor: true };
    };
    return { status: "ready", value: { roles: ROLES.map(projection), receipt } };
}
const _widen46 = true;
void _widen46;
