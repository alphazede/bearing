import { createHash } from "node:crypto";
import { canonicalStringify } from "../contracts/run.js";
import { REASONING_TIERS } from "../profile/reasoning-policy.js";
export const MAX_EQUIVALENT_FAILURES = 3;
export const RETRY_WARRANTS = [
    "new_hypothesis",
    "new_evidence",
    "changed_strategy",
    "changed_environment",
    "approved_amendment",
];
const ESCALATION_TARGETS = {
    "within-slice": "explorer",
    "cross-slice": "trail-boss",
    "cross-phase": "navigator",
    "contract-change": "owner",
};
export function failureFingerprint(input) {
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
function append(ledger, attempt, outcome) {
    return [...ledger, {
            fingerprint: attempt.fingerprint,
            warrant: attempt.warrant ?? null,
            reasoningTier: attempt.reasoningTier,
            outcome,
        }];
}
function lastEquivalentAdmission(ledger, fingerprint) {
    for (let index = ledger.length - 1; index >= 0; index -= 1) {
        const entry = ledger[index];
        if (entry.fingerprint === fingerprint && entry.outcome === "admitted")
            return entry;
    }
    return undefined;
}
export function admitRetry(ledger, attempt) {
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
    const equivalentFailures = ledger.filter((entry) => entry.fingerprint === attempt.fingerprint && entry.outcome === "admitted").length;
    if (equivalentFailures >= MAX_EQUIVALENT_FAILURES) {
        return {
            ok: true,
            ledger: append(ledger, attempt, "escalation_required"),
            escalation: ESCALATION_TARGETS[attempt.scope],
        };
    }
    return { ok: true, ledger: append(ledger, attempt, "admitted") };
}
