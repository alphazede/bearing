import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { BUILTIN_ROUTES, createAgentAdapter, routeFor, type ProcessRunner, type RouteDescriptor, type RouteModelOption } from "../adapters/adapters.js";
import {
  parseAgentProfile,
  resolveRun,
  type AgentProfile,
  type ResolvedRun,
  type RunOverrides,
  type RoleProjection,
  type Selection,
} from "../profile/profile.js";

export const REASONING_LEVELS = ["default", "off", "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "thinking"] as const;

export interface RouteInspectionPort {
  executableAvailable(executable: string): boolean;
  currentSelection?(route: RouteDescriptor): { readonly model: string; readonly reasoning: string };
  modelOptions?(route: RouteDescriptor, repositoryPath?: string): readonly RouteModelOption[];
}

export interface VerificationPort {
  verify(selection: Selection, role: RoleProjection, repositoryPath: string): Promise<boolean>;
}

export class AdapterVerification implements VerificationPort {
  constructor(private readonly runner: ProcessRunner) {}
  async verify(selection: Selection, role: RoleProjection, repositoryPath: string): Promise<boolean> {
    const adapter = createAgentAdapter(selection, this.runner);
    if (!adapter) return false;
    const receipt = await adapter.execute({ runId: `readiness-${randomUUID()}`, repositoryPath, role: { ...role, authority: { ...role.authority, write: false, network: selection.provider === "agy" ? role.authority.network : false, externalAction: false }, toolAllow: role.toolAllow.filter((tool) => !/write|edit|shell|bash/i.test(tool)), sessionId: null }, task: { prompt: "Return a short structured completion confirming readiness. Do not read or write repository files." } });
    return receipt.status === "completed" && receipt.events.some((event) => /^(complete|completed|done|result|turn\.completed|agent_end|step_finish)$/i.test(event.type));
  }
}

export interface RouteInspection {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly detected: boolean;
  readonly capabilities: readonly string[];
  readonly reasoning: string;
}

export type ReadinessResult =
  | {
      readonly status: "ready" | "detected";
      readonly detected: true;
      readonly verified: boolean;
      readonly run: ResolvedRun;
    }
  | {
      readonly status: "blocked";
      readonly detected: boolean;
      readonly verified: false;
      readonly code: "selection_unavailable";
      readonly repair: "choose_detected_route";
    };

const BASE_PROFILE: AgentProfile = (() => {
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
  if (!parsed.ok) throw new Error("invalid built-in profile");
  return parsed.value;
})();

function descriptor(selection: Selection): RouteDescriptor | undefined {
  const route = routeFor(selection);
  return route?.reasoningLevels.includes(selection.reasoning) ? route : undefined;
}

function fallback(route: RouteDescriptor, current: { readonly model: string; readonly reasoning: string } | undefined): readonly RouteModelOption[] {
  const model = current?.model ?? route.model;
  const reasoning = route.reasoningLevels.includes(current?.reasoning ?? "") ? current!.reasoning : route.reasoningLevels[0]!;
  return [{ model, label: model === "*" ? "Agent default" : model, reasoningLevels: route.reasoningLevels, defaultReasoning: reasoning }];
}

function normalized(options: readonly RouteModelOption[], fallbackOption: readonly RouteModelOption[]): readonly RouteModelOption[] {
  const seen = new Set<string>();
  const safe = options.flatMap((option) => {
    const model = typeof option.model === "string" && /^[^\s\u0000-\u001f]{1,256}$/.test(option.model) ? option.model : undefined;
    const levels = Array.isArray(option.reasoningLevels) ? option.reasoningLevels.filter((level): level is string => typeof level === "string" && REASONING_LEVELS.includes(level as typeof REASONING_LEVELS[number])).slice(0, REASONING_LEVELS.length) : [];
    if (!model || !levels.length || seen.has(model)) return [];
    seen.add(model);
    return [{ model, label: model === "*" ? "Agent default" : model, reasoningLevels: levels, defaultReasoning: levels.includes(option.defaultReasoning) ? option.defaultReasoning : levels[0]! }];
  });
  return safe.length ? safe.slice(0, 64) : fallbackOption;
}

export class ReadinessService {
  private readonly models = new Map<string, readonly RouteModelOption[]>();
  constructor(
    private readonly inspection: RouteInspectionPort,
    private readonly verification?: VerificationPort,
    private readonly overrides: RunOverrides = {},
  ) {}

  inspect(_repositoryPath = process.cwd()): readonly RouteInspection[] {
    return BUILTIN_ROUTES.slice(0, 16).map((route) => {
      const detected = this.inspection.executableAvailable(route.executable);
      const current = this.inspection.currentSelection?.(route);
      const selectedModel = fallback(route, current)[0]!;
      return {
        id: route.id,
        provider: route.provider,
        model: selectedModel.model,
        reasoning: selectedModel.reasoningLevels.includes(current?.reasoning ?? "") ? current!.reasoning : selectedModel.defaultReasoning,
        detected,
        capabilities: route.capabilities.slice(0, 16),
      };
    });
  }

  discover(routeId: string, repositoryPath: string, detected = false): readonly RouteModelOption[] | undefined {
    const route = BUILTIN_ROUTES.find((candidate) => candidate.id === routeId);
    if (!route || (!detected && !this.inspection.executableAvailable(route.executable))) return undefined;
    let repository: string;
    try {
      repository = realpathSync(repositoryPath);
      if (!statSync(repository).isDirectory()) return undefined;
    } catch { return undefined; }
    const key = `${repository}\u0000${route.id}`;
    const cached = this.models.get(key);
    if (cached) return cached;
    const safeFallback = fallback(route, this.inspection.currentSelection?.(route));
    let discovered: readonly RouteModelOption[] = [];
    try { discovered = this.inspection.modelOptions?.(route, repository) ?? []; } catch { /* static fallback */ }
    const choices = normalized(discovered, safeFallback);
    this.models.set(key, choices);
    return choices;
  }

  async check(selection: Selection, repositoryPath = process.cwd()): Promise<ReadinessResult> {
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
