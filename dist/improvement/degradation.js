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
function exhaustedBudget(value) {
    if (!object(value))
        return false;
    const used = own(value, "used");
    const budget = own(value, "budget");
    return nonNegativeInteger(used)
        && nonNegativeInteger(budget)
        && budget > 0
        && used >= budget;
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
export function detectDegradation(input) {
    if (!object(input))
        return NO_SIGNAL;
    try {
        const outcomes = own(input, "outcomes");
        const retry = retryEvidence(outcomes);
        const recoveryCount = own(input, "recoveryCount");
        const reasons = [];
        if (exhaustedBudget(own(input, "tokenBudget"))) {
            reasons.push("token_budget_exhausted");
        }
        if (retry.equivalentFailuresRepeated) {
            reasons.push("equivalent_failures_repeated");
        }
        if (nonNegativeInteger(recoveryCount) && recoveryCount >= 2) {
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
