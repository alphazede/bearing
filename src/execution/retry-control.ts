import { createHash } from "node:crypto";
import { canonicalStringify } from "../contracts/run.js";
import { REASONING_TIERS, type ReasoningTier } from "../profile/reasoning-policy.js";

export const MAX_EQUIVALENT_FAILURES = 3;

export type FocusCompletionErrorSignature =
  | "git_state"
  | "path_outside_write_set"
  | "artifact_missing"
  | "evidence_invalid"
  | "no_product_change";

export interface FailureFingerprintInput {
  readonly stage: string;
  readonly failureCode: string;
  readonly commandId?: string;
  readonly errorSignature: FocusCompletionErrorSignature;
  readonly relevantState: unknown;
  readonly changedPaths: readonly string[];
  readonly hypothesisId?: string;
}

export const RETRY_WARRANTS = [
  "new_hypothesis",
  "new_evidence",
  "changed_strategy",
  "changed_environment",
  "approved_amendment",
] as const;
export type RetryWarrant = (typeof RETRY_WARRANTS)[number];

export type RetryRefusal =
  | "retry_requires_warrant"
  | "retry_warrant_scope_mismatch"
  | "same_attempt_higher_reasoning"
  | "retry_limit_reached"
  | "escalation_required";

export type RetryOutcome = "admitted" | RetryRefusal;

export interface RetryLedgerEntry {
  readonly fingerprint: string;
  readonly warrant: RetryWarrant | null;
  readonly reasoningTier: ReasoningTier;
  readonly outcome: RetryOutcome;
}

export type EscalationScope =
  | "within-slice"
  | "cross-slice"
  | "cross-phase"
  | "contract-change";

export type EscalationTarget = "explorer" | "trail-boss" | "navigator" | "owner";

export interface RetryAttempt {
  readonly fingerprint: string;
  readonly warrant?: RetryWarrant;
  readonly reasoningTier: ReasoningTier;
  readonly scope: EscalationScope;
}

export type RetryDecision =
  | {
    readonly ok: true;
    readonly ledger: readonly RetryLedgerEntry[];
    readonly escalation?: EscalationTarget;
  }
  | {
    readonly ok: false;
    readonly reason: Exclude<RetryRefusal, "escalation_required">;
    readonly ledger: readonly RetryLedgerEntry[];
  };

const ESCALATION_TARGETS: Readonly<Record<EscalationScope, EscalationTarget>> = {
  "within-slice": "explorer",
  "cross-slice": "trail-boss",
  "cross-phase": "navigator",
  "contract-change": "owner",
};

export function retryWarrantAllowed(scope: EscalationScope, warrant: RetryWarrant): boolean {
  return warrant !== "approved_amendment" || scope === "contract-change";
}

export function failureFingerprint(input: FailureFingerprintInput): string {
  const canonical = canonicalStringify({
    stage: input.stage,
    failureCode: input.failureCode,
    ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
    errorSignature: input.errorSignature,
    relevantState: input.relevantState,
    changedPaths: [...new Set(input.changedPaths)].sort(),
    ...(input.hypothesisId === undefined ? {} : { hypothesisId: input.hypothesisId }),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function append(
  ledger: readonly RetryLedgerEntry[],
  attempt: RetryAttempt,
  outcome: RetryOutcome,
): readonly RetryLedgerEntry[] {
  return [...ledger, {
    fingerprint: attempt.fingerprint,
    warrant: attempt.warrant ?? null,
    reasoningTier: attempt.reasoningTier,
    outcome,
  }];
}

function lastEquivalentAdmission(
  ledger: readonly RetryLedgerEntry[],
  fingerprint: string,
): RetryLedgerEntry | undefined {
  for (let index = ledger.length - 1; index >= 0; index -= 1) {
    const entry = ledger[index];
    if (entry.fingerprint === fingerprint && entry.outcome === "admitted") return entry;
  }
  return undefined;
}

export function admitRetry(
  ledger: readonly RetryLedgerEntry[],
  attempt: RetryAttempt,
): RetryDecision {
  if (attempt.warrant !== undefined && !retryWarrantAllowed(attempt.scope, attempt.warrant)) {
    const reason = "retry_warrant_scope_mismatch";
    return { ok: false, reason, ledger: append(ledger, attempt, reason) };
  }
  const previous = lastEquivalentAdmission(ledger, attempt.fingerprint);
  const tierRaised = previous !== undefined
    && REASONING_TIERS.indexOf(attempt.reasoningTier) > REASONING_TIERS.indexOf(previous.reasoningTier);
  if (tierRaised && attempt.warrant !== "new_hypothesis" && attempt.warrant !== "new_evidence") {
    const reason = "same_attempt_higher_reasoning";
    return { ok: false, reason, ledger: append(ledger, attempt, reason) };
  }
  if (attempt.warrant === undefined) {
    const reason = "retry_requires_warrant";
    return { ok: false, reason, ledger: append(ledger, attempt, reason) };
  }

  const equivalentFailures = ledger.filter(
    (entry) => entry.fingerprint === attempt.fingerprint && entry.outcome === "admitted",
  ).length;
  if (equivalentFailures >= MAX_EQUIVALENT_FAILURES) {
    return {
      ok: true,
      ledger: append(ledger, attempt, "escalation_required"),
      escalation: ESCALATION_TARGETS[attempt.scope],
    };
  }
  return { ok: true, ledger: append(ledger, attempt, "admitted") };
}
