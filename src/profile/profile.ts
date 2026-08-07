/** Pure, fail-closed profile and run-policy resolution. */
import {
  DEFAULT_REASONING_TIERS,
  REASONING_PROVIDER_MAP,
  REASONING_TIERS,
  resolveReasoning,
  type ReasoningPolicy,
  type ReasoningTier,
} from "./reasoning-policy.js";
import { enumValue } from "../contracts/guards.js";

export const PROFILE_SCHEMA_VERSION = 2 as const;

export const ROLES = ["navigator", "explorer", "crewmate", "surveyor"] as const;
export type Role = (typeof ROLES)[number];
export type VerificationRole = "validator" | "grader" | "park-ranger";
export type ContextMode = "off" | "evidence-only" | "rag-assisted";
export type IsolationMode = "auto" | "required" | "off";
type SessionMode = "off" | "ephemeral" | "persistent";
type ResumeMode = "never" | "allowed" | "required";
type ForkMode = "never" | "allowed";

export interface Selection {
  readonly provider: string;
  readonly model: string;
  readonly reasoning: string;
}

export interface AgentProfile {
  readonly schemaVersion: typeof PROFILE_SCHEMA_VERSION;
  readonly agentRef: string;
  readonly profileRef: string;
  readonly credentialAccountRef: string;
  readonly roles: readonly Role[];
  readonly toolAllow: readonly string[];
  readonly toolDeny: readonly string[];
  readonly authority: { readonly read: boolean; readonly write: boolean; readonly network: boolean; readonly workspace: boolean; readonly externalAction: boolean };
  readonly enabledSkills: readonly string[];
  readonly context: ContextMode;
  readonly systemPromptRef: string;
  readonly limits: { readonly timeoutMs: number; readonly maxTurns: number; readonly maxTools: number; readonly maxRetries: number; readonly maxConcurrency: number; readonly maxDelegation: number; readonly tokenBudget: number; readonly costBudget?: number };
  readonly session: { readonly persistence: SessionMode; readonly resume: ResumeMode; readonly fork: ForkMode };
  readonly structuredEvents: boolean;
  readonly fallbackEnabled: boolean;
  readonly isolation: IsolationMode;
  readonly reasoningPolicy: ReasoningPolicy;
  readonly selection?: Selection;
}

export type ProfileResult = { readonly ok: true; readonly value: AgentProfile } | { readonly ok: false; readonly code: "profile_invalid" | "profile_schema_invalid" | "reasoning_unmappable" };
export type ProfileMigrationResult = { readonly ok: true; readonly value: AgentProfile; readonly migrated: boolean } | { readonly ok: false; readonly code: "profile_invalid" | "profile_schema_invalid" | "reasoning_unmappable" };
export type OverrideResult = { readonly ok: true; readonly value: RunOverrides } | { readonly ok: false; readonly code: "override_invalid" | "override_unsafe" };
export type ResolveResult = { readonly status: "ready"; readonly value: ResolvedRun } | { readonly status: "blocked"; readonly code: "selection_missing" | "override_invalid" | "override_unsafe" | "session_nonce_invalid" | "reasoning_unmappable" };

export interface RunOverrides {
  readonly agentRef?: string;
  readonly profileRef?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly reasoning?: string;
  readonly tools?: readonly string[];
  readonly excludedTools?: readonly string[];
  readonly noSession?: boolean;
  readonly offline?: boolean;
  readonly timeoutMs?: number;
  readonly maxTurns?: number;
  readonly budget?: { readonly tokens?: number; readonly cost?: number };
  readonly decisionDepth?: "focused" | "standard" | "deep";
}

