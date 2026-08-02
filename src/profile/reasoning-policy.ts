/** Pure, fail-closed per-role reasoning policy resolution. */
export const REASONING_TIERS = ["minimal", "low", "medium", "high", "very-high", "max"] as const;
export type ReasoningTier = (typeof REASONING_TIERS)[number];

/** Approved abstract-tier to provider-level policy table. */
export const REASONING_PROVIDER_MAP = {
  minimal: { codex: "low", claude: "low", grok: "low", agy: "low", pi: "minimal", opencode: "minimal" },
  low: { codex: "low", claude: "low", grok: "low", agy: "low", pi: "low", opencode: "low" },
  medium: { codex: "medium", claude: "medium", grok: "medium", agy: "medium", pi: "medium", opencode: "medium" },
  high: { codex: "high", claude: "high", grok: "high", agy: "high", pi: "high", opencode: "high" },
  "very-high": { codex: "xhigh", claude: "xhigh", grok: "xhigh", agy: "thinking", pi: "xhigh", opencode: "xhigh" },
  max: { codex: "max", claude: "max", grok: "xhigh", agy: "thinking", pi: "xhigh", opencode: "max" },
} as const;

export type ReasoningProvider = keyof (typeof REASONING_PROVIDER_MAP)[ReasoningTier];

export interface ReasoningPolicy {
  readonly defaults: Readonly<Record<string, ReasoningTier>>;
  readonly escalation: {
    readonly maxSteps: number;
    readonly onNewFailureFingerprint: boolean;
    readonly onCrossBoundaryDefect: boolean;
  };
}

export const DEFAULT_REASONING_TIERS = {
  navigator: "high",
  explorer: "medium",
  "sub-explorer": "medium",
  crewmate: "medium",
  validator: "high",
  grader: "high",
  "park-ranger": "high",
  surveyor: "medium",
  "trail-boss": "medium",
} as const satisfies Readonly<Record<string, ReasoningTier>>;

export const GLOBAL_DEFAULT_REASONING_TIER: ReasoningTier = "medium";

const BACKGROUND_BRIEF_POLICY: ReasoningPolicy = {
  defaults: { "background-brief": "medium" },
  escalation: { maxSteps: 0, onNewFailureFingerprint: false, onCrossBoundaryDefect: false },
};

export type ReasoningResolution = {
  readonly ok: true;
  readonly tier: ReasoningTier;
  readonly providerLevel: string;
  readonly clamped: boolean;
  readonly reason: "default" | "override" | "escalated" | "clamped";
} | {
  readonly ok: false;
  readonly code: "reasoning_unmappable";
};

export interface ResolveReasoningInput {
  readonly role: string;
  readonly provider: string;
  readonly policy: ReasoningPolicy;
  readonly globalOverride?: ReasoningTier;
  readonly escalationStep?: number;
}

export function resolveBackgroundReasoning(providerName: string, ownerCeiling?: ReasoningTier): ReasoningResolution {
  return resolveReasoning({
    role: "background-brief",
    provider: providerName,
    policy: BACKGROUND_BRIEF_POLICY,
    ...(ownerCeiling === undefined ? {} : { globalOverride: ownerCeiling }),
  });
}

function isReasoningTier(value: unknown): value is ReasoningTier {
  return typeof value === "string" && (REASONING_TIERS as readonly string[]).includes(value);
}

function provider(provider: string): provider is ReasoningProvider {
  return Object.hasOwn(REASONING_PROVIDER_MAP.minimal, provider);
}

function providerCeiling(providerName: ReasoningProvider): number {
  let ceiling = REASONING_TIERS.length - 1;
  const topLevel = REASONING_PROVIDER_MAP.max[providerName];
  while (ceiling > 0 && REASONING_PROVIDER_MAP[REASONING_TIERS[ceiling - 1]!][providerName] === topLevel) ceiling -= 1;
  return ceiling;
}

export function resolveReasoning(input: ResolveReasoningInput): ReasoningResolution {
  if (!provider(input.provider)) return { ok: false, code: "reasoning_unmappable" };
  if (input.escalationStep !== undefined && !Number.isFinite(input.escalationStep)) return { ok: false, code: "reasoning_unmappable" };

  const baseTier = input.policy.defaults[input.role] ?? GLOBAL_DEFAULT_REASONING_TIER;
  if (!isReasoningTier(baseTier) || input.globalOverride !== undefined && !isReasoningTier(input.globalOverride)) return { ok: false, code: "reasoning_unmappable" };
  const baseIndex = REASONING_TIERS.indexOf(baseTier);
  const requestedSteps = Math.max(0, Math.trunc(input.escalationStep ?? 0));
  const allowedSteps = Math.max(0, Math.trunc(input.policy.escalation.maxSteps));
  const escalationSteps = Math.min(requestedSteps, allowedSteps);
  const requestedIndex = Math.min(baseIndex + escalationSteps, REASONING_TIERS.length - 1);
  const ceiling = Math.min(providerCeiling(input.provider), input.globalOverride === undefined ? REASONING_TIERS.length - 1 : REASONING_TIERS.indexOf(input.globalOverride));
  const clamped = requestedIndex > ceiling;
  const tier = REASONING_TIERS[Math.min(requestedIndex, ceiling)]!;
  const reason = clamped ? "clamped" : escalationSteps > 0 ? "escalated" : "default";

  return { ok: true, tier, providerLevel: REASONING_PROVIDER_MAP[tier][input.provider], clamped, reason };
}
