export const DEGRADATION_REASONS = Object.freeze([
    "token_budget_exhausted",
    "equivalent_failures_repeated",
    "recovery_repeated",
    "retry_refused",
    "continuity_lost",
]);
const NO_SIGNAL = Object.freeze({
    ok: false,
    reason: "no_signal",
});
const FINGERPRINT_REF = /^[a-f0-9]{64}$/;
const RETRY_REFUSALS = Object.freeze([
    "retry_requires_warrant",
    "same_attempt_higher_reasoning",
    "retry_limit_reached",
]);
const RETRY_CODES = Object.freeze([
    "admitted",
    ...RETRY_REFUSALS,
    "escalation_required",
]);
const TOKEN_BUDGET_STATES = Object.freeze(["within_budget", "exhausted"]);
const RECOVERY_OUTCOMES = Object.freeze(["repaired", "stopped"]);
const MAX_TOKEN_TOTAL = Number.MAX_SAFE_INTEGER;
const MAX_RECOVERY_ATTEMPTS = 16;
function object(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function own(value, key) {
    return Object.hasOwn(value, key) ? value[key] : undefined;
}
function nonNegativeInteger(value) {
    return typeof value === "number"
        && Number.isSafeInteger(value)
        && value >= 0;
}
function retryEvidence(value) {
    if (!Array.isArray(value)) {
        return { equivalentFailuresRepeated: false, retryRefused: false };
    }
    const fingerprints = new Set();
    let equivalentFailuresRepeated = false;
    let retryRefused = false;
    for (const candidate of value) {
        if (!object(candidate) || own(candidate, "signal") !== "retry")
            continue;
        const code = own(candidate, "code");
        if (typeof code !== "string"
            || !RETRY_CODES.some((allowed) => allowed === code))
            continue;
        if (RETRY_REFUSALS.some((refusal) => refusal === code)) {
            retryRefused = true;
        }
        const fingerprintRef = own(candidate, "fingerprintRef");
        if (typeof fingerprintRef !== "string" || !FINGERPRINT_REF.test(fingerprintRef))
            continue;
        if (fingerprints.has(fingerprintRef))
            equivalentFailuresRepeated = true;
        else
            fingerprints.add(fingerprintRef);
    }
    return { equivalentFailuresRepeated, retryRefused };
}
function tokenAndRecoveryEvidence(value) {
    if (!Array.isArray(value))
        return { tokenBudgetExhausted: false, recoveryRepeated: false };
    let tokenEvidenceValid = true;
    let exhaustedObserved = false;
    let recoveryCount = 0;
    for (const candidate of value) {
        if (!object(candidate))
            continue;
        const signal = own(candidate, "signal");
        if (signal === "token_usage") {
            const code = own(candidate, "code");
            const tokens = own(candidate, "tokens");
            const budget = own(candidate, "budget");
            if (!TOKEN_BUDGET_STATES.some((allowed) => allowed === code)
                || !nonNegativeInteger(tokens)
                || tokens > MAX_TOKEN_TOTAL
                || !nonNegativeInteger(budget)
                || budget === 0) {
                tokenEvidenceValid = false;
                continue;
            }
            if (code === "exhausted" && tokens <= budget) {
                tokenEvidenceValid = false;
                continue;
            }
            if (code === "exhausted")
                exhaustedObserved = true;
            continue;
        }
        if (signal === "recovery") {
            const code = own(candidate, "code");
            const attempts = own(candidate, "attempts");
            if (RECOVERY_OUTCOMES.some((allowed) => allowed === code)
                && nonNegativeInteger(attempts)
                && attempts > 0
                && attempts <= MAX_RECOVERY_ATTEMPTS)
                recoveryCount += attempts;
        }
    }
    return { tokenBudgetExhausted: tokenEvidenceValid && exhaustedObserved, recoveryRepeated: recoveryCount >= 2 };
}
export function detectDegradation(input) {
    if (!object(input))
        return NO_SIGNAL;
    try {
        const outcomes = own(input, "outcomes");
        const retry = retryEvidence(outcomes);
        const tokenAndRecovery = tokenAndRecoveryEvidence(outcomes);
        const reasons = [];
        if (tokenAndRecovery.tokenBudgetExhausted) {
            reasons.push("token_budget_exhausted");
        }
        if (retry.equivalentFailuresRepeated) {
            reasons.push("equivalent_failures_repeated");
        }
        if (tokenAndRecovery.recoveryRepeated) {
            reasons.push("recovery_repeated");
        }
        if (retry.retryRefused) {
            reasons.push("retry_refused");
        }
        if (own(input, "sessionContinuity") === "lost") {
            reasons.push("continuity_lost");
        }
        return reasons.length === 0
            ? NO_SIGNAL
            : Object.freeze({
                ok: true,
                reasons: Object.freeze(reasons),
            });
    }
    catch {
        return NO_SIGNAL;
    }
}