export interface RoleProjection {
  readonly role: Role | VerificationRole;
  readonly identity: string;
  readonly sessionId: string | null;
  readonly selection: Selection;
  readonly reasoning: { readonly tier: ReasoningTier; readonly providerLevel: string; readonly clamped: boolean };
  readonly toolAllow: readonly string[];
  readonly toolDeny: readonly string[];
  readonly authority: AgentProfile["authority"];
  readonly context: ContextMode;
  readonly isolationRequested: IsolationMode;
  readonly fallbackEnabled: boolean;
  readonly limits: AgentProfile["limits"];
  /** Surveyors report independently and are never execution authorities. */
  readonly executor: boolean;
}

export interface ResolvedRun {
  readonly roles: readonly RoleProjection[];
  readonly receipt: RunReceipt;
}

interface RunReceipt {
  readonly requested: Readonly<Record<string, unknown>>;
  readonly effective: Readonly<Record<string, unknown>>;
  readonly blockingCodes: readonly string[];
  readonly warningCodes: readonly string[];
}

const MAX_STRING = 256;
const MAX_ARRAY = 64;
const PROFILE_KEYS = new Set(["schemaVersion", "agentRef", "profileRef", "credentialAccountRef", "roles", "toolAllow", "toolDeny", "authority", "enabledSkills", "context", "systemPromptRef", "limits", "session", "structuredEvents", "fallbackEnabled", "isolation", "reasoningPolicy", "selection"]);
const PROFILE_V1_KEYS = new Set([...PROFILE_KEYS].filter((key) => key !== "reasoningPolicy"));
const REASONING_POLICY_KEYS = new Set(["defaults", "escalation"]);
const REASONING_DEFAULT_KEYS = new Set(Object.keys(DEFAULT_REASONING_TIERS));
const REASONING_ESCALATION_KEYS = new Set(["maxSteps", "onNewFailureFingerprint", "onCrossBoundaryDefect"]);
const OVERRIDE_KEYS = new Set(["agentRef", "profileRef", "provider", "model", "reasoning", "tools", "excludedTools", "noSession", "offline", "timeoutMs", "maxTurns", "budget", "decisionDepth"]);
const DEFAULT_REASONING_POLICY: ReasoningPolicy = {
  defaults: DEFAULT_REASONING_TIERS,
  escalation: { maxSteps: 2, onNewFailureFingerprint: true, onCrossBoundaryDefect: true },
};

function object(v: unknown): v is Record<string, unknown> { return typeof v === "object" && v !== null && !Array.isArray(v); }
function exactKeys(v: Record<string, unknown>, keys: ReadonlySet<string>, optional = new Set<string>()): boolean { return Object.keys(v).every((key) => keys.has(key)) && [...keys].filter((key) => !optional.has(key)).every((key) => key in v); }
function text(v: unknown): v is string { return typeof v === "string" && v.length > 0 && v.length <= MAX_STRING; }
function list(v: unknown): v is readonly string[] { return Array.isArray(v) && v.length <= MAX_ARRAY && v.every(text) && new Set(v).size === v.length; }
function positive(v: unknown): v is number { return typeof v === "number" && Number.isSafeInteger(v) && v > 0; }
function nonNegative(v: unknown): v is number { return typeof v === "number" && Number.isSafeInteger(v) && v >= 0; }
export function parseAgentProfile(input: unknown): ProfileResult {
  const migrated = migrateAgentProfile(input);
  return migrated.ok ? { ok: true, value: migrated.value } : migrated;
}

export function migrateAgentProfile(input: unknown): ProfileMigrationResult {
  if (!object(input)) return { ok: false, code: "profile_invalid" };
  if (input.schemaVersion === PROFILE_SCHEMA_VERSION) {
    const parsed = parseV2Profile(input);
    return parsed.ok ? { ok: true, value: parsed.value, migrated: false } : parsed;
  }
  if (input.schemaVersion !== 1) return { ok: false, code: "profile_schema_invalid" };
  const legacy = parseV1Profile(input);
  if (!legacy.ok) return legacy;
  let migratedSelection: Selection | undefined;
  if (legacy.value.selection) {
    const tier = normalizeReasoningTier(legacy.value.selection.reasoning, legacy.value.selection.provider);
    if (!tier) return { ok: false, code: "reasoning_unmappable" };
    migratedSelection = { ...legacy.value.selection, reasoning: tier };
  }
  const migrated = parseV2Profile({ ...legacy.value, schemaVersion: PROFILE_SCHEMA_VERSION, reasoningPolicy: DEFAULT_REASONING_POLICY, ...(migratedSelection ? { selection: migratedSelection } : {}) });
  return migrated.ok ? { ok: true, value: migrated.value, migrated: true } : migrated;
}

