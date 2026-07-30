const CONCURRENCY_SIGNALS = [
    "write_set_conflict",
    "shared_file",
    "unstable_test",
    "repeated_integration_failure",
];
function declaredTags(value) {
    return Array.isArray(value)
        && [...value].every((tag) => typeof tag === "string" && tag.length > 0);
}
function disjoint(left, right) {
    const rightSet = new Set(right);
    return left.every((value) => !rightSet.has(value));
}
export function provenIndependent(a, b) {
    if (a.parallelSafe !== true || b.parallelSafe !== true)
        return false;
    if (!declaredTags(a.writeSet) || !declaredTags(b.writeSet)
        || !declaredTags(a.interfaceTags) || !declaredTags(b.interfaceTags)
        || !declaredTags(a.environmentTags) || !declaredTags(b.environmentTags)
        || !declaredTags(a.integrationBoundaryTags) || !declaredTags(b.integrationBoundaryTags)) {
        return false;
    }
    return disjoint(a.writeSet, b.writeSet)
        && disjoint(a.interfaceTags, b.interfaceTags)
        && disjoint(a.environmentTags, b.environmentTags)
        && disjoint(a.integrationBoundaryTags, b.integrationBoundaryTags);
}
function validCap(value) {
    return Number.isSafeInteger(value) && value >= 0;
}
function validSignal(value) {
    return typeof value === "string"
        && CONCURRENCY_SIGNALS.some((signal) => signal === value);
}
function assertValidConcurrencyInput(input) {
    if (!validCap(input.ceiling) || !validCap(input.ownerCap) || !validCap(input.independenceCap)
        || !Array.isArray(input.signals) || input.signals.some((signal) => !validSignal(signal))
        || (input.scope !== "cross-phase" && input.scope !== "within-phase")
        || typeof input.phaseId !== "string" || input.phaseId.length === 0
        || (input.prior !== undefined
            && (typeof input.prior.phaseId !== "string" || input.prior.phaseId.length === 0
                || !validCap(input.prior.cap)
                || (input.prior.reducedBy !== undefined && !validSignal(input.prior.reducedBy))))) {
        throw new TypeError("invalid concurrency input");
    }
}
export function admissibleConcurrency(input) {
    assertValidConcurrencyInput(input);
    const signal = CONCURRENCY_SIGNALS.find((candidate) => input.signals.includes(candidate));
    const degradedCap = signal === undefined ? Number.MAX_SAFE_INTEGER : 1;
    const unrestricted = Math.min(input.ceiling, input.ownerCap, input.independenceCap, degradedCap);
    const samePhasePrior = input.prior?.phaseId === input.phaseId ? input.prior : undefined;
    const cap = Math.min(unrestricted, samePhasePrior?.cap ?? Number.MAX_SAFE_INTEGER);
    const reducedBy = signal
        ?? (samePhasePrior !== undefined && samePhasePrior.cap <= unrestricted
            ? samePhasePrior.reducedBy
            : undefined);
    return {
        cap,
        controller: input.scope === "cross-phase" ? "trail-boss" : "explorer",
        ...(reducedBy === undefined ? {} : { reducedBy }),
    };
}
