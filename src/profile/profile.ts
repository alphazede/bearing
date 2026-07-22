/** Pure, fail-closed profile and run-policy resolution. */
export const PROFILE_SCHEMA_VERSION = 1 as const;

export const ROLES = ["navigator", "explorer", "crewmate", "surveyor"] as const;
export type Role = (typeof ROLES)[number];
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
  readonly selection?: Selection;
}

export type ProfileResult = { readonly ok: true; readonly value: AgentProfile } | { readonly ok: false; readonly code: "profile_invalid" | "profile_schema_invalid" };
export type OverrideResult = { readonly ok: true; readonly value: RunOverrides } | { readonly ok: false; readonly code: "override_invalid" | "override_unsafe" };
export type ResolveResult = { readonly status: "ready"; readonly value: ResolvedRun } | { readonly status: "blocked"; readonly code: "selection_missing" | "override_invalid" | "override_unsafe" | "session_nonce_invalid" };

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
  readonly role: Role;
  readonly identity: string;
  readonly sessionId: string | null;
  readonly selection: Selection;
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

export interface RunReceipt {
  readonly requested: Readonly<Record<string, unknown>>;
  readonly effective: Readonly<Record<string, unknown>>;
  readonly blockingCodes: readonly string[];
  readonly warningCodes: readonly string[];
}

const MAX_STRING = 256;
const MAX_ARRAY = 64;
const PROFILE_KEYS = new Set(["schemaVersion", "agentRef", "profileRef", "credentialAccountRef", "roles", "toolAllow", "toolDeny", "authority", "enabledSkills", "context", "systemPromptRef", "limits", "session", "structuredEvents", "fallbackEnabled", "isolation", "selection"]);
const OVERRIDE_KEYS = new Set(["agentRef", "profileRef", "provider", "model", "reasoning", "tools", "excludedTools", "noSession", "offline", "timeoutMs", "maxTurns", "budget", "decisionDepth"]);

function object(v: unknown): v is Record<string, unknown> { return typeof v === "object" && v !== null && !Array.isArray(v); }
function exactKeys(v: Record<string, unknown>, keys: ReadonlySet<string>, optional = new Set<string>()): boolean { return Object.keys(v).every((key) => keys.has(key)) && [...keys].filter((key) => !optional.has(key)).every((key) => key in v); }
function text(v: unknown): v is string { return typeof v === "string" && v.length > 0 && v.length <= MAX_STRING; }
function list(v: unknown): v is readonly string[] { return Array.isArray(v) && v.length <= MAX_ARRAY && v.every(text) && new Set(v).size === v.length; }
function positive(v: unknown): v is number { return typeof v === "number" && Number.isSafeInteger(v) && v > 0; }
function enumValue<T extends string>(v: unknown, values: readonly T[]): v is T { return typeof v === "string" && (values as readonly string[]).includes(v); }

export function parseAgentProfile(input: unknown): ProfileResult {
  if (!object(input)) return { ok: false, code: "profile_invalid" };
  if (input.schemaVersion !== PROFILE_SCHEMA_VERSION) return { ok: false, code: "profile_schema_invalid" };
  if (!exactKeys(input, PROFILE_KEYS, new Set(["selection", "fallbackEnabled"]))) return { ok: false, code: "profile_invalid" };
  const roles = input.roles, allowed = input.toolAllow, denied = input.toolDeny;
  if (!text(input.agentRef) || !text(input.profileRef) || !text(input.credentialAccountRef) || !text(input.systemPromptRef) || !list(roles) || roles.length !== ROLES.length || !ROLES.every((role) => roles.includes(role)) || !list(allowed) || !list(denied) || allowed.some((tool) => denied.includes(tool)) || !list(input.enabledSkills) || !enumValue(input.context, ["off", "evidence-only", "rag-assisted"] as const) || !enumValue(input.isolation, ["auto", "required", "off"] as const) || typeof input.structuredEvents !== "boolean" || (input.fallbackEnabled !== undefined && typeof input.fallbackEnabled !== "boolean")) return { ok: false, code: "profile_invalid" };
  if (!authority(input.authority) || (input.context !== "off" && !input.authority.read) || !limits(input.limits) || !session(input.session) || (input.selection !== undefined && !selection(input.selection))) return { ok: false, code: "profile_invalid" };
  return { ok: true, value: { ...input, fallbackEnabled: input.fallbackEnabled ?? false } as AgentProfile };
}

function authority(v: unknown): v is AgentProfile["authority"] { return object(v) && exactKeys(v, new Set(["read", "write", "network", "workspace", "externalAction"])) && Object.values(v).every((value) => typeof value === "boolean"); }
function limits(v: unknown): v is AgentProfile["limits"] { return object(v) && exactKeys(v, new Set(["timeoutMs", "maxTurns", "maxTools", "maxRetries", "maxConcurrency", "maxDelegation", "tokenBudget", "costBudget"]), new Set(["costBudget"])) && [v.timeoutMs, v.maxTurns, v.maxTools, v.maxRetries, v.maxConcurrency, v.maxDelegation, v.tokenBudget, ...(v.costBudget === undefined ? [] : [v.costBudget])].every(positive); }
function session(v: unknown): v is AgentProfile["session"] { return object(v) && exactKeys(v, new Set(["persistence", "resume", "fork"])) && enumValue(v.persistence, ["off", "ephemeral", "persistent"] as const) && enumValue(v.resume, ["never", "allowed", "required"] as const) && enumValue(v.fork, ["never", "allowed"] as const); }
function selection(v: unknown): v is Selection { return object(v) && exactKeys(v, new Set(["provider", "model", "reasoning"])) && text(v.provider) && text(v.model) && text(v.reasoning); }