function parseV2Profile(input: Record<string, unknown>): ProfileResult {
  if (!exactKeys(input, PROFILE_KEYS, new Set(["selection", "fallbackEnabled"]))) return { ok: false, code: "profile_invalid" };
  if (input.schemaVersion !== PROFILE_SCHEMA_VERSION) return { ok: false, code: "profile_schema_invalid" };
  const roles = input.roles, allowed = input.toolAllow, denied = input.toolDeny;
  if (!text(input.agentRef) || !text(input.profileRef) || !text(input.credentialAccountRef) || !text(input.systemPromptRef) || !list(roles) || roles.length !== ROLES.length || !ROLES.every((role) => roles.includes(role)) || !list(allowed) || !list(denied) || allowed.some((tool) => denied.includes(tool)) || !list(input.enabledSkills) || !enumValue(input.context, ["off", "evidence-only", "rag-assisted"] as const) || !enumValue(input.isolation, ["auto", "required", "off"] as const) || typeof input.structuredEvents !== "boolean" || (input.fallbackEnabled !== undefined && typeof input.fallbackEnabled !== "boolean")) return { ok: false, code: "profile_invalid" };
  if (!authority(input.authority) || (input.context !== "off" && !input.authority.read) || !limits(input.limits) || !session(input.session) || !reasoningPolicy(input.reasoningPolicy)) return { ok: false, code: "profile_invalid" };
  let normalizedSelection: Selection | undefined;
  if (input.selection !== undefined) {
    if (!legacySelection(input.selection)) return { ok: false, code: "profile_invalid" };
    const reasoning = normalizeReasoningTier(input.selection.reasoning, input.selection.provider);
    if (!reasoning) return { ok: false, code: "reasoning_unmappable" };
    normalizedSelection = { ...input.selection, reasoning };
    if (!selection(normalizedSelection)) return { ok: false, code: "profile_invalid" };
  }
  const { selection: _selection, ...profile } = input;
  return { ok: true, value: { ...profile, fallbackEnabled: input.fallbackEnabled ?? false, ...(normalizedSelection ? { selection: normalizedSelection } : {}) } as unknown as AgentProfile };
}

function authority(v: unknown): v is AgentProfile["authority"] { return object(v) && exactKeys(v, new Set(["read", "write", "network", "workspace", "externalAction"])) && Object.values(v).every((value) => typeof value === "boolean"); }
function limits(v: unknown): v is AgentProfile["limits"] { return object(v) && exactKeys(v, new Set(["timeoutMs", "maxTurns", "maxTools", "maxRetries", "maxConcurrency", "maxDelegation", "tokenBudget", "costBudget"]), new Set(["costBudget"])) && [v.timeoutMs, v.maxTurns, v.maxTools, v.maxRetries, v.maxConcurrency, v.maxDelegation, v.tokenBudget, ...(v.costBudget === undefined ? [] : [v.costBudget])].every(positive); }
function session(v: unknown): v is AgentProfile["session"] { return object(v) && exactKeys(v, new Set(["persistence", "resume", "fork"])) && enumValue(v.persistence, ["off", "ephemeral", "persistent"] as const) && enumValue(v.resume, ["never", "allowed", "required"] as const) && enumValue(v.fork, ["never", "allowed"] as const); }
function reasoningPolicy(v: unknown): v is ReasoningPolicy {
  if (!object(v) || !exactKeys(v, REASONING_POLICY_KEYS) || !object(v.defaults) || !exactKeys(v.defaults, REASONING_DEFAULT_KEYS) || !Object.values(v.defaults).every((tier) => enumValue(tier, REASONING_TIERS)) || !object(v.escalation) || !exactKeys(v.escalation, REASONING_ESCALATION_KEYS)) return false;
  return nonNegative(v.escalation.maxSteps) && typeof v.escalation.onNewFailureFingerprint === "boolean" && typeof v.escalation.onCrossBoundaryDefect === "boolean";
}
interface LegacySelection {
  readonly provider: string;
  readonly model: string;
  readonly reasoning: string;
}
type AgentProfileV1 = Omit<AgentProfile, "schemaVersion" | "reasoningPolicy" | "selection"> & { readonly schemaVersion: 1; readonly selection?: LegacySelection };
type ProfileV1Result = { readonly ok: true; readonly value: AgentProfileV1 } | { readonly ok: false; readonly code: "profile_invalid" | "profile_schema_invalid" };

