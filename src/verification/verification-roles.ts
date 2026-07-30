import { normalizeReasoningTier, type ResolvedRun, type RoleProjection } from "../profile/profile.js";
import { resolveReasoning, type ReasoningPolicy } from "../profile/reasoning-policy.js";

export const VERIFICATION_ROLES = ["validator", "grader", "park-ranger"] as const;
export type VerificationRole = (typeof VERIFICATION_ROLES)[number];

export type VerificationProjection = Omit<RoleProjection, "role" | "executor">
  & { readonly role: VerificationRole; readonly executor: false };

export type VerificationRoleFailure =
  | "verification_role_unknown"
  | "verification_not_isolated"
  | "self_certification"
  | "shared_ancestry";

function isVerificationRole(r: string): r is VerificationRole {
  return (VERIFICATION_ROLES as readonly string[]).includes(r);
}

export function deriveVerificationProjection(input: {
  readonly run: ResolvedRun;
  readonly role: VerificationRole;
  readonly policy: ReasoningPolicy;
  readonly sessionNonce: string;
  readonly escalationStep?: number;
}): { ok: true; value: VerificationProjection } | { ok: false; code: VerificationRoleFailure | "reasoning_unmappable" } {
  const { run, role, policy, sessionNonce, escalationStep } = input;
  if (!isVerificationRole(role)) return { ok: false, code: "verification_role_unknown" };
  // All roles share the run selection; Crewmate retains the run's full tool projection.
  const base = run.roles[0];
  const fullToolRole = run.roles.find((candidate) => candidate.role === "crewmate");
  if (!base || !fullToolRole) return { ok: false, code: "verification_role_unknown" };
  const selectedTier = normalizeReasoningTier(base.selection.reasoning, base.selection.provider);
  if (!selectedTier) return { ok: false, code: "reasoning_unmappable" };
  const resolved = resolveReasoning({ role, provider: base.selection.provider, policy, globalOverride: selectedTier, escalationStep });
  if (!resolved.ok) return { ok: false, code: "reasoning_unmappable" };
  const withoutWrite = fullToolRole.toolAllow.filter((t) => !/write|edit|shell|bash/i.test(t));
  const readOnly = { ...base.authority, write: false, externalAction: false };
  const baseRoleSuffix = `:${base.role}`;
  const agentIdentity = base.identity.endsWith(baseRoleSuffix)
    ? base.identity.slice(0, -baseRoleSuffix.length)
    : base.identity;
  const proj: VerificationProjection = {
    role,
    identity: `${agentIdentity}:${role}`,
    sessionId: `${agentIdentity}:${role}:session:${sessionNonce}`,
    selection: base.selection,
    reasoning: { tier: resolved.tier, providerLevel: resolved.providerLevel, clamped: resolved.clamped },
    toolAllow: withoutWrite,
    toolDeny: [...base.toolDeny],
    authority: { ...readOnly, network: false },
    context: "off",
    isolationRequested: base.isolationRequested,
    fallbackEnabled: base.fallbackEnabled,
    limits: { ...base.limits },
    executor: false,
  };
  return { ok: true, value: proj };
}

export function verificationSessionScope(input: { readonly runId: string; readonly role: VerificationRole; readonly contentHash: string }): string {
  const { runId, role, contentHash } = input;
  return `verify:${runId}:${role}:${contentHash.slice(0, 12)}`;
}

export function assertIsolatedVerification(request: {
  readonly role: VerificationProjection;
  readonly providerSessionId?: string;
  readonly focusMode?: boolean;
}): { ok: true } | { ok: false; code: "verification_not_isolated" } {
  const { role, providerSessionId, focusMode } = request;
  if (providerSessionId !== undefined) return { ok: false, code: "verification_not_isolated" };
  if (focusMode === true) return { ok: false, code: "verification_not_isolated" };
  if (role.authority.write || role.authority.externalAction) return { ok: false, code: "verification_not_isolated" };
  return { ok: true };
}

export function assertIndependentVerification(input: {
  readonly verifierSessionId: string | null;
  readonly implementerSessionIds: readonly string[];
  readonly executionAncestry: readonly string[];
}): { ok: true } | { ok: false; code: "self_certification" | "shared_ancestry" } {
  const { verifierSessionId, implementerSessionIds, executionAncestry } = input;
  if (verifierSessionId != null && implementerSessionIds.includes(verifierSessionId)) {
    return { ok: false, code: "self_certification" };
  }
  if (executionAncestry.length > 0) {
    return { ok: false, code: "shared_ancestry" };
  }
  return { ok: true };
}