export function parseRunOverrides(input: unknown): OverrideResult {
  if (!object(input)) return { ok: false, code: "override_invalid" };
  if (Object.keys(input).some((key) => /key|secret|token|credential|authority|role/i.test(key))) return { ok: false, code: "override_unsafe" };
  if (!exactKeys(input, OVERRIDE_KEYS, OVERRIDE_KEYS)) return { ok: false, code: "override_invalid" };
  const tools = input.tools, excluded = input.excludedTools;
  if ([input.agentRef, input.profileRef, input.provider, input.model, input.reasoning].some((value) => value !== undefined && !text(value)) || (tools !== undefined && !list(tools)) || (excluded !== undefined && !list(excluded)) || (Array.isArray(tools) && Array.isArray(excluded) && tools.some((tool) => excluded.includes(tool))) || (input.noSession !== undefined && typeof input.noSession !== "boolean") || (input.offline !== undefined && typeof input.offline !== "boolean") || (input.timeoutMs !== undefined && !positive(input.timeoutMs)) || (input.maxTurns !== undefined && !positive(input.maxTurns)) || (input.decisionDepth !== undefined && !enumValue(input.decisionDepth, ["focused", "standard", "deep"] as const)) || (input.budget !== undefined && (!object(input.budget) || !exactKeys(input.budget, new Set(["tokens", "cost"]), new Set(["tokens", "cost"])) || (input.budget.tokens === undefined && input.budget.cost === undefined) || [input.budget.tokens, input.budget.cost].some((value) => value !== undefined && !positive(value))))) return { ok: false, code: "override_invalid" };
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
  const selected: Selection = { provider: overrides.provider ?? profile.selection.provider, model: overrides.model ?? profile.selection.model, reasoning: overrides.reasoning ?? profile.selection.reasoning };
  const noSession = overrides.noSession === true || profile.session.persistence === "off";
  const effectiveLimits = { timeoutMs: overrides.timeoutMs ?? profile.limits.timeoutMs, maxTurns: overrides.maxTurns ?? profile.limits.maxTurns, tokenBudget: overrides.budget?.tokens ?? profile.limits.tokenBudget, ...(profile.limits.costBudget === undefined && overrides.budget?.cost === undefined ? {} : { costBudget: overrides.budget?.cost ?? profile.limits.costBudget }) };
  const requestedRoute = { agentRef: profile.agentRef, profileRef: profile.profileRef, ...profile.selection };
  const effectiveRoute = { agentRef: overrides.agentRef ?? profile.agentRef, profileRef: overrides.profileRef ?? profile.profileRef, ...selected };
  const authority = { ...profile.authority, network: overrides.offline === true ? false : profile.authority.network };
  const requestedLimits = { ...profile.limits };
  const receipt: RunReceipt = { requested: { route: requestedRoute, isolation: profile.isolation, context: profile.context, limits: requestedLimits }, effective: { route: effectiveRoute, isolation: "unattested", context: profile.context, limits: effectiveLimits, tools, authority, session: noSession ? "off" : profile.session.persistence, ...(overrides.decisionDepth ? { decisionDepth: overrides.decisionDepth } : {}) }, blockingCodes: [], warningCodes: profile.fallbackEnabled ? [] : ["fallback_disabled"] };
  const projection = (role: Role): RoleProjection => {
    const readOnly = { ...authority, write: false, externalAction: false };
    const withoutWrite = tools.filter((tool) => !/write|edit|shell|bash/i.test(tool));
    const shared = { role, identity: `${effectiveRoute.agentRef}:${role}`, sessionId: noSession ? null : `${effectiveRoute.agentRef}:${role}:session:${sessionNonce}`, selection: selected, toolDeny: [...profile.toolDeny], isolationRequested: profile.isolation, fallbackEnabled: profile.fallbackEnabled, limits: { ...profile.limits, ...effectiveLimits } };
    if (role === "navigator") return { ...shared, toolAllow: tools.filter((tool) => !/search/i.test(tool)), authority: { ...authority, network: false, externalAction: false }, context: "off", executor: true };
    if (role === "explorer") return { ...shared, toolAllow: withoutWrite, authority: readOnly, context: profile.context, executor: true };
    if (role === "surveyor") return { ...shared, toolAllow: withoutWrite.filter((tool) => !/search/i.test(tool)), authority: { ...readOnly, network: false }, context: "off", executor: false };
    return { ...shared, toolAllow: authority.write ? [...tools] : withoutWrite, authority: { ...authority }, context: profile.context, executor: true };
  };
  return { status: "ready", value: { roles: ROLES.map(projection), receipt } };
}