function parseV1Profile(input: Record<string, unknown>): ProfileV1Result {
  if (!exactKeys(input, PROFILE_V1_KEYS, new Set(["selection", "fallbackEnabled"]))) return { ok: false, code: "profile_invalid" };
  if (input.schemaVersion !== 1) return { ok: false, code: "profile_schema_invalid" };
  const roles = input.roles, allowed = input.toolAllow, denied = input.toolDeny;
  if (!text(input.agentRef) || !text(input.profileRef) || !text(input.credentialAccountRef) || !text(input.systemPromptRef) || !list(roles) || roles.length !== ROLES.length || !ROLES.every((role) => roles.includes(role)) || !list(allowed) || !list(denied) || allowed.some((tool) => denied.includes(tool)) || !list(input.enabledSkills) || !enumValue(input.context, ["off", "evidence-only", "rag-assisted"] as const) || !enumValue(input.isolation, ["auto", "required", "off"] as const) || typeof input.structuredEvents !== "boolean" || (input.fallbackEnabled !== undefined && typeof input.fallbackEnabled !== "boolean")) return { ok: false, code: "profile_invalid" };
  if (!authority(input.authority) || (input.context !== "off" && !input.authority.read) || !limits(input.limits) || !session(input.session) || (input.selection !== undefined && !legacySelection(input.selection))) return { ok: false, code: "profile_invalid" };
  return { ok: true, value: { ...input, fallbackEnabled: input.fallbackEnabled ?? false } as AgentProfileV1 };
}

function selection(v: unknown): v is Selection { return object(v) && exactKeys(v, new Set(["provider", "model", "reasoning"])) && text(v.provider) && text(v.model) && enumValue(v.reasoning, REASONING_TIERS); }

function legacySelection(v: unknown): v is LegacySelection { return object(v) && exactKeys(v, new Set(["provider", "model", "reasoning"])) && text(v.provider) && text(v.model) && text(v.reasoning); }

export function normalizeReasoningTier(providerLevel: string, provider?: string): ReasoningTier | undefined {
  if (enumValue(providerLevel, REASONING_TIERS)) return providerLevel;
  if ((provider === undefined || provider === "codex") && providerLevel === "ultra") return "max";
  if ((provider === undefined || provider === "opencode") && providerLevel === "default") return "medium";
  if ((provider === undefined || provider === "opencode") && providerLevel === "none" || (provider === undefined || provider === "pi") && providerLevel === "off") return "minimal";
  const providers = provider === undefined ? Object.keys(REASONING_PROVIDER_MAP.minimal) as (keyof typeof REASONING_PROVIDER_MAP.minimal)[] : Object.hasOwn(REASONING_PROVIDER_MAP.minimal, provider) ? [provider as keyof typeof REASONING_PROVIDER_MAP.minimal] : [];
  const candidates = REASONING_TIERS.filter((tier) => providers.some((candidate) => REASONING_PROVIDER_MAP[tier][candidate] === providerLevel));
  return candidates.includes("very-high") ? "very-high" : candidates[0];
}

export function parseRunOverrides(input: unknown): OverrideResult {
  if (!object(input)) return { ok: false, code: "override_invalid" };
  if (Object.keys(input).some((key) => /key|secret|token|credential|authority|role/i.test(key))) return { ok: false, code: "override_unsafe" };
  if (!exactKeys(input, OVERRIDE_KEYS, OVERRIDE_KEYS)) return { ok: false, code: "override_invalid" };
  const tools = input.tools, excluded = input.excludedTools;
  if ([input.agentRef, input.profileRef, input.provider, input.model].some((value) => value !== undefined && !text(value)) || (input.reasoning !== undefined && !enumValue(input.reasoning, REASONING_TIERS)) || (tools !== undefined && !list(tools)) || (excluded !== undefined && !list(excluded)) || (Array.isArray(tools) && Array.isArray(excluded) && tools.some((tool) => excluded.includes(tool))) || (input.noSession !== undefined && typeof input.noSession !== "boolean") || (input.offline !== undefined && typeof input.offline !== "boolean") || (input.timeoutMs !== undefined && !positive(input.timeoutMs)) || (input.maxTurns !== undefined && !positive(input.maxTurns)) || (input.decisionDepth !== undefined && !enumValue(input.decisionDepth, ["focused", "standard", "deep"] as const)) || (input.budget !== undefined && (!object(input.budget) || !exactKeys(input.budget, new Set(["tokens", "cost"]), new Set(["tokens", "cost"])) || (input.budget.tokens === undefined && input.budget.cost === undefined) || [input.budget.tokens, input.budget.cost].some((value) => value !== undefined && !positive(value))))) return { ok: false, code: "override_invalid" };
  return { ok: true, value: input as RunOverrides };
}

export function resolveRun(profile: AgentProfile, rawOverrides: unknown, sessionNonce: string): ResolveResult {
  if (!profile.selection) return { status: "blocked", code: "selection_missing" };
  if (!text(sessionNonce)) return { status: "blocked", code: "session_nonce_invalid" };
  const parsed = parseRunOverrides(rawOverrides);
  if (!parsed.ok) return { status: "blocked", code: parsed.code };
  const overrides = parsed.value;
  if ((overrides.tools && overrides.tools.some((tool) => !profile.toolAllow.includes(tool))) || (overrides.excludedTools && overrides.excludedTools.some((tool) => profile.toolDeny.includes(tool))) || (overrides.timeoutMs !== undefined && overrides.timeoutMs > profile.limits.timeoutMs) || (overrides.maxTurns !== undefined && overrides.maxTurns > profile.limits.maxTurns) || (overrides.budget?.tokens !== undefined && overrides.budget.tokens > profile.limits.tokenBudget) || (overrides.budget?.cost !== undefined && (profile.limits.costBudget === undefined || overrides.budget.cost > profile.limits.costBudget))) return { status: "blocked", code: "override_unsafe" };
  const tools = (overrides.tools ?? profile.toolAllow).filter((tool) => !overrides.excludedTools?.includes(tool));
  const effectiveReasoning = overrides.reasoning ?? profile.selection.reasoning;
  if (!enumValue(effectiveReasoning, REASONING_TIERS)) return { status: "blocked", code: "reasoning_unmappable" };
  const selected: Selection = { provider: overrides.provider ?? profile.selection.provider, model: overrides.model ?? profile.selection.model, reasoning: effectiveReasoning };
  const roleReasoning = new Map<Role, RoleProjection["reasoning"]>();
  for (const role of ROLES) {
    const resolved = resolveReasoning({ role, provider: selected.provider, policy: profile.reasoningPolicy, globalOverride: effectiveReasoning, ownerRequest: effectiveReasoning });
    if (!resolved.ok) return { status: "blocked", code: resolved.code };
    roleReasoning.set(role, { tier: resolved.tier, providerLevel: resolved.providerLevel, clamped: resolved.clamped });
  }
  const noSession = overrides.noSession === true || profile.session.persistence === "off";
  const effectiveLimits = { timeoutMs: overrides.timeoutMs ?? profile.limits.timeoutMs, maxTurns: overrides.maxTurns ?? profile.limits.maxTurns, tokenBudget: overrides.budget?.tokens ?? profile.limits.tokenBudget, ...(profile.limits.costBudget === undefined && overrides.budget?.cost === undefined ? {} : { costBudget: overrides.budget?.cost ?? profile.limits.costBudget }) };
  const requestedRoute = { agentRef: profile.agentRef, profileRef: profile.profileRef, ...profile.selection };
  const effectiveRoute = { agentRef: overrides.agentRef ?? profile.agentRef, profileRef: overrides.profileRef ?? profile.profileRef, provider: selected.provider, model: selected.model, reasoning: Object.fromEntries(ROLES.map((role) => [role, roleReasoning.get(role)!.providerLevel])) };
  const authority = { ...profile.authority, network: overrides.offline === true ? false : profile.authority.network };
  const requestedLimits = { ...profile.limits };
  const receipt: RunReceipt = { requested: { route: requestedRoute, isolation: profile.isolation, context: profile.context, limits: requestedLimits }, effective: { route: effectiveRoute, isolation: "unattested", context: profile.context, limits: effectiveLimits, tools, authority, session: noSession ? "off" : profile.session.persistence, ...(overrides.decisionDepth ? { decisionDepth: overrides.decisionDepth } : {}) }, blockingCodes: [], warningCodes: profile.fallbackEnabled ? [] : ["fallback_disabled"] };
  const projection = (role: Role): RoleProjection => {
    const readOnly = { ...authority, write: false, externalAction: false };
    const withoutWrite = tools.filter((tool) => !/write|edit|shell|bash/i.test(tool));
    const reasoning = roleReasoning.get(role)!;
    const shared = { role, identity: `${effectiveRoute.agentRef}:${role}`, sessionId: noSession ? null : `${effectiveRoute.agentRef}:${role}:session:${sessionNonce}`, selection: selected, reasoning, toolDeny: [...profile.toolDeny], isolationRequested: profile.isolation, fallbackEnabled: profile.fallbackEnabled, limits: { ...profile.limits, ...effectiveLimits } };
    if (role === "navigator") return { ...shared, toolAllow: tools.filter((tool) => !/search/i.test(tool)), authority: { ...authority, network: false, externalAction: false }, context: "off", executor: true };
    if (role === "explorer") return { ...shared, toolAllow: withoutWrite, authority: readOnly, context: profile.context, executor: true };
    if (role === "surveyor") return { ...shared, toolAllow: withoutWrite.filter((tool) => !/search/i.test(tool)), authority: { ...readOnly, network: false }, context: "off", executor: false };
    return { ...shared, toolAllow: authority.write ? [...tools] : withoutWrite, authority: { ...authority }, context: profile.context, executor: true };
  };
  return { status: "ready", value: { roles: ROLES.map(projection), receipt } };
}

// 4.6: regression guard. This assignment is only valid after widening RoleProjection["role"].
// Reverting the widen (without removing guard) makes CMD-TYPECHECK fail.
// 4.6 regression guard: assignability of a verification role to RoleProjection["role"] is checked
// at the TYPE level, so reverting the widen is a compile error. Expressed as a type rather than an
// `if (false)` block, because that block emitted dead code into the published dist/ bundle.
type _Widen46 = VerificationRole extends RoleProjection["role"] ? true : never;
const _widen46: _Widen46 = true;
void _widen46;
